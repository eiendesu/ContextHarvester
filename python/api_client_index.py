"""Frontend API client index (v5) — tree-sitter / regex via ts_parser."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import harvester_root, iter_repo_files, merge_exclude_folders, rel_path
from route_normalize import normalize_path, route_key
from ts_parser import parse_ts_file

_API_FILE_HINT = __import__("re").compile(r"(api|service|client)", __import__("re").I)


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
    import_graph_edges: list[dict[str, Any]] = []

    for path in iter_repo_files(repo, exclude, include_ext, config.get("excludeExtensions", []), code_only=True):
        rel = rel_path(path, repo)
        if path.suffix.lower() not in (".ts", ".tsx"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        analysis = parse_ts_file(rel, text)
        is_api_file = bool(_API_FILE_HINT.search(rel))

        for imp in analysis.imports:
            import_graph_edges.append({"from": rel, "to": imp["from"], "line": imp.get("line")})

        export_names = [e["name"] for e in analysis.exports]
        for call in analysis.api_calls:
            url_raw = call.get("url") or ""
            if "/api" not in url_raw.lower():
                continue
            verb = (call.get("verb") or "GET").upper()
            route = _extract_url(url_raw)
            fn_name = ""
            line = call.get("line") or 0
            for ex in export_names:
                pos = text.find(f"function {ex}")
                if pos < 0:
                    pos = text.find(f"const {ex}")
                if 0 <= pos < len(text) and line > text.count("\n", 0, pos) + 1:
                    fn_name = ex
            if not is_api_file and not fn_name:
                continue
            clients.append(
                {
                    "id": f"apiclient:{rel}:{fn_name or 'anon'}:{verb}:{route}",
                    "file": rel,
                    "function": fn_name,
                    "method": verb,
                    "route": route,
                    "routeKey": route_key(verb, route),
                    "client": "fetch",
                    "line": line,
                    "rawUrl": url_raw[:200],
                    "origin": analysis.origin,
                }
            )

    index = {
        "version": "5.0",
        "clients": clients,
        "count": len(clients),
        "importHints": import_graph_edges[:500],
    }
    out = harvester_root(repo) / "api_client_index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    return index
