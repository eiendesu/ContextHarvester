"""Frontend ↔ backend API matching with confidence scores (v5 type-2)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import harvester_root
from route_normalize import route_key, segment_match_score


def build_api_links(
    repo: Path,
    api_clients: dict[str, Any],
    backend_routes: dict[str, Any],
) -> dict[str, Any]:
    links: list[dict[str, Any]] = []
    endpoints = backend_routes.get("endpoints") or []
    clients = api_clients.get("clients") or []

    by_key: dict[str, list[dict[str, Any]]] = {}
    for ep in endpoints:
        by_key.setdefault(ep.get("routeKey") or route_key(ep.get("method", "GET"), ep.get("route", "")), []).append(ep)

    for cl in clients:
        key = cl.get("routeKey") or route_key(cl.get("method", "GET"), cl.get("route", ""))
        best_ep = None
        best_conf = 0.0
        exact = by_key.get(key, [])
        if exact:
            best_ep = exact[0]
            best_conf = 1.0
        else:
            for ep in endpoints:
                if (ep.get("method") or "").upper() != (cl.get("method") or "GET").upper():
                    continue
                seg = segment_match_score(cl.get("route", ""), ep.get("route", ""))
                if seg > best_conf:
                    best_conf = seg
                    best_ep = ep
            if best_conf >= 0.85:
                best_conf = 0.9
            elif best_conf >= 0.6:
                best_conf = 0.75
            elif best_conf > 0:
                best_conf = 0.4

        if not best_ep or best_conf < 0.4:
            continue

        links.append(
            {
                "clientId": cl.get("id"),
                "clientFile": cl.get("file"),
                "clientFunction": cl.get("function"),
                "clientMethod": cl.get("method"),
                "clientRoute": cl.get("route"),
                "endpointId": best_ep.get("id"),
                "backendFile": best_ep.get("file"),
                "backendAction": best_ep.get("qualifiedName"),
                "backendMethod": best_ep.get("method"),
                "backendRoute": best_ep.get("route"),
                "confidence": round(best_conf, 2),
                "certain": best_conf >= 0.9,
            }
        )

    result = {"version": "5.0", "links": links, "count": len(links)}
    out = harvester_root(repo) / "api_links.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return result
