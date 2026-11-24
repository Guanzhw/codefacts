"""Run a fresh, evidence-limited CodeFacts navigation session."""

import argparse
from collections import defaultdict, deque
from dataclasses import dataclass
import fcntl
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT.parent / "evolution-10"), str(ROOT.parent / "symbol-follow")]
import nav
import navtest


DEFAULTS = {
    "ordering": "round_robin",
    "cross_file": False,
    "label_mode": "plain",
    "link_cap": 850,
    "reserve": 950,
    "first_limit": 1500,
    "second_limit": 1500,
    "source_mode": "head",
}
INITIAL_POLICY = nav.policy_for({"compact": True, "rows": 28, "menu_bytes": 2000})
CALL = re.compile(r"(?:\.|::)([A-Za-z_]\w*)\s*\(")
CALL_OR_FUNCTION = re.compile(r"\b([A-Za-z_][A-Za-z_0-9]*)\s*\(")
TYPE_NAME = re.compile(r"\b[A-Z][A-Za-z_0-9]*\b")
# One result page per visible call, with a fixed bound on the number of calls.
CROSS_TERMS = 8
CROSS_RESULTS = 16


def policy_for(overrides):
    if not isinstance(overrides, dict) or overrides.keys() - DEFAULTS.keys():
        raise nav.Unavailable
    policy = DEFAULTS | overrides
    ranges = {
        "link_cap": (0, nav.BYTE_LIMIT),
        "reserve": (0, nav.BYTE_LIMIT),
        "first_limit": (1, 1500),
        "second_limit": (1, nav.BYTE_LIMIT),
    }
    for name, (minimum, maximum) in ranges.items():
        value = policy[name]
        if type(value) is not int or not minimum <= value <= maximum:
            raise nav.Unavailable
    choices = {
        "ordering": ("round_robin", "calls_first", "type_first", "trait_groups"),
        "label_mode": ("plain", "trait", "line"),
        "source_mode": ("head", "edges"),
    }
    if any(policy[name] not in allowed for name, allowed in choices.items()):
        raise nav.Unavailable
    if type(policy["cross_file"]) is not bool:
        raise nav.Unavailable
    return policy


@dataclass(frozen=True)
class Link:
    name: str
    receiver: str
    trait: str
    location: tuple[str, int, int]
    is_call: bool


def outline_pages(repo, index, path):
    args = ("--scope", "all", "--limit", "50", "--format", "compact")
    page = json.loads(nav.native(repo, index, "outline", path, *args))
    yield page
    while cursor := page.get("next_cursor"):
        page = json.loads(nav.native(repo, index, "outline", path, *args, "--cursor", cursor))
        yield page


def link_from_symbol(symbol, owners, path, words, calls):
    if symbol["kind"] not in {"function", "method"}:
        return None
    evidence = symbol["evidence"]
    start, end = evidence["start_line"], evidence["end_line"]
    if not nav.source_path(path) or not 1 <= start <= end:
        return None
    name = symbol["name"]
    owner = owners.get(symbol.get("rust_impl", {}).get("owner_ref"), {})
    type_names = TYPE_NAME.findall(owner.get("receiver", "").partition("<")[0].strip())
    receiver = type_names[-1] if type_names else ""
    is_call = name in calls
    if not is_call and receiver not in words:
        return None
    trait = owner.get("trait_name") or ""
    return Link(name, receiver, trait, (path, start, end), is_call)


def cross_file_links(repo, index, path, body):
    terms = dict.fromkeys(CALL.findall(body) + CALL_OR_FUNCTION.findall(body))
    for term in list(terms)[:CROSS_TERMS]:
        page = json.loads(
            nav.native(repo, index, "search", term, "--scope", "all", "--format", "compact",
                       "--limit", str(CROSS_RESULTS))
        )
        owners = page.get("rust_impl_owners", {})
        for symbol in page["results"]:
            target = symbol["evidence"]["file_path"]
            if target != path and symbol["name"] == term:
                link = link_from_symbol(symbol, owners, target, set(), {term})
                if link is not None:
                    yield link


