"""Run a frozen CodeFacts navigation session against a public case."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


CORPUS = Path(__file__).resolve().parent.parent
HELPERS = ("follow-10/cli.py", "evolution-10/nav.py", "symbol-follow/navtest.py")
HELPER_ROOT = next((root for root in (CORPUS, CORPUS.parent)
                    if all((root / path).is_file() for path in HELPERS)), None)
if HELPER_ROOT is None:
    raise SystemExit("Frozen CodeFacts helpers are missing. See tools/PLAY.md.")
sys.dont_write_bytecode = True
sys.path.insert(0, str(HELPER_ROOT / "follow-10"))
import cli


nav = cli.nav
MODES = ("legacy-baseline", "legacy-cross-file", "expanded-symbol", "expanded-explore")
SCHEMA_VERSION = 1
READ_CAP = 1500
SEARCH_CAP = 600
STATE = "session.json"
SOURCE_LINE = re.compile(r"\d+:(?: (.*))?")
INITIAL_QUERY = re.compile(r"[A-Za-z_0-9.][A-Za-z_0-9 :.+/<>,#-]*")
KEYWORDS = set("""
    as async await break case catch class const continue default def defer do else enum except
    false fn for foreach from func function if impl import in interface is let match mod move
    mut new nil none null of package pass pub raise ref return self Self static struct super
    switch then throw trait true try type unsafe use var void where while with yield
