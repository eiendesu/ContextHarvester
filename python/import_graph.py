"""Build TypeScript import graph for caller → API client mapping (v5)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import emit_progress, harvester_root, iter_repo_files, merge_exclude_folders, rel_path
from ts_parser import parse_ts_file


def _resolve_import(from_rel: str, spec: str) -> str | None:
    """Best-effort resolve relative import to repo-relative path."""
    if spec.startswith("."):
        base = Path(from_rel).parent
        target = (base / spec).as_posix()
        for ext in ("", ".ts", ".tsx", "/index.ts", "/index.tsx"):
            cand = target + ext if ext else target
            return cand.lstrip("./")
    return spec


def build_import_graph(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    exclude = merge_exclude_folders(config.get("excludeFolders"))
    include_ext = config.get("includeExtensions", [".ts", ".tsx"])

    edges: list[dict[str, Any]] = []
    file_exports: dict[str, list[str]] = {}

    files = [
        p
        for p in iter_repo_files(
            repo, exclude, include_ext, config.get("excludeExtensions", []), code_only=True
        )
        if p.suffix.lower() in (".ts", ".tsx")
    ]
    total = len(files)

    for i, path in enumerate(files, 1):
        if i % 40 == 0 or i == total:
            emit_progress("import_graph", "Import graph", i, total)
        rel = rel_path(path, repo)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        analysis = parse_ts_file(rel, text)
        file_exports[rel] = [e["name"] for e in analysis.exports]
        for imp in analysis.imports:
            target = _resolve_import(rel, imp["from"])
            if target:
                edges.append(
                    {
                        "from": rel,
                        "to": target,
                        "type": "imports",
                        "line": imp.get("line"),
                        "origin": analysis.origin,
                    }
                )

    # caller mapping: if file A imports api file B and calls export from B
    callers: list[dict[str, Any]] = []
    api_files = {f for f in file_exports if "api" in f.lower() or "service" in f.lower()}
    for e in edges:
        if e["to"] in api_files or any(
            e["to"].endswith(x) for x in (".ts", ".tsx")
        ):
            callers.append(
                {
                    "consumerFile": e["from"],
                    "apiFile": e["to"],
                    "type": "imports_api",
                }
            )

    index = {
        "version": "5.0",
        "edges": edges,
        "callers": callers,
        "fileExports": file_exports,
        "edgeCount": len(edges),
    }
    out = harvester_root(repo) / "import_graph.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    return index
