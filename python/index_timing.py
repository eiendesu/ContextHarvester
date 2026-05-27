"""Track and persist index/reindex run timings (total + per top-level folder)."""
from __future__ import annotations

import json
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from common import harvester_root, utc_now_iso

HISTORY_FILE = "index_run_history.json"
HISTORY_MAX_RUNS = 50


def top_level_folder(rel: str) -> str:
    rel = rel.replace("\\", "/").strip("/")
    if not rel or "/" not in rel:
        return "(root)"
    return rel.split("/")[0]


def _history_path(repo: Path) -> Path:
    return harvester_root(repo) / HISTORY_FILE


def load_index_run_history(repo_path: str | Path) -> dict[str, Any]:
    path = _history_path(Path(repo_path))
    if not path.is_file():
        return {"runs": []}
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("runs"), list):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"runs": []}


def get_index_run(repo_path: str | Path, run_id: str) -> dict[str, Any] | None:
    for run in load_index_run_history(repo_path).get("runs", []):
        if run.get("id") == run_id:
            return run
    return None


class IndexRunTracker:
  """Wall-clock tracker for rebuild_index / incremental_index."""

  def __init__(self, repo_path: str | Path, action: str) -> None:
      self.repo = Path(repo_path).resolve()
      self.action = action
      self.run_id = str(uuid.uuid4())
      self.started_at = utc_now_iso()
      self._t0 = time.perf_counter()
      self.phases_ms: dict[str, int] = {}
      self.folders: dict[str, dict[str, Any]] = {}
      self.success = True
      self.error: str | None = None
      self.stats: dict[str, Any] = {}

  @contextmanager
  def phase(self, name: str) -> Iterator[None]:
      t0 = time.perf_counter()
      try:
          yield
      finally:
          self.phases_ms[name] = self.phases_ms.get(name, 0) + round(
              (time.perf_counter() - t0) * 1000
          )

  def record_file(
      self,
      rel: str,
      duration_ms: float,
      *,
      indexed: bool = False,
      skipped_unchanged: bool = False,
  ) -> None:
      folder = top_level_folder(rel)
      if folder not in self.folders:
          self.folders[folder] = {
              "folder": folder,
              "durationMs": 0,
              "filesProcessed": 0,
              "filesIndexed": 0,
              "filesSkippedUnchanged": 0,
          }
      entry = self.folders[folder]
      entry["durationMs"] = int(entry["durationMs"] + round(duration_ms))
      entry["filesProcessed"] = int(entry["filesProcessed"]) + 1
      if skipped_unchanged:
          entry["filesSkippedUnchanged"] = int(entry["filesSkippedUnchanged"]) + 1
      elif indexed:
          entry["filesIndexed"] = int(entry["filesIndexed"]) + 1

  def finish(self, *, success: bool = True, meta: dict[str, Any] | None = None, error: str | None = None) -> dict[str, Any]:
      self.success = success
      self.error = error
      total_ms = round((time.perf_counter() - self._t0) * 1000)
      finished_at = utc_now_iso()

      if meta:
          self.stats = {
              "totalFiles": meta.get("totalFiles"),
              "codeFiles": meta.get("codeFiles"),
              "docFiles": meta.get("docFiles"),
              "symbolsIndexed": meta.get("symbolsIndexed"),
          }

      folders_sorted = sorted(
          self.folders.values(),
          key=lambda x: x.get("durationMs", 0),
          reverse=True,
      )

      record: dict[str, Any] = {
          "id": self.run_id,
          "action": self.action,
          "startedAt": self.started_at,
          "finishedAt": finished_at,
          "durationMs": total_ms,
          "success": success,
          "error": error,
          "stats": self.stats,
          "phasesMs": self.phases_ms,
          "folders": folders_sorted,
      }

      self._append_history(record)
      return record

  def _append_history(self, record: dict[str, Any]) -> None:
      path = _history_path(self.repo)
      path.parent.mkdir(parents=True, exist_ok=True)
      history = load_index_run_history(self.repo)
      runs: list[dict[str, Any]] = list(history.get("runs", []))
      runs.insert(0, record)
      history["runs"] = runs[:HISTORY_MAX_RUNS]
      history["lastRunId"] = record["id"]
      with path.open("w", encoding="utf-8") as f:
          json.dump(history, f, indent=2, ensure_ascii=False)

