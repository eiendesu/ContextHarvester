"""Query Understanding — classify feature request before HyDE."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from common import emit_progress, get_ollama_client, harvester_root, load_vocabulary, ollama_generate, phase_model


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


def run(config: dict[str, Any]) -> dict[str, Any] | None:
    emit_progress("query_understanding", "Query Understanding")
    feature = config.get("featureInput", "")
    if not feature.strip():
        return None

    repo_path = Path(config["repoPath"]).resolve()
    vocab = load_vocabulary(repo_path)
    known = (
        vocab.get("classes", [])
        + vocab.get("tables", [])
        + vocab.get("components", [])
    )[:80]

    # Layer 2 integration: load validated functional map (if any).
    functional_map = {}
    try:
        fmap_path = harvester_root(repo_path) / "functional_map.json"
        if fmap_path.exists():
            functional_map = json.loads(fmap_path.read_text(encoding="utf-8"))
    except Exception:
        functional_map = {}
    map_ready = bool(functional_map.get("functionalMapReady"))
    valid_functions = [
        f
        for f in (functional_map.get("functions") or [])
        if isinstance(f, dict) and f.get("validated") is True
    ] if map_ready else []
    function_ids = [str(f.get("id")) for f in valid_functions if f.get("id")]
    function_names = [str(f.get("name")) for f in valid_functions if f.get("name")]

    url, model = phase_model(config, "classifier")
    if not model:
        return None

    function_hint = ""
    if function_ids:
        # Keep it small: ids are enough; HyDE will inject terms later.
        function_hint = f"\nFunzionalità esistenti (ID): {', '.join(function_ids)}"

    prompt = f"""Analizza questo requisito e restituisci SOLO un oggetto JSON con questa struttura:
{{
  "type": "new_entity|modify_existing|integration|fix|other",
  "areas": ["backend", "frontend", "sql"],
  "key_symbols": ["NomeClasse1", "NomeTabella1"],
  "search_hints": ["termine specifico da cercare nel codice"],
  "related_function": uno tra gli ID disponibili oppure null
}}

Requisito: {feature}
Simboli noti nel progetto: {', '.join(known)}
{function_hint}

Rispondi SOLO con JSON valido, nessuna spiegazione."""

    try:
        client = get_ollama_client(url)
        resp = ollama_generate(client, model, prompt)
        parsed = _parse_json(resp)
        if not parsed:
            return None
        return {
            "type": parsed.get("type", "other"),
            "areas": parsed.get("areas", []),
            "key_symbols": parsed.get("key_symbols", []),
            "search_hints": parsed.get("search_hints", []),
            "related_function": parsed.get("related_function", None),
        }
    except Exception:
        return None
