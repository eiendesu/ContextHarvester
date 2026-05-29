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


def _build_name_lookup(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    """Build name lookup tables for call edge resolution."""
    by_class: dict[str, str] = {}
    by_class_lower: dict[str, str] = {}
    node_to_class: dict[str, str] = {}
    node_to_file: dict[str, str] = {}
    interfaces: dict[str, str] = {}
    file_to_node_id: dict[str, str] = {}

    for n in nodes:
        nid = n["id"]
        ntype = n.get("type", "")
        label = n.get("label", "")
        fp = n.get("filePath", "")
        qname = n.get("qualifiedName", "")

        node_to_file[nid] = fp
        if ntype == "file":
            file_to_node_id[fp] = nid

        if ntype in ("class", "dto", "record"):
            by_class[label] = nid
            by_class_lower[label.lower()] = nid
            node_to_class[nid] = label
            # heuristic: ILeadService -> LeadService if single impl
            if label.startswith("I") and len(label) > 1:
                concrete = label[1:]
                if concrete in by_class:
                    interfaces[label] = concrete

        if ntype == "method" and qname:
            node_to_class[nid] = qname.split(".")[0] if "." in qname else label

    return {
        "byClassName": by_class,
        "byClassNameLower": by_class_lower,
        "nodeToClass": node_to_class,
        "nodeToFile": node_to_file,
        "interfaces": interfaces,
        "fileToNodeId": file_to_node_id,
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

    # Import graph (TypeScript)
    import_g = _load_json(repo, "import_graph.json")
    for ie in import_g.get("edges") or []:
        sf, tf = ie.get("from"), ie.get("to")
        sid, tid = file_nodes.get(sf), file_nodes.get(tf)
        if sid and tid and sid != tid:
            edges.append(
                {
                    "source": sid,
                    "target": tid,
                    "type": "imports",
                    "weight": 1.0,
                    "confidence": 0.9,
                    "origin": "import_graph",
                }
            )

    # Caller → API client (consumer imports api file)
    for c in import_g.get("callers") or []:
        cf, af = c.get("consumerFile"), c.get("apiFile")
        sid, tid = file_nodes.get(cf), file_nodes.get(af)
        if sid and tid:
            edges.append(
                {
                    "source": sid,
                    "target": tid,
                    "type": "imports",
                    "weight": 1.0,
                    "confidence": 0.85,
                    "origin": "import_graph",
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

    node_by_id = {n["id"]: n for n in nodes}

    # Call edge resolution (Fase 1 + Fase 2)
    raw_cs = _load_json(repo, "call_edges_raw_cs.json").get("calls", [])
    raw_ts = _load_json(repo, "call_edges_raw_ts.json").get("calls", [])

    if raw_cs or raw_ts:
        name_lookup = _build_name_lookup(nodes)
        settings = {
            "enableDIResolution": config.get("callEdges", {}).get("enableDIResolution", True)
            if isinstance(config.get("callEdges"), dict)
            else True,
        }
        from phase_call_resolution import resolve_all_call_edges, save_call_edge_results

        resolved = resolve_all_call_edges(raw_cs, raw_ts, name_lookup, settings)
        save_call_edge_results(repo, resolved, raw_cs, raw_ts)

        # Add "calls" edges to graph_detail
        for call in resolved:
            from_file = call.get("fromFile", "")
            to_file = call.get("toFile", "")
            to_node_id = call.get("toNodeId", "")
            if not from_file or not to_file or not to_node_id:
                continue
            from_node_id = name_lookup.get("fileToNodeId", {}).get(from_file)
            if from_node_id and from_node_id != to_node_id:
                edges.append({
                    "source": from_node_id,
                    "target": to_node_id,
                    "type": "calls",
                    "weight": 1.0,
                    "confidence": 0.9,
                    "origin": call.get("resolvedBy", "phase1"),
                    "callDetail": {
                        "fromMethod": call.get("fromMethod", ""),
                        "toMethod": call.get("targetMethod", ""),
                        "line": call.get("line", 0),
                    },
                })

    node_by_id = {n["id"]: n for n in nodes}

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


_CROSS_LAYER_TYPES = frozenset(
    {"http_calls", "http_calls_inferred", "served_by", "imports", "api_endpoint", "api_client_method"}
)


def _filtered_adjacency(
    repo: Path,
    direction: str,
    cross_layer: bool,
) -> dict[str, list[str]]:
    detail = _load_json(repo, "graph_detail.json")
    upstream: dict[str, list[str]] = defaultdict(list)
    downstream: dict[str, list[str]] = defaultdict(list)
    for e in detail.get("edges") or []:
        if e.get("type") == "contains":
            continue
        if cross_layer and e.get("type") not in _CROSS_LAYER_TYPES:
            continue
        s, t = e.get("source"), e.get("target")
        if s and t:
            downstream[s].append(t)
            upstream[t].append(s)
    if direction == "upstream":
        return {k: sorted(set(v)) for k, v in upstream.items()}
    return {k: sorted(set(v)) for k, v in downstream.items()}


def impact_analysis_v2(
    repo: Path,
    node_id: str,
    *,
    max_depth: int = 3,
    direction: str = "downstream",
    mode: str = "transitive",
    cross_layer: bool = False,
) -> dict[str, Any]:
    """Impact on typed graph using impact_index or filtered detail edges."""
    detail = _load_json(repo, "graph_detail.json")
    node_by_id = {n["id"]: n for n in detail.get("nodes") or []}

    if cross_layer:
        adj = _filtered_adjacency(repo, direction, True)
    else:
        idx = _load_json(repo, "impact_index.json")
        adj = idx.get("upstream" if direction == "upstream" else "downstream") or {}

    # resolve node_id by label/file if not exact id
    if node_id not in node_by_id:
        q = node_id.lower()
        for n in detail.get("nodes") or []:
            if n.get("id") == node_id:
                break
            if q in (n.get("label") or "").lower() or q in (n.get("filePath") or "").lower():
                node_id = n["id"]
                break

    visited: set[str] = set()
    layers: dict[int, list[dict[str, Any]]] = {}
    frontier = [node_id]
    depth = 0
    path_edges: list[dict[str, str]] = []
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
                    "qualifiedName": n.get("qualifiedName"),
                }
            )
            for nb in adj.get(nid, []):
                if nb not in visited:
                    next_f.append(nb)
                    path_edges.append({"from": nid, "to": nb})
        if layer_items:
            layers[depth] = layer_items
        frontier = next_f
        if mode == "direct" and depth >= 1:
            break

    return {
        "node": node_id,
        "direction": direction,
        "mode": mode,
        "crossLayer": cross_layer,
        "total": sum(len(v) for v in layers.values()),
        "impact": layers,
        "pathEdges": path_edges[:200],
    }


def find_path_v2(
    repo: Path,
    source_id: str,
    target_id: str,
    *,
    max_depth: int = 12,
    cross_layer: bool = False,
) -> dict[str, Any]:
    """BFS shortest path between two detail nodes."""
    detail = _load_json(repo, "graph_detail.json")
    node_by_id = {n["id"]: n for n in detail.get("nodes") or []}
    adj = _filtered_adjacency(repo, "downstream", cross_layer) if cross_layer else _load_json(repo, "impact_index.json").get("downstream", {})

    if source_id not in node_by_id or target_id not in node_by_id:
        for n in detail.get("nodes") or []:
            lid = n.get("id", "")
            if source_id not in node_by_id and source_id.lower() in (n.get("label") or "").lower():
                source_id = lid
            if target_id not in node_by_id and target_id.lower() in (n.get("label") or "").lower():
                target_id = lid

    queue: list[tuple[str, list[str]]] = [(source_id, [source_id])]
    seen = {source_id}
    while queue:
        cur, path = queue.pop(0)
        if len(path) > max_depth:
            continue
        if cur == target_id:
            return {
                "found": True,
                "length": len(path) - 1,
                "path": [
                    {
                        "id": pid,
                        "label": node_by_id.get(pid, {}).get("label", pid),
                        "type": node_by_id.get(pid, {}).get("type"),
                    }
                    for pid in path
                ],
            }
        for nb in adj.get(cur, []):
            if nb not in seen:
                seen.add(nb)
                queue.append((nb, path + [nb]))
    return {"found": False, "source": source_id, "target": target_id}


def search_nodes_v2(
    repo: Path,
    query: str,
    *,
    node_type: str = "",
    limit: int = 50,
) -> list[dict[str, Any]]:
    detail = _load_json(repo, "graph_detail.json")
    q = (query or "").lower().strip()
    if not q:
        return []
    out: list[dict[str, Any]] = []
    for n in detail.get("nodes") or []:
        if node_type and n.get("type") != node_type:
            continue
        hay = f"{n.get('label','')} {n.get('qualifiedName','')} {n.get('filePath','')} {n.get('id','')}".lower()
        if q in hay:
            out.append(
                {
                    "id": n.get("id"),
                    "label": n.get("label"),
                    "type": n.get("type"),
                    "filePath": n.get("filePath"),
                }
            )
        if len(out) >= limit:
            break
    return out
