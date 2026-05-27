"""ASP.NET controller/action route index (v5) — Roslyn primary, regex fallback."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from common import harvester_root, iter_repo_files, merge_exclude_folders, rel_path
from route_normalize import expand_action_token, expand_controller_token, normalize_path, route_key

_CLASS_ROUTE = re.compile(r'\[Route\s*\(\s*"([^"]*)"\s*\)\]', re.I)
_API_CONTROLLER = re.compile(r"\[ApiController\]", re.I)
_CONTROLLER_CLASS = re.compile(r"\bclass\s+(\w+Controller)\b")
_HTTP_ATTR = re.compile(
    r"\[(Http(Get|Post|Put|Delete|Patch))(?:\s*\(\s*\"([^\"]*)\"\s*\))?\]",
    re.I,
)
_METHOD_NAME = re.compile(
    r"\b(?:public|private|protected|internal)\s+[\w<>,\s\[\]]+\s+(\w+)\s*\(",
)


def _line_number(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _regex_endpoints(repo: Path, exclude: list[str]) -> list[dict[str, Any]]:
    endpoints: list[dict[str, Any]] = []
    for path in repo.rglob("*.cs"):
        rel = rel_path(path, repo)
        if any(x in rel.replace("/", "\\").lower() for x in ("\\bin\\", "\\obj\\", "/bin/", "/obj/")):
            continue
        if any(exc.lower() in rel.lower() for exc in exclude):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        cm = _CONTROLLER_CLASS.search(text)
        if not cm:
            continue
        controller = cm.group(1)
        class_route = ""
        cr = _CLASS_ROUTE.search(text)
        if cr:
            class_route = cr.group(1).strip()
        elif _API_CONTROLLER.search(text):
            class_route = "api/[controller]"
        class_route = expand_controller_token(class_route, controller)
        class_route_norm = normalize_path(class_route)

        for hm in _HTTP_ATTR.finditer(text):
            verb = hm.group(2).upper()
            action_route = (hm.group(3) or "").strip()
            tail = text[hm.end() : hm.end() + 400]
            mm = _METHOD_NAME.search(tail)
            action_name = mm.group(1) if mm else ""
            full = class_route_norm
            if action_route:
                sub = normalize_path(action_route)
                full = normalize_path(f"{class_route_norm}/{sub}") if not sub.startswith("/") else sub
            full = expand_action_token(full, action_name)
            endpoints.append(
                {
                    "id": f"endpoint:{rel}:{action_name}:{verb}:{full}",
                    "controller": controller,
                    "action": action_name,
                    "method": verb,
                    "route": full,
                    "routeKey": route_key(verb, full),
                    "file": rel,
                    "line": _line_number(text, hm.start()),
                    "qualifiedName": f"{controller}.{action_name}",
                    "origin": "regex",
                }
            )
    return endpoints


def build_backend_route_index(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    exclude = merge_exclude_folders(config.get("excludeFolders"))
    endpoints: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    if config.get("useRoslyn", True):
        from roslyn_bridge import roslyn_backend_endpoints, run_roslyn_scan

        scan = run_roslyn_scan(repo)
        if scan:
            for ep in roslyn_backend_endpoints(scan, repo):
                key = ep.get("routeKey") or ""
                if key and key not in seen_keys:
                    seen_keys.add(key)
                    endpoints.append(ep)

    for ep in _regex_endpoints(repo, exclude):
        key = ep.get("routeKey") or ""
        if key in seen_keys:
            continue
        seen_keys.add(key)
        endpoints.append(ep)

    index = {
        "version": "5.0",
        "endpoints": endpoints,
        "count": len(endpoints),
        "sources": {"roslyn": sum(1 for e in endpoints if e.get("origin") == "roslyn"), "regex": sum(1 for e in endpoints if e.get("origin") == "regex")},
    }
    out = harvester_root(repo) / "backend_route_index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    return index
