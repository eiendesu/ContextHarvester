"""Invoke RoslynHarvester .NET tool for C# symbols and routes (v5)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

_TOOL_DIR = Path(__file__).resolve().parent.parent / "tools" / "RoslynHarvester"

_scan_cache: dict[str, dict[str, Any] | None] = {}
_persisted_repo_keys: set[str] = set()


def clear_roslyn_scan_cache() -> None:
    _scan_cache.clear()
    _persisted_repo_keys.clear()


def _dotnet_available() -> bool:
    try:
        subprocess.run(["dotnet", "--version"], capture_output=True, check=True, timeout=15)
        return True
    except Exception:
        return False


def _execute_roslyn_scan(repo: Path, timeout_s: int = 300) -> dict[str, Any] | None:
    if not _dotnet_available():
        return None
    if not _TOOL_DIR.is_dir():
        return None
    try:
        proc = subprocess.run(
            ["dotnet", "run", "--project", str(_TOOL_DIR), "--", str(repo.resolve())],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=str(_TOOL_DIR),
        )
    except subprocess.TimeoutExpired:
        return None
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def run_roslyn_scan(
    repo: Path,
    timeout_s: int = 300,
    *,
    save: bool = True,
    trigger: str = "reindex",
    duration_ms: int | None = None,
) -> dict[str, Any] | None:
    """Return parsed JSON from RoslynHarvester; cache per processo; opzionale persist."""
    key = str(repo.resolve())
    if key not in _scan_cache:
        _scan_cache[key] = _execute_roslyn_scan(repo, timeout_s=timeout_s)
    scan = _scan_cache[key]
    if scan and save and key not in _persisted_repo_keys:
        from roslyn_store import persist_roslyn_scan

        persist_roslyn_scan(repo, scan, trigger=trigger, duration_ms=duration_ms)
        _persisted_repo_keys.add(key)
    return scan


def merge_roslyn_into_symbol_v2(
    scan: dict[str, Any],
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    file_map: dict[str, list[str]],
    entities: list[dict[str, Any]],
) -> None:
    """Append/replace nodes from Roslyn scan (origin=roslyn)."""
    existing_ids = {n["id"] for n in nodes}

    def _nid(file_rel: str, sym_type: str, name: str) -> str:
        import re

        safe = re.sub(r"[^a-zA-Z0-9]+", "-", f"{file_rel}-{sym_type}-{name}").strip("-").lower()
        return safe[:180]

    for fe in scan.get("files") or []:
        rel = fe.get("path") or ""
        if not rel:
            continue
        file_id = _nid(rel, "file", Path(rel).stem)
        if file_id not in existing_ids:
            nodes.append(
                {
                    "id": file_id,
                    "type": "file",
                    "label": Path(rel).name,
                    "qualifiedName": rel,
                    "filePath": rel,
                    "lineStart": 1,
                    "lineEnd": 1,
                    "language": "csharp",
                    "parentId": None,
                    "visibility": "public",
                    "origin": "roslyn",
                }
            )
            existing_ids.add(file_id)
            file_map.setdefault(rel, []).append(file_id)

        for cls in fe.get("classes") or []:
            name = cls.get("name") or ""
            sym_type = cls.get("kind") or "class"
            cid = _nid(rel, sym_type, name)
            if cid in existing_ids:
                continue
            nodes.append(
                {
                    "id": cid,
                    "type": sym_type,
                    "label": name,
                    "qualifiedName": name,
                    "filePath": rel,
                    "lineStart": cls.get("line", 1),
                    "lineEnd": cls.get("line", 1),
                    "language": "csharp",
                    "parentId": file_id,
                    "visibility": "public",
                    "origin": "roslyn",
                }
            )
            existing_ids.add(cid)
            file_map.setdefault(rel, []).append(cid)
            edges.append(
                {
                    "source": file_id,
                    "target": cid,
                    "type": "contains",
                    "weight": 1.0,
                    "confidence": 1.0,
                    "origin": "roslyn",
                }
            )
            if sym_type == "dto":
                entities.append({"id": cid, "name": name, "file": rel, "kind": "dto"})

        for meth in fe.get("methods") or []:
            cname = meth.get("className") or ""
            mname = meth.get("name") or ""
            cid = _nid(rel, "class", cname)
            mid = _nid(rel, "method", f"{cname}.{mname}")
            if mid in existing_ids:
                continue
            nodes.append(
                {
                    "id": mid,
                    "type": "method",
                    "label": mname,
                    "qualifiedName": meth.get("qualifiedName") or f"{cname}.{mname}",
                    "filePath": rel,
                    "lineStart": meth.get("line", 1),
                    "lineEnd": meth.get("line", 1),
                    "language": "csharp",
                    "parentId": cid if cid in existing_ids else file_id,
                    "visibility": meth.get("visibility", "public"),
                    "origin": "roslyn",
                }
            )
            existing_ids.add(mid)
            file_map.setdefault(rel, []).append(mid)
            parent = cid if cid in existing_ids else file_id
            edges.append(
                {
                    "source": parent,
                    "target": mid,
                    "type": "contains",
                    "weight": 1.0,
                    "confidence": 1.0,
                    "origin": "roslyn",
                }
            )


def roslyn_backend_endpoints(scan: dict[str, Any], repo: Path) -> list[dict[str, Any]]:
    """Convert Roslyn scan to backend_route_index endpoint records."""
    from route_normalize import expand_action_token, expand_controller_token, normalize_path, route_key

    endpoints: list[dict[str, Any]] = []
    for fe in scan.get("files") or []:
        rel = fe.get("path") or ""
        for ep in fe.get("endpoints") or []:
            controller = ep.get("controller") or ""
            class_route = expand_controller_token(ep.get("classRoute") or "", controller)
            action_route = ep.get("actionRoute") or ""
            full = normalize_path(class_route)
            if action_route:
                sub = normalize_path(action_route)
                full = normalize_path(f"{full}/{sub}") if not sub.startswith("/") else sub
            full = expand_action_token(full, ep.get("action") or "")
            verb = (ep.get("method") or "GET").upper()
            endpoints.append(
                {
                    "id": f"endpoint:{rel}:{ep.get('action')}:{verb}:{full}",
                    "controller": controller,
                    "action": ep.get("action"),
                    "method": verb,
                    "route": full,
                    "routeKey": route_key(verb, full),
                    "file": rel,
                    "line": ep.get("line", 0),
                    "qualifiedName": ep.get("qualifiedName") or "",
                    "origin": "roslyn",
                }
            )
    return endpoints
