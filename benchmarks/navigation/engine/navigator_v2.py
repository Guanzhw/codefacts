"""Optional ranking of public navigation rows and source excerpts."""

from dataclasses import dataclass
import json
from pathlib import PurePosixPath
import re
import subprocess
import tempfile
import time

from navigation_versions import RESTRICTED_FOLLOWUPS
import navigation_features as extended
import navigator_v1 as legacy


CALL_FEATURES = {"body_call", "return_call", "forwarded_call", "boilerplate"}
NEW_ROW_FEATURES = CALL_FEATURES | {"enclosing_symptom", "source_overlap"} | extended.ROW_FEATURES
ROW_FEATURES = legacy.ROW_FEATURES | NEW_ROW_FEATURES
SOURCE_TERM_FEATURES = CALL_FEATURES | extended.TERM_FEATURES
TERM_FEATURES = legacy.TERM_FEATURES | SOURCE_TERM_FEATURES
LEGACY_OFFSETS = {"default", "middle", "tail-context"}
BODY_OFFSETS = {"body-start", "body-end"} | extended.OFFSETS
ENCLOSING_KINDS = {"class", "struct", "enum", "trait", "interface", "module"}
QUALIFIER = re.compile(r"(?:::|[.#/])")
PATH_SUFFIX = re.compile(r"([a-z]{3,})(?:utils|helpers|types)$")
CODE_NOISE = re.compile(
    r'/\*.*?(?:\*/|\Z)|//[^\n]*|\#[^\n]*'
    r'|""".*?(?:"""|\Z)|\'\'\'.*?(?:\'\'\'|\Z)'
    r'|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|\x60(?:\\.|[^\x60\\])*\x60',
    re.DOTALL,
)
IMPORT = re.compile(
    r"^[ \t]*(?:from[ \t]+[.\w]+[ \t]+import\b|(?:pub[ \t]+)?use\s+"
    r"|import\b(?![ \t]*\()|export[ \t]+(?=[{*]))[^\n;]*"
    r"|^[ \t]*(?:const|let|var)[ \t]+[^\n=]+=[ \t]*require[ \t]*\([^\n]*",
    re.MULTILINE,
)
BODY_CALL = re.compile(r"\b([A-Za-z_][A-Za-z_0-9]*)\s*(?:(?:::)?<[^<>{}\n]+>\s*)?\(")
DECLARATION_PREFIX = re.compile(r"\b(?:def|fn|func|function|class|struct|enum|trait|interface)\s*\*?\s*$")
MEMBER_PREFIX = re.compile(r"(?:[ \t]*(?:async|static|public|private|protected|get|set|override)\b)*[ \t]*")
RETURN_PREFIX = re.compile(
    r"(?:\breturn|=>)\s*(?:await\s+)?(?:\(\s*)*"
    r"(?:[A-Za-z_][A-Za-z_0-9]*\s*(?:\?\.|\.|::|->)\s*)*$"
)
PASSED_PARAMETER = re.compile(
    r"\s*(?:\.\.\.|\*\*?|&\s*(?:mut\s+)?)?([A-Za-z_][A-Za-z_0-9]*)"
    r"(?:\s*(?:\.|::|->)\s*[A-Za-z_][A-Za-z_0-9]*)*\s*"
)
LIMIT_ASSIGNMENT = re.compile(r"(?<![<>=!])[:=](?![:=>])")
SOURCE_NUMBER = re.compile(r"([1-9]\d*):(?: .*|$)")
DELIMITERS = {"(": ")", "[": "]", "{": "}"}
CLOSING = frozenset(DELIMITERS.values())
QUOTED_KEY = re.compile(r"(?P<quote>['\"])(?P<name>[A-Za-z_][A-Za-z_0-9]*)(?P=quote)")
KEY_SEPARATOR = re.compile(r"\s*:(?!:)")
GENERIC_DECLARATION = re.compile(
    r"\b(?:def|fn|func|function|class|struct|enum|trait|interface)"
    r"\s+\*?\s*[A-Za-z_][A-Za-z_0-9]*\s*<[^>{}\n]*$"
)


