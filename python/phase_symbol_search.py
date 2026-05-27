"""Symbol Search — direct lookup from symbol_index + usages."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from common import emit_progress, language_for_ext, load_symbol_index


SYMBOL_SCORE = 0.95


def _chunk_from_file(repo: Path, file_rel: str, score: float, source: str) -> dict[str, Any] | None:
    fp = repo / file_rel
    if not fp.exists():
        return None
    try:
        lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    if not lines:
        return None
    text = "\n".join(lines)
    return {
        "file_path": file_rel,
        "start_line": 1,
        "end_line": len(lines),
        "text": text,
        "score": score,
        "language": language_for_ext(fp.suffix),
        "source": source,
    }


def run(config: dict[str, Any], query_analysis: dict[str, Any] | None) -> list[dict[str, Any]]:
    emit_progress("symbol_search", "Symbol Search")
    if not query_analysis:
        return []

    key_symbols = query_analysis.get("key_symbols") or []
    if not key_symbols:
        return []

    repo = Path(config["repoPath"]).resolve()
    index = load_symbol_index(repo)
    symbols = index.get("symbols", {})
    usages_map = index.get("usages", {})

    chunks: list[dict[str, Any]] = []
    seen: set[str] = set()

    for sym in key_symbols:
        if sym not in symbols:
            continue
        info = symbols[sym]
        def_file = info.get("file", "")
        if def_file and def_file not in seen:
            c = _chunk_from_file(repo, def_file, SYMBOL_SCORE, "symbol")
            if c:
                chunks.append(c)
                seen.add(def_file)
        for usage_file in usages_map.get(sym, []):
            if usage_file not in seen:
                c = _chunk_from_file(repo, usage_file, SYMBOL_SCORE, "symbol_usage")
                if c:
                    chunks.append(c)
                    seen.add(usage_file)

    return chunks
