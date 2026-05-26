"""Extract project vocabulary (classes, tables, components) via regex."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from common import emit_progress, harvester_root, iter_repo_files, rel_path


def run(config: dict[str, Any]) -> Path:
    repo = Path(config["repoPath"]).resolve()
    exclude_folders = config.get("excludeFolders", [])
    include_ext = config.get("includeExtensions", [])
    exclude_ext = config.get("excludeExtensions", [])

    vocab: dict[str, list[str]] = {
        "classes": [],
        "interfaces": [],
        "namespaces": [],
        "methods": [],
        "feature_flags": [],
        "components": [],
        "imports": [],
        "tables": [],
        "procedures": [],
    }

    files = list(
        iter_repo_files(repo, exclude_folders, include_ext, exclude_ext, code_only=False)
    )
    total = len(files)

    cs_class = re.compile(r"\bclass\s+(\w+)")
    cs_iface = re.compile(r"\binterface\s+(I\w+|\w+)")
    cs_ns = re.compile(r"\bnamespace\s+([\w.]+)")
    cs_method = re.compile(r"\bpublic\s+[\w<>,\s\[\]]+\s+(\w+)\s*\(")
    ff = re.compile(r"\b(FF_[A-Z0-9_]+)\b")

    ts_fn = re.compile(r"\bexport\s+(?:default\s+)?function\s+(\w+)")
    ts_comp = re.compile(r"\bconst\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>|\([^)]*\)\s*:\s*)")
    ts_import = re.compile(r"\bimport\s+.*\s+from\s+['\"]([^'\"]+)['\"]")

    sql_table = re.compile(r"\bCREATE\s+TABLE\s+([\w.]+)", re.I)
    sql_alter = re.compile(r"\bALTER\s+TABLE\s+([\w.]+)", re.I)
    sql_proc = re.compile(r"\bCREATE\s+(?:PROC|PROCEDURE)\s+([\w.]+)", re.I)

    for i, path in enumerate(files, 1):
        emit_progress("phase0", "Vocabulary extraction", i, total)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = rel_path(path, repo)
        ext = path.suffix.lower()

        if ext == ".cs":
            vocab["classes"].extend(cs_class.findall(text))
            vocab["interfaces"].extend(cs_iface.findall(text))
            vocab["namespaces"].extend(cs_ns.findall(text))
            vocab["methods"].extend(cs_method.findall(text))
            vocab["feature_flags"].extend(ff.findall(text))
        elif ext in (".ts", ".tsx"):
            vocab["components"].extend(ts_fn.findall(text))
            vocab["components"].extend(ts_comp.findall(text))
            vocab["imports"].extend(ts_import.findall(text))
        elif ext == ".sql":
            vocab["tables"].extend(sql_table.findall(text))
            vocab["tables"].extend(sql_alter.findall(text))
            vocab["procedures"].extend(sql_proc.findall(text))

    for key in vocab:
        vocab[key] = sorted(set(vocab[key]))

    out = harvester_root(repo) / "project_vocabulary.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(vocab, f, indent=2, ensure_ascii=False)
    return out
