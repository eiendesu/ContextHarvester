"""Persistenza analisi Roslyn + storico in .context-harvester/roslyn/."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from common import harvester_root, utc_now_iso

HISTORY_INDEX = "roslyn_history.json"
CURRENT_FILE = "roslyn/current.json"
MAX_HISTORY = 40


def _roslyn_dir(repo: Path) -> Path:
    d = harvester_root(repo) / "roslyn"
    d.mkdir(parents=True, exist_ok=True)
    return d


def summarize_scan(scan: dict[str, Any]) -> dict[str, int]:
    files = scan.get("files") or []
    controllers = 0
    for fe in files:
        for c in fe.get("classes") or []:
            if c.get("isController"):
                controllers += 1
    return {
        "fileCount": len(files),
        "classCount": sum(len(f.get("classes") or []) for f in files),
        "methodCount": sum(len(f.get("methods") or []) for f in files),
        "endpointCount": sum(len(f.get("endpoints") or []) for f in files),
        "controllerCount": controllers,
    }


def persist_roslyn_scan(
    repo: Path,
    scan: dict[str, Any],
    *,
    trigger: str = "reindex",
    duration_ms: int | None = None,
) -> dict[str, Any]:
    """Salva scan completo + voce storico. Ritorna metadata run."""
    root = _roslyn_dir(repo)
    hist_dir = root / "history"
    hist_dir.mkdir(parents=True, exist_ok=True)

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    summary = summarize_scan(scan)
    finished = utc_now_iso()

    entry = {
        "id": run_id,
        "trigger": trigger,
        "startedAt": finished,
        "finishedAt": finished,
        "durationMs": duration_ms,
        "success": True,
        "summary": summary,
        "storagePath": f"roslyn/history/{run_id}.json",
    }

    payload = {
        "version": "1.0",
        "meta": entry,
        "scan": scan,
    }
    hist_file = hist_dir / f"{run_id}.json"
    hist_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    current = {"version": "1.0", "meta": entry, "scan": scan}
    (root / "current.json").write_text(
        json.dumps(current, ensure_ascii=False),
        encoding="utf-8",
    )

    index_path = harvester_root(repo) / HISTORY_INDEX
    index: dict[str, Any] = {"runs": [], "lastRunId": run_id}
    if index_path.is_file():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except Exception:
            index = {"runs": []}
    runs = [entry] + [r for r in (index.get("runs") or []) if r.get("id") != run_id]
    index["runs"] = runs[:MAX_HISTORY]
    index["lastRunId"] = run_id
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    return entry


def load_roslyn_history(repo: Path) -> dict[str, Any]:
    p = harvester_root(repo) / HISTORY_INDEX
    if not p.is_file():
        return {"runs": [], "lastRunId": None}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data.get("runs"), list):
            return data
    except Exception:
        pass
    return {"runs": [], "lastRunId": None}


def load_roslyn_run(repo: Path, run_id: str) -> dict[str, Any] | None:
    p = harvester_root(repo) / "roslyn" / "history" / f"{run_id}.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_roslyn_current(repo: Path) -> dict[str, Any] | None:
    p = harvester_root(repo) / CURRENT_FILE
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def compact_files_for_ui(scan: dict[str, Any], limit: int = 800) -> list[dict[str, Any]]:
    """Lista file compatta per la webview (evita payload enormi)."""
    out: list[dict[str, Any]] = []
    for fe in (scan.get("files") or [])[:limit]:
        path = fe.get("path") or ""
        classes = fe.get("classes") or []
        methods = fe.get("methods") or []
        endpoints = fe.get("endpoints") or []
        out.append(
            {
                "path": path,
                "classCount": len(classes),
                "methodCount": len(methods),
                "endpointCount": len(endpoints),
                "classes": [
                    {
                        "name": c.get("name"),
                        "kind": c.get("kind"),
                        "line": c.get("line"),
                        "isController": c.get("isController"),
                        "route": c.get("route"),
                    }
                    for c in classes[:80]
                ],
                "methods": [
                    {
                        "name": m.get("name"),
                        "className": m.get("className"),
                        "line": m.get("line"),
                        "visibility": m.get("visibility"),
                        "qualifiedName": m.get("qualifiedName"),
                    }
                    for m in methods[:120]
                ],
                "endpoints": [
                    {
                        "controller": e.get("controller"),
                        "action": e.get("action"),
                        "method": e.get("method"),
                        "actionRoute": e.get("actionRoute"),
                        "classRoute": e.get("classRoute"),
                        "line": e.get("line"),
                    }
                    for e in endpoints[:40]
                ],
            }
        )
    return out
