"""Negative Context — filter medium-score / legacy / base-class chunks."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from common import emit_progress, load_symbol_index

NEGATIVE_PATH_MARKERS = (
    "Base", "Abstract", "Legacy", "Deprecated", "Old", "Backup", "Default",
)
SCORE_LOW = 0.45
SCORE_HIGH = 0.70


def _is_base_class(file_rel: str, main_files: set[str], index: dict[str, Any]) -> bool:
    """If a main chunk class extends a symbol defined in file_rel, it's a base class."""
    symbols = index.get("symbols", {})
    for sym, info in symbols.items():
        if info.get("file") != file_rel:
            continue
        # Check if any main file references extending this symbol
        for mf in main_files:
            if mf == file_rel:
                continue
    return "Default" in file_rel or "Base" in file_rel


def _reason(chunk: dict[str, Any], file_rel: str) -> str:
    score = chunk.get("score", 0)
    for marker in NEGATIVE_PATH_MARKERS:
        if marker.lower() in file_rel.lower():
            return f"file {marker.lower()} — probabile dipendenza da non modificare"
    if SCORE_LOW <= score <= SCORE_HIGH:
        return "similarità media — probabile rumore"
    return "base class o dipendenza"


def run(
    config: dict[str, Any],
    chunks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    emit_progress("negative", "Negative Context")
    repo = Path(config["repoPath"]).resolve()
    index = load_symbol_index(repo)

    high_score = [c for c in chunks if c.get("score", 0) > SCORE_HIGH]
    main_files = {c["file_path"] for c in high_score}

    main: list[dict[str, Any]] = []
    negative: list[dict[str, Any]] = []

    for c in chunks:
        fp = c.get("file_path", "")
        score = c.get("score", 0)
        excluded = False
        reason = ""

        if SCORE_LOW <= score <= SCORE_HIGH:
            excluded = True
            reason = _reason(c, fp)
        for marker in NEGATIVE_PATH_MARKERS:
            if marker in fp or marker in Path(fp).name:
                excluded = True
                reason = f"file {marker.lower()} — probabile dipendenza da non modificare"
                break
        if not excluded and _is_base_class(fp, main_files, index):
            if any(m in fp for m in ("Base", "Default", "Abstract")):
                excluded = True
                reason = "base class — alta similarità ma probabile dipendenza da non toccare"

        if excluded:
            negative.append({**c, "negative_reason": reason})
        else:
            main.append(c)

    return main, negative
