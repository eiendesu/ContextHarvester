"""Layer 3 — Graph Report (NetworkX only, no AI)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import networkx as nx
import pickle

from common import emit_progress, harvester_root


def _load_functional_map(repo: Path) -> dict[str, Any] | None:
    p = harvester_root(repo) / "functional_map.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def run(config: dict[str, Any]) -> Path:
    repo = Path(config["repoPath"]).resolve()
    harv_root = Path(harvester_root(repo)).resolve()
    graph_pkl = harv_root / "graphify_graph.pkl"
    out_md = harv_root / "GRAPH_REPORT.md"

    if not graph_pkl.exists():
        # Nothing to do yet; still write a stub so UI can show something.
        out_md.write_text("# Graph Report\n\nNessuna analisi funzionale trovata. Esegui prima functional analysis.\n", encoding="utf-8")
        return out_md

    emit_progress("graph_report", "Generazione GRAPH_REPORT.md")
    with graph_pkl.open("rb") as f:
        # phase_graph stores a DiGraph, but reports are easier on undirected
        G = pickle.load(f)

    G_und = G.to_undirected()

    func_map = _load_functional_map(repo) or {}
    functions = func_map.get("functions", []) if isinstance(func_map.get("functions"), list) else []
    validated_ids = {f.get("id") for f in functions if f.get("validated")}
    file_to_function: dict[str, str] = {}
    for f in functions:
        fid = f.get("id")
        if not fid or not f.get("files"):
            continue
        if fid in validated_ids:
            for fp in f.get("files", []):
                file_to_function[str(fp)] = str(fid)

    # God nodes = top degree
    god = sorted(G_und.degree(), key=lambda x: x[1], reverse=True)[:10]

    # Bridge nodes = top node betweenness
    bridges = nx.betweenness_centrality(G_und)
    bridge_sorted = sorted(bridges.items(), key=lambda x: x[1], reverse=True)[:10]

    # Isolated nodes
    isolated = list(nx.isolates(G_und))
    isolated = [n for n in isolated if G_und.degree(n) == 0]

    # Surprising edges: edges crossing different function groups (or unassigned)
    surprises: list[dict[str, Any]] = []
    for u, v, d in G_und.edges(data=True):
        fu = file_to_function.get(u, "")
        fv = file_to_function.get(v, "")
        if fu and fv and fu != fv:
            surprises.append(
                {
                    "source": u,
                    "target": v,
                    "relation": d.get("relation", "uses"),
                    "confidence": d.get("confidence", "EXTRACTED"),
                    "note": f"Cross-function ({fu} ↔ {fv})",
                }
            )
    surprises = surprises[:25]

    # Community density (file-group density)
    community_density: dict[str, float] = {}
    if validated_ids:
        for fid in validated_ids:
            nodes = [fp for fp, fgid in file_to_function.items() if fgid == fid]
            if len(nodes) < 2:
                continue
            sub = G_und.subgraph(nodes)
            actual = sub.number_of_edges()
            possible = len(nodes) * (len(nodes) - 1) / 2
            community_density[str(fid)] = round(actual / possible, 3) if possible else 0.0

    today = __import__("datetime").date.today().isoformat()
    lines: list[str] = [
        f"# Graph Report — {Path(repo).name}",
        f"Generato: {today} | Nodi: {G_und.number_of_nodes()} | Edge: {G_und.number_of_edges()}",
        "",
        "## God Nodes (più connessi)",
        "| Nodo | Connessioni | Funzione |",
        "|---|---:|---|",
    ]
    for n, deg in god:
        lines.append(f"| `{Path(str(n)).name}` | {int(deg)} | {file_to_function.get(str(n), '-')} |")

    lines += ["", "## Bridge Nodes (betweenness)", "| Nodo | Betweenness | Funzione |", "|---|---:|---|"]
    for n, score in bridge_sorted:
        lines.append(f"| `{Path(str(n)).name}` | {score:.4f} | {file_to_function.get(str(n), '-')} |")

    lines += ["", "## Surprising Connections", ""]
    if surprises:
        for s in surprises:
            lines.append(f"- `{Path(str(s['source'])).name}` → `{Path(str(s['target'])).name}` ({s['relation']}, {s['confidence']}) — {s['note']}")
    else:
        lines.append("- Nessuna connessione cross-funzione evidente.")

    lines += ["", "## Nodi isolati (nessuna connessione rilevata)", ""]
    if isolated:
        for n in isolated[:30]:
            lines.append(f"- `{Path(str(n)).name}`")
        if len(isolated) > 30:
            lines.append(f"- ... (+{len(isolated) - 30} altri)")
    else:
        lines.append("- Nessun nodo isolato rilevato.")

    if community_density:
        lines += ["", "## Density per funzione", ""]
        for fid, dens in sorted(community_density.items(), key=lambda x: x[1], reverse=True):
            lines.append(f"- `{fid}`: {dens}")

    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out_md

