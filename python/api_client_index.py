"""Frontend API client index (v5) — fetch/axios/template strings."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from common import harvester_root, iter_repo_files, merge_exclude_folders, rel_path
from route_normalize import normalize_path, route_key

_EXPORT_FN = re.compile(r"\bexport\s+(?:async\s+)?function\s+(\w+)", re.I)
_EXPORT_CONST = re.compile(r"\bexport\s+const\s+(\w+)\s*=", re.I)
_FETCH = re.compile(
    r"""(?:fetch|axios\.(get|post|put|delete|patch))\s*\(\s*[`'"]([^`'"]+)[`'"]""",
    re.I,
)
_TEMPLATE_FETCH = re.compile(
    r"""fetch\s*\(\s*`([^`]+)`""",
    re.I,
)
_API_FILE_HINT = re.compile(r"(api|service|client)", re.I)


def _line_number(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _guess_verb(match: re.Match[str], text: str) -> str:
    g1 = match.group(1)
    if g1:
        return g1.upper()
    before = text[max(0, match.start() - 80) : match.start()].lower()
    for v in ("post", "put", "delete", "patch", "get"):
        if v in before:
            return v.upper()
    return "GET"


def _extract_url(raw: str) -> str:
    u = raw.strip()
    if u.startswith("http"):
        idx = u.find("/", 8)
        u = u[idx:] if idx > 0 else u
    return normalize_path(u)


def build_api_client_index(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    exclude = merge_exclude_folders(config.get("excludeFolders"))
    include_ext = config.get("includeExtensions", [".ts", ".tsx"])
    clients: list[dict[str, Any]] = []

    for path in iter_repo_files(repo, exclude, include_ext, config.get("excludeExtensions", []), code_only=True):
        rel = rel_path(path, repo)
        if not _API_FILE_HINT.search(rel):
            continue
        if path.suffix.lower() not in (".ts", ".tsx"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        exports: list[str] = []
        for m in _EXPORT_FN.finditer(text):
            exports.append(m.group(1))
        for m in _EXPORT_CONST.finditer(text):
            exports.append(m.group(1))

        for m in list(_FETCH.finditer(text)) + list(_TEMPLATE_FETCH.finditer(text)):
            url_raw = m.group(2) if m.lastindex and m.lastindex >= 2 else m.group(1)
            if not url_raw or "/api" not in url_raw.lower():
                continue
            verb = _guess_verb(m, text) if m.re is _FETCH else "GET"
            route = _extract_url(url_raw)
            # associate with nearest export above match
            fn_name = ""
            for ex in exports:
                pos = text.find(f"function {ex}")
                if pos < 0:
                    pos = text.find(f"const {ex}")
                if 0 <= pos < m.start():
                    fn_name = ex
            clients.append(
                {
                    "id": f"apiclient:{rel}:{fn_name or 'anon'}:{verb}:{route}",
                    "file": rel,
                    "function": fn_name,
                    "method": verb,
                    "route": route,
                    "routeKey": route_key(verb, route),
                    "client": "fetch" if "fetch" in m.group(0).lower() else "axios",
                    "line": _line_number(text, m.start()),
                    "rawUrl": url_raw[:200],
                }
            )

    index = {"version": "5.0", "clients": clients, "count": len(clients)}
    out = harvester_root(repo) / "api_client_index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    return index
