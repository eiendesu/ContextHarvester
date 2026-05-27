"""Run individual Context Harvester phases for the Dev Lab UI."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import ensure_project_context, harvester_root, merge_chunks

import phase0_vocabulary
import phase1_index
import phase2_hyde
import phase3_retrieval
import phase3b_rerank
import phase_grep
import phase_deps
import phase_query_understanding
import phase_symbol_search
import phase_iterative
import phase_tests
import phase_structure
import phase_negative
import phase_confidence
import phase_fingerprint
import phase_graph
import graph_report
import assembler
import symbol_index
from functional_map import refresh_graph_json

CACHE_NAME = "dev_lab_cache.json"

PHASE_LABELS: dict[str, str] = {
    "phase0": "Phase 0 — Vocabulary",
    "phase1": "Phase 1 — Vector index + symbols",
    "symbol_index": "Symbol index only",
    "query_understanding": "Query understanding",
    "hyde": "HyDE",
    "retrieval": "Vector retrieval",
    "symbol_search": "Symbol search",
    "iterative": "Iterative retrieval",
    "grep": "Grep expansion",
    "rerank": "Re-ranking",
    "tests": "Test files",
    "structure": "Structure pass",
    "negative": "Negative examples",
    "deps": "Dependency graph",
    "confidence": "Confidence score",
    "assembler": "Assembler (output MD)",
    "fingerprint": "Fingerprint",
    "graph": "Functional graph (Layer 2)",
    "graph_report": "Graph report (GRAPH_REPORT.md)",
    "refresh_graph_viz": "Refresh graph.json viz",
    "pipeline_retrieval": "Pipeline: query → assembler (no index)",
    "clear_cache": "Clear dev lab cache",
}


def cache_path(repo_path: str | Path) -> Path:
    return harvester_root(repo_path) / CACHE_NAME


def load_cache(repo_path: str | Path) -> dict[str, Any]:
    p = cache_path(repo_path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_cache(repo_path: str | Path, cache: dict[str, Any]) -> None:
    p = cache_path(repo_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def clear_cache(repo_path: str | Path) -> None:
    p = cache_path(repo_path)
    if p.exists():
        p.unlink()


def _summary(cache: dict[str, Any]) -> dict[str, Any]:
    chunks = cache.get("chunks") or []
    return {
        "hasQueryAnalysis": bool(cache.get("query_analysis")),
        "hydeCount": len(cache.get("hyde") or []),
        "chunksCount": len(chunks) if isinstance(chunks, list) else 0,
        "depsCount": len(cache.get("deps") or []),
        "testsCount": len(cache.get("test_files") or []),
        "hasConfidence": cache.get("confidence") is not None,
        "lastPhase": cache.get("last_phase"),
    }


def _apply_query_analysis(config: dict, query_analysis: dict | None) -> None:
    if not query_analysis:
        return
    areas = query_analysis.get("areas") or []
    if areas:
        config["focusBackend"] = "backend" in areas
        config["focusFrontend"] = "frontend" in areas
        config["focusSql"] = "sql" in areas


def run_phase(config: dict[str, Any], phase: str) -> dict[str, Any]:
    repo = Path(config["repoPath"]).resolve()
    ensure_project_context(str(repo))
    cache = load_cache(repo)
    phase = (phase or "").strip()

    if phase == "clear_cache":
        clear_cache(repo)
        return {"phase": phase, "message": "Cache dev lab cancellata.", "cacheSummary": _summary({})}

    if phase == "phase0":
        out = phase0_vocabulary.run(config)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "path": str(out), "cacheSummary": _summary(cache)}

    if phase == "phase1":
        if config.get("incremental"):
            meta = phase1_index.run(config)
        else:
            phase0_vocabulary.run(config)
            meta = phase1_index.run(config)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "indexMeta": meta, "cacheSummary": _summary(cache)}

    if phase == "symbol_index":
        sym = symbol_index.build_symbol_index(config)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        symbols = sym.get("symbols") or {}
        return {
            "phase": phase,
            "symbolsCount": len(symbols),
            "cacheSummary": _summary(cache),
        }

    if phase == "query_understanding":
        qa = phase_query_understanding.run(config)
        cache["query_analysis"] = qa
        _apply_query_analysis(config, qa)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "queryAnalysis": qa, "cacheSummary": _summary(cache)}

    if phase == "hyde":
        qa = cache.get("query_analysis")
        hyde = phase2_hyde.run(config, qa if isinstance(qa, dict) else None)
        cache["hyde"] = hyde
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "hydeCount": len(hyde), "cacheSummary": _summary(cache)}

    if phase == "retrieval":
        hyde = cache.get("hyde") or []
        if not isinstance(hyde, list) or not hyde:
            hyde = phase2_hyde.run(config, cache.get("query_analysis"))
            cache["hyde"] = hyde
        chunks = phase3_retrieval.run(config, hyde)
        cache["chunks"] = chunks
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "chunksCount": len(chunks), "cacheSummary": _summary(cache)}

    if phase == "symbol_search":
        chunks = cache.get("chunks") or []
        qa = cache.get("query_analysis")
        sym_chunks = phase_symbol_search.run(config, qa if isinstance(qa, dict) else None)
        cache["chunks"] = merge_chunks(chunks if isinstance(chunks, list) else [], sym_chunks)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {
            "phase": phase,
            "added": len(sym_chunks),
            "chunksCount": len(cache["chunks"]),
            "cacheSummary": _summary(cache),
        }

    if phase == "iterative":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        cache["chunks"] = phase_iterative.run(config, chunks)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "chunksCount": len(cache["chunks"]), "cacheSummary": _summary(cache)}

    if phase == "grep":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        qa = cache.get("query_analysis") if isinstance(cache.get("query_analysis"), dict) else {}
        hints = (qa or {}).get("search_hints") or []
        grep_chunks = phase_grep.run(config, chunks, search_hints=hints)
        cache["chunks"] = merge_chunks(chunks, grep_chunks)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "chunksCount": len(cache["chunks"]), "cacheSummary": _summary(cache)}

    if phase == "rerank":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        cache["chunks"] = phase3b_rerank.run(config, chunks)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "chunksCount": len(cache["chunks"]), "cacheSummary": _summary(cache)}

    if phase == "tests":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        test_files = phase_tests.run(config, chunks)
        cache["test_files"] = test_files
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "testsCount": len(test_files), "cacheSummary": _summary(cache)}

    if phase == "structure":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        cache["chunks"] = phase_structure.run(config, chunks)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "chunksCount": len(cache["chunks"]), "cacheSummary": _summary(cache)}

    if phase == "negative":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        chunks, negative = phase_negative.run(config, chunks)
        cache["chunks"] = chunks
        cache["negative_chunks"] = negative
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {
            "phase": phase,
            "chunksCount": len(chunks),
            "negativeCount": len(negative),
            "cacheSummary": _summary(cache),
        }

    if phase == "deps":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        deps = phase_deps.run(config, chunks)
        cache["deps"] = deps
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "depsCount": len(deps), "cacheSummary": _summary(cache)}

    if phase == "confidence":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        conf = phase_confidence.run(config, chunks)
        cache["confidence"] = conf
        cache["last_phase"] = phase
        save_cache(repo, cache)
        score = conf.get("score") if isinstance(conf, dict) else None
        return {"phase": phase, "confidenceScore": score, "cacheSummary": _summary(cache)}

    if phase == "assembler":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        deps = cache.get("deps") or []
        if not isinstance(deps, list):
            deps = []
        result = assembler.run(
            config,
            chunks,
            deps,
            tests=cache.get("test_files") or [],
            negative=cache.get("negative_chunks") or [],
            confidence=cache.get("confidence"),
            query_analysis=cache.get("query_analysis"),
        )
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {
            "phase": phase,
            "outputFile": str(result["md"]),
            "jsonFile": str(result.get("json", "")),
            "txtFile": str(result.get("txt", "")),
            "cacheSummary": _summary(cache),
        }

    if phase == "fingerprint":
        chunks = cache.get("chunks") or []
        if not isinstance(chunks, list):
            chunks = []
        deps = cache.get("deps") or []
        if not isinstance(deps, list):
            deps = []
        all_files = sorted({c["file_path"] for c in chunks} | {d["file_path"] for d in deps})
        conf = cache.get("confidence") if isinstance(cache.get("confidence"), dict) else {}
        fp = phase_fingerprint.run(
            config,
            config.get("cardId", "context"),
            all_files,
            len(chunks),
            conf,
        )
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {
            "phase": phase,
            "fingerprint": fp.get("fingerprint"),
            "cacheSummary": _summary(cache),
        }

    if phase == "graph":
        meta = phase_graph.run(config)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "graphMeta": meta, "cacheSummary": _summary(cache)}

    if phase == "graph_report":
        report = graph_report.run(config)
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "reportPath": str(report), "cacheSummary": _summary(cache)}

    if phase == "refresh_graph_viz":
        refresh_graph_json(config["repoPath"])
        cache["last_phase"] = phase
        save_cache(repo, cache)
        return {"phase": phase, "message": "graph.json aggiornato.", "cacheSummary": _summary(cache)}

    if phase == "pipeline_retrieval":
        qa = phase_query_understanding.run(config)
        cache["query_analysis"] = qa
        _apply_query_analysis(config, qa)
        hyde = phase2_hyde.run(config, qa)
        cache["hyde"] = hyde
        chunks = phase3_retrieval.run(config, hyde)
        sym_chunks = phase_symbol_search.run(config, qa)
        chunks = merge_chunks(chunks, sym_chunks)
        chunks = phase_iterative.run(config, chunks)
        hints = (qa or {}).get("search_hints") or []
        grep_chunks = phase_grep.run(config, chunks, search_hints=hints)
        chunks = merge_chunks(chunks, grep_chunks)
        chunks = phase3b_rerank.run(config, chunks)
        test_files = phase_tests.run(config, chunks)
        chunks = phase_structure.run(config, chunks)
        chunks, negative = phase_negative.run(config, chunks)
        deps = phase_deps.run(config, chunks)
        confidence = phase_confidence.run(config, chunks)
        result = assembler.run(
            config,
            chunks,
            deps,
            tests=test_files,
            negative=negative,
            confidence=confidence,
            query_analysis=qa,
        )
        cache.update(
            {
                "chunks": chunks,
                "hyde": hyde,
                "test_files": test_files,
                "negative_chunks": negative,
                "deps": deps,
                "confidence": confidence,
                "last_phase": phase,
            }
        )
        save_cache(repo, cache)
        return {
            "phase": phase,
            "outputFile": str(result["md"]),
            "chunksCount": len(chunks),
            "depsCount": len(deps),
            "cacheSummary": _summary(cache),
        }

    known = ", ".join(sorted(PHASE_LABELS.keys()))
    raise ValueError(f"Fase sconosciuta: {phase}. Valide: {known}")
