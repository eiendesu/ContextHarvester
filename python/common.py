"""Shared utilities for Context Harvester Python backend."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def emit_progress(phase: str, message: str, current: int | None = None, total: int | None = None) -> None:
    ev: dict[str, Any] = {"event": "progress", "phase": phase, "message": message}
    if current is not None:
        ev["current"] = current
    if total is not None:
        ev["total"] = total
    emit(ev)


def harvester_root(repo_path: str | Path) -> Path:
    return Path(repo_path).resolve() / ".context-harvester"


def chroma_root(repo_path: str | Path) -> Path:
    return harvester_root(repo_path) / "chroma_db"


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def rel_path(path: Path, repo: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        return path.name


def should_skip_dir(name: str, exclude_folders: list[str]) -> bool:
    return name in exclude_folders or name.startswith(".")


def iter_repo_files(
    repo_path: Path,
    exclude_folders: list[str],
    include_extensions: list[str],
    exclude_extensions: list[str],
    doc_extensions: list[str] | None = None,
    code_only: bool = False,
    docs_only: bool = False,
) -> Iterator[Path]:
    doc_ext = {e.lower() if e.startswith(".") else f".{e.lower()}" for e in (doc_extensions or [])}
    inc = {e.lower() if e.startswith(".") else f".{e.lower()}" for e in include_extensions if e}
    exc = {e.lower() if e.startswith(".") else f".{e.lower()}" for e in exclude_extensions if e}

    for root, dirs, files in os.walk(repo_path):
        dirs[:] = [d for d in dirs if not should_skip_dir(d, exclude_folders)]
        for name in files:
            p = Path(root) / name
            ext = p.suffix.lower()
            if docs_only:
                if ext not in doc_ext:
                    continue
            elif code_only:
                if ext in doc_ext:
                    continue
            if inc and ext not in inc:
                continue
            if not inc and ext in exc:
                continue
            yield p


def tokenize_words(text: str) -> list[str]:
    return re.findall(r"\S+", text)


def chunk_text_sliding(text: str, chunk_size: int, chunk_overlap: int) -> list[tuple[int, int, str]]:
    words = tokenize_words(text)
    if not words:
        return []
    chunks: list[tuple[int, int, str]] = []
    step = max(1, chunk_size - chunk_overlap)
    i = 0
    line_offsets = _word_line_offsets(text, words)
    idx = 0
    while idx < len(words):
        slice_words = words[idx : idx + chunk_size]
        if not slice_words:
            break
        start_line = line_offsets[idx] if idx < len(line_offsets) else 1
        end_idx = min(idx + len(slice_words) - 1, len(line_offsets) - 1)
        end_line = line_offsets[end_idx] if line_offsets else start_line
        chunks.append((start_line, end_line, " ".join(slice_words)))
        idx += step
        if idx >= len(words):
            break
    return chunks


def _word_line_offsets(text: str, words: list[str]) -> list[int]:
    offsets: list[int] = []
    pos = 0
    for w in words:
        i = text.find(w, pos)
        if i < 0:
            offsets.append(1)
            continue
        offsets.append(text.count("\n", 0, i) + 1)
        pos = i + len(w)
    return offsets


def language_for_ext(ext: str) -> str:
    return {
        ".cs": "csharp",
        ".ts": "typescript",
        ".tsx": "tsx",
        ".sql": "sql",
        ".md": "markdown",
        ".py": "python",
        ".js": "javascript",
    }.get(ext.lower(), "text")


def load_vocabulary(repo_path: Path) -> dict[str, Any]:
    path = harvester_root(repo_path) / "project_vocabulary.json"
    if path.exists():
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    return {}


def load_index_meta(repo_path: Path) -> dict[str, Any]:
    path = harvester_root(repo_path) / "index_meta.json"
    if path.exists():
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_index_meta(repo_path: Path, meta: dict[str, Any]) -> None:
    path = harvester_root(repo_path) / "index_meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_ollama_client(url: str):
    import ollama

    host = url.rstrip("/")
    return ollama.Client(host=host)


def embed_text(client, model: str, text: str) -> list[float]:
    resp = client.embeddings(model=model, prompt=text[:8000])
    return resp["embedding"]


def ollama_generate(client, model: str, prompt: str) -> str:
    resp = client.generate(model=model, prompt=prompt, stream=False)
    return (resp.get("response") or "").strip()
