"""Post-process Leiden partition — reassign low-connectivity nodes (Approccio 2)."""
from __future__ import annotations

import networkx as nx


def reassign_partition_neighbors(
    G_und: nx.Graph,
    partition: dict[str, int],
    *,
    min_degree: int = 1,
) -> dict[str, int]:
    """
    For nodes in singleton communities (or degree < min_degree in partition sense),
    assign to the community of the highest-degree neighbor.
    Idempotent when re-run on the same input.
    """
    if not partition:
        return partition

    out = dict(partition)
    # Build community sizes
    comm_sizes: dict[int, int] = {}
    for cid in out.values():
        comm_sizes[cid] = comm_sizes.get(cid, 0) + 1

    changed = True
    while changed:
        changed = False
        for node in list(out.keys()):
            cid = out[node]
            if comm_sizes.get(cid, 0) > 1:
                continue
            if G_und.degree(node) < min_degree:
                continue
            neighbors = list(G_und.neighbors(node))
            if not neighbors:
                continue
            best = max(neighbors, key=lambda n: G_und.degree(n))
            best_cid = out.get(best)
            if best_cid is None or best_cid == cid:
                continue
            if comm_sizes.get(best_cid, 0) < 1:
                continue
            comm_sizes[cid] = comm_sizes.get(cid, 1) - 1
            out[node] = best_cid
            comm_sizes[best_cid] = comm_sizes.get(best_cid, 0) + 1
            changed = True

    return out
