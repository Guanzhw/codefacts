"""Evidence-limited navigation over the published CodeFacts CLI."""

import argparse
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent
BINARY = ROOT.parent / "bin" / "codefacts"
BINARY_SHA256 = "8cdee78cbdab10501d467836c04cb1f9d7b9bbe8608fb79bb6c10eda9779bf5b"
BYTE_LIMIT = 4200
OP_LIMIT = 6
DEFAULTS = {
    "followups": 0,
    "reads": 1,
    "menu_bytes": 2000,
    "read_bytes": 2000,
    "rows": 20,
    "compact": False,
    "scope": "all",
    "context": "head",
    "search_backend": "explore",
    "expand_terms": False,
}
TICKET = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
HEADER = re.compile(r"## (.+):(\d+)-(\d+) \| (.+)")
CODE_LINE = re.compile(r"(\d+):(?: .*|$)")
ROLE = re.compile(r"\[(?:complete|preview|source omitted)\] ([^;]+)")
PUBLIC_ROLES = ("implementation", "test", "documentation", "manifest", "configuration")
MENU_TITLE = re.compile(rf"\[\d+\] (.+):\d+-\d+ \| (.+?)(?: \((?:{'|'.join(PUBLIC_ROLES)})\))?")
READ_TITLE = re.compile(r"\[\d+\] (.+):\d+-\d+")
TEST_NAMES = {
    "test", "tests", "testing", "testdata", "fixture", "fixtures", "snapshot",
    "snapshots", "bench", "benches", "benchmark", "benchmarks", "example", "examples",
}


class Unavailable(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "Unavailable.\n")


@dataclass
class Candidate:
    path: str
    start: int
    end: int
    label: str
    role: str = ""
    preview: tuple = ()

    @property
    def location(self):
        return (self.path, self.start, self.end)


def byte_count(value):
    return len(value.encode("utf-8"))


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def create_json(path, data):
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.link(temporary, path)
        finally:
            temporary.unlink()


def policy_for(overrides):
    if not isinstance(overrides, dict) or overrides.keys() - DEFAULTS.keys():
        raise Unavailable
    policy = DEFAULTS | overrides
    integers = {
        "followups": (0, 2),
        "reads": (1, 3),
        "menu_bytes": (1, BYTE_LIMIT),
        "read_bytes": (1, BYTE_LIMIT),
        "rows": (1, 50),
    }
    for key, (minimum, maximum) in integers.items():
        value = policy[key]
        if type(value) is not int or not minimum <= value <= maximum:
            raise Unavailable
    for key in ("compact", "expand_terms"):
        if type(policy[key]) is not bool:
            raise Unavailable
    choices = {
        "scope": ("all", "impl"),
        "context": ("head", "edges"),
        "search_backend": ("explore", "symbol"),
    }
    if any(policy[key] not in allowed for key, allowed in choices.items()):
        raise Unavailable
    return policy


def source_path(path):
    parts = PurePosixPath(path).parts
    return bool(parts) and not PurePosixPath(path).is_absolute() and ".." not in parts


def lexical_candidates(raw):
    cards = []
    card = None
    for line in raw.split("\n"):
        match = HEADER.fullmatch(line)
        if match:
            path, first, last, label = match.groups()
            card = None
            if source_path(path) and 1 <= int(first) <= int(last):
                card = Candidate(path, int(first), int(last), label)
                cards.append(card)
        elif card and (match := ROLE.match(line)):
            if match[1] in PUBLIC_ROLES:
                card.role = match[1]
        elif card and len(card.preview) < 2 and (match := CODE_LINE.fullmatch(line)):
            if card.start <= int(match[1]) <= card.end:
                card.preview += (line,)
    return cards


