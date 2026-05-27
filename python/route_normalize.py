"""HTTP route normalization for API matching (v5)."""
from __future__ import annotations

import re

_PARAM_RE = re.compile(r"\$\{[^}]+\}")
_BRACE_PARAM_RE = re.compile(r"\{[^}]+\}")


def normalize_path(path: str) -> str:
    """Normalize URL path segments for matching."""
    p = (path or "").strip()
    if not p:
        return "/"
    if not p.startswith("/"):
        p = "/" + p
    p = _PARAM_RE.sub("{param}", p)
    p = _BRACE_PARAM_RE.sub("{param}", p)
    p = re.sub(r"/+", "/", p)
    return p.rstrip("/").lower() or "/"


def expand_controller_token(route: str, controller_name: str) -> str:
    """Expand [controller] placeholder from class name (ContractsController -> contracts)."""
    base = (controller_name or "").replace("Controller", "")
    token = base[:1].lower() + base[1:] if base else "controller"
    return route.replace("[controller]", token).replace("{controller}", token)


def expand_action_token(route: str, action_name: str) -> str:
    return route.replace("[action]", action_name).replace("{action}", action_name)


def route_key(method: str, path: str) -> str:
    return f"{(method or 'GET').upper()} {normalize_path(path)}"


def segment_match_score(frontend: str, backend: str) -> float:
    """Score 0..1 by static segment overlap."""
    fa = [s for s in normalize_path(frontend).split("/") if s]
    ba = [s for s in normalize_path(backend).split("/") if s]
    if not fa or not ba:
        return 0.0
    if len(fa) != len(ba):
        # allow one extra segment with penalty
        if abs(len(fa) - len(ba)) > 1:
            return 0.0
    score = 0.0
    matched = 0
    for i in range(min(len(fa), len(ba))):
        if fa[i] == ba[i]:
            matched += 1
            score += 1.0
        elif fa[i] == "{param}" or ba[i] == "{param}":
            matched += 1
            score += 0.85
        else:
            return 0.0
    return score / max(len(fa), len(ba), 1)
