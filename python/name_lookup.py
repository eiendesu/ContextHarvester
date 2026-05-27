"""Build and resolve class/file name → graph node id (file rel path)."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from common import harvester_root, iter_repo_files, merge_exclude_folders, rel_path

CS_CLASS = re.compile(r"\b(?:public\s+|internal\s+|private\s+)?(?:abstract\s+)?class\s+(\w+)")
CS_INTERFACE = re.compile(r"\binterface\s+(I\w+|\w+)")
TS_EXPORT_FN = re.compile(r"\bexport\s+(?:default\s+)?function\s+(\w+)")
TS_EXPORT_CONST = re.compile(r"\bexport\s+(?:default\s+)?const\s+(\w+)\s*=")
TS_EXPORT_CLASS = re.compile(r"\bexport\s+(?:default\s+)?class\s+(\w+)")


def _primary_name_from_text(path: Path, text: str) -> str | None:
    ext = path.suffix.lower()
    if ext == ".cs":
        m = CS_CLASS.search(text)
        if m:
            return m.group(1)
        m = CS_INTERFACE.search(text)
        if m:
            return m.group(1)
    elif ext in (".ts", ".tsx", ".js", ".jsx"):
        for pat in (TS_EXPORT_CLASS, TS_EXPORT_FN, TS_EXPORT_CONST):
            m = pat.search(text)
            if m:
                return m.group(1)
    return path.stem or None


def build_name_lookup(
    repo: Path,
    exclude_folders: list[str] | None = None,
    include_extensions: list[str] | None = None,
    exclude_extensions: list[str] | None = None,
) -> dict[str, Any]:
    """Scan repo files and build lookup tables (Approccio 1)."""
    repo = repo.resolve()
    exclude_folders = merge_exclude_folders(exclude_folders)
    include_extensions = include_extensions or []
    exclude_extensions = exclude_extensions or []

    by_class_name: dict[str, str] = {}
    by_path_fragment: dict[str, str] = {}
    file_meta: dict[str, dict[str, str]] = {}
    interfaces: dict[str, str] = {}

    for path in iter_repo_files(
        repo, exclude_folders, include_extensions, exclude_extensions, code_only=True
    ):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = rel_path(path, repo)
        class_name = _primary_name_from_text(path, text) or path.stem
        file_meta[rel] = {
            "fullPath": rel,
            "className": class_name,
            "label": class_name,
        }

        # Prefer longer paths on collision (more specific)
        existing = by_class_name.get(class_name)
        if not existing or len(rel) > len(existing):
            by_class_name[class_name] = rel

        key_lower = class_name.lower()
        if key_lower not in by_class_name:
            by_class_name[key_lower] = rel

        frag = rel.replace("\\", "/").lower()
        by_path_fragment[frag] = rel
        stem_frag = path.stem.lower()
        if stem_frag:
            by_path_fragment[stem_frag] = rel

        if class_name.startswith("I") and len(class_name) > 1 and class_name[1].isupper():
            impl = class_name[1:]
            if impl in by_class_name:
                interfaces[class_name] = impl

    return {
        "version": "1.0",
        "byClassName": by_class_name,
        "byPathFragment": by_path_fragment,
        "fileMeta": file_meta,
        "interfaces": interfaces,
    }


def save_name_lookup(repo: Path, lookup: dict[str, Any]) -> Path:
    p = harvester_root(repo) / "name_lookup.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(lookup, indent=2, ensure_ascii=False), encoding="utf-8")
    return p


def load_name_lookup(repo: Path) -> dict[str, Any]:
    p = harvester_root(repo) / "name_lookup.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def resolve_node_id(name: str, lookup: dict[str, Any]) -> str | None:
    """Resolve symbol/class/path hint to file rel path (node id)."""
    if not name or not lookup:
        return None
    name = name.strip()
    if not name:
        return None

    by_class = lookup.get("byClassName") or {}
    if name in by_class:
        return str(by_class[name])
    if name.lower() in by_class:
        return str(by_class[name.lower()])

    interfaces = lookup.get("interfaces") or {}
    if name in interfaces:
        impl = interfaces[name]
        if impl in by_class:
            return str(by_class[impl])

    by_frag = lookup.get("byPathFragment") or {}
    nl = name.lower().replace("\\", "/")
    if nl in by_frag:
        return str(by_frag[nl])
    for frag, node_id in by_frag.items():
        if nl in frag or frag in nl:
            return str(node_id)

    # Partial class name match
    for key, node_id in by_class.items():
        if len(key) < 3:
            continue
        if name.lower() == key.lower() or name in key or key in name:
            return str(node_id)

    # Generics: List<LeadService>
    m = re.search(r"<(\w+)>", name)
    if m:
        inner = resolve_node_id(m.group(1), lookup)
        if inner:
            return inner

    return None


def node_label(node_id: str, lookup: dict[str, Any]) -> str:
    meta = (lookup.get("fileMeta") or {}).get(node_id) or {}
    return meta.get("label") or meta.get("className") or Path(node_id).stem
