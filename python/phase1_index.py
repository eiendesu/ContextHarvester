"""Build ChromaDB vector index with sliding-window chunking."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from common import (
    chroma_root,
    chunk_text_sliding,
    embed_text,
    emit_progress,
    file_hash,
    get_ollama_client,
    is_rel_path_excluded,
    iter_repo_files,
    merge_exclude_folders,
    language_for_ext,
    load_index_meta,
    phase_model,
    rel_path,
    save_index_meta,
    utc_now_iso,
)
import symbol_index


def _chunk_id(rel: str, idx: int) -> str:
    raw = f"{rel}::{idx}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _index_collection(
    client,
    collection_name: str,
    files: list[Path],
    repo: Path,
    config: dict[str, Any],
    phase_label: str,
) -> tuple[int, dict[str, str]]:
    chroma_path = chroma_root(repo)
    chroma_path.mkdir(parents=True, exist_ok=True)
    db = chromadb.PersistentClient(
        path=str(chroma_path),
        settings=ChromaSettings(anonymized_telemetry=False),
    )
    col = db.get_or_create_collection(collection_name)

    url, model = phase_model(config, "embedding")
    ollama = get_ollama_client(url)
    chunk_size = int(config.get("chunkSize", 400))
    chunk_overlap = int(config.get("chunkOverlap", 50))

    meta = load_index_meta(repo)
    old_hashes: dict[str, str] = meta.get("fileHashes", {})
    new_hashes: dict[str, str] = {}
    indexed = 0
    total = len(files)

    exclude_folders = merge_exclude_folders(config.get("excludeFolders"))
    tracker = config.get("_indexTimingTracker")

    for i, path in enumerate(files, 1):
        emit_progress(phase_label, f"Indexing {path.name}", i, total)
        rel = rel_path(path, repo)
        t_file = time.perf_counter()
        indexed_file = False
        skipped_unchanged = False
        try:
            if is_rel_path_excluded(rel, exclude_folders):
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            h = file_hash(path)
            new_hashes[rel] = h

            if config.get("incremental") and old_hashes.get(rel) == h:
                skipped_unchanged = True
                continue

            # Remove old chunks for this file
            try:
                existing = col.get(where={"file_path": rel})
                if existing and existing.get("ids"):
                    col.delete(ids=existing["ids"])
            except Exception:
                pass

            if config.get("semanticChunking", False):
                from chunking_semantic import semantic_chunks

                chunks = semantic_chunks(
                    content, language_for_ext(path.suffix), chunk_size, chunk_overlap
                )
            else:
                chunks = chunk_text_sliding(content, chunk_size, chunk_overlap)
            if not chunks:
                continue

            ids, embeddings, documents, metadatas = [], [], [], []
            for idx, (start_line, end_line, text) in enumerate(chunks):
                cid = _chunk_id(rel, idx)
                try:
                    emb = embed_text(ollama, model, text)
                except Exception as e:
                    emit_progress(phase_label, f"Embed failed {rel}: {e}", i, total)
                    continue
                ids.append(cid)
                embeddings.append(emb)
                documents.append(text)
                metadatas.append({
                    "file_path": rel,
                    "start_line": start_line,
                    "end_line": end_line,
                    "language": language_for_ext(path.suffix),
                    "chunk_index": idx,
                })

            if ids:
                col.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
                indexed += 1
                indexed_file = True
        finally:
            if tracker:
                tracker.record_file(
                    rel,
                    (time.perf_counter() - t_file) * 1000,
                    indexed=indexed_file,
                    skipped_unchanged=skipped_unchanged,
                )

    # Remove deleted files
    if config.get("incremental"):
        for old_rel in set(old_hashes) - set(new_hashes):
            try:
                existing = col.get(where={"file_path": old_rel})
                if existing and existing.get("ids"):
                    col.delete(ids=existing["ids"])
            except Exception:
                pass

    return indexed, new_hashes


def run(config: dict[str, Any]) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    exclude_folders = merge_exclude_folders(config.get("excludeFolders"))
    include_ext = config.get("includeExtensions", [])
    exclude_ext = config.get("excludeExtensions", [])
    doc_ext = config.get("docExtensions", [".md"])

    code_files = list(
        iter_repo_files(
            repo, exclude_folders, include_ext, exclude_ext,
            doc_extensions=doc_ext, code_only=True,
        )
    )
    doc_files = list(
        iter_repo_files(
            repo, exclude_folders, include_ext, exclude_ext,
            doc_extensions=doc_ext, docs_only=True,
        )
    )

    tracker = config.get("_indexTimingTracker")

    emit_progress("phase1", "Indexing code files", 0, len(code_files))
    if tracker:
        with tracker.phase("phase1_code"):
            code_count, code_hashes = _index_collection(
                None, "code_index", code_files, repo, config, "phase1"
            )
    else:
        code_count, code_hashes = _index_collection(
            None, "code_index", code_files, repo, config, "phase1"
        )

    doc_hashes: dict[str, str] = {}
    if doc_ext and doc_files:
        emit_progress("phase1", "Indexing documentation", 0, len(doc_files))
        if tracker:
            with tracker.phase("phase1_docs"):
                _, doc_hashes = _index_collection(
                    None, "docs_index", doc_files, repo, config, "phase1"
                )
        else:
            _, doc_hashes = _index_collection(
                None, "docs_index", doc_files, repo, config, "phase1"
            )

    all_hashes = {**code_hashes, **doc_hashes}

    from roslyn_bridge import clear_roslyn_scan_cache

    clear_roslyn_scan_cache()

    if tracker:
        with tracker.phase("symbol_index"):
            sym_index = symbol_index.build_symbol_index(config)
    else:
        sym_index = symbol_index.build_symbol_index(config)

    if config.get("v2Symbols", True):
        from symbol_index_v2 import build_symbol_index_v2

        if tracker:
            with tracker.phase("symbol_index_v2"):
                build_symbol_index_v2(config)
        else:
            build_symbol_index_v2(config)

    if config.get("v2ApiMatching", True):
        from api_client_index import build_api_client_index
        from api_matcher import build_api_links
        from backend_route_index import build_backend_route_index
        from import_graph import build_import_graph

        if tracker:
            with tracker.phase("import_graph"):
                build_import_graph(config)
            with tracker.phase("api_indexes"):
                br = build_backend_route_index(config)
                ac = build_api_client_index(config)
                build_api_links(repo, ac, br)
        else:
            build_import_graph(config)
            br = build_backend_route_index(config)
            ac = build_api_client_index(config)
            build_api_links(repo, ac, br)
    meta = {
        "lastIndexed": utc_now_iso(),
        "totalFiles": len(all_hashes),
        "codeFiles": len(code_hashes),
        "docFiles": len(doc_hashes),
        "symbolsIndexed": len(sym_index.get("symbols", {})),
        "usagesIndexed": sum(len(v) for v in sym_index.get("usages", {}).values()),
        "fileHashes": all_hashes,
        "settings": {
            "includeExtensions": include_ext,
            "excludeExtensions": exclude_ext,
            "excludeFolders": exclude_folders,
        },
    }
    save_index_meta(repo, meta)
    return meta
