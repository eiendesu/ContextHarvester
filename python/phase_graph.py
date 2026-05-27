"""Layer 2 — Functional Analysis (knowledge graph + community clustering).

This implementation is deterministic (no AI): it builds a file→file graph
based on `symbol_index.json` usages.

Outputs:
- `.context-harvester/graphify_graph.pkl` (pickled NetworkX graph)
- `.context-harvester/communities_raw.json` (raw communities)
- `.context-harvester/functional_map.json` (candidate functions + terms)
- `.context-harvester/graph.json` (vis.js-friendly serialization)
"""

from __future__ import annotations

import json
import pickle
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import networkx as nx

from common import emit_progress, harvester_root, load_vocabulary, merge_exclude_folders
from functional_map import build_groups_metadata, group_label_for_id
from graph_reassign import reassign_partition_neighbors
from name_lookup import build_name_lookup, load_name_lookup, node_label, resolve_node_id, save_name_lookup
from symbol_index import load_symbol_index


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s or "function"


def _safe_basename(path_str: str) -> str:
    p = Path(path_str)
    return p.stem or p.name


def _leiden_partition(G_undirected: nx.Graph) -> dict[str, int]:
    """Return node->community_id using Leiden if available; fallback to Louvain."""
    if G_undirected.number_of_nodes() == 0:
        return {}
    if G_undirected.number_of_edges() == 0:
        # degenerate graph: each node its own community
        return {n: i for i, n in enumerate(sorted(G_undirected.nodes))}

    try:
        from graspologic.partition import leiden

        # graspologic leiden drops isolates; we handle isolates outside
        return leiden(G_undirected)
    except Exception:
        # Fallback: networkx louvain (communities as list of sets)
        try:
            from networkx.algorithms.community import louvain_communities

            communities = louvain_communities(G_undirected, seed=42)
            node_to_cid: dict[str, int] = {}
            for cid, nodes in enumerate(communities):
                for n in nodes:
                    node_to_cid[n] = cid
            return node_to_cid
        except Exception:
            return {n: i for i, n in enumerate(sorted(G_undirected.nodes))}


def _partition_to_communities(partition: dict[str, int], isolates: list[str]) -> dict[int, list[str]]:
    communities: dict[int, list[str]] = {}
    for node, cid in partition.items():
        communities.setdefault(int(cid), []).append(node)

    # Add isolates as their own communities
    if isolates:
        next_cid = max(communities.keys(), default=-1) + 1
        for iso in isolates:
            communities[next_cid] = [iso]
            next_cid += 1
    return {cid: sorted(nodes) for cid, nodes in communities.items()}


def _community_god_nodes(G: nx.Graph, nodes: list[str], top_k: int = 3) -> list[str]:
    ranked = sorted(nodes, key=lambda n: G.degree(n), reverse=True)
    return ranked[:top_k]


def _terms_from_symbols(symbols: dict[str, Any], vocab: dict[str, Any], symbol_labels: list[str]) -> dict[str, Any]:
    vocab_classes = set(vocab.get("classes", []))
    vocab_components = set(vocab.get("components", []))
    vocab_tables = set(vocab.get("tables", []))
    vocab_feature_flags = set(vocab.get("feature_flags", []))
    vocab_methods = set(vocab.get("methods", []))

    terms = {
        "classes": sorted([s for s in symbol_labels if s in vocab_classes])[:50],
        "components": sorted([s for s in symbol_labels if s in vocab_components])[:50],
        "tables": sorted([s for s in symbol_labels if s in vocab_tables])[:50],
        "methods": sorted([s for s in symbol_labels if s in vocab_methods])[:50],
        "featureFlags": sorted([s for s in symbol_labels if s in vocab_feature_flags])[:50],
    }
    # Domain concepts is intentionally broad; used for HyDE injection.
    domain_concepts = set()
    for k in ("classes", "components", "tables", "methods", "featureFlags"):
        for t in terms.get(k, []):
            domain_concepts.add(t)
    terms["domainConcepts"] = sorted(domain_concepts)[:80]
    return terms