def symbol_links(repo, index, path, body, cross_file):
    words = set(nav.IDENTIFIER.findall(body))
    calls = set(CALL.findall(body))
    for page in outline_pages(repo, index, path):
        owners = page.get("rust_impl_owners", {})
        for symbol in page["symbols"]:
            link = link_from_symbol(symbol, owners, path, words, calls)
            if link is not None:
                yield link
    if cross_file:
        yield from cross_file_links(repo, index, path, body)


def round_robin(groups):
    active = deque(groups)
    while active:
        group = active.popleft()
        yield group.popleft()
        if group:
            active.append(group)


def ordered_links(links, ordering):
    groups = defaultdict(deque)
    for link in links:
        if ordering == "trait_groups" and link.trait:
            key = ("trait", link.trait)
        elif link.is_call:
            key = ("call", link.name)
        else:
            key = ("type", link.receiver)
        groups[key].append(link)
    if ordering in ("calls_first", "type_first"):
        preferred = "call" if ordering == "calls_first" else "type"
        yield from round_robin(group for key, group in groups.items() if key[0] == preferred)
        yield from round_robin(group for key, group in groups.items() if key[0] != preferred)
    else:
        yield from round_robin(groups.values())


def link_label(link, current_path, mode):
    path, start, _ = link.location
    title = link.name if link.is_call else f"{link.receiver}.{link.name}"
    if mode == "trait" and link.trait:
        title += f" ({link.trait})"
    if path != current_path:
        title += f" @ {path}"
    if mode == "line":
        title += f":{start}"
    return title


def add_links(repo, index, excerpt, slots, budget, policy):
    if budget == 0:
        return ""
    link_policy = ("ordering", "cross_file", "label_mode")
    if all(policy[key] == DEFAULTS[key] for key in link_policy):
        return navtest.add_links(repo, index, excerpt, slots, budget)

    header, *lines = excerpt.splitlines()
    path = nav.READ_TITLE.fullmatch(header)[1]
    body = "\n".join(line.partition(": ")[2] for line in lines)
    known = {tuple(location) for location in slots.values()}
    links = (link for link in symbol_links(repo, index, path, body, policy["cross_file"])
             if link.location not in known)
    next_id = max(int(number) for number in slots) + 1
    rows = []
    for link in ordered_links(links, policy["ordering"]):
        if link.location in known:
            continue
        row = f"[{next_id}] {link_label(link, path, policy['label_mode'])}\n"
        size = nav.byte_count(row)
        if size <= budget:
            slots[str(next_id)] = list(link.location)
            rows.append(row)
            known.add(link.location)
            next_id += 1
            budget -= size
    return "".join(rows)


