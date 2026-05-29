"""Typed hierarchical symbol index (v5) — extends regex symbol_index."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from common import emit_progress, harvester_root, iter_repo_files, merge_exclude_folders, rel_path

CS_CLASS = re.compile(r"\b(?:public\s+)?(?:abstract\s+)?(?:partial\s+)?class\s+(\w+)")
CS_RECORD_STRUCT = re.compile(
    r"\b(?:public\s+)?(?:partial\s+)?(?:record|struct)\s+(?:class\s+)?(\w+)",
)
CS_METHOD = re.compile(
    r"\b(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>,\s\[\]]+\s+(\w+)\s*\(",
)
CS_INTERFACE = re.compile(r"\binterface\s+(I\w+|\w+)")
TS_EXPORT_FN = re.compile(r"\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)")
TS_EXPORT_CONST = re.compile(r"\bexport\s+(?:default\s+)?const\s+(\w+)")
TS_CLASS = re.compile(r"\bexport\s+(?:default\s+)?class\s+(\w+)")
DTO_SUFFIX = re.compile(r"(Dto|DTO|Request|Response|Model|Entity)$", re.I)


def _nid(file_rel: str, sym_type: str, name: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9]+", "-", f"{file_rel}-{sym_type}-{name}").strip("-").lower()
    return safe[:180]


def _line_number(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _lang(ext: str) -> str:
    if ext == ".cs":
        return "csharp"
    if ext in (".ts", ".tsx"):
        return "typescript"
    if ext == ".sql":
        return "sql"
    return "unknown"


def build_symbol_index_v2(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    exclude = merge_exclude_folders(config.get("excludeFolders"))
    include_ext = config.get("includeExtensions", [])
    exclude_ext = config.get("excludeExtensions", [])

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    file_map: dict[str, list[str]] = {}
    entities: list[dict[str, Any]] = []

    files = list(iter_repo_files(repo, exclude, include_ext, exclude_ext, code_only=True))
    total = len(files)

    for i, path in enumerate(files, 1):
        if i % 50 == 0 or i == total:
            emit_progress("symbol_index_v2", "Symbol index v2", i, total)
        rel = rel_path(path, repo)
        ext = path.suffix.lower()
        lang = _lang(ext)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        file_id = _nid(rel, "file", Path(rel).stem)
        nodes.append(
            {
                "id": file_id,
                "type": "file",
                "label": Path(rel).name,
                "qualifiedName": rel,
                "filePath": rel,
                "lineStart": 1,
                "lineEnd": text.count("\n") + 1,
                "language": lang,
                "parentId": None,
                "visibility": "public",
            }
        )
        file_map.setdefault(rel, []).append(file_id)

        if ext == ".cs":
            type_spans: list[tuple[int, int, str, str]] = []
            for m in CS_CLASS.finditer(text):
                type_spans.append((m.start(), m.end(), m.group(1), "class"))
            for m in CS_RECORD_STRUCT.finditer(text):
                type_spans.append((m.start(), m.end(), m.group(1), "record"))
            type_spans.sort(key=lambda x: x[0])

            for idx, (start, _end, name, kind) in enumerate(type_spans):
                block_end = type_spans[idx + 1][0] if idx + 1 < len(type_spans) else len(text)
                cid = _nid(rel, "class", name)
                line = _line_number(text, start)
                sym_type = "dto" if DTO_SUFFIX.search(name) else "class"
                nodes.append(
                    {
                        "id": cid,
                        "type": sym_type,
                        "label": name,
                        "qualifiedName": name,
                        "filePath": rel,
                        "lineStart": line,
                        "lineEnd": line,
                        "language": lang,
                        "parentId": file_id,
                        "visibility": "public",
                    }
                )
                file_map[rel].append(cid)
                edges.append(
                    {
                        "source": file_id,
                        "target": cid,
                        "type": "contains",
                        "weight": 1.0,
                        "confidence": 1.0,
                        "origin": "regex",
                    }
                )
                if sym_type == "dto":
                    entities.append({"id": cid, "name": name, "file": rel, "kind": "dto"})
                block = text[start:block_end]
                for mm in CS_METHOD.finditer(block):
                    mn = mm.group(1)
                    if mn in ("if", "for", "while", "switch", "catch", "get", "set", "value"):
                        continue
                    mid = _nid(rel, "method", f"{name}.{mn}")
                    mline = _line_number(text, start + mm.start())
                    nodes.append(
                        {
                            "id": mid,
                            "type": "method",
                            "label": mn,
                            "qualifiedName": f"{name}.{mn}",
                            "filePath": rel,
                            "lineStart": mline,
                            "lineEnd": mline,
                            "language": lang,
                            "parentId": cid,
                            "visibility": "public",
                        }
                    )
                    file_map[rel].append(mid)
                    edges.append(
                        {
                            "source": cid,
                            "target": mid,
                            "type": "contains",
                            "weight": 1.0,
                            "confidence": 1.0,
                            "origin": "regex",
                        }
                    )
            for m in CS_INTERFACE.finditer(text):
                name = m.group(1)
                iid = _nid(rel, "class", name)
                nodes.append(
                    {
                        "id": iid,
                        "type": "class",
                        "label": name,
                        "qualifiedName": name,
                        "filePath": rel,
                        "lineStart": _line_number(text, m.start()),
                        "lineEnd": _line_number(text, m.start()),
                        "language": lang,
                        "parentId": file_id,
                        "visibility": "public",
                    }
                )
                file_map[rel].append(iid)
                edges.append(
                    {
                        "source": file_id,
                        "target": iid,
                        "type": "contains",
                        "weight": 1.0,
                        "confidence": 1.0,
                        "origin": "regex",
                    }
                )

        elif ext in (".ts", ".tsx"):
            is_api_file = bool(re.search(r"(api|service|client)", rel, re.I))
            for m in TS_CLASS.finditer(text):
                name = m.group(1)
                cid = _nid(rel, "class", name)
                nodes.append(
                    {
                        "id": cid,
                        "type": "class",
                        "label": name,
                        "qualifiedName": name,
                        "filePath": rel,
                        "lineStart": _line_number(text, m.start()),
                        "lineEnd": _line_number(text, m.start()),
                        "language": lang,
                        "parentId": file_id,
                        "visibility": "public",
                    }
                )
                file_map[rel].append(cid)
                edges.append(
                    {
                        "source": file_id,
                        "target": cid,
                        "type": "contains",
                        "weight": 1.0,
                        "confidence": 1.0,
                        "origin": "regex",
                    }
                )
            for m in TS_EXPORT_FN.finditer(text):
                name = m.group(1)
                ntype = "api_client_method" if is_api_file else "method"
                mid = _nid(rel, ntype, name)
                nodes.append(
                    {
                        "id": mid,
                        "type": ntype,
                        "label": name,
                        "qualifiedName": name,
                        "filePath": rel,
                        "lineStart": _line_number(text, m.start()),
                        "lineEnd": _line_number(text, m.start()),
                        "language": lang,
                        "parentId": file_id,
                        "visibility": "public",
                    }
                )
                file_map[rel].append(mid)
                edges.append(
                    {
                        "source": file_id,
                        "target": mid,
                        "type": "contains",
                        "weight": 1.0,
                        "confidence": 1.0,
                        "origin": "regex",
                    }
                )
                if is_api_file:
                    afid = _nid(rel, "api_client_file", Path(rel).stem)
                    if not any(n["id"] == afid for n in nodes):
                        nodes.append(
                            {
                                "id": afid,
                                "type": "api_client_file",
                                "label": Path(rel).name,
                                "qualifiedName": rel,
                                "filePath": rel,
                                "lineStart": 1,
                                "lineEnd": 1,
                                "language": lang,
                                "parentId": file_id,
                                "visibility": "public",
                            }
                        )
                        file_map[rel].append(afid)
                        edges.append(
                            {
                                "source": file_id,
                                "target": afid,
                                "type": "contains",
                                "weight": 1.0,
                                "confidence": 1.0,
                                "origin": "regex",
                            }
                        )
                    edges.append(
                        {
                            "source": afid,
                            "target": mid,
                            "type": "contains",
                            "weight": 1.0,
                            "confidence": 1.0,
                            "origin": "regex",
                        }
                    )

    emit_progress("symbol_index_v2", "Roslyn C# merge", 0, 1)
    if config.get("useRoslyn", True):
        from roslyn_bridge import (
            extract_raw_calls_from_roslyn,
            merge_roslyn_into_symbol_v2,
            run_roslyn_scan,
        )

        scan = run_roslyn_scan(repo)
        if scan:
            merge_roslyn_into_symbol_v2(scan, nodes, edges, file_map, entities)
            raw_cs = extract_raw_calls_from_roslyn(scan)
            if raw_cs:
                root = harvester_root(repo)
                root.mkdir(parents=True, exist_ok=True)
                (root / "call_edges_raw_cs.json").write_text(
                    json.dumps({"calls": raw_cs}, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )

    index = {
        "version": "5.0",
        "nodes": nodes,
        "edges": edges,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
    }
    root = harvester_root(repo)
    root.mkdir(parents=True, exist_ok=True)
    (root / "symbol_index_v2.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (root / "file_symbol_map.json").write_text(
        json.dumps({"version": "5.0", "files": file_map}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (root / "entity_index.json").write_text(
        json.dumps({"version": "5.0", "entities": entities, "count": len(entities)}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return index