def is_secondary(card):
    parts = PurePosixPath(card.path.lower()).parts
    stem = PurePosixPath(card.path.lower()).stem
    return (
        card.role in ("test", "documentation")
        or bool(set(parts[:-1]) & TEST_NAMES)
        or stem in TEST_NAMES
        or stem.startswith(("test_", "fixture_"))
        or stem.endswith(("_test", "_tests", "_fixture", "_fixtures", ".test", ".spec"))
    )


def native(repo, index, command, *args):
    process = subprocess.run(
        [BINARY, command, *args, "--root", repo, "--state", index, "--lsp", "off"],
        cwd=ROOT,
        capture_output=True,
        encoding="utf-8",
        timeout=120,
        check=True,
    )
    return process.stdout


def symbol_candidates(repo, index, term):
    raw = native(repo, index, "search", term, "--format", "compact", "--scope", "all", "--limit", "50")
    result = json.loads(raw)
    cards = []
    for symbol in result["results"]:
        evidence = symbol["evidence"]
        path = evidence["file_path"]
        start, end = evidence["start_line"], evidence["end_line"]
        if not source_path(path) or not 1 <= start <= end:
            continue
        name = symbol.get("qualified_name") or symbol["name"]
        label = f"{symbol['kind']} {' '.join(name.split())}"
        role = ""
        if symbol["kind"] == "heading":
            role = "documentation"
        elif name.startswith(("tests.", "test.")):
            role = "test"
        cards.append(Candidate(path, start, end, label, role))
    return cards


def find_candidates(repo, index, query, policy):
    cards = []
    if policy["search_backend"] == "symbol":
        cards = symbol_candidates(repo, index, query)
    if not cards:
        cards = lexical_candidates(native(repo, index, "explore", query, "--max-bytes", "32000"))
    if policy["scope"] == "impl":
        cards.sort(key=is_secondary)
    return cards


def capped_prefix(lines, budget):
    selected = []
    for line in lines:
        size = byte_count(line + "\n")
        if size > budget:
            break
        selected.append(line)
        budget -= size
    return selected


def menu_text(cards, query, policy, known, budget):
    budget = min(budget, policy["menu_bytes"])
    heading = f"Search: {query}\n"
    remaining = budget - byte_count(heading)
    new = {}
    shown = set()
    lines = []
    serial = max(known.values(), default=0) + 1
    if remaining < 0:
        raise Unavailable
    for card in cards:
        if card.location in shown:
            continue
        candidate_id = known.get(card.location, serial)
        title = f"[{candidate_id}] {card.path}:{card.start}-{card.end} | {card.label}"
        if card.role and not policy["compact"]:
            title += f" ({card.role})"
        if byte_count(title + "\n") > remaining:
            break
        row = [title]
        if not policy["compact"]:
            preview_budget = remaining - byte_count(title + "\n")
            row += capped_prefix(card.preview, preview_budget)
        blob = "\n".join(row) + "\n"
        if card.location not in known:
            serial += 1
        new[candidate_id] = card.location
        lines.append(blob)
        shown.add(card.location)
        remaining -= byte_count(blob)
        if len(lines) == policy["rows"]:
            break
    if not lines and remaining >= byte_count("No selectable results.\n"):
        lines.append("No selectable results.\n")
    return heading + "".join(lines), new


def source_ranges(repo, index, path, ranges):
    requests = [{"file_path": path, "start_line": lo, "end_line": hi} for lo, hi in ranges]
    raw = native(repo, index, "explore", "--reads", json.dumps(requests), "--max-bytes", "32000")
    source = {}
    inside = False
    for line in raw.split("\n"):
        if match := HEADER.fullmatch(line):
            inside = match[1] == path
        elif inside and (match := CODE_LINE.fullmatch(line)):
            number = int(match[1])
            if any(lo <= number <= hi for lo, hi in ranges):
                source[number] = line
    return source


def contiguous(source, line_numbers):
    lines = []
    for line in line_numbers:
        if line not in source:
            break
        lines.append(source[line])
    return lines


