"""Choose and replay a deterministic route through a public CodeFacts session."""

import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time


PUBLIC = Path(__file__).resolve().parent.parent / "runtime"
PLAY = PUBLIC / "tools" / "play.py"
BYTE_LIMIT = 4200
SEARCH_CAP = 600
MODES = {"legacy-baseline", "legacy-cross-file", "expanded-symbol", "expanded-explore"}
DEFAULTS = {
    "mode": "legacy-baseline",
    "first_weights": {},
    "second_weights": {},
    "second_pool": "new-first",
    "first_offset": "default",
    "second_offset": "default",
    "followup": "off",
    "followup_weights": {},
}
ROW_FEATURES = {
    "implementation", "test", "example", "documentation", "match", "declaration",
    "call", "symptom", "novel", "initial", "link", "search", "focused",
}
TERM_FEATURES = {"call", "qualified", "declaration", "symptom", "frequency", "specificity"}

MENU_ROW = re.compile(r"\[([1-9]\d*)\] (.+):([1-9]\d*)-([1-9]\d*) \| (.+)")
PAGE_HEADER = re.compile(r"\[([1-9]\d*)\] (.+):([1-9]\d*)-([1-9]\d*)")
LINK_ROW = re.compile(r"\[([1-9]\d*)\] (.+)")
SOURCE_LINE = re.compile(r"[1-9]\d*:(?: (.*))?")
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
WORDS = re.compile(r"[A-Za-z0-9]+")
CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
DECLARATION = re.compile(
    r"\b(?:def|fn|func|function|class|struct|enum|trait|interface|const|let|type|var)"
    r"\s+\*?\s*([A-Za-z_][A-Za-z_0-9]*)"
)
CALL = re.compile(r"\b([A-Za-z_][A-Za-z_0-9]*)\s*\(")
QUALIFIED = re.compile(r"(?:\.|::)\s*([A-Za-z_][A-Za-z_0-9]*)\s*\(")
DECLARATION_KIND = {
    "function", "method", "class", "struct", "enum", "trait", "interface", "type_alias",
    "constant", "variable", "constructor", "field", "module", "macro",
}
TEST_PATH = {"test", "tests", "testing", "testdata", "fixture", "fixtures", "snapshot", "snapshots"}
EXAMPLE_PATH = {"bench", "benches", "benchmark", "benchmarks", "demo", "demos", "example", "examples"}
DOC_PATH = {"doc", "docs", "documentation"}
# The public search grammar excludes these exact identifier spellings.
KEYWORDS = set("""
    as async await break case catch class const continue default def defer do else enum except
    false fn for foreach from func function if impl import in interface is let match mod move
    mut new nil none null of package pass pub raise ref return self Self static struct super
    switch then throw trait true try type unsafe use var void where while with yield
""".split())
COMMON_WORDS = set("""
    about after all also always and any are back because been before both case does end even
    expect expected first following for from get got had has have how inside into just last
    left like line many may more most only option order out over report reports result return
    returned returns right same see should since some still than that the their them then there
    these they this those through two use used uses using value values want was way were what
    when where which while will with without work works would
""".split())


@dataclass(frozen=True)
class Row:
    number: int
    label: str
    path: str | None
    origin: str
    focus: str
    low: int | None = None
    high: int | None = None


@dataclass(frozen=True)
class Page:
    text: str
    path: str
    code: str
    links: tuple[Row, ...]


def load_policy(path):
    overrides = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(overrides, dict) or overrides.keys() - DEFAULTS.keys():
        raise ValueError("Expected a policy object with supported keys")
    policy = DEFAULTS | overrides
    choices = {
        "mode": MODES,
        "second_pool": {"new-first", "all", "initial-first"},
        "first_offset": {"default", "middle", "tail-context"},
        "second_offset": {"default", "middle", "tail-context"},
        "followup": {"off", "first", "ranked"},
    }
    for key, allowed in choices.items():
        if not isinstance(policy[key], str) or policy[key] not in allowed:
            raise ValueError(f"Invalid value for {key}")
    for key, allowed in (("first_weights", ROW_FEATURES), ("second_weights", ROW_FEATURES),
                         ("followup_weights", TERM_FEATURES)):
        weights = policy[key]
        if not isinstance(weights, dict) or weights.keys() - allowed:
            raise ValueError(f"Expected supported feature weights for {key}")
        if any(type(weight) is not int or not -20 <= weight <= 20 for weight in weights.values()):
            raise ValueError(f"Expected integer feature weights between -20 and 20 for {key}")
    return policy


def menu_rows(text, origin, focus):
    rows = []
    for line in text.split("\n"):
        if match := MENU_ROW.fullmatch(line):
            number, path, low, high, label = match.groups()
            rows.append(Row(int(number), label, path, origin, focus, int(low), int(high)))
    return rows


