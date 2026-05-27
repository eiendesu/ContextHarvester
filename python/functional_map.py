"""Load/save functional_map.json and refresh graph.json group colors."""
from __future__ import annotations

import json
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import networkx as nx

from common import harvester_root


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(repo_path: str | Path) -> dict[str, Any]:
    p = harvester_root(repo_path) / "functional_map.json"
    if not p.exists():
        return {"version": "1.0", "functionalMapReady": False, "functions": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"version": "1.0", "functionalMapReady": False, "functions": []}


def save(repo_path: str | Path, data: dict[str, Any]) -> Path:
    p = harvester_root(repo_path) / "functional_map.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    data["lastUpdated"] = _utc_now_iso()
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return p


def validated_functions(fmap: dict[str, Any]) -> list[dict[str, Any]]:
    if not fmap.get("functionalMapReady"):
        return []
    return [f for f in (fmap.get("functions") or []) if isinstance(f, dict) and f.get("validated")]


def find_function(fmap: dict[str, Any], name_or_id: str) -> dict[str, Any] | None:
    key = (name_or_id or "").strip().lower()
    for f in fmap.get("functions") or []:
        if not isinstance(f, dict):
            continue
        if str(f.get("id", "")).lower() == key or str(f.get("name", "")).lower() == key:
            return f
    return None


def build_groups_metadata(functions: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Catalog for graph UI: human-readable names keyed by function id."""
    out: list[dict[str, Any]] = []
    for f in functions or []:
        if not isinstance(f, dict) or not f.get("validated"):
            continue
        fid = str(f.get("id", "")).strip()
        if not fid:
            continue
        out.append({
            "id": fid,
            "name": str(f.get("name") or fid),
            "source": str(f.get("source") or "leiden"),
            "fileCount": len(f.get("files") or []),
        })
    out.sort(key=lambda x: x["name"].lower())
    return out


def group_label_for_id(group_id: str | None, id_to_name: dict[str, str]) -> str:
    if not group_id or group_id == "unassigned":
        return "Non assegnati"
    return id_to_name.get(group_id, group_id)


def refresh_graph_json(repo_path: str | Path) -> None:
    """Update graph.json node groups from validated functions."""
    repo = Path(repo_path).resolve()
    harv = harvester_root(repo)
    graph_path = harv / "graph.json"
    if not graph_path.exists():
        return

    fmap = load(repo)
    file_to_group: dict[str, str] = {}
    id_to_name: dict[str, str] = {}
    for f in fmap.get("functions") or []:
        if not isinstance(f, dict):
            continue
        if not f.get("validated"):
            continue
        gid = str(f["id"])
        id_to_name[gid] = str(f.get("name") or gid)
        for fp in f.get("files") or []:
            file_to_group[str(fp)] = gid

    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except Exception:
        return

    for node in graph.get("nodes") or []:
        fp = node.get("file") or node.get("id")
        if fp:
            grp = file_to_group.get(str(fp), "unassigned")
            node["group"] = grp
            node["groupLabel"] = group_label_for_id(grp, id_to_name)

    graph["groups"] = build_groups_metadata(fmap.get("functions"))
    graph_path.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")


def get_graph_stats(repo_path: str | Path) -> dict[str, Any]:
    harv = harvester_root(repo_path)
    stats: dict[str, Any] = {"nodes": 0, "edges": 0, "communities": 0}
    pkl = harv / "graphify_graph.pkl"
    if pkl.exists():
        try:
            with pkl.open("rb") as f:
                g = pickle.load(f)
            if isinstance(g, nx.Graph):
                stats["nodes"] = g.number_of_nodes()
                stats["edges"] = g.number_of_edges()
        except Exception:
            pass
    raw = harv / "communities_raw.json"
    if raw.exists():
        try:
            data = json.loads(raw.read_text(encoding="utf-8"))
            stats["communities"] = len(data.get("communities") or [])
        except Exception:
            pass
    fmap = load(repo_path)
    funcs = fmap.get("functions") or []
    stats["functions"] = len(funcs)
    stats["validated"] = sum(1 for f in funcs if isinstance(f, dict) and f.get("validated"))
    stats["functionalMapReady"] = bool(fmap.get("functionalMapReady"))
    return stats
