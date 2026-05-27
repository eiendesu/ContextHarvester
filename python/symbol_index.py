"""Build symbol_index.json with definitions and usages (no AI)."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from common import (
    emit_progress,
    harvester_root,
    iter_repo_files,
    load_symbol_index,
    merge_exclude_folders,
    rel_path,
)


CS_CLASS = re.compile(r"\b(?:public\s+)?(?:abstract\s+)?class\s+(\w+)")
CS_INTERFACE = re.compile(r"\binterface\s+(I\w+|\w+)")
CS_EXTENDS = re.compile(r"\bclass\s+(\w+)\s*:\s*(\w+)")
TS_EXPORT_FN = re.compile(r"\bexport\s+(?:default\s+)?function\s+(\w+)")
TS_EXPORT_CONST = re.compile(r"\bexport\s+(?:default\s+)?const\s+(\w+)")
TS_IMPORT = re.compile(r"""import\s+(?:\{[^}]+\}|\w+)\s+from\s+['"]([^'"]+)['"]""")
TS_JSX = re.compile(r"<(\w+)")
SQL_TABLE = re.compile(r"\bCREATE\s+TABLE\s+([\w.]+)", re.I)

# Usage patterns
CS_USAGE = re.compile(
    r"\bnew\s+(\w+)\s*\(|(\w+)\.|\:\s*(\w+)\b|<(\w+)>",
)
TS_USAGE_IMPORT = re.compile(r"""import\s+.*\b(\w+)\b.*from\s+['"][^'"]+['"]""")
TS_USAGE_JSX = re.compile(r"<(\w+)")
TS_USAGE_CALL = re.compile(r"\b(\w+)\s*\(")


def _add_symbol(
    symbols: dict[str, dict[str, Any]],
    name: str,
    sym_type: str,
    file_rel: str,
    line: int,
    namespace: str = "",
) -> None:
    if not name or name in ("string", "int", "void", "var", "const", "let"):
        return
    if name not in symbols:
        symbols[name] = {
            "type": sym_type,
            "file": file_rel,
            "line": line,
        }
        if namespace:
            symbols[name]["namespace"] = namespace


def _line_number(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _scan_file(
    path: Path,
    repo: Path,
    symbols: dict[str, dict[str, Any]],
    usages: dict[str, list[str]],
) -> None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    rel = rel_path(path, repo)
    ext = path.suffix.lower()

    if ext == ".cs":
        for m in CS_CLASS.finditer(text):
            _add_symbol(symbols, m.group(1), "class", rel, _line_number(text, m.start()))
        for m in CS_INTERFACE.finditer(text):
            _add_symbol(symbols, m.group(1), "interface", rel, _line_number(text, m.start()))
        for m in CS_EXTENDS.finditer(text):
            child, parent = m.group(1), m.group(2)
            if parent in symbols:
                symbols.setdefault(child, symbols.get(child, {}))
        for m in CS_USAGE.finditer(text):
            for g in m.groups():
                if g and g in symbols and rel not in usages.setdefault(g, []):
                    if rel != symbols[g].get("file"):
                        usages[g].append(rel)

    elif ext in (".ts", ".tsx"):
        for m in TS_EXPORT_FN.finditer(text):
            _add_symbol(symbols, m.group(1), "component", rel, _line_number(text, m.start()))
        for m in TS_EXPORT_CONST.finditer(text):
            _add_symbol(symbols, m.group(1), "component", rel, _line_number(text, m.start()))
        for m in TS_JSX.finditer(text):
            name = m.group(1)
            if name[0].isupper() and name in symbols and rel not in usages.setdefault(name, []):
                if rel != symbols[name].get("file"):
                    usages[name].append(rel)
        for m in TS_USAGE_IMPORT.finditer(text):
            name = m.group(1)
            if name in symbols and rel not in usages.setdefault(name, []):
                if rel != symbols[name].get("file"):
                    usages[name].append(rel)

    elif ext == ".sql":
        for m in SQL_TABLE.finditer(text):
            _add_symbol(symbols, m.group(1), "table", rel, _line_number(text, m.start()))


def build_symbol_index(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    exclude_folders = merge_exclude_folders(config.get("excludeFolders"))
    include_ext = config.get("includeExtensions", [])
    exclude_ext = config.get("excludeExtensions", [])

    symbols: dict[str, dict[str, Any]] = {}
    usages: dict[str, list[str]] = {}

    tracker = config.get("_indexTimingTracker")

    files = list(
        iter_repo_files(repo, exclude_folders, include_ext, exclude_ext, code_only=True)
    )
    total = len(files)
    for i, path in enumerate(files, 1):
        if i % 50 == 0 or i == total:
            emit_progress("symbol_index", "Symbol index", i, total)
        rel = rel_path(path, repo)
        t_file = time.perf_counter()
        _scan_file(path, repo, symbols, usages)
        if tracker:
            tracker.record_file(rel, (time.perf_counter() - t_file) * 1000, indexed=True)

    # Deduplicate usage lists
    for name in usages:
        usages[name] = sorted(set(usages[name]))

    index = {"symbols": symbols, "usages": usages}
    out = harvester_root(repo) / "symbol_index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    return index