def read_page(text, number, query):
    lines = text.split("\n")
    header = PAGE_HEADER.fullmatch(lines[0])
    if not header or int(header[1]) != number:
        raise ValueError("Public read returned an unexpected source header")
    code = []
    end = 1
    while end < len(lines) and (match := SOURCE_LINE.fullmatch(lines[end])):
        code.append(match[1] or "")
        end += 1
    if not code:
        raise ValueError("Public read returned no numbered source")
    links = []
    for line in lines[end:]:
        if match := LINK_ROW.fullmatch(line):
            label, separator, path = match[2].partition(" @ ")
            links.append(Row(int(match[1]), label, path if separator else None, "link", query))
    return Page("\n".join(lines[:end]) + "\n", header[2], "\n".join(code), tuple(links))


def terms(text):
    """Case-fold visible words and their camel-case components."""
    words = WORDS.findall(text)
    parts = (part for word in words for part in CAMEL_BOUNDARY.split(word))
    return {word.casefold() for word in [*words, *parts] if len(word) >= 2}


def informative(text):
    return {word for word in terms(text) - COMMON_WORDS if not word.isdigit()}


def symbol_name(label):
    kind, _, display = label.partition(" ")
    if kind in DECLARATION_KIND:
        label = display
    head = label.split("(", 1)[0].split("<", 1)[0].strip()
    components = IDENTIFIER.findall(head)
    return components[-1] if components else ""


def path_kind(path, label):
    if not path:
        return ""
    relative = PurePosixPath(path.lower())
    folders = set(relative.parts[:-1])
    stem = relative.stem
    if (folders & TEST_PATH or stem in TEST_PATH or stem.startswith(("test_", "fixture_"))
            or stem.endswith(("_test", "_tests", ".test", ".spec", "_fixture"))):
        return "test"
    if folders & EXAMPLE_PATH or stem in EXAMPLE_PATH or stem.startswith("example_"):
        return "example"
    if folders & DOC_PATH or label.startswith("heading ") or relative.suffix in {".md", ".rst", ".adoc"}:
        return "documentation"
    if label.startswith("lexical ") and relative.suffix in {".json", ".toml", ".yaml", ".yml"}:
        return ""
    return "implementation" if not relative.name.endswith(".d.ts") else ""


def visible_calls(code):
    return set(CALL.findall(code)) - set(DECLARATION.findall(code)) - KEYWORDS


def read_offset(row, offset):
    if offset == "default" or row.low is None:
        return None
    if offset == "middle":
        start = (row.low + row.high) // 2
    else:
        start = max(row.low, row.high - 7)
    return start if start != row.low else None


