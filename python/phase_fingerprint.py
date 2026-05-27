"""Context fingerprint — SHA256 of included files for regeneration hints."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from common import file_hash, harvester_root, utc_now_iso


def _compute_fingerprint(files: list[str], repo: Path) -> str:
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode())
        fp = repo / rel
        if fp.exists():
            h.update(file_hash(fp).encode())
    return f"sha256:{h.hexdigest()}"


def load_context_log(repo_path: str | Path) -> dict[str, Any]:
    path = harvester_root(repo_path) / "context_log.json"
    if path.exists():
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_context_log(repo_path: str | Path, log: dict[str, Any]) -> None:
    path = harvester_root(repo_path) / "context_log.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(log, f, indent=2, ensure_ascii=False)


def run(
    config: dict[str, Any],
    card_id: str,
    files: list[str],
    chunks_count: int,
    confidence: dict[str, Any] | None,
) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    fingerprint = _compute_fingerprint(files, repo)
    entry = {
        "lastGenerated": utc_now_iso(),
        "fingerprint": fingerprint,
        "files": sorted(files),
        "chunksCount": chunks_count,
        "confidenceScore": confidence.get("score") if confidence else None,
    }
    log = load_context_log(repo)
    log[card_id] = entry
    save_context_log(repo, log)
    return entry


def check_fingerprint(
    repo_path: str | Path,
    card_id: str,
    current_files: list[str] | None = None,
) -> dict[str, Any]:
    repo = Path(repo_path).resolve()
    log = load_context_log(repo)
    prev = log.get(card_id)
    if not prev:
        return {"status": "new", "previous": None}
    files_to_check = current_files if current_files else prev.get("files", [])
    if not files_to_check:
        return {"status": "new", "previous": prev}
    current_fp = _compute_fingerprint(files_to_check, repo)
    if current_fp == prev.get("fingerprint"):
        return {"status": "identical", "previous": prev, "fingerprint": current_fp}
    return {"status": "changed", "previous": prev, "fingerprint": current_fp}
