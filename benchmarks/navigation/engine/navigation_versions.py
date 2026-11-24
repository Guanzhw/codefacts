"""Select the public navigator generation required by a policy tree."""

from navigation_features import CONSTRUCTOR_CONTEXT, OFFSETS, ROW_FEATURES, TERM_FEATURES


FOLLOWUP_ENGINES = {"body-call": 3, "returned-or-forwarded": 3, "argument-match": 4}
RESTRICTED_FOLLOWUPS = frozenset(FOLLOWUP_ENGINES)
ENGINES = (2, 3, 4, 5, 6)


def uses_extended_navigation(config):
    offsets = (config.get(key) for key in ("first_offset", "second_offset"))
    if any(isinstance(offset, str) and offset in OFFSETS for offset in offsets):
        return True
    for key, features in (("first_weights", ROW_FEATURES - {"module_affinity", "value_flow"}),
                          ("second_weights", ROW_FEATURES), ("followup_weights", TERM_FEATURES)):
        weights = config.get(key)
        if isinstance(weights, dict) and any(weights.get(feature) for feature in features):
            return True
    return False


def policy_engine(config):
    if not isinstance(config, dict):
        return 2
    if "gate" in config:
        return max(policy_engine(config.get(branch)) for branch in ("then", "otherwise"))
    if config.get("second_strategy") == CONSTRUCTOR_CONTEXT:
        return 6
    if uses_extended_navigation(config):
        return 5
    mode = config.get("followup")
    return FOLLOWUP_ENGINES.get(mode, 2) if isinstance(mode, str) else 2