def edge_lines(source, first, last, middle, budget):
    head = contiguous(source, range(first, middle + 1))
    tail = contiguous(source, range(last, middle, -1))
    if len(head) + len(tail) == last - first + 1:
        entire = head + tail[::-1]
        if sum(byte_count(line + "\n") for line in entire) <= budget:
            return entire
    omission = "[source lines omitted]"
    separator = byte_count(omission + "\n")
    if head and tail and budget > separator:
        head_fit = capped_prefix(head, (budget - separator) // 2)
        tail_fit = capped_prefix(tail, budget - separator - sum(byte_count(line + "\n") for line in head_fit))
        if head_fit and tail_fit:
            return head_fit + [omission] + tail_fit[::-1]
    return capped_prefix(head, budget)


def read_text(repo, index, policy, candidate_id, location, first, budget):
    path, low, last = location
    if first is None:
        first = low
    if not low <= first <= last:
        raise Unavailable
    heading = f"[{candidate_id}] {path}:{first}-{last}\n"
    budget = min(budget, policy["read_bytes"]) - byte_count(heading)
    if budget <= 0:
        raise Unavailable
    if policy["context"] == "edges" and first < last:
        middle = (first + last) // 2
        ranges = [(first, min(middle, first + 99)), (max(middle + 1, last - 99), last)]
        lines = edge_lines(source_ranges(repo, index, path, ranges), first, last, middle, budget)
    else:
        source = source_ranges(repo, index, path, [(first, last)])
        lines = capped_prefix(contiguous(source, range(first, last + 1)), budget)
    if not lines:
        raise Unavailable
    return heading + "\n".join(lines) + "\n", first


def record_event(directory, events, action, text, **metadata):
    event = {
        "sequence": len(events) + 1,
        "type": action,
        "text": text,
        "bytes": byte_count(text),
        "time_ns": time.time_ns(),
        **metadata,
    }
    create_json(directory / f"{event['sequence']:04}.json", event)
    sys.stdout.buffer.write(text.encode("utf-8"))


def visible_words(events, expand_terms):
    words = set()
    for event in events:
        for line in event["text"].split("\n"):
            if line.startswith("Observed behavior: ") and expand_terms:
                visible = line.removeprefix("Observed behavior: ")
            elif match := MENU_TITLE.fullmatch(line):
                path, label = match.groups()
                _, _, name = label.partition(" ")
                visible = f"{path} {name}" if label != "lexical source range" else path
            elif match := READ_TITLE.fullmatch(line):
                visible = match[1]
            elif CODE_LINE.fullmatch(line):
                visible = line.partition(":")[2]
            else:
                continue
            words.update(match[0].casefold() for match in IDENTIFIER.finditer(visible))
    return words


def get_events(directory):
    return [load(path) for path in sorted(directory.glob("[0-9][0-9][0-9][0-9].json"))]


def check_version(session_dir, setup, spec):
    with BINARY.open("rb") as handle:
        actual = hashlib.file_digest(handle, "sha256").hexdigest()
    if actual != BINARY_SHA256:
        raise Unavailable
    with Path(__file__).open("rb") as handle:
        source_hash = hashlib.file_digest(handle, "sha256").hexdigest()
    protocol = json.dumps([setup, spec], sort_keys=True).encode("utf-8")
    lock = {
        "codefacts_version": "0.4.1",
        "codefacts_sha256": actual,
        "nav_sha256": source_hash,
        "setup_sha256": hashlib.sha256(protocol).hexdigest(),
    }
    lockfile = session_dir / "version.json"
    if lockfile.exists():
        if load(lockfile) != lock:
            raise Unavailable
    else:
        create_json(lockfile, lock)


def execute(args, session_dir):
    setup = load(session_dir / "setup.json")
    case_dir = Path(setup["case_dir"])
    if not case_dir.is_absolute():
        raise Unavailable
    spec = load(case_dir / "case.json")
    query = " ".join(spec["query"].split())
    if not query or not re.fullmatch(r"[A-Za-z_0-9.][A-Za-z_0-9 :.+/<>,#-]*", query):
        raise Unavailable
    repo = (case_dir / "repo").resolve(strict=True)
    cache = ROOT / "cache"
    cache.mkdir(exist_ok=True)
    index = cache / f"{hashlib.sha256(os.fsencode(repo)).hexdigest()}.sqlite"
    policy = policy_for(setup["policy"])
    event_dir = session_dir / "events"
    event_dir.mkdir(exist_ok=True)
    events = get_events(event_dir)
    used = sum(event["bytes"] for event in events)
    budget = BYTE_LIMIT - used
    answer_file = session_dir / "answer.json"
    if answer_file.exists():
        raise Unavailable
    if args.command == "submit":
        if not events or not args.diagnosis.strip():
            raise Unavailable
        check_version(session_dir, setup, spec)
        elapsed = (time.monotonic_ns() - events[0]["monotonic_ns"]) / 1e9
        create_json(answer_file, {"answer": args.diagnosis, "wall_seconds": elapsed, "bytes": used, "usage": None})
        print("Recorded")
        return
    if len(events) == OP_LIMIT or budget <= 0:
        raise Unavailable
    check_version(session_dir, setup, spec)
    locations = {}
    for event in events:
        locations.update({int(key): tuple(val) for key, val in event.get("candidates", {}).items()})
    known = {location: candidate_id for candidate_id, location in locations.items()}
    if args.command == "start":
        if events:
            raise Unavailable
        started = time.monotonic_ns()
        symptom = "Observed behavior: " + " ".join(spec["symptom"].split()) + "\n"
        if byte_count(symptom) >= budget:
            raise Unavailable
        cards = find_candidates(repo, index, query, policy | {"search_backend": "explore"})
        menu, candidates = menu_text(cards, query, policy, known, budget - byte_count(symptom))
        record_event(event_dir, events, "start", symptom + menu, candidates=candidates,
                     query=query, monotonic_ns=started)
    elif not events:
        raise Unavailable
    elif args.command == "search":
        term = args.term
        if len(term) > 120 or not IDENTIFIER.fullmatch(term):
            raise Unavailable
        previous = [event["query"].casefold() for event in events if "query" in event]
        if (
            len(previous) - 1 >= policy["followups"]
            or term.casefold() in previous
            or term.casefold() not in visible_words(events, policy["expand_terms"])
        ):
            raise Unavailable
        cards = find_candidates(repo, index, term, policy)
        text, candidates = menu_text(cards, term, policy, known, budget)
        record_event(event_dir, events, "search", text, candidates=candidates, query=term)
    elif args.command == "read":
        candidate_id = args.number
        location = locations.get(candidate_id)
        reads = [event for event in events if event["type"] == "read"]
        if location is None or len(reads) >= policy["reads"]:
            raise Unavailable
        first = location[1] if args.start_line is None else args.start_line
        if any(event["candidate"] == candidate_id and event["start_line"] == first for event in reads):
            raise Unavailable
        text, first = read_text(repo, index, policy, candidate_id, location, first, budget)
        record_event(event_dir, events, "read", text, candidate=candidate_id, start_line=first)


def main():
    parser = Parser(prog="nav.py")
    parser.add_argument("ticket")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("start")
    read = commands.add_parser("read")
    read.add_argument("number", type=int)
    read.add_argument("start_line", type=int, nargs="?")
    commands.add_parser("search").add_argument("term")
    commands.add_parser("submit").add_argument("diagnosis")
    args = parser.parse_args()
    if not TICKET.fullmatch(args.ticket):
        print("Unavailable.", file=sys.stderr)
        return 2
    session_dir = ROOT / "sessions" / args.ticket
    try:
        with (session_dir / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            execute(args, session_dir)
    except (Unavailable, OSError, UnicodeError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("Unavailable.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
