"""Logical structure — classify chunks by reading flow."""
from __future__ import annotations

from typing import Any

from common import emit_progress, get_ollama_client, ollama_generate, phase_model

VALID_LEVELS = ("entry_point", "service", "data", "utility")
LEVEL_ORDER = {"entry_point": 0, "service": 1, "data": 2, "utility": 3, "dependency": 4, "test": 5}


def _classify_chunk(client, model: str, chunk_text: str) -> str:
    prompt = f"""Classifica questo chunk di codice in UNA di queste categorie:
entry_point, service, data, utility

Chunk:
{chunk_text[:2500]}

Rispondi SOLO con la categoria, nessun altro testo."""
    try:
        resp = ollama_generate(client, model, prompt).strip().lower()
        for level in VALID_LEVELS:
            if level in resp:
                return level
    except Exception:
        pass
    return "utility"


def run(config: dict[str, Any], chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    emit_progress("structure", "Struttura logica")
    url, model = phase_model(config, "structurer")
    if not model:
        return chunks

    client = get_ollama_client(url)
    total = len(chunks)

    for i, c in enumerate(chunks, 1):
        if i % 3 == 0 or i == total:
            emit_progress("structure", f"Classificazione chunk {i}/{total}", i, total)
        level = _classify_chunk(client, model, c.get("text", ""))
        c["level"] = level

    chunks.sort(
        key=lambda x: (LEVEL_ORDER.get(x.get("level", "utility"), 3), -x.get("score", 0)),
    )
    return chunks
