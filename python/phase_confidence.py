"""Confidence Score — optional final quality assessment."""
from __future__ import annotations

import json
import re
from typing import Any

from common import emit_progress, get_ollama_client, ollama_generate, phase_model


def _chunks_summary(chunks: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for c in chunks:
        fp = c.get("file_path", "")
        text = c.get("text", "").splitlines()[:3]
        preview = " | ".join(ln.strip()[:80] for ln in text)
        lines.append(f"- `{fp}`: {preview}")
    return "\n".join(lines)


def _parse_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                return None
    return None


def run(config: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not config.get("enableConfidenceScore", False):
        return None

    url, model = phase_model(config, "confidence")
    if not model:
        return None

    emit_progress("confidence", "Confidence Score")
    feature = config.get("featureInput", "")
    summary = _chunks_summary(chunks)

    prompt = f"""Sei un code reviewer esperto. Valuta se il contesto di codice fornito è sufficiente
per implementare il requisito dato.

Requisito: {feature}

Contesto recuperato:
{summary}

Rispondi con JSON:
{{
  "score": 7,
  "complete": true,
  "missing": ["descrizione di cosa potrebbe mancare"],
  "notes": "breve nota opzionale"
}}

Scala: 1-4 insufficiente, 5-6 parziale, 7-8 buono, 9-10 completo.
Rispondi SOLO con JSON valido."""

    try:
        client = get_ollama_client(url)
        resp = ollama_generate(client, model, prompt)
        parsed = _parse_json(resp)
        if not parsed:
            return None
        return {
            "score": int(parsed.get("score", 5)),
            "complete": bool(parsed.get("complete", False)),
            "missing": parsed.get("missing", []),
            "notes": parsed.get("notes", ""),
        }
    except Exception:
        return None