def sha256(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def check_version(session, setup, spec):
    binary_hash = sha256(nav.BINARY)
    if binary_hash != nav.BINARY_SHA256:
        raise nav.Unavailable
    protocol = json.dumps([setup, spec], sort_keys=True).encode("utf-8")
    version = {
        "codefacts_version": "0.4.1",
        "codefacts_sha256": binary_hash,
        "cli_sha256": sha256(Path(__file__)),
        "nav_sha256": sha256(Path(nav.__file__)),
        "navtest_sha256": sha256(Path(navtest.__file__)),
        "setup_sha256": hashlib.sha256(protocol).hexdigest(),
    }
    lockfile = session / "version.json"
    if lockfile.exists():
        if nav.load(lockfile) != version:
            raise nav.Unavailable
    else:
        nav.create_json(lockfile, version)


def start(repo, index, spec, event_dir, events, remaining):
    if events:
        raise nav.Unavailable
    started = time.monotonic_ns()
    query = " ".join(spec["query"].split())
    if not re.fullmatch(r"[A-Za-z_0-9.][A-Za-z_0-9 :.+/<>,#-]*", query):
        raise nav.Unavailable
    symptom = "Observed behavior: " + " ".join(spec["symptom"].split()) + "\n"
    if nav.byte_count(symptom) >= remaining:
        raise nav.Unavailable
    cards = nav.find_candidates(repo, index, query, INITIAL_POLICY)
    menu, candidates = nav.menu_text(cards, query, INITIAL_POLICY, {},
                                     remaining - nav.byte_count(symptom))
    nav.record_event(event_dir, events, "start", symptom + menu, candidates=candidates,
                     monotonic_ns=started)


def read(repo, index, policy, args, event_dir, events, remaining):
    reads = [event for event in events if event["type"] == "read"]
    slots = {}
    for event in events:
        slots.update(event.get("candidates", {}))
    slot = str(args.number)
    if slot not in slots or len(reads) >= 2:
        raise nav.Unavailable
    location = slots[slot]
    first = location[1] if args.start_line is None else args.start_line
    if any(event["candidate"] == args.number and event["start_line"] == first for event in reads):
        raise nav.Unavailable

    read_policy = (
        {"context": policy["source_mode"], "read_bytes": policy["second_limit"]}
        if reads else {"context": "head", "read_bytes": policy["first_limit"]}
    )
    excerpt, first = nav.read_text(repo, index, read_policy, args.number, location, first, remaining)
    source_bytes = nav.byte_count(excerpt)
    links = ""
    new_slots = {}
    if not reads:
        link_budget = min(policy["link_cap"], max(0, remaining - source_bytes - policy["reserve"]))
        original_slots = set(slots)
        links = add_links(repo, index, excerpt, slots, link_budget, policy)
        new_slots = {number: span for number, span in slots.items() if number not in original_slots}
    nav.record_event(event_dir, events, "read", excerpt + links, candidate=args.number,
                     start_line=first, linked=slot not in events[0]["candidates"],
                     candidates=new_slots, source_bytes=source_bytes, link_bytes=nav.byte_count(links))


def execute(args, session):
    setup = nav.load(session / "setup.json")
    case = Path(setup["case_dir"])
    if not case.is_absolute():
        raise nav.Unavailable
    raw_spec = nav.load(case / "case.json")
    spec = {key: raw_spec[key] for key in ("query", "symptom")}
    if any(not isinstance(value, str) for value in spec.values()):
        raise nav.Unavailable
    repo = (case / "repo").resolve(strict=True)
    index = session / "index.sqlite"
    policy = policy_for(setup["policy"])
    event_dir = session / "events"
    event_dir.mkdir(exist_ok=True)
    events = nav.get_events(event_dir)
    used = sum(event["bytes"] for event in events)
    answer_file = session / "answer.json"
    if answer_file.exists() or (not events and args.command != "start"):
        raise nav.Unavailable
    check_version(session, setup, spec)
    if args.command == "start":
        start(repo, index, spec, event_dir, events, nav.BYTE_LIMIT - used)
    elif args.command == "read":
        read(repo, index, policy, args, event_dir, events, nav.BYTE_LIMIT - used)
    elif args.answer.strip():
        elapsed = (time.monotonic_ns() - events[0]["monotonic_ns"]) / 1e9
        nav.create_json(answer_file, {"answer": args.answer, "bytes": used,
                                      "seconds": elapsed, "usage": None})
        print("Recorded")
    else:
        raise nav.Unavailable


def positive_int(value):
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise argparse.ArgumentTypeError("expected a positive integer")
    return int(value)


def main():
    parser = nav.Parser(prog="cli.py")
    parser.add_argument("ticket")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("start")
    read_command = commands.add_parser("read")
    read_command.add_argument("number", type=positive_int)
    read_command.add_argument("start_line", type=positive_int, nargs="?")
    commands.add_parser("submit").add_argument("answer")
    args = parser.parse_args()
    if not nav.TICKET.fullmatch(args.ticket):
        print("Unavailable.", file=sys.stderr)
        return 2
    session = ROOT / "sessions" / args.ticket
    try:
        with (session / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            execute(args, session)
    except (nav.Unavailable, OSError, UnicodeError, ValueError, KeyError, TypeError,
            subprocess.SubprocessError):
        print("Unavailable.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