def load_policy(path):
    overrides = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(overrides, dict) or overrides.keys() - (legacy.DEFAULTS.keys() | {"second_strategy"}):
        raise ValueError("Expected a policy object with supported keys")
    if "second_strategy" in overrides and overrides["second_strategy"] != extended.CONSTRUCTOR_CONTEXT:
        raise ValueError("Invalid value for second_strategy")
    policy = legacy.DEFAULTS | overrides
    choices = {
        "mode": legacy.MODES,
        "second_pool": {"new-first", "all", "initial-first"},
        "first_offset": LEGACY_OFFSETS | BODY_OFFSETS,
        "second_offset": LEGACY_OFFSETS | BODY_OFFSETS | {"unseen"},
        "followup": {"off", "first", "ranked"} | RESTRICTED_FOLLOWUPS,
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


def blank(match):
    return re.sub(r"[^\n]", " ", match[0])


def arguments(code, start):
    """Return comma-separated arguments at the call's outer parenthesis depth."""
    stack = []
    parts = []
    first = start
    for idx in range(start, len(code)):
        char = code[idx]
        if char in DELIMITERS:
            stack.append(DELIMITERS[char])
        elif char == ")" and not stack:
            return parts + [code[first:idx]], idx + 1
        elif stack and char == stack[-1]:
            stack.pop()
        elif char == "," and not stack:
            parts.append(code[first:idx])
            first = idx + 1
    return parts, None


def visible_parameters(parts):
    parameters = set()
    for part in parts:
        declaration = LIMIT_ASSIGNMENT.split(part, 1)[0]
        names = legacy.IDENTIFIER.findall(declaration)
        if names:
            parameters.add(names[-1])
    return parameters


@dataclass(frozen=True)
class Calls:
    body: set
    returning: set
    forwarded: set
    boilerplate: set
    sites: tuple

    def features(self, name):
        return {
            "body_call": name in self.body,
            "return_call": name in self.returning,
            "forwarded_call": name in self.forwarded,
            "boilerplate": name in self.boilerplate,
        }


def clean_source(code):
    return IMPORT.sub(blank, CODE_NOISE.sub(blank, code))


def source_calls(code):
    clean = clean_source(code)
    body, returning, forwarded, declarations = set(), set(), set(), set()
    parameters = set()
    sites = []
    for call in BODY_CALL.finditer(clean):
        name = call[1]
        if name in legacy.KEYWORDS:
            continue
        prefix = clean[clean.rfind("\n", 0, call.start()) + 1:call.start()]
        parts, end = arguments(clean, call.end())
        if (DECLARATION_PREFIX.search(prefix)
                or (end is not None and MEMBER_PREFIX.fullmatch(prefix)
                    and re.match(r"[^\S\n]*\{", clean[end:]))):
            declarations.add(name)
            parameters = visible_parameters(parts)
            continue
        body.add(name)
        sites.append((name, call.start(), call.end()))
        # Only this direct call receives the return signal, even when its arguments contain calls.
        if RETURN_PREFIX.search(prefix) or (not prefix.strip() and RETURN_PREFIX.search(clean[:call.start()].rstrip())):
            returning.add(name)
        if parameters and any(
            (passed := PASSED_PARAMETER.fullmatch(part.split("=", 1)[-1]))
            and passed[1] in parameters for part in parts
        ):
            forwarded.add(name)

    noncode = set(legacy.IDENTIFIER.findall(code)) - set(legacy.IDENTIFIER.findall(clean))
    return Calls(body, returning, forwarded, (noncode | declarations) - body, tuple(sites))


def balanced_argument_end(code, start):
    expected = [")"]
    for index in range(start, len(code)):
        char = code[index]
        if char in DELIMITERS:
            expected.append(DELIMITERS[char])
        elif char in CLOSING:
            if char != expected.pop():
                return None
            if not expected:
                return index
        elif char in "'\"`":
            return None
    return None


def argument_tokens(clean, noise):
    for match in legacy.IDENTIFIER.finditer(clean):
        yield match.start(), match[0]
    for token in noise:
        quoted = QUOTED_KEY.fullmatch(token[0])
        if (quoted and clean[:token.start()].rstrip().endswith(("{", ","))
                and KEY_SEPARATOR.match(clean, token.end())):
            yield token.start(), quoted["name"]


def argument_matches(code, sites, symptom):
    symptom_names = {name.casefold() for name in legacy.IDENTIFIER.findall(symptom)
                     if name.casefold() not in legacy.KEYWORDS and legacy.informative(name)}
    if not sites or not symptom_names:
        return {}
    noise = tuple(CODE_NOISE.finditer(code))
    clean = IMPORT.sub(blank, CODE_NOISE.sub(blank, code))
    spans = []
    for name, head, start in sites:
        prefix = clean[clean.rfind("\n", 0, head) + 1:head]
        if GENERIC_DECLARATION.search(prefix):
            continue
        if (end := balanced_argument_end(clean, start)) is not None:
            spans.append((name, start, end))
    hits = {start: set() for _, start, _ in spans}
    for position, token in argument_tokens(clean, noise):
        name = token.casefold()
        if name not in symptom_names or any(head <= position < start for _, head, start in sites):
            continue
        # Nested calls own their own arguments. Sibling calls cannot share a match.
        containing = [start for _, start, end in spans if start <= position < end]
        if containing:
            hits[max(containing)].add(name)
    scores = {}
    for name, start, _ in spans:
        scores[name] = max(scores.get(name, 0), len(hits[start]))
    return scores


class PageContext:
    def __init__(self, page, flow=False, clipped=False):
        self.page = page
        self.lines = {
            int(match[1]) for line in page.text.splitlines()
            if (match := SOURCE_NUMBER.fullmatch(line))
        }
        self.calls = source_calls(page.code)
        self.flow = frozenset()
        if flow:
            code = extended.omit_partial_docstring(page.code) if clipped and page.path.endswith(".py") else page.code
            sites = self.calls.sites if code == page.code else source_calls(code).sites
            self.flow = extended.value_flow(clean_source(code), sites, arguments)

    def overlaps_file(self, row):
        return row.path == self.page.path

    def slots_seen(self, row):
        return sum(row.low <= line <= row.high for line in self.lines)


def range_start(row, offset, context=None):
    if offset in LEGACY_OFFSETS:
        return True, legacy.read_offset(row, offset)
    if row.low is None:
        return True, None
    span = row.high - row.low + 1
    if offset == "body-start":
        start = row.low + (min(8, span // 8) if span >= 12 else 0)
    elif offset == "body-end":
        start = max(row.low, row.high - 15)
    elif offset == "middle-if-wide":
        start = (row.low + row.high) // 2 if span > 24 else row.low
    else:
        start = row.low
        if context.overlaps_file(row):
            while start in context.lines:
                start += 1
        if start > row.high:
            return False, None
    return True, start if start != row.low else None


def first_available(session, rows, query, offset, previous=None, context=None):
    if offset in LEGACY_OFFSETS:
        return session.first_available(rows, query, offset, previous)
    seen = set()
    for row in rows:
        if row.number in seen:
            continue
        seen.add(row.number)
        allowed, start = range_start(row, offset, context)
        if not allowed or (previous and row.number == previous[0].number and start == previous[1]):
            continue
        if page := session.observe("read", row=row, start=start):
            return row, legacy.read_page(page, row.number, query), start
    return None


def qualified_components(label):
    kind, _, display = label.partition(" ")
    if kind not in legacy.DECLARATION_KIND:
        return []
    return QUALIFIER.split(display.split("(", 1)[0].split("<", 1)[0])[:-1]


def enclosing_words(row, path, enclosures):
    components = qualified_components(row.label)
    if path:
        location = PurePosixPath(path)
        components.extend([*location.parts[:-1], location.stem])
        if suffix := PATH_SUFFIX.fullmatch(location.stem):
            components.append(suffix[1])
    if row.low is not None:
        components.extend(
            legacy.symbol_name(other.label)
            for other in enclosures.get(row.path, ())
            if other.number != row.number and other.low <= row.low and row.high <= other.high
            and (other.low < row.low or row.high < other.high)
        )
    return legacy.informative(" ".join(components))


def rank_rows(rows, weights, symptom_words, context=None, enclosures=None, owners=()):
    if not any(weight for feature, weight in weights.items() if feature in NEW_ROW_FEATURES):
        old_weights = {feature: weight for feature, weight in weights.items() if feature in legacy.ROW_FEATURES}
        return legacy.rank_rows(rows, old_weights, symptom_words, context.page if context else None)
    page = context.page if context else None
    calls = legacy.visible_calls(page.code) if page else set()
    use_extension = any(weights.get(feature) for feature in extended.ROW_FEATURES)

    def score(row):
        features = legacy.row_features(row, symptom_words, page, calls)
        name = legacy.symbol_name(row.label)
        features.update(context.calls.features(name) if context else dict.fromkeys(CALL_FEATURES, 0))
        if row.label.split(" ", 1)[0] in {"import", "export"} or (row.path or "").endswith(".d.ts"):
            features["boilerplate"] = 1
        path = row.path or (page.path if page else None)
        features["enclosing_symptom"] = min(4, len(symptom_words & enclosing_words(row, path, enclosures)))
        overlap = context.slots_seen(row) if context and row.low is not None and context.overlaps_file(row) else 0
        features["source_overlap"] = (4 * overlap + row.high - row.low) // (row.high - row.low + 1) if overlap else 0
        if use_extension:
            features.update(extended.row_features(row, page.path if page else None, owners,
                                                  context.flow if context else (), qualified_components(row.label)))
        return sum(weight * features[key] for key, weight in weights.items() if weight)

    return sorted(rows, key=score, reverse=True)


def followup_term(context, query, symptom_words, policy, remaining, *, symptom=""):
    weights = policy["followup_weights"]
    mode = policy["followup"]
    allowed_calls = None
    if mode in {"body-call", "argument-match"}:
        allowed_calls = context.calls.body
    elif mode == "returned-or-forwarded":
        allowed_calls = context.calls.returning | context.calls.forwarded
    if allowed_calls is None and (mode == "first" or not any(weights.get(name) for name in SOURCE_TERM_FEATURES)):
        return legacy.followup_term(context.page, query, symptom_words, policy | {
            "followup_weights": {key: weight for key, weight in weights.items() if key in legacy.TERM_FEATURES},
        }, remaining)

    candidates = legacy.Counter(legacy.IDENTIFIER.findall(context.page.code))
    eligible = [
        term for term in candidates if (allowed_calls is None or term in allowed_calls)
        and term not in legacy.KEYWORDS and term.casefold() != query.casefold()
        and len(term) <= 120 and len(f"Search: {term}\n") <= min(legacy.SEARCH_CAP, remaining)
    ]
    if not eligible:
        return None
    declarations = set(legacy.DECLARATION.findall(context.page.code))
    calls = legacy.visible_calls(context.page.code)
    qualified = set(legacy.QUALIFIED.findall(context.page.code))

    def score(term):
        features = {
            "call": term in calls,
            "qualified": term in qualified,
            "declaration": term in declarations,
            "symptom": min(3, len(symptom_words & legacy.informative(term))),
            "frequency": min(4, candidates[term]),
            "specificity": min(5, len(term) // 4),
        }
        features.update(context.calls.features(term))
        features["value_flow"] = term in context.flow
        return sum(weight * features[key] for key, weight in weights.items())

    if mode == "argument-match":
        matches = argument_matches(context.page.code, context.calls.sites, symptom)
        return max(eligible, key=lambda term: (matches.get(term, 0), score(term)))
    return max(eligible, key=score)


def displayed_enclosures(rows):
    enclosures = {}
    for row in rows:
        if row.low is not None and row.label.split(" ", 1)[0] in ENCLOSING_KINDS:
            enclosures.setdefault(row.path, []).append(row)
    return enclosures


def second_rows(initial, additional, context, policy, symptom_words, owners=()):
    enclosures = displayed_enclosures([*initial, *additional])

    def ranked(rows):
        return rank_rows(rows, policy["second_weights"], symptom_words, context, enclosures, owners)

    if policy["second_pool"] == "all":
        return ranked([*initial, *additional])
    if policy["second_pool"] == "initial-first":
        return [*ranked(initial), *ranked(additional)]
    return [*ranked(additional), *ranked(initial)]


class Session(legacy.Session):
    def observe(self, action, *, row=None, start=None, term=None):
        try:
            return super().observe(action, row=row, start=start, term=term)
        except subprocess.CalledProcessError as error:
            if (
                action != "search" or error.returncode != 2 or error.stdout
                or not error.stderr.startswith(b"Unavailable.")
            ):
                raise
            self.steps.append({"action": action, "term": term, "bytes": 0, "accepted": False})
            return None


def navigate(policy, case):
    new_offset = any(policy[field] not in LEGACY_OFFSETS for field in ("first_offset", "second_offset"))
    weights = {"first_weights": legacy.ROW_FEATURES, "second_weights": legacy.ROW_FEATURES,
               "followup_weights": legacy.TERM_FEATURES}
    new_weight = any(weight and key not in allowed for field, allowed in weights.items()
                     for key, weight in policy[field].items())
    may_search = policy["mode"].startswith("expanded-") and policy["followup"] != "off"
    constructor_context = policy.get("second_strategy") == extended.CONSTRUCTOR_CONTEXT
    if not new_offset and not new_weight and not may_search and not constructor_context:
        legacy_weights = {
            field: {key: weight for key, weight in policy[field].items() if key in allowed}
            for field, allowed in weights.items()
        }
        return legacy.navigate(policy | legacy_weights, case)

    spec = json.loads((case / "case.json").read_text(encoding="utf-8"))
    symptom, query = spec["symptom"], " ".join(spec["query"].split())
    symptom_words = legacy.informative(symptom)
    owners = extended.owner_mentions(symptom) if any(
        policy[field].get("named_owner") for field in ("first_weights", "second_weights")
    ) else ()
    flow = any(policy[field].get("value_flow") for field in ("second_weights", "followup_weights"))
    pages = []
    with tempfile.TemporaryDirectory(prefix="codefacts-batch-nav-") as directory:
        session = Session(directory)
        session.run("new", "--case", case, "--mode", policy["mode"]).check_returncode()
        started = time.monotonic()
        initial = legacy.menu_rows(session.observe("start"), "initial", query)
        first_rows = rank_rows(initial, policy["first_weights"], symptom_words,
                               enclosures=displayed_enclosures(initial), owners=owners)
        first = first_available(session, first_rows, query, policy["first_offset"])
        if first:
            row, page, start = first
            pages.append(page)
            companion = None
            if constructor_context and session.remaining > 0:
                candidate = extended.constructor_caller(initial, row, page, symptom_words, clean_source)
                if candidate:
                    _, offset = range_start(candidate, "middle-if-wide")
                    if text := session.observe("read", row=candidate, start=offset):
                        companion = legacy.read_page(text, candidate.number, query)
            if companion is None:
                context = PageContext(page, flow=flow, clipped=start is not None)
                additional = list(page.links)
                if may_search:
                    term = followup_term(context, query, symptom_words, policy, session.remaining, symptom=symptom)
                    if term is not None:
                        menu = session.observe("search", term=term)
                        additional = legacy.menu_rows(menu, "search", term) if menu is not None else []
                if session.remaining > 0:
                    rows = second_rows(initial, additional, context, policy, symptom_words, owners)
                    second = first_available(session, rows, query, policy["second_offset"], (row, start), context)
                    if second:
                        companion = second[1]
            if companion is not None:
                pages.append(companion)
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
