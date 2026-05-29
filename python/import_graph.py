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

    analyses: dict[str, Any] = {}
    for i, path in enumerate(files, 1):
        if i % 40 == 0 or i == total:
            emit_progress("import_graph", "Import graph", i, total)
        rel = rel_path(path, repo)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        analysis = parse_ts_file(rel, text)
        analyses[rel] = analysis
        exports = [e["name"] for e in analysis.exports]
        if analysis.default_export:
            exports.append(analysis.default_export)
        file_exports[rel] = exports

    # Build name -> files mapping for component/hook resolution
    name_to_files: dict[str, list[str]] = {}
    for rel, analysis in analyses.items():
        for e in analysis.exports:
            name_to_files.setdefault(e["name"], []).append(rel)
        if analysis.default_export:
            name_to_files.setdefault(analysis.default_export, []).append(rel)

    for rel, analysis in analyses.items():
        # 1. Direct import edges (highest confidence)
        for imp in analysis.imports:
            target = _resolve_import(rel, imp["from"])
            if target:
                edges.append(
                    {
                        "from": rel,
                        "to": target,
                        "type": "imports",
                        "confidence": 1.0,
                        "line": imp.get("line"),
                        "evidence": imp.get("from"),
                        "origin": analysis.origin,
                    }
                )

        # 2. JSX component usage edges
        for jsx in analysis.jsx_components:
            name = jsx["name"]
            targets = name_to_files.get(name, [])
            for target in targets:
                if target != rel:
                    edges.append(
                        {
                            "from": rel,
                            "to": target,
                            "type": "uses_component",
                            "confidence": 0.7,
                            "line": jsx.get("line"),
                            "evidence": f"JSX <{name}/>",
                            "origin": analysis.origin,
                        }
                    )

        # 3. Hook usage edges
        for hook in analysis.hooks:
            name = hook["name"]
            targets = name_to_files.get(name, [])
            for target in targets:
                if target != rel:
                    edges.append(
                        {
                            "from": rel,
                            "to": target,
                            "type": "uses_hook",
                            "confidence": 0.6,
                            "line": hook.get("line"),
                            "evidence": f"hook {name}()",
                            "origin": analysis.origin,
                        }
                    )

        # 4. Probabilistic edges for unresolved imports
        for imp in analysis.imports:
            target = _resolve_import(rel, imp["from"])
            if not target:
                edges.append(
                    {
                        "from": rel,
                        "to": imp["from"],
                        "type": "imports_unresolved",
                        "confidence": 0.3,
                        "line": imp.get("line"),
                        "evidence": imp["from"],
                        "origin": analysis.origin,
                    }
                )

    # caller mapping: if file A imports api file B and calls export from B
    callers: list[dict[str, Any]] = []
    api_files = {f for f in file_exports if "api" in f.lower() or "service" in f.lower()}
    for e in edges:
        if e["type"] == "imports" and (e["to"] in api_files or any(
            e["to"].endswith(x) for x in (".ts", ".tsx")
        )):
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
