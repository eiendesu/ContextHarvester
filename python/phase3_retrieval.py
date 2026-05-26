"""Vector retrieval from ChromaDB using HyDE embeddings."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from common import chroma_root, embed_text, emit_progress, get_ollama_client


def _query_collection(col, embedding: list[float], n: int) -> list[dict[str, Any]]:
    if col.count() == 0:
        return []
    result = col.query(query_embeddings=[embedding], n_results=min(n, col.count()))
    chunks: list[dict[str, Any]] = []
    ids = result.get("ids", [[]])[0]
    docs = result.get("documents", [[]])[0]
    metas = result.get("metadatas", [[]])[0]
    dists = result.get("distances", [[]])[0]
    for i, doc_id in enumerate(ids):
        meta = metas[i] if i < len(metas) else {}
        dist = dists[i] if i < len(dists) else 1.0
        score = max(0.0, 1.0 - dist)
        chunks.append({
            "id": doc_id,
            "file_path": meta.get("file_path", ""),
            "start_line": int(meta.get("start_line", 1)),
            "end_line": int(meta.get("end_line", 1)),
            "text": docs[i] if i < len(docs) else "",
            "score": score,
            "language": meta.get("language", "text"),
            "scores": [score],
        })
    return chunks


def _merge_chunks(all_chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for c in all_chunks:
        key = f"{c['file_path']}:{c['start_line']}"
        if key in merged:
            merged[key]["scores"].extend(c.get("scores", [c["score"]]))
            merged[key]["score"] = sum(merged[key]["scores"]) / len(merged[key]["scores"])
            if c["end_line"] > merged[key]["end_line"]:
                merged[key]["end_line"] = c["end_line"]
                merged[key]["text"] = c["text"]
        else:
            merged[key] = {**c, "scores": list(c.get("scores", [c["score"]]))}
    result = list(merged.values())
    result.sort(key=lambda x: x["score"], reverse=True)
    return result


def run(config: dict[str, Any], hyde_snippets: list[str]) -> list[dict[str, Any]]:
    repo = Path(config["repoPath"]).resolve()
    chroma_path = chroma_root(repo)
    db = chromadb.PersistentClient(
        path=str(chroma_path),
        settings=ChromaSettings(anonymized_telemetry=False),
    )
    code_col = db.get_or_create_collection("code_index")
    docs_col = db.get_or_create_collection("docs_index")

    client = get_ollama_client(config["ollamaUrl"])
    model = config["embeddingModel"]
    top_k = int(config.get("topKBeforeRerank", 20))
    include_docs = config.get("includeDocsInRetrieval", False)

    all_chunks: list[dict[str, Any]] = []
    emit_progress("phase3", "Retrieval vettoriale")

    for snippet in hyde_snippets:
        emb = embed_text(client, model, snippet)
        all_chunks.extend(_query_collection(code_col, emb, top_k))
        if include_docs and docs_col.count() > 0:
            all_chunks.extend(_query_collection(docs_col, emb, 5))

    merged = _merge_chunks(all_chunks)

    # Enrich chunks with source file line ranges
    for c in merged:
        fp = repo / c["file_path"]
        if fp.exists():
            try:
                lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
                s, e = max(0, c["start_line"] - 1), min(len(lines), c["end_line"])
                if lines[s:e]:
                    c["text"] = "\n".join(lines[s:e])
            except OSError:
                pass

    return merged[: top_k * 2]
