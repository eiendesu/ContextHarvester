"""Re-rank retrieved chunks by relevance to feature input."""
from __future__ import annotations

import re
from typing import Any

from common import emit_progress, get_ollama_client, ollama_generate, phase_model


def _score_chunk(client, model: str, feature: str, chunk_text: str) -> float:
    prompt = f"""Da 0 a 10, quanto è rilevante questo codice per il requisito dato?
Requisito: {feature}
Codice:
{chunk_text[:3000]}

Rispondi SOLO con un numero intero."""
    try:
        resp = ollama_generate(client, model, prompt)
        m = re.search(r"\d+", resp)
        if m:
            return min(10.0, float(m.group())) / 10.0
    except Exception:
        pass
    return 0.5


def run(config: dict[str, Any], chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not config.get("enableReranking", True):
        top_k = int(config.get("topK", 10))
        return chunks[:top_k]

    emit_progress("phase3b", "Re-ranking")
    url, model = phase_model(config, "rerank")
    if not model:
        url, model = phase_model(config, "hyde")
    client = get_ollama_client(url)
    feature = config.get("featureInput", "")
    top_k = int(config.get("topK", 10))

    for c in chunks:
        c["score"] = _score_chunk(client, model, feature, c.get("text", ""))

    chunks.sort(key=lambda x: x["score"], reverse=True)
    return chunks[:top_k]
