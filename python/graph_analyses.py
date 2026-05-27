"""Codebase graph analyses (NetworkX, no AI)."""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import networkx as nx

from common import harvester_root
from functional_map import load as load_functional_map
from label_first import load_graph_pickle
from name_lookup import load_name_lookup, node_label, resolve_node_id


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git_commit_counts(repo: Path, days: int) -> dict[str, int]:
    counts: dict[str, int] = {}
    try:
        out = subprocess.run(
            [
                "git", "log",
                f"--since={days} days ago",
                "--name-only",
                "--pretty=format:",
            ],
            cwd=str(repo),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if out.returncode != 0:
            return counts
        for line in out.stdout.splitlines():
            line = line.strip().replace("\\", "/")
            if line:
                counts[line] = counts.get(line, 0) + 1
    except Exception:
        pass
    return counts


def _entry_point_files(repo: Path, patterns: list[str]) -> set[str]:
    found: set[str] = set()
    pats = [p.lower() for p in patterns]
    for path in repo.rglob("*"):
        if not path.is_file():
            continue
        rel = path.as_posix()
        name = path.name.lower()
        for pat in pats:
            if pat in name or pat in rel.lower():
                found.add(rel)
                break
    return found


def impact_analysis(
    repo: Path,
    node_id: str,
    *,
    max_depth: int = 3,
    lookup: dict[str, Any] | None = None,
) -> dict[str, Any]:
    graph = load_graph_pickle(repo)
    if graph is None:
        return {"error": "Grafo non trovato", "node": node_id, "impact": {}, "total": 0}

    lookup = lookup or load_name_lookup(repo)
    resolved = resolve_node_id(node_id, lookup) or node_id
    if not graph.has_node(resolved):
        return {"error": f"Nodo non trovato: {node_id}", "node": node_id, "impact": {}, "total": 0}

    G = graph.to_undirected()
    results: dict[int, list[dict[str, Any]]] = {}
    lengths = nx.single_source_shortest_path_length(G, resolved, cutoff=max_depth)

    for n, dist in lengths.items():
        if dist == 0 or dist > max_depth:
            continue
        results.setdefault(dist, []).append({
            "id": n,
            "label": node_label(n, lookup),
            "file": n,
            "fullPath": n,
        })

    total = sum(len(v) for v in results.values())
    return {
        "node": resolved,
        "label": node_label(resolved, lookup),
        "impact": {str(k): v for k, v in sorted(results.items())},
        "total": total,
    }


def run_all_analyses(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    graph = load_graph_pickle(repo)
    if graph is None:
        return {"error": "Grafo non trovato", "analyzedAt": _utc_now()}

    lookup = load_name_lookup(repo)
    entry_patterns = config.get("analysisEntryPointPatterns") or [
        "Controller", "Program.cs", "Startup.cs", "Page.tsx", "App.tsx", "index.ts",
    ]
    entry_points = _entry_point_files(repo, entry_patterns)
    git_days = int(config.get("analysisGitLogDays", 90))
    git_log = _git_commit_counts(repo, git_days)
    similarity_threshold = float(config.get("analysisFunctionSimilarityThreshold", 0.3))

    # Dead code
    dead_code: list[dict[str, str]] = []
    for n in graph.nodes:
        rel = str(n)
        if graph.in_degree(n) == 0 and rel not in entry_points:
            dead_code.append({"id": rel, "label": node_label(rel, lookup), "file": rel})

    # Circular deps
    circular: list[list[str]] = []
    try:
        for cycle in nx.simple_cycles(graph):
            if len(cycle) <= 8:
                circular.append([node_label(c, lookup) for c in cycle])
            if len(circular) >= 20:
                break
    except Exception:
        pass

    # Hotspot
    G_und = graph.to_undirected()
    try:
        centrality = nx.betweenness_centrality(G_und)
    except Exception:
        centrality = {n: 0.0 for n in graph.nodes}

    hotspots: list[dict[str, Any]] = []
    for n in graph.nodes:
        rel = str(n)
        c = centrality.get(n, 0.0)
        commits = git_log.get(rel, 0)
        score = c * (1 + commits)
        hotspots.append({
            "id": rel,
            "label": node_label(rel, lookup),
            "centrality": round(c, 4),
            "recentCommits": commits,
            "score": round(score, 4),
            "degree": int(G_und.degree(n)),
        })
    hotspots.sort(key=lambda x: x["score"], reverse=True)
    hotspots = hotspots[:20]

    # Test gap — classes without *Test* / *.Tests.* sibling
    fmap = load_functional_map(repo)
    test_files = {str(f).lower() for f in repo.rglob("*") if f.is_file() and "test" in f.name.lower()}
    test_gap: list[dict[str, str]] = []
    for n in list(graph.nodes)[:500]:
        rel = str(n)
        if not rel.endswith(".cs"):
            continue
        stem = Path(rel).stem
        if any(stem.lower() in tf for tf in test_files):
            continue
        if graph.in_degree(n) > 2:
            test_gap.append({"id": rel, "label": node_label(rel, lookup), "file": rel})
        if len(test_gap) >= 50:
            break

    # Similar functions (Jaccard on files)
    similar: list[dict[str, Any]] = []
    funcs = [f for f in (fmap.get("functions") or []) if isinstance(f, dict) and f.get("validated")]
    for i, f1 in enumerate(funcs):
        s1 = set(f1.get("files") or [])
        if not s1:
            continue
        for f2 in funcs[i + 1 :]:
            s2 = set(f2.get("files") or [])
            if not s2:
                continue
            inter = len(s1 & s2)
            union = len(s1 | s2)
            if union == 0:
                continue
            j = inter / union
            if j >= similarity_threshold:
                similar.append({
                    "f1": f1.get("name"),
                    "f2": f2.get("name"),
                    "shared": inter,
                    "similarity": round(j, 3),
                })
    similar.sort(key=lambda x: x["similarity"], reverse=True)

    from graph_api_edges import find_api_edges

    api_edges = find_api_edges(repo, config)

    result = {
        "analyzedAt": _utc_now(),
        "deadCode": dead_code[:50],
        "circularDeps": circular[:20],
        "hotspots": hotspots,
        "testGap": test_gap[:50],
        "similarFunctions": similar[:20],
        "apiEdges": api_edges[:50],
        "counts": {
            "deadCode": len(dead_code),
            "circularDeps": len(circular),
            "hotspots": len(hotspots),
            "testGap": len(test_gap),
            "similarFunctions": len(similar),
            "apiEdges": len(api_edges),
        },
    }

    cache_path = harvester_root(repo) / "graph_analysis.json"
    cache_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return result


def load_cached_analyses(repo: Path) -> dict[str, Any]:
    p = harvester_root(repo) / "graph_analysis.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
