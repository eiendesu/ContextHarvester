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


DEFAULT_EXCLUDE_FOLDERS = [
    "bin",
    "obj",
    "node_modules",
    ".git",
    "dist",
    "build",
    ".context-harvester",
    "packages",
    ".vs",
    "TestResults",
]


def merge_exclude_folders(configured: list[str] | None) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for item in [*DEFAULT_EXCLUDE_FOLDERS, *(configured or [])]:
        key = str(item).strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(str(item).strip())
    return merged


def _normalize_exclude_folders(exclude_folders: list[str]) -> list[str]:
    out: list[str] = []
    for raw in exclude_folders:
        if not raw or not str(raw).strip():
            continue
        out.append(str(raw).replace("\\", "/").strip("/").lower())
    return out


def is_rel_path_excluded(rel: str, exclude_folders: list[str]) -> bool:
    """True if relative path matches an excluded folder name or path prefix."""
    rel_norm = rel.replace("\\", "/").strip("/").lower()
    if not rel_norm:
        return False
    parts = rel_norm.split("/")
    for exc in _normalize_exclude_folders(exclude_folders):
        if "/" in exc:
            if rel_norm == exc or rel_norm.startswith(exc + "/"):
                return True
        elif exc in parts:
            return True
    return False


def should_skip_dir(name: str, exclude_folders: list[str], parent_rel: str = "") -> bool:
    if name.startswith("."):
        return True
    sub_rel = f"{parent_rel}/{name}".strip("/") if parent_rel else name
    return is_rel_path_excluded(sub_rel, exclude_folders)


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
    repo = Path(repo_path).resolve()

    for root, dirs, files in os.walk(repo):
        root_rel = rel_path(Path(root), repo) if Path(root) != repo else ""
        dirs[:] = [d for d in dirs if not should_skip_dir(d, exclude_folders, root_rel)]
        for name in files:
            p = Path(root) / name
            if is_rel_path_excluded(rel_path(p, repo), exclude_folders):
                continue
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


def load_symbol_index(repo_path: str | Path) -> dict[str, Any]:
    path = harvester_root(repo_path) / "symbol_index.json"
    if path.exists():
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    return {"symbols": {}, "usages": {}}


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


def phase_model(config: dict[str, Any], phase: str) -> tuple[str, str]:
    """Return (ollama_url, model_name) for a pipeline phase."""
    ollama = config.get("ollama") or {}
    if phase in ollama:
        entry = ollama[phase]
        url = entry.get("url") or config.get("ollamaUrl", "http://localhost:11434")
        model = entry.get("model", "")
        return url, model
    legacy: dict[str, tuple[str, str]] = {
        "embedding": ("ollamaUrl", "embeddingModel"),
        "hyde": ("ollamaUrl", "hydeModel"),
        "rerank": ("ollamaUrl", "rerankModel"),
        "classifier": ("ollamaUrl", "hydeModel"),
        "structurer": ("ollamaUrl", "hydeModel"),
        "confidence": ("ollamaUrl", "hydeModel"),
    }
    url_key, model_key = legacy.get(phase, ("ollamaUrl", "hydeModel"))
    return config.get(url_key, "http://localhost:11434"), config.get(model_key, "")


def project_context_path(repo_path: str | Path) -> Path:
    return harvester_root(repo_path) / "project_context.md"


def ensure_project_context(repo_path: str | Path) -> Path:
    path = project_context_path(repo_path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            """# Project Context

## Architettura generale
<!-- Descrivi brevemente i layer principali del progetto -->

## Pattern dominanti
<!-- Es: FluentValidation, Dapper, Grommet -->

## Naming conventions
<!-- Es: DefaultXxxValidator / CustomerXxxValidator -->

## Anti-pattern — NON fare
<!-- Cosa evitare in questo progetto -->

## Note per l'AI
<!-- Contesto utile prima di generare codice -->
""",
            encoding="utf-8",
        )
    return path


def load_project_context(repo_path: str | Path) -> str:
    path = project_context_path(repo_path)
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return ""


def merge_chunks(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for c in a + b:
        key = f"{c.get('file_path', '')}:{c.get('start_line', 1)}"
        if key in merged:
            merged[key]["score"] = max(merged[key].get("score", 0), c.get("score", 0))
        else:
            merged[key] = dict(c)
    result = list(merged.values())
    result.sort(key=lambda x: x.get("score", 0), reverse=True)
    return result