def run(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    harv_root = Path(harvester_root(repo)).resolve()
    graphify_graph_pkl = harv_root / "graphify_graph.pkl"
    communities_raw_path = harv_root / "communities_raw.json"
    functional_map_path = harv_root / "functional_map.json"
    graph_json_path = harv_root / "graph.json"

    emit_progress("phase_graph", "Functional Analysis: loading indexes")
    sym_index = load_symbol_index(repo)
    vocab = load_vocabulary(repo)

    emit_progress("phase_graph", "Building name lookup")
    exclude_folders = merge_exclude_folders(config.get("excludeFolders"))
    include_ext = config.get("includeExtensions", [])
    exclude_ext = config.get("excludeExtensions", [])
    if config.get("graphNormalizeNodeNames", True):
        lookup = build_name_lookup(repo, exclude_folders, include_ext, exclude_ext)
        save_name_lookup(repo, lookup)
    else:
        lookup = load_name_lookup(repo)

    # Build file→file graph from symbol usages:
    # If file A uses symbol S, and S is defined in file B => A --uses--> B
    symbols = sym_index.get("symbols", {})
    usages = sym_index.get("usages", {})

    emit_progress("phase_graph", "Functional Analysis: building file graph")
    G_dir = nx.DiGraph()

    def add_node_if_missing(file_rel: str) -> None:
        if not file_rel:
            return
        if file_rel not in G_dir:
            meta = (lookup.get("fileMeta") or {}).get(file_rel) or {}
            G_dir.add_node(
                file_rel,
                label=meta.get("label") or _safe_basename(file_rel),
                className=meta.get("className") or _safe_basename(file_rel),
                fullPath=file_rel,
                source_file=file_rel,
                file_type="code",
            )

    for sym, sinfo in symbols.items():
        def_file = sinfo.get("file", "")
        usage_files = usages.get(sym, []) or []
        add_node_if_missing(def_file)
        resolved_def = resolve_node_id(def_file, lookup) or def_file
        if resolved_def != def_file and G_dir.has_node(resolved_def):
            def_file = resolved_def
        for uf in usage_files:
            add_node_if_missing(uf)
            target = resolve_node_id(sym, lookup) or def_file
            if not target or not uf or uf == target:
                continue
            if not G_dir.has_node(target):
                add_node_if_missing(target)
            if G_dir.has_edge(uf, target):
                G_dir[uf][target]["weight"] = float(G_dir[uf][target].get("weight", 1.0)) + 1.0
            else:
                G_dir.add_edge(uf, target, relation="uses", confidence="EXTRACTED", weight=1.0)

    # Cluster on undirected projection.
    G_und = G_dir.to_undirected()
    isolates = [n for n in G_und.nodes if G_und.degree(n) == 0]
    connected_nodes = [n for n in G_und.nodes if G_und.degree(n) > 0]
    connected = G_und.subgraph(connected_nodes).copy()

    emit_progress("phase_graph", "Functional Analysis: Leiden clustering")
    partition = _leiden_partition(connected) if connected.number_of_nodes() else {}
    if config.get("graphReassignUnassigned", True) and partition:
        min_deg = int(config.get("graphMinDegreeForReassign", 1))
        partition = reassign_partition_neighbors(connected, partition, min_degree=min_deg)
    communities = _partition_to_communities(partition, isolates)

    # Configurable filtering (defaults per plan)
    min_comm = int(config.get("graphMinCommunitySize", 3))
    max_comm = int(config.get("graphMaxCommunitySize", 50))
    auto_validate = bool(config.get("graphAutoValidate", False))

    # Sort communities by size descending for stable indexing
    comm_items = sorted(communities.items(), key=lambda kv: len(kv[1]), reverse=True)

    validated_functions: list[dict[str, Any]] = []
    communities_raw: list[dict[str, Any]] = []

    # We keep discarded communities for report/debugging.
    for raw_idx, (cid, files) in enumerate(comm_items):
        if not files:
            continue
        if len(files) < min_comm:
            continue

        # If too large, split approximately by rerunning clustering on the subgraph.
        if len(files) > max_comm:
            sub = G_und.subgraph(files).copy()
            sub_isolates = [n for n in sub.nodes if sub.degree(n) == 0]
            sub_connected_nodes = [n for n in sub.nodes if sub.degree(n) > 0]
            sub_connected = sub.subgraph(sub_connected_nodes).copy()
            sub_partition = _leiden_partition(sub_connected) if sub_connected.number_of_nodes() else {}
            sub_comms = _partition_to_communities(sub_partition, sub_isolates)
            # flatten sub-comms, capped by size
            for sub_nodes in sub_comms.values():
                if len(sub_nodes) >= min_comm:
                    files = sub_nodes
                    break

        files = sorted(files)
        god_nodes = _community_god_nodes(G_und, files, top_k=3)
        god_labels = [node_label(g, lookup) for g in god_nodes]
        community_name = god_labels[0] if god_labels else _safe_basename(files[0])
        function_id = _slugify(community_name) + "-" + _slugify(str(god_nodes[1] if len(god_nodes) > 1 else god_nodes[0]))

        # Compute symbol labels inside this community.
        file_set = set(files)
        symbol_labels: list[str] = []
        for sym, sinfo in symbols.items():
            if sinfo.get("file") in file_set:
                symbol_labels.append(sym)

        terms = _terms_from_symbols(symbols, vocab, symbol_labels)

        communities_raw.append(
            {
                "communityIndex": raw_idx,
                "communityId": cid,
                "name": community_name,
                "files": files,
                "godNodes": god_nodes,
                "size": len(files),
            }
        )

        validated = auto_validate
        function_obj = {
            "id": function_id,
            "name": community_name,
            "source": "leiden",
            "validated": validated,
            "manuallyEdited": False,
            "godNodes": god_labels or god_nodes,
            "nodes": [
                {"id": s, "file": symbols[s].get("file", ""), "type": symbols[s].get("type", "symbol")}
                for s in symbol_labels[:500]
            ],
            "edges": [],
            "files": files,
            "terms": terms,
        }
        validated_functions.append(function_obj)

    # Save artifacts
    harv_root.mkdir(parents=True, exist_ok=True)

    with graphify_graph_pkl.open("wb") as f:
        pickle.dump(G_dir, f)

    communities_raw_path.write_text(json.dumps({"communities": communities_raw}, indent=2, ensure_ascii=False), encoding="utf-8")

    # Preserve label-first functions (user-defined; take precedence on file overlap)
    existing_label_first: list[dict[str, Any]] = []
    if functional_map_path.is_file():
        try:
            old = json.loads(functional_map_path.read_text(encoding="utf-8"))
            existing_label_first = [
                f for f in (old.get("functions") or [])
                if isinstance(f, dict) and f.get("source") == "label-first"
            ]
        except Exception:
            pass

    leiden_files: set[str] = set()
    for f in validated_functions:
        leiden_files.update(f.get("files") or [])

    merged_functions = list(validated_functions)
    for lf in existing_label_first:
        lf_files = set(lf.get("files") or [])
        for f in merged_functions:
            f["files"] = [fp for fp in (f.get("files") or []) if fp not in lf_files]
        merged_functions = [f for f in merged_functions if f.get("files")]
        merged_functions.append(lf)

    any_validated = any(f.get("validated") for f in merged_functions)

    functional_map_path.write_text(
        json.dumps(
            {
                "version": "1.0",
                "lastUpdated": _utc_now_iso(),
                "functionalMapReady": auto_validate or any_validated,
                "functions": merged_functions,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    # vis.js serialization
    # Group by function id (only validated ones). Unvalidated communities get group = communityIndex.
    validated_by_id = {f["id"]: f for f in validated_functions if f.get("validated")}
    file_to_group: dict[str, str] = {}
    id_to_name: dict[str, str] = {}
    for f in merged_functions:
        if not f.get("validated"):
            continue
        group_value = str(f["id"])
        id_to_name[group_value] = str(f.get("name") or group_value)
        for fp in f.get("files", []):
            file_to_group[fp] = group_value

    nodes_vis: list[dict[str, Any]] = []
    for fp in G_dir.nodes():
        degree = int(G_und.degree(fp))
        meta = (lookup.get("fileMeta") or {}).get(fp) or {}
        grp = file_to_group.get(fp, "unassigned")
        nodes_vis.append(
            {
                "id": fp,
                "label": meta.get("label") or node_label(fp, lookup),
                "className": meta.get("className") or _safe_basename(fp),
                "fullPath": fp,
                "group": grp,
                "groupLabel": group_label_for_id(grp, id_to_name),
                "file": fp,
                "size": max(5, degree),
                "type": "file",
            }
        )

    edges_vis: list[dict[str, Any]] = []
    for u, v, d in G_dir.edges(data=True):
        edges_vis.append(
            {
                "from": u,
                "to": v,
                "label": d.get("relation", "uses"),
                "confidence": d.get("confidence", "EXTRACTED"),
                "weight": d.get("weight", 1.0),
            }
        )

    graph_json_path.write_text(
        json.dumps(
            {
                "nodes": nodes_vis,
                "edges": edges_vis,
                "groups": build_groups_metadata(merged_functions),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    try:
        from graph_analyses import run_all_analyses

        run_all_analyses(config)
    except Exception:
        pass

    return {
        "communitiesCount": len(communities_raw),
        "functionalFunctionsCount": len(merged_functions),
        "autoValidated": auto_validate,
        "functionalMapReady": auto_validate,
    }

