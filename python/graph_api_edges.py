"""Detect frontend ↔ backend API edges (best-effort)."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from common import merge_exclude_folders, rel_path

FETCH_RE = re.compile(
    r"""(?:fetch|axios\.(?:get|post|put|delete|patch))\s*\(\s*['"](/api/[^'"]+)['"]""",
    re.I,
)
ROUTE_RE = re.compile(
    r"""\[(?:HttpGet|HttpPost|HttpPut|HttpDelete)(?:\("([^"]*)"\))?\]""",
    re.I,
)
CONTROLLER_RE = re.compile(r"\bclass\s+(\w+Controller)\b")


def find_api_edges(repo: Path, config: dict[str, Any]) -> list[dict[str, str]]:
    repo = repo.resolve()
    exclude = merge_exclude_folders(config.get("excludeFolders"))
    patterns = config.get("analysisApiEdgePatterns") or ["fetch", "axios"]
    edges: list[dict[str, str]] = []

    controllers: list[tuple[str, str, str]] = []
    for cs in repo.rglob("*.cs"):
        if any(part in str(cs) for part in ("\\bin\\", "/bin/", "\\obj\\", "/obj/")):
            continue
        try:
            text = cs.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = CONTROLLER_RE.search(text)
        if not m:
            continue
        rel = rel_path(cs, repo)
        for rm in ROUTE_RE.finditer(text):
            route = rm.group(1) or ""
            controllers.append((rel, m.group(1), route))

    for ts in repo.rglob("*.ts*"):
        if ts.suffix.lower() not in (".ts", ".tsx"):
            continue
        skip = False
        for exc in exclude:
            if exc.lower() in str(ts).lower():
                skip = True
                break
        if skip:
            continue
        try:
            text = ts.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel_ts = rel_path(ts, repo)
        for fm in FETCH_RE.finditer(text):
            api_path = fm.group(1)
            target = _match_controller(api_path, controllers)
            edges.append({
                "from": rel_ts,
                "to": target or "?",
                "api": api_path,
            })
        if len(edges) >= 100:
            break

    return edges


def _match_controller(api_path: str, controllers: list[tuple[str, str, str]]) -> str | None:
    api_lower = api_path.lower()
    for rel, cls, route in controllers:
        if route and route.lower() in api_lower:
            return rel
        name = cls.replace("Controller", "").lower()
        if name and name in api_lower:
            return rel
    return None
