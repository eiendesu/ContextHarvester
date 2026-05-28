"""Esegue solo scan Roslyn e salva storico."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from common import emit_progress


def run(config: dict[str, Any]) -> dict[str, Any]:
    from roslyn_bridge import clear_roslyn_scan_cache, run_roslyn_scan
    from roslyn_store import load_roslyn_current, summarize_scan

    repo = Path(config["repoPath"]).resolve()
    trigger = str(config.get("roslynTrigger") or "manual")
    clear_roslyn_scan_cache()
    emit_progress("roslyn_scan", "Avvio RoslynHarvester", 0, 1)
    t0 = time.perf_counter()
    scan = run_roslyn_scan(repo, save=True, trigger=trigger)
    duration_ms = int((time.perf_counter() - t0) * 1000)
    if scan is None:
        raise RuntimeError(
            "Roslyn non disponibile: installa .NET 8 SDK e verifica tools/RoslynHarvester"
        )
    current = load_roslyn_current(repo)
    meta = (current or {}).get("meta") or {}
    if meta and duration_ms:
        meta = {**meta, "durationMs": duration_ms}
    emit_progress("roslyn_scan", "Roslyn completato", 1, 1)
    return {
        "roslynRun": meta,
        "summary": summarize_scan(scan),
        "durationMs": duration_ms,
    }