def row_features(row, symptom_words, page, calls):
    name = symbol_name(row.label)
    match = 0
    if row.focus.casefold() == name.casefold():
        match = 2
    elif (terms(row.focus) & terms(row.label + " " + (row.path or ""))
          or row.focus.casefold() in row.label.casefold()):
        match = 1
    kind = path_kind(row.path or (page.path if page else None), row.label)
    return {
        "implementation": kind == "implementation",
        "test": kind == "test",
        "example": kind == "example",
        "documentation": kind == "documentation",
        "match": match,
        "declaration": row.label.split(" ", 1)[0] in DECLARATION_KIND,
        "call": name in calls,
        "symptom": min(4, len(symptom_words & informative(row.label + " " + (row.path or "")))),
        "novel": bool(page and row.path and row.path != page.path),
        "initial": row.origin == "initial",
        "link": row.origin == "link",
        "search": row.origin == "search",
        "focused": max(0, 4 - (row.high - row.low) // 8) if row.low is not None else 0,
    }


def rank_rows(rows, weights, symptom_words, page=None):
    if not any(weights.values()):
        return list(rows)
    calls = visible_calls(page.code) if page else set()

    def score(row):
        features = row_features(row, symptom_words, page, calls)
        return sum(weight * features[key] for key, weight in weights.items())

    return sorted(rows, key=score, reverse=True)


def followup_term(page, query, symptom_words, policy, remaining):
    candidates = Counter(IDENTIFIER.findall(page.code))
    eligible = [term for term in candidates if term not in KEYWORDS and term.casefold() != query.casefold()
                and len(term) <= 120 and len(f"Search: {term}\n") <= min(SEARCH_CAP, remaining)]
    if not eligible or policy["followup"] == "first":
        return next(iter(eligible), None)

    declarations = set(DECLARATION.findall(page.code))
    calls = visible_calls(page.code)
    qualified = set(QUALIFIED.findall(page.code))
    weights = policy["followup_weights"]

    def score(term):
        features = {
            "call": term in calls,
            "qualified": term in qualified,
            "declaration": term in declarations,
            "symptom": min(3, len(symptom_words & informative(term))),
            "frequency": min(4, candidates[term]),
            "specificity": min(5, len(term) // 4),
        }
        return sum(weight * features[key] for key, weight in weights.items())

    return max(eligible, key=score)


class Session:
    def __init__(self, directory):
        self.directory = directory
        self.evidence = bytearray()
        self.steps = []

    def run(self, action, *arguments):
        return subprocess.run(
            [sys.executable, str(PLAY), action, "--session", str(self.directory), *map(str, arguments)],
            capture_output=True, timeout=180,
        )

    def observe(self, action, *, row=None, start=None, term=None):
        step = {"action": action}
        arguments = ()
        if row is not None:
            arguments = (row.number,)
            step["id"] = row.number
            if start is not None:
                arguments += (start,)
                step["start_line"] = start
        if term is not None:
            arguments = (term,)
            step["term"] = term
        result = self.run(action, *arguments)
        if action == "read" and result.returncode == 2 and not result.stdout:
            self.steps.append(step | {"bytes": 0, "accepted": False})
            return None
        result.check_returncode()
        self.steps.append(step | {"bytes": len(result.stdout), "accepted": True})
        self.evidence.extend(result.stdout)
        return result.stdout.decode("utf-8")

    def first_available(self, rows, query, offset, previous=None):
        seen = set()
        for row in rows:
            if row.number in seen:
                continue
            seen.add(row.number)
            start = read_offset(row, offset)
            if (previous and row.number == previous[0].number
                    and (offset == "default" or row.low is None or start == previous[1])):
                continue
            if text := self.observe("read", row=row, start=start):
                return row, read_page(text, row.number, query), start
        return None

    def verify(self, pages):
        replay = self.run("replay")
        replay.check_returncode()
        status = self.run("status")
        status.check_returncode()
        summary = json.loads(status.stdout)
        digest = hashlib.sha256(self.evidence).hexdigest()
        byte_count = len(self.evidence)
        checks = {
            "bytes": byte_count,
            "remaining_bytes": BYTE_LIMIT - byte_count,
            "reads": len(pages),
            "followups": sum(step["action"] == "search" and step["accepted"] for step in self.steps),
            "stream_sha256": digest,
            "submitted": False,
        }
        if (replay.stdout != self.evidence or summary != checks or byte_count > BYTE_LIMIT
                or any(page.text.encode("utf-8") not in self.evidence for page in pages)):
            raise ValueError("Public status or replay disagrees with captured navigation evidence")
        return digest

    @property
    def remaining(self):
        return BYTE_LIMIT - len(self.evidence)


def second_rows(initial, additional, first, policy, symptom_words):
    def ranked(rows):
        return rank_rows(rows, policy["second_weights"], symptom_words, first)

    if policy["second_pool"] == "all":
        return ranked([*initial, *additional])
    if policy["second_pool"] == "initial-first":
        return [*ranked(initial), *ranked(additional)]
    return [*ranked(additional), *ranked(initial)]


def navigate(policy, case):
    spec = json.loads((case / "case.json").read_text(encoding="utf-8"))
    symptom, query = spec["symptom"], " ".join(spec["query"].split())
    symptom_words = informative(symptom)
    pages = []
    with tempfile.TemporaryDirectory(prefix="codefacts-batch-nav-") as directory:
        session = Session(directory)
        session.run("new", "--case", case, "--mode", policy["mode"]).check_returncode()
        started = time.monotonic()
        initial = menu_rows(session.observe("start"), "initial", query)
        first_rows = rank_rows(initial, policy["first_weights"], symptom_words)
        first = session.first_available(first_rows, query, policy["first_offset"])
        if first:
            row, page, start = first
            pages.append(page)
            additional = list(page.links)
            if policy["mode"].startswith("expanded-") and policy["followup"] != "off":
                term = followup_term(page, query, symptom_words, policy, session.remaining)
                if term is not None:
                    additional = menu_rows(session.observe("search", term=term), "search", term)
            if session.remaining > 0:
                rows = second_rows(initial, additional, page, policy, symptom_words)
                second = session.first_available(rows, query, policy["second_offset"], (row, start))
                if second:
                    pages.append(second[1])
        elapsed = time.monotonic() - started
        digest = session.verify(pages)
        return {
            "symptom": symptom,
            "query": query,
            "evidence": session.evidence.decode("utf-8"),
            "pages": [page.text for page in pages],
            "bytes": len(session.evidence),
            "elapsed_seconds": elapsed,
            "steps": session.steps,
            "stream_sha256": digest,
            "mode": policy["mode"],
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("policy", type=Path)
    parser.add_argument("case", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        result = navigate(load_policy(args.policy), args.case.resolve(strict=True))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.output.parent,
                                         prefix=".navigation-", delete=False) as handle:
            temporary = Path(handle.name)
            try:
                json.dump(result, handle, ensure_ascii=False, allow_nan=False, indent=2)
                handle.write("\n")
                handle.flush()
                temporary.replace(args.output)
            finally:
                temporary.unlink(missing_ok=True)
    except subprocess.CalledProcessError as error:
        parser.exit(2, f"Public navigation action failed. {error.stderr.decode('utf-8').strip()}\n")
    except (OSError, TypeError, KeyError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(2, f"Navigation failed. {error}\n")


if __name__ == "__main__":
    main()
