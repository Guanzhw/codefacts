"""Opt-in navigation features calculated from public menus and the first excerpt."""

from pathlib import PurePosixPath
import re

import navigator_v1 as legacy


CALLABLE_KINDS = frozenset({"function", "method", "constructor", "macro"})
ROW_FEATURES = frozenset({"callable_definition", "query_suffix", "module_affinity", "named_owner", "value_flow"})
TERM_FEATURES = frozenset({"value_flow"})
OFFSETS = frozenset({"middle-if-wide"})
CONSTRUCTOR_CONTEXT = "constructor-context"
CONSTRUCTORS = frozenset({"__init__", "__new__", "constructor"})
FIELD_WRITE = re.compile(r"\b(?:self|this)\.[A-Za-z_]\w*\s*=(?!=)")
RECEIVER = r"(?:[A-Za-z_]\w*\s*(?:\?\.|\.|::|->)\s*)*"
ASSIGNMENT = re.compile(
    r"\s*(?:(?:const|let|var|mut)\s+)?(?P<name>[A-Za-z_]\w*)"
    r"(?:\s*:[^=]+)?\s*=(?!=)\s*(?:await\s+)?" + RECEIVER,
)
REASSIGNMENT = re.compile(r"^\s*(?:(?:const|let|var|mut)\s+)?([A-Za-z_]\w*)\s*=(?!=)", re.MULTILINE)
NAMED_ARGUMENT = re.compile(r"^\s*[A-Za-z_]\w*\s*=(?!=)")


def components(name):
    return tuple(piece.casefold() for word in legacy.WORDS.findall(name)
                 for piece in legacy.CAMEL_BOUNDARY.split(word))


def suffix_match(query, name):
    wanted, candidate = components(query), components(name)
    return bool(wanted) and candidate[-len(wanted):] == wanted


def module_affinity(path, anchor):
    if not path or not anchor:
        return 0
    left, right = PurePosixPath(path), PurePosixPath(anchor)
    depth = 0
    for left_part, right_part in zip(left.parts[:-1], right.parts[:-1]):
        if left_part != right_part:
            break
        depth += 1
    return min(depth, 3) + (left == right)


def word_forms(word):
    forms = {word}
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        forms.add(word[:-1])
    for suffix in ("ing", "ed"):
        if len(word) >= len(suffix) + 3 and word.endswith(suffix):
            base = word[:-len(suffix)]
            forms.update((base, base + "e"))
    return forms


def constructor_caller(rows, anchor, page, symptom_words, clean_source):
    """Choose an unambiguous cross-file callable to inspect for construction context."""
    kind = anchor.label.partition(" ")[0]
    if kind != "constructor" and legacy.symbol_name(anchor.label) not in CONSTRUCTORS:
        return None
    if not FIELD_WRITE.search(clean_source(page.code)):
        return None

    symptom_forms = {form for word in symptom_words for form in word_forms(word)}
    choices = []
    for row in rows:
        if (not row.path or row.path == page.path or row.low is None or row.high - row.low + 1 < 16
                or legacy.path_kind(row.path, row.label) != "implementation"
                or row.label.partition(" ")[0] not in CALLABLE_KINDS):
            continue
        name_words = legacy.informative(" ".join(components(legacy.symbol_name(row.label))))
        affinity = module_affinity(row.path, page.path)
        overlap = sum(bool(word_forms(word) & symptom_forms) for word in name_words)
        if affinity and overlap and len(name_words) >= 2:
            choices.append(((overlap, affinity), row))
    if not choices:
        return None
    best = max(score for score, _ in choices)
    candidates = {(row.path, row.low, row.high): row for score, row in choices if score == best}
    return next(iter(candidates.values())) if len(candidates) == 1 else None


def owner_mentions(symptom):
    return {name.casefold() for name in legacy.IDENTIFIER.findall(symptom)
            if legacy.CAMEL_BOUNDARY.search(name)}


def named_owner(row, owners, qualifiers):
    visible_owners = list(qualifiers)
    if row.path:
        visible_owners.append(PurePosixPath(row.path).stem)
    return any(owner.casefold() in owners for owner in visible_owners)


def omit_partial_docstring(code):
    """Preserve numbering when a clipped Python excerpt starts inside a docstring."""
    markers = list(re.finditer(r'''(?<!\\)(?:"""|\'\'\')''', code))
    if not markers or len(markers) % 2 == 0:
        return code
    first = markers[0]
    start = code.rfind("\n", 0, first.start()) + 1
    stop = code.find("\n", first.end())
    if stop == -1 or code[start:stop].strip() != first[0]:
        return code
    return re.sub(r"[^\n]", " ", code[:stop]) + code[stop:]


def value_flow(clean, sites, arguments):
    """Find calls whose assigned output appears in a later call's arguments."""
    definitions = {}
    consumed = set()
    processed = 0
    for name, head, start in sites:
        line_start = clean.rfind("\n", 0, head) + 1
        if line_start > processed:
            for overwrite in REASSIGNMENT.finditer(clean, processed, line_start):
                definitions.pop(overwrite[1], None)
            processed = line_start
        parts, end = arguments(clean, start)
        if end is None:
            continue
        for part in parts:
            for symbol in legacy.IDENTIFIER.findall(NAMED_ARGUMENT.sub("", part)):
                if symbol in definitions:
                    callee, definition_end = definitions[symbol]
                    if head >= definition_end:
                        consumed.add(callee)
        if assignment := ASSIGNMENT.fullmatch(clean[line_start:head]):
            definitions[assignment["name"]] = name, end
            processed = max(processed, end)
    return consumed


def row_features(row, anchor_path, owners, flow, qualifiers):
    name = legacy.symbol_name(row.label)
    kind = row.label.partition(" ")[0]
    path = row.path or anchor_path
    return {
        "callable_definition": kind in CALLABLE_KINDS and legacy.path_kind(path, row.label) == "implementation",
        "query_suffix": kind in legacy.DECLARATION_KIND and suffix_match(row.focus, name),
        "module_affinity": module_affinity(path, anchor_path),
        "named_owner": named_owner(row, owners, qualifiers),
        "value_flow": name in flow,
    }
