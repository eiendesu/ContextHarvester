"""Iterative Retrieval — expand pool from symbols found in chunks."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from common import chroma_root, embed_text, emit_progress, get_ollama_client, load_symbol_index, phase_model
from phase3_retrieval import _merge_chunks, _query_collection

CS_SYM = re.compile(r"\bnew\s+(\w+)\s*\(|(\w+)\.")
TS_IMPORT = re.compile(r"""import\s+.*\b(\w+)\b.*from\s+['"][^'"]+['"]""")


def _extract_symbols_from_chunks(chunks: list[dict[str, Any]]) -> set[str]:
    found: set[str] = set()
    for c in chunks:
        text = c.get("text", "")
        for m in CS_SYM.finditer(text):
            for g in m.groups():
                if g and g[0].isupper():
                    found.add(g)
        for m in TS_IMPORT.finditer(text):
            found.add(m.group(1))
        for m in re.findall(r"\b([A-Z][a-zA-Z0-9]{2,})\b", text):
            if len(m) >= 3:
                found.add(m)
    return found


def _files_for_symbol(sym: str, index: dict[str, Any]) -> list[str]:
    sym_index = index.get("symbols", {})
    usages_map = index.get("usages", {})
    if sym not in sym_index:
        return []
    files = [sym_index[sym].get("file", "")]
    files.extend(usages_map.get(sym, []))
    return [f for f in files if f]


def _chunk_from_file(repo: Path, file_rel: str, score: float) -> dict[str, Any] | None:
    fp = repo / file_rel
    if not fp.exists():
        return None
    try:
        lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    if not lines:
        return None
    return {
        "file_path": file_rel,
        "start_line": 1,
        "end_line": len(lines),
        "text": "\n".join(lines),
        "score": score,
        "language": fp.suffix.lstrip("."),
        "source": "iterative",
    }


def run(config: dict[str, Any], chunks: list[dict[str, Any]], max_iterations: int = 2) -> list[dict[str, Any]]:
    emit_progress("iterative", "Iterative Retrieval")
    repo = Path(config["repoPath"]).resolve()
    index = load_symbol_index(repo)
    pool = list(chunks)
    pool_files = {c["file_path"] for c in pool}

    url, model = phase_model(config, "embedding")
    client = get_ollama_client(url)
    chroma_path = chroma_root(repo)
    db = chromadb.PersistentClient(
        path=str(chroma_path),
        settings=ChromaSettings(anonymized_telemetry=False),
    )
    code_col = db.get_or_create_collection("code_index")

    for iteration in range(max_iterations):
        emit_progress("iterative", f"Iterazione {iteration + 1}", iteration + 1, max_iterations)
        before = len(pool_files)
        found_syms = _extract_symbols_from_chunks(pool)

        for sym in found_syms:
            for file_rel in _files_for_symbol(sym, index):
                if file_rel in pool_files:
                    continue
                chunk = _chunk_from_file(repo, file_rel, 0.85)
                if chunk:
                    pool.append(chunk)
                    pool_files.add(file_rel)

            if sym in index.get("symbols", {}):
                try:
                    emb = embed_text(client, model, sym)
                    for c in _query_collection(code_col, emb, 5):
                        if c["file_path"] not in pool_files:
                            pool.append(c)
                            pool_files.add(c["file_path"])
                except Exception:
                    pass

        pool = _merge_chunks(pool)
        pool_files = {c["file_path"] for c in pool}
        if len(pool_files) == before:
            break

    return pool