""".split())


class Unavailable(Exception):
    pass


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def tool_hashes():
    return {"codefacts_version": "0.4.1", "codefacts_sha256": nav.BINARY_SHA256,
            "play_sha256": cli.sha256(Path(__file__)),
            "cli_sha256": cli.sha256(Path(cli.__file__)),
            "nav_sha256": cli.sha256(Path(nav.__file__)),
            "navtest_sha256": cli.sha256(Path(cli.navtest.__file__))}


def check_binary(path):
    if not path.is_file() or not os.access(path, os.X_OK) or cli.sha256(path) != nav.BINARY_SHA256:
        raise Unavailable("Use the pinned CodeFacts 0.4.1 executable. See tools/PLAY.md.")


def find_binary(override):
    if override is not None:
        candidates = [override]
    else:
        candidates = [CORPUS / "bin" / "codefacts", nav.BINARY]
        if on_path := shutil.which("codefacts"):
            candidates.append(Path(on_path))
    for candidate in candidates:
        try:
            check_binary(candidate)
            return candidate.resolve(strict=True)
        except Unavailable:
            continue
    raise Unavailable("Use the pinned CodeFacts 0.4.1 executable. See tools/PLAY.md.")


def source_path(repo, relative):
    if not isinstance(relative, str) or not nav.source_path(relative):
        raise Unavailable("Invalid source path.")
    path = (repo / relative).resolve(strict=True)
    if not path.is_relative_to(repo) or not path.is_file():
        raise Unavailable("Source path must resolve to a file inside the public repository.")
    return path


def read_case(case):
    spec_path = case / "case.json"
    repo = Path(os.environ["CODEFACTS_NAVIGATION_SOURCE"]) if "CODEFACTS_NAVIGATION_SOURCE" in os.environ else case / "repo"
    if spec_path.is_symlink() or not spec_path.is_file() or repo.is_symlink() or not repo.is_dir():
        raise Unavailable("Expected a public case.json and repo directory.")
    spec = nav.load(spec_path)
    symptom, query = spec["symptom"], spec["query"]
    if not isinstance(symptom, str) or not isinstance(query, str):
        raise Unavailable("Expected a text symptom and initial query.")
    query = " ".join(query.split())
    if not symptom.strip() or not INITIAL_QUERY.fullmatch(query):
        raise Unavailable("Expected a symptom and a searchable initial query.")
    return repo, {"symptom": symptom, "query": query}


def guard_tree(repo):
    for directory, dirs, files in os.walk(repo):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink() and not path.resolve().is_relative_to(repo):
                raise Unavailable("Repository symlinks must stay inside the public source tree.")


@contextmanager
def locked(session, create=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if create:
        flags |= os.O_CREAT
    fd = os.open(session / ".lock", flags, 0o600)
    with os.fdopen(fd, "r") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def save_state(session, state):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=session,
                                     prefix=".session-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(state, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, session / STATE)
        finally:
            temporary.unlink(missing_ok=True)


def stream(events):
    return "".join(event["text"] for event in events)


def summary(events, answer):
    evidence = stream(events)
    size = nav.byte_count(evidence)
    return {"bytes": size, "remaining_bytes": nav.BYTE_LIMIT - size,
            "reads": sum(event["type"] == "read" for event in events),
            "followups": sum(event["type"] == "search" for event in events),
            "stream_sha256": sha256(evidence), "submitted": answer is not None}


def checked_state(session):
    path = session / STATE
    if path.is_symlink():
        raise Unavailable("Invalid session ledger path.")
    state = nav.load(path)
    events, answer = state["events"], state["answer"]
    if state["schema_version"] != SCHEMA_VERSION or state["mode"] not in MODES:
        raise Unavailable("Unknown session version or mode.")
    if state["summary"] != summary(events, answer) or state["summary"]["remaining_bytes"] < 0:
        raise Unavailable("Session evidence ledger is inconsistent.")
    if any(event["sequence"] != sequence or event["bytes"] != nav.byte_count(event["text"])
           or event["sha256"] != sha256(event["text"])
           for sequence, event in enumerate(events, 1)):
        raise Unavailable("Session evidence ledger is inconsistent.")
    return state


def new(args, session):
    case = args.case.resolve(strict=True)
    if session.is_relative_to(case):
        raise Unavailable("Session directory must be outside the public case.")
    repo, spec = read_case(case)
    guard_tree(repo)
    binary = find_binary(args.binary)
    session.mkdir(parents=True, mode=0o700, exist_ok=True)
    with locked(session, create=True):
        if any(path.name != ".lock" for path in session.iterdir()):
            raise Unavailable("Choose a fresh or empty session directory.")
        save_state(session, {"schema_version": SCHEMA_VERSION, "mode": args.mode, "case_dir": str(case),
                             "spec": spec, "binary": str(binary), "versions": tool_hashes(),
                             "events": [], "answer": None, "summary": summary([], None)})


def capture_event(operation, *args):
    captured = []

    def capture(_directory, _events, action, text, **metadata):
        metadata.pop("monotonic_ns", None)
        captured.append({"type": action, "text": text, **metadata})

    with patch.object(nav, "record_event", capture):
        operation(*args)
    event, = captured
    return event


def locations(events):
    slots = {}
    for event in events:
        slots.update(event["candidates"])
    return slots


def read(args, repo, index, state, remaining):
    events = state["events"]
    slot = str(args.number)
    location = locations(events).get(slot)
    reads = [event for event in events if event["type"] == "read"]
    if location is None or len(reads) >= 2:
        raise Unavailable("Choose a displayed ID while a source read remains.")
    path, low, high = location
    source_path(repo, path)
    start = low if args.start_line is None else args.start_line
    if args.start_line is not None:
        disclosed = any(slot in event["candidates"] for event in events
                        if event["type"] in {"start", "search"})
        if not disclosed or not low <= start <= high:
            raise Unavailable("Use the default start or an offset within a displayed range.")
    if any(event["candidate"] == args.number and event["start_line"] == start for event in reads):
        raise Unavailable("Choose a source read with a different ID or start line.")
    if state["mode"].startswith("legacy-"):
        policy = cli.policy_for({"cross_file": state["mode"] == "legacy-cross-file"})
        return capture_event(cli.read, repo, index, policy, args, None, events, remaining)
    excerpt, _ = nav.read_text(repo, index, {"context": "head", "read_bytes": READ_CAP},
                               args.number, location, start, remaining)
    return {"type": "read", "text": excerpt, "candidate": args.number, "start_line": start,
            "candidates": {}, "source_bytes": nav.byte_count(excerpt), "link_bytes": 0}


def search(args, repo, index, state, remaining):
    events = state["events"]
    if not state["mode"].startswith("expanded-") or [event["type"] for event in events] != ["start", "read"]:
        raise Unavailable("Expanded modes allow one search between the first and second source reads.")
    term = args.term
    page = events[1]["text"]
    code = "\n".join(match[1] or "" for line in page.split("\n")[1:]
                     if (match := SOURCE_LINE.fullmatch(line)))
    if (len(term) > 120 or term in KEYWORDS or term.casefold() == state["spec"]["query"].casefold()
            or term not in nav.IDENTIFIER.findall(code)):
        raise Unavailable("Choose a case-sensitive identifier shown in the first source page.")
    budget = min(remaining, SEARCH_CAP)
    if nav.byte_count(f"Search: {term}\n") > budget:
        raise Unavailable("The remaining byte budget cannot fit this search heading.")
    wanted = state["mode"].removeprefix("expanded-")
    cards = nav.symbol_candidates(repo, index, term) if wanted == "symbol" else []
    backend = "symbol" if cards else "explore"
    if not cards:
        cards = nav.find_candidates(repo, index, term, cli.INITIAL_POLICY)
    known = {tuple(span): int(key) for key, span in locations(events).items()}
    policy = cli.INITIAL_POLICY | {"menu_bytes": SEARCH_CAP}
    menu, slots = nav.menu_text(cards, term, policy, known, budget)
    return {"type": "search", "text": menu, "candidates": slots, "term": term,
            "backend": wanted, "actual_backend": backend}


def record(session, state, event, started, timer):
    events = state["events"]
    size = nav.byte_count(event["text"])
    if size > state["summary"]["remaining_bytes"]:
        raise Unavailable("Evidence byte limit exceeded.")
    event.update(sequence=len(events) + 1, bytes=size, sha256=sha256(event["text"]),
                 time_ns=started, duration_ns=time.monotonic_ns() - timer)
    event["candidates"] = {str(number): list(span) for number, span in event["candidates"].items()}
    events.append(event)
    state["summary"] = summary(events, None)
    save_state(session, state)
    sys.stdout.buffer.write(event["text"].encode("utf-8"))


def submit(args, session, state):
    answer = args.answer if args.answer_file is None else args.answer_file.read_text(encoding="utf-8")
    if not answer.strip():
        raise Unavailable("Provide a diagnosis to submit.")
    usage = nav.load(args.usage_file) if args.usage_file is not None else None
    if usage is not None and not isinstance(usage, dict):
        raise Unavailable("Usage must be a JSON object or null.")
    now = time.time_ns()
    state["answer"] = {"answer": answer, "usage": usage, "time_ns": now,
                       "bytes": state["summary"]["bytes"],
                       "seconds": max(0, now - state["events"][0]["time_ns"]) / 1e9}
    state["summary"] = summary(state["events"], state["answer"])
    save_state(session, state)
    print("Recorded")


def execute(args, session):
    state = checked_state(session)
    events = state["events"]
    command = args.command
    if command == "replay":
        sys.stdout.buffer.write(stream(events).encode("utf-8"))
        return
    if command == "status":
        print(json.dumps(state["summary"]))
        return
    if state["answer"] is not None:
        raise Unavailable("Session already submitted.")
    if command == "start" and events:
        raise Unavailable("Session already started.")
    if command != "start" and not events:
        raise Unavailable("Start the session first.")
    case = Path(state["case_dir"])
    if not case.is_absolute() or session.is_relative_to(case.resolve()):
        raise Unavailable("Session directory must be outside the public case.")
    if command == "submit":
        submit(args, session, state)
        return
    if state["versions"] != tool_hashes():
        raise Unavailable("Frozen runtime version changed. Create a new session.")
    repo, spec = read_case(case)
    if spec != state["spec"]:
        raise Unavailable("Public symptom or query changed. Create a new session.")
    guard_tree(repo)
    index = session / "index.sqlite"
    if any(path.is_symlink() for path in session.glob("index.sqlite*")):
        raise Unavailable("Native index must stay inside the session directory.")
    binary = Path(state["binary"])
    check_binary(binary)
    started, timer = time.time_ns(), time.monotonic_ns()
    remaining = state["summary"]["remaining_bytes"]
    with patch.object(nav, "BINARY", binary):
        if command == "start":
            event = capture_event(cli.start, repo, index, spec, None, events, remaining)
        elif command == "read":
            event = read(args, repo, index, state, remaining)
        else:
            event = search(args, repo, index, state, remaining)
    for path, _, _ in event["candidates"].values():
        source_path(repo, path)
    record(session, state, event, started, timer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("new", help="create a fresh public-case session")
    create.add_argument("--case", type=Path, required=True)
    create.add_argument("--mode", choices=MODES, required=True)
    create.add_argument("--binary", type=Path, help="path to the frozen CodeFacts executable")
    start = commands.add_parser("start", help="show the symptom and initial menu")
    source = commands.add_parser("read", help="show a source page from a displayed ID")
    source.add_argument("number", type=cli.positive_int)
    source.add_argument("start_line", type=cli.positive_int, nargs="?")
    followup = commands.add_parser("search", help="search one identifier from the first source page")
    followup.add_argument("term")
    answer = commands.add_parser("submit", help="record the diagnosis")
    body = answer.add_mutually_exclusive_group(required=True)
    body.add_argument("--answer")
    body.add_argument("--answer-file", type=Path)
    answer.add_argument("--usage-file", type=Path)
    replay = commands.add_parser("replay", help="emit the complete recorded evidence stream")
    status = commands.add_parser("status", help="show evidence usage and completion status")
    for command in (create, start, source, followup, answer, replay, status):
        command.add_argument("--session", type=Path, required=True)
    args = parser.parse_args()
    try:
        session = args.session.resolve()
        if args.command == "new":
            new(args, session)
        elif not (session / STATE).is_file():
            raise Unavailable("Choose an initialized session directory.")
        else:
            with locked(session):
                execute(args, session)
    except Unavailable as error:
        print(f"Unavailable. {error}", file=sys.stderr)
        return 2
    except (nav.Unavailable, OSError, RuntimeError, ValueError, KeyError, TypeError,
            subprocess.SubprocessError):
        print("Unavailable.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
