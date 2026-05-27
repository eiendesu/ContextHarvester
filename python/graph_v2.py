"""Typed graph builder v5 — detail graph + derived file view."""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import networkx as nx

from common import emit_progress, harvester_root
from symbol_index import load_symbol_index


def _load_json(repo: Path, name: str) -> dict[str, Any]:
    p = harvester_root(repo) / name
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _aggregate_file_edges(detail_edges: list[dict[str, Any]], node_by_id: dict[str, dict]) -> list[dict[str, Any]]:
    agg: dict[tuple[str, str], float] = defaultdict(float)
    for e in detail_edges:
        st = node_by_id.get(e["source"], {})
        tt = node_by_id.get(e["target"], {})
        sf = st.get("filePath") or ""
        tf = tt.get("filePath") or ""
        if not sf or not tf or sf == tf:
            continue
        et = e.get("type", "references")
        if et == "contains":
            continue
        key = (sf, tf)
        agg[key] += float(e.get("weight", 1.0))
    return [
        {
            "from": u,
            "to": v,
            "label": "aggregated",
            "weight": w,
            "confidence": "DERIVED",
            "type": "maps_to_file",
        }
        for (u, v), w in agg.items()
    ]


def _build_expansion_index(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    by_file: dict[str, dict[str, Any]] = {}
    for n in nodes:
        fp = n.get("filePath")
        if not fp:
            continue
        entry = by_file.setdefault(fp, {"nodeIds": [], "edgeIds": []})
        entry["nodeIds"].append(n["id"])
    for i, e in enumerate(edges):
        st = e.get("source", "")
        for fp, entry in by_file.items():
            if any(nid == st for nid in entry["nodeIds"]):
                entry["edgeIds"].append(i)
    return {"version": "5.0", "files": by_file}


def _build_impact_index(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    upstream: dict[str, list[str]] = defaultdict(list)
    downstream: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if e.get("type") == "contains":
            continue
        s, t = e.get("source"), e.get("target")
        if s and t:
            downstream[s].append(t)
            upstream[t].append(s)
    return {
        "version": "5.0",
        "upstream": {k: sorted(set(v)) for k, v in upstream.items()},
        "downstream": {k: sorted(set(v)) for k, v in downstream.items()},
        "nodeCount": len(nodes),
    }


def run_graph_v2(config: dict[str, Any], file_groups: dict[str, str] | None = None) -> dict[str, Any]:
    """Build graph_detail.json, graph_file.json, expansion + impact indexes."""
    repo = Path(config["repoPath"]).resolve()
    harv = harvester_root(repo)

    emit_progress("graph_v2", "Loading v2 indexes", 0, 1)
    sym_v2 = _load_json(repo, "symbol_index_v2.json")
    api_links = _load_json(repo, "api_links.json")
    legacy_sym = load_symbol_index(repo)

    nodes: list[dict[str, Any]] = list(sym_v2.get("nodes") or [])
    edges: list[dict[str, Any]] = list(sym_v2.get("edges") or [])
    node_by_id = {n["id"]: n for n in nodes}

    # Legacy file→file uses from symbol_index
    symbols = legacy_sym.get("symbols", {})
    usages = legacy_sym.get("usages", {})
    file_nodes = {n["filePath"]: n["id"] for n in nodes if n.get("type") == "file"}
    for sym, sinfo in symbols.items():
        def_file = sinfo.get("file", "")
        if not def_file:
            continue
        for uf in usages.get(sym, []) or []:
            if uf == def_file:
                continue
            sid = file_nodes.get(uf)
            tid = file_nodes.get(def_file)
            if sid and tid:
                edges.append(
                    {
                        "source": sid,
                        "target": tid,
                        "type": "references",
                        "weight": 1.0,
                        "confidence": 0.8,
                        "origin": "symbol_index",
                    }
                )

    # API cross-layer edges
    for link in api_links.get("links") or []:
        conf = float(link.get("confidence", 0.5))
        et = "http_calls" if conf >= 0.9 else "http_calls_inferred"
        # find client method node
        cid = None
        eid = None
        for n in nodes:
            if n.get("filePath") == link.get("clientFile") and n.get("type") in (
                "api_client_method",
                "method",
            ):
                if n.get("label") == link.get("clientFunction") or not link.get("clientFunction"):
                    cid = n["id"]
                    break
        for n in nodes:
            if n.get("filePath") == link.get("backendFile") and n.get("type") == "method":
                if link.get("backendAction", "").endswith("." + n.get("label", "")):
                    eid = n["id"]
                    break
        if not eid:
            eid = _ensure_endpoint_node(nodes, node_by_id, link)
        if cid and eid:
            edges.append(
                {
                    "source": cid,
                    "target": eid,
                    "type": et,
                    "weight": conf,
                    "confidence": conf,
                    "origin": "api_matcher",
                }
            )
            edges.append(
                {
                    "source": eid,
                    "target": cid,
                    "type": "served_by",
                    "weight": conf,
                    "confidence": conf,
                    "origin": "api_matcher",
                }
            )

    # File-level nodes for graph_file
    file_edges = _aggregate_file_edges(edges, node_by_id)
    file_nodes_vis: list[dict[str, Any]] = []
    for n in nodes:
        if n.get("type") != "file":
            continue
        fp = n.get("filePath", "")
        grp = (file_groups or {}).get(fp, "unassigned")
        file_nodes_vis.append(
            {
                "id": fp,
                "label": n.get("label", fp),
                "fullPath": fp,
                "group": grp,
                "type": "file",
                "detailNodeId": n["id"],
            }
        )

    detail = {"version": "5.0", "nodes": nodes, "edges": edges}
    graph_file = {
        "version": "5.0",
        "nodes": file_nodes_vis,
        "edges": file_edges,
        "groups": [],
    }
    expansion = _build_expansion_index(nodes, edges)
    impact = _build_impact_index(nodes, edges)

    harv.mkdir(parents=True, exist_ok=True)
    (harv / "graph_detail.json").write_text(
        json.dumps(detail, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (harv / "graph_file.json").write_text(
        json.dumps(graph_file, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (harv / "graph_expansion_index.json").write_text(
        json.dumps(expansion, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (harv / "impact_index.json").write_text(
        json.dumps(impact, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    emit_progress("graph_v2", "Graph v2 written", 1, 1)
    return {
        "detailNodes": len(nodes),
        "detailEdges": len(edges),
        "fileNodes": len(file_nodes_vis),
        "fileEdges": len(file_edges),
    }


def _ensure_endpoint_node(
    nodes: list[dict[str, Any]],
    node_by_id: dict[str, dict],
    link: dict[str, Any],
) -> str:
    eid = f"endpoint:{link.get('backendFile')}:{link.get('backendRoute')}"
    if eid not in node_by_id:
        n = {
            "id": eid,
            "type": "api_endpoint",
            "label": f"{link.get('backendMethod')} {link.get('backendRoute')}",
            "qualifiedName": link.get("backendAction", ""),
            "filePath": link.get("backendFile", ""),
            "lineStart": 0,
            "lineEnd": 0,
            "language": "csharp",
            "parentId": None,
            "visibility": "public",
        }
        nodes.append(n)
        node_by_id[eid] = n
    return eid


def impact_analysis_v2(
    repo: Path,
    node_id: str,
    *,
    max_depth: int = 3,
    direction: str = "downstream",
    mode: str = "transitive",
) -> dict[str, Any]:
    """Impact on typed graph using impact_index.json."""
    idx = _load_json(repo, "impact_index.json")
    detail = _load_json(repo, "graph_detail.json")
    node_by_id = {n["id"]: n for n in detail.get("nodes") or []}

    if direction == "upstream":
        adj = idx.get("upstream") or {}
    else:
        adj = idx.get("downstream") or {}

    visited: set[str] = set()
    layers: dict[int, list[dict[str, Any]]] = {}
    frontier = [node_id]
    depth = 0
    while frontier and depth < max_depth:
        depth += 1
        next_f: list[str] = []
        layer_items: list[dict[str, Any]] = []
        for nid in frontier:
            if nid in visited:
                continue
            visited.add(nid)
            n = node_by_id.get(nid, {})
            layer_items.append(
                {
                    "id": nid,
                    "label": n.get("label", nid),
                    "type": n.get("type"),
                    "file": n.get("filePath"),
                }
            )
            for nb in adj.get(nid, []):
                if nb not in visited:
                    next_f.append(nb)
        if layer_items:
            layers[depth] = layer_items
        frontier = next_f
        if mode == "direct" and depth >= 1:
            break

    return {
        "node": node_id,
        "direction": direction,
        "mode": mode,
        "total": sum(len(v) for v in layers.values()),
        "impact": layers,
    }
