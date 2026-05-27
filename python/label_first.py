"""Label-first functional discovery (Approccio 3)."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterator

import networkx as nx

from common import get_ollama_client, harvester_root, load_vocabulary, ollama_generate, phase_model
from functional_map import load, save
from name_lookup import load_name_lookup, node_label, resolve_node_id


def _parse_expansion_json(text: str) -> dict[str, Any] | None:
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


def _fallback_expansion(user_input: str) -> dict[str, Any]:
    words = [w for w in re.split(r"\W+", user_input.lower()) if len(w) > 2]
    return {
        "terms_it": words,
        "terms_en": words,
        "class_patterns": [],
        "file_patterns": words,
        "table_patterns": [],
    }


def expand_query(config: dict[str, Any], user_input: str) -> dict[str, Any]:
    """Step 1 — AI query expansion with fallback."""
    user_input = (user_input or "").strip()
    if not user_input:
        return _fallback_expansion("")

    repo = Path(config["repoPath"]).resolve()
    vocab = load_vocabulary(repo)
    summary_parts: list[str] = []
    for key in ("classes", "components", "tables", "methods"):
        items = vocab.get(key, [])[:25]
        if items:
            summary_parts.extend(items)
    vocab_summary = ", ".join(summary_parts[:100])

    url = config.get("labelExpansionUrl") or config.get("ollamaUrl", "http://localhost:11434")
    model = config.get("labelExpansionModel") or "qwen3:4b"
    ollama_cfg = config.get("ollama") or {}
    if isinstance(ollama_cfg, dict) and ollama_cfg.get("classifier"):
        url = config.get("labelExpansionUrl") or ollama_cfg["classifier"].get("url", url)
        model = config.get("labelExpansionModel") or ollama_cfg["classifier"].get("model", model)

    prompt = f"""Sei un assistente che analizza codebase software.
Dato un input in linguaggio naturale che descrive una funzionalità,
estrai i termini tecnici che potrebbero identificarla nel codice.

Vocabolario del progetto (classi, componenti, tabelle note):
{vocab_summary}

Input: "{user_input}"

