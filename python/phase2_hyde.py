"""HyDE query expansion — generate hypothetical code snippets."""
from __future__ import annotations

from typing import Any

import json
from pathlib import Path

from common import emit_progress, get_ollama_client, harvester_root, load_vocabulary, ollama_generate, phase_model


def run(config: dict[str, Any], query_analysis: dict[str, Any] | None = None) -> list[str]:
    repo_path = config["repoPath"]
    vocab = load_vocabulary(repo_path)
    feature = config.get("featureInput", "")
    if query_analysis:
        hints = query_analysis.get("search_hints") or []
        if hints:
            feature = f"{feature}\n\nTermini chiave: {', '.join(hints)}"

        related_function = query_analysis.get("related_function")
        if related_function:
            try:
                fmap_path = harvester_root(Path(repo_path).resolve()) / "functional_map.json"
                if fmap_path.exists():
                    fmap = json.loads(fmap_path.read_text(encoding="utf-8"))
                    funcs = fmap.get("functions") or []
                    fn = next((f for f in funcs if isinstance(f, dict) and f.get("validated") and str(f.get("id")) == str(related_function)), None)
                    if fn and isinstance(fn.get("terms"), dict):
                        dc = fn["terms"].get("domainConcepts") or []
                        if dc:
                            dc_list = [t for t in dc if isinstance(t, str)]
                            feature = (
                                f"{feature}\n\nFunzionalità target: {fn.get('name','')}\n"
                                f"Termini funzionali: {', '.join(dc_list[:40])}"
                            )
            except Exception:
                pass
    url, model = phase_model(config, "hyde")
    client = get_ollama_client(url)
    multi = config.get("multiQueryHyde", True)

    snippets: list[str] = []
    prompts: list[tuple[str, str]] = []

    classes = vocab.get("classes", [])[:50]
    namespaces = vocab.get("namespaces", [])[:20]
    flags = vocab.get("feature_flags", [])
    components = vocab.get("components", [])[:50]
    imports = vocab.get("imports", [])[:30]
    tables = vocab.get("tables", [])[:50]
    procedures = vocab.get("procedures", [])[:30]

    if not multi:
        prompts.append(("generic", f"""Requisito: {feature}

Scrivi uno snippet di codice ipotetico (20-30 righe) che rappresenti come questa feature potrebbe essere implementata.
Rispondi SOLO con codice, nessuna spiegazione."""))
    else:
        if config.get("focusBackend", True):
            prompts.append(("backend", f"""Sei un developer C#/.NET.

Classi esistenti nel progetto: {', '.join(classes)}
Namespace: {', '.join(namespaces)}
Feature flags: {', '.join(flags)}

Requisito: {feature}

Scrivi uno snippet C# ipotetico (20-30 righe) che rappresenti come questa feature potrebbe essere implementata. Usa i nomi reali del progetto.
Rispondi SOLO con codice, nessuna spiegazione."""))

        if config.get("focusFrontend", True):
            prompts.append(("frontend", f"""Sei un developer React/TypeScript.

Componenti esistenti: {', '.join(components)}
Moduli usati: {', '.join(imports)}

Requisito: {feature}

Scrivi uno snippet TypeScript/React ipotetico (20-30 righe). Usa i nomi reali del progetto. SOLO codice."""))

        if config.get("focusSql", True):
            prompts.append(("sql", f"""Sei un DBA su SQL Server.

Tabelle esistenti: {', '.join(tables)}
Stored procedure esistenti: {', '.join(procedures)}

Requisito: {feature}

Scrivi uno snippet SQL ipotetico (10-20 righe). Usa i nomi reali del progetto. SOLO codice."""))

    total = len(prompts)
    for i, (label, prompt) in enumerate(prompts, 1):
        emit_progress("phase2", f"HyDE query {i}/{total} ({label})", i, total)
        try:
            text = ollama_generate(client, model, prompt)
            if text:
                snippets.append(text)
        except Exception:
            continue

    if not snippets:
        snippets.append(feature)
    return snippets
