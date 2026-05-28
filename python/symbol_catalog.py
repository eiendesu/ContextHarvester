"""Catalogo simboli per Graph View — symbol_index_v2 con fallback legacy."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import harvester_root, load_symbol_index

BROWSEABLE_TYPES = frozenset(
    {
        "method",
        "class",
        "dto",
        "interface",
        "api_endpoint",
        "api_client_method",
        "api_client_file",
        "function",
    }
)

TYPE_LABELS = {
    "method": "Metodo",
    "class": "Classe",
    "dto": "DTO",
    "interface": "Interfaccia",
    "api_endpoint": "Endpoint",
    "api_client_method": "API client",
    "api_client_file": "File API",
    "function": "Funzione",
}


def _compact(node: dict[str, Any]) -> dict[str, Any]:
    t = str(node.get("type") or "unknown")
    label = str(node.get("label") or node.get("id") or "")
    qn = str(node.get("qualifiedName") or label)
    fp = str(node.get("filePath") or "")
    return {
        "id": node.get("id"),
        "type": t,
        "typeLabel": TYPE_LABELS.get(t, t),
        "label": label,
        "qualifiedName": qn,
        "filePath": fp,
        "lineStart": int(node.get("lineStart") or node.get("line") or 1),
        "visibility": node.get("visibility"),
        "language": node.get("language"),
    }


def _from_v2(repo: Path) -> list[dict[str, Any]]:
    p = harvester_root(repo) / "symbol_index_v2.json"
    if not p.is_file():
        return []
    data = json.loads(p.read_text(encoding="utf-8"))
    out: list[dict[str, Any]] = []
    for n in data.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t not in BROWSEABLE_TYPES:
            continue
        out.append(_compact(n))
    return out


def _from_detail(repo: Path) -> list[dict[str, Any]]:
    p = harvester_root(repo) / "graph_detail.json"
    if not p.is_file():
        return []
    data = json.loads(p.read_text(encoding="utf-8"))
    out: list[dict[str, Any]] = []
    for n in data.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t not in BROWSEABLE_TYPES:
            continue
        out.append(_compact(n))
    return out


def _from_legacy(repo: Path) -> list[dict[str, Any]]:
    idx = load_symbol_index(repo)
    symbols = idx.get("symbols") or {}
    out: list[dict[str, Any]] = []
    for name, info in symbols.items():
        if not isinstance(info, dict):
            continue
        t = str(info.get("type") or "unknown")
        if t not in BROWSEABLE_TYPES:
            continue
        fp = str(info.get("file") or "")
        ns = str(info.get("namespace") or "")
        qn = f"{ns}.{name}".strip(".") if ns else name
        out.append(
            {
                "id": f"legacy:{name}:{fp}",
                "type": t,
                "typeLabel": TYPE_LABELS.get(t, t),
                "label": name,
                "qualifiedName": qn,
                "filePath": fp,
                "lineStart": int(info.get("line") or 1),
                "visibility": None,
                "language": None,
            }
        )
    return out


def load_symbol_catalog(repo: Path) -> tuple[list[dict[str, Any]], str]:
    """Ritorna (simboli, fonte)."""
    v2 = _from_v2(repo)
    if v2:
        v2.sort(key=lambda s: (s["type"], s["label"].lower(), s["filePath"]))
        return v2, "symbol_index_v2"
    detail = _from_detail(repo)
    if detail:
        detail.sort(key=lambda s: (s["type"], s["label"].lower(), s["filePath"]))
        return detail, "graph_detail"
    legacy = _from_legacy(repo)
    legacy.sort(key=lambda s: (s["type"], s["label"].lower(), s["filePath"]))
    return legacy, "symbol_index"


def search_symbols(
    repo: Path,
    *,
    q: str = "",
    type_filter: str = "",
    limit: int = 0,
    offset: int = 0,
) -> dict[str, Any]:
    symbols, source = load_symbol_catalog(repo)
    if not symbols:
        return {
            "symbols": [],
            "total": 0,
            "source": source,
            "error": "Nessun indice simboli — esegui Rebuild Index con v2Symbols attivo.",
        }

    query = (q or "").lower().strip()
    types = {t.strip() for t in (type_filter or "").split(",") if t.strip()}

    filtered: list[dict[str, Any]] = []
    for s in symbols:
        if types and s["type"] not in types:
            continue
        if query:
            hay = f"{s['label']} {s['qualifiedName']} {s['filePath']} {s['type']}".lower()
            if query not in hay:
                continue
        filtered.append(s)

    total = len(filtered)
    start = max(0, offset)
    if limit and limit > 0:
        page = filtered[start : start + limit]
    else:
        page = filtered[start:]

    counts: dict[str, int] = {}
    files_seen: set[str] = set()
    for s in symbols:
        counts[s["type"]] = counts.get(s["type"], 0) + 1
        fp = s.get("filePath") or ""
        if fp:
            files_seen.add(fp)

    return {
        "symbols": page,
        "total": total,
        "catalogTotal": len(symbols),
        "fileCount": len(files_seen),
        "offset": start,
        "limit": limit,
        "source": source,
        "countsByType": counts,
    }