Restituisci SOLO un oggetto JSON valido:
{{
  "terms_it": ["termine1"],
  "terms_en": ["term1"],
  "class_patterns": ["NomeClasse"],
  "file_patterns": ["pattern-nel-path"],
  "table_patterns": ["Schema.Tabella"]
}}"""

    try:
        client = get_ollama_client(url)
        raw = ollama_generate(client, model, prompt)
        parsed = _parse_expansion_json(raw)
        if parsed and isinstance(parsed, dict):
            for k in ("terms_it", "terms_en", "class_patterns", "file_patterns", "table_patterns"):
                if k not in parsed:
                    parsed[k] = []
            return parsed
    except Exception:
        pass

    return _fallback_expansion(user_input)


def find_seed_nodes(
    expansion: dict[str, Any],
    graph: nx.DiGraph,
    lookup: dict[str, Any],
) -> list[str]:
    """Step 2 — seed finding."""
    seeds: list[str] = []

    for pattern in expansion.get("class_patterns") or []:
        node_id = resolve_node_id(str(pattern), lookup)
        if node_id and graph.has_node(node_id):
            seeds.append(node_id)

    for pattern in expansion.get("table_patterns") or []:
        node_id = resolve_node_id(str(pattern), lookup)
        if node_id and graph.has_node(node_id):
            seeds.append(node_id)

    for node_id in graph.nodes:
        meta = graph.nodes[node_id]
        file_path = str(meta.get("fullPath") or meta.get("source_file") or node_id).lower()
        for pattern in expansion.get("file_patterns") or []:
            if str(pattern).lower() in file_path:
                seeds.append(str(node_id))
                break

    if not seeds:
        all_terms = list(expansion.get("terms_en") or []) + list(expansion.get("terms_it") or [])
        for node_id in graph.nodes:
            label = str(graph.nodes[node_id].get("label", "")).lower()
            file_path = str(node_id).lower()
            for term in all_terms:
                t = str(term).lower()
                if t and (t in label or t in file_path):
                    seeds.append(str(node_id))
                    break

    return list(dict.fromkeys(seeds))


def traverse_from_seeds(
    seeds: list[str],
    graph: nx.DiGraph,
    depth: int = 2,
    max_nodes: int = 100,
) -> list[str]:
    """Step 3 — BFS traversal on directed graph."""
    visited: set[str] = set(seeds)
    frontier = set(seeds)

    for level in range(depth):
        new_frontier: set[str] = set()
        for node in frontier:
            for neighbor in graph.successors(node):
                if neighbor not in visited:
                    new_frontier.add(str(neighbor))
            if level == 0:
                for neighbor in graph.predecessors(node):
                    if neighbor not in visited:
                        new_frontier.add(str(neighbor))
        visited.update(new_frontier)
        frontier = new_frontier
        if len(visited) >= max_nodes:
            break

    return list(visited)[:max_nodes]


def load_graph_pickle(repo: Path) -> nx.DiGraph | None:
    import pickle

    p = harvester_root(repo) / "graphify_graph.pkl"
    if not p.is_file():
        return None
    try:
        with p.open("rb") as f:
            g = pickle.load(f)
        if isinstance(g, nx.DiGraph):
            return g
    except Exception:
        return None
    return None


def run_label_first(
    config: dict[str, Any],
    user_input: str,
    *,
    depth: int | None = None,
    max_nodes: int | None = None,
) -> dict[str, Any]:
    """Full label-first pipeline; returns seeds, nodes, expansion."""
    repo = Path(config["repoPath"]).resolve()
    graph = load_graph_pickle(repo)
    if graph is None:
        raise FileNotFoundError("graphify_graph.pkl non trovato. Esegui Functional Analysis.")

    lookup = load_name_lookup(repo)
    expansion = expand_query(config, user_input)
    seeds = find_seed_nodes(expansion, graph, lookup)
    d = depth if depth is not None else int(config.get("labelFirstTraversalDepth", 2))
    mx = max_nodes if max_nodes is not None else int(config.get("labelFirstMaxNodes", 100))
    nodes = traverse_from_seeds(seeds, graph, depth=d, max_nodes=mx)

    node_details = [
        {
            "id": n,
            "label": node_label(n, lookup),
            "fullPath": n,
            "file": n,
        }
        for n in nodes
    ]

    return {
        "labelInput": user_input,
        "expansion": expansion,
        "seeds": seeds,
        "nodes": nodes,
        "nodeDetails": node_details,
        "count": len(nodes),
    }


def save_label_first_function(
    config: dict[str, Any],
    name: str,
    label_input: str,
    node_ids: list[str],
    *,
    traversal_depth: int = 2,
) -> dict[str, Any]:
    """Step 5 — persist label-first function; label-first wins over leiden files."""
    import re as _re
    from datetime import datetime, timezone

    from symbol_index import load_symbol_index

    repo = Path(config["repoPath"]).resolve()
    lookup = load_name_lookup(repo)
    sym_index = load_symbol_index(repo)
    symbols = sym_index.get("symbols", {})
    vocab = load_vocabulary(repo)

    fmap = load(repo)
    functions: list[dict[str, Any]] = list(fmap.get("functions") or [])

    slug = _re.sub(r"[^a-z0-9]+", "-", (name or label_input).lower()).strip("-") or "function"
    fn_id = slug
    suffix = 2
    existing_ids = {str(f.get("id")) for f in functions}
    while fn_id in existing_ids:
        fn_id = f"{slug}-{suffix}"
        suffix += 1

    node_set = set(node_ids)
    # Remove these files from other functions (label-first precedence)
    for f in functions:
        files = f.get("files") or []
        f["files"] = [fp for fp in files if fp not in node_set]

    symbol_labels: list[str] = []
    for sym, sinfo in symbols.items():
        if sinfo.get("file") in node_set:
            symbol_labels.append(sym)

    from phase_graph import _terms_from_symbols  # reuse

    terms = _terms_from_symbols(symbols, vocab, symbol_labels)

    new_fn = {
        "id": fn_id,
        "name": name or label_input,
        "source": "label-first",
        "labelInput": label_input,
        "validated": True,
        "manuallyEdited": True,
        "traversalDepth": traversal_depth,
        "godNodes": [node_label(n, lookup) for n in node_ids[:3]],
        "nodes": [
            {"id": s, "file": symbols[s].get("file", ""), "type": symbols[s].get("type", "symbol")}
            for s in symbol_labels[:500]
        ],
        "edges": [],
        "files": sorted(node_set),
        "terms": terms,
    }
    functions.append(new_fn)
    fmap["functions"] = [f for f in functions if f.get("files")]
    fmap["functionalMapReady"] = any(
        isinstance(f, dict) and f.get("validated") for f in fmap["functions"]
    )
    fmap["lastUpdated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save(repo, fmap)

    from functional_map import refresh_graph_json

    refresh_graph_json(repo)

    return new_fn


def label_first_stream(
    config: dict[str, Any],
    user_input: str,
    *,
    depth: int | None = None,
    max_nodes: int | None = None,
) -> Iterator[dict[str, Any]]:
    yield {"stage": "expansion", "message": "Espansione query..."}
    repo = Path(config["repoPath"]).resolve()
    lookup = load_name_lookup(repo)
    expansion = expand_query(config, user_input)
    yield {"stage": "expansion_done", "expansion": expansion}

    graph = load_graph_pickle(repo)
    if graph is None:
        yield {"stage": "error", "message": "Grafo non trovato"}
        return

    yield {"stage": "seeds", "message": "Ricerca nodi seed..."}
    seeds = find_seed_nodes(expansion, graph, lookup)
    yield {"stage": "seeds_done", "seeds": seeds}

    d = depth if depth is not None else int(config.get("labelFirstTraversalDepth", 2))
    mx = max_nodes if max_nodes is not None else int(config.get("labelFirstMaxNodes", 100))
    yield {"stage": "traverse", "message": f"Traversal depth={d}..."}
    nodes = traverse_from_seeds(seeds, graph, depth=d, max_nodes=mx)
    yield {
        "stage": "done",
        "labelInput": user_input,
        "expansion": expansion,
        "seeds": seeds,
        "nodes": nodes,
        "nodeDetails": [
            {"id": n, "label": node_label(n, lookup), "fullPath": n}
            for n in nodes
        ],
        "count": len(nodes),
    }
