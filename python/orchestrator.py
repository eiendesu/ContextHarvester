#!/usr/bin/env python3
"""Single entry point for Context Harvester — called from VS Code extension."""
from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config_loader import load_config
from common import chunk_text_sliding, emit, ensure_project_context, harvester_root, language_for_ext, merge_chunks
from index_timing import IndexRunTracker

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


def _apply_query_analysis(config: dict, query_analysis: dict | None) -> None:
    if not query_analysis:
        return
    areas = query_analysis.get("areas") or []
    if areas:
        config["focusBackend"] = "backend" in areas
        config["focusFrontend"] = "frontend" in areas
        config["focusSql"] = "sql" in areas


def rebuild_index(config: dict) -> dict:
    tracker = IndexRunTracker(config["repoPath"], "rebuild_index")
    config["_indexTimingTracker"] = tracker
    try:
        with tracker.phase("phase0_vocabulary"):
            phase0_vocabulary.run(config)
        meta = phase1_index.run(config)
        return tracker.finish(success=True, meta=meta)
    except Exception as e:
        tracker.finish(success=False, error=str(e))
        raise


def incremental_index(config: dict) -> dict:
    config["incremental"] = True
    tracker = IndexRunTracker(config["repoPath"], "incremental_index")
    config["_indexTimingTracker"] = tracker
    try:
        meta = phase1_index.run(config)
        return tracker.finish(success=True, meta=meta)
    except Exception as e:
        tracker.finish(success=False, error=str(e))
        raise


def generate_context(config: dict) -> dict:
    ensure_project_context(config["repoPath"])

    # Optional Layer 2 auto-run: if enabled and functional_map is missing.
    if config.get("enableFunctionalAnalysis"):
        repo = Path(config["repoPath"]).resolve()
        fmap_path = harvester_root(repo) / "functional_map.json"
        if not fmap_path.exists():
            phase_graph.run(config)
            graph_report.run(config)

    query_analysis = phase_query_understanding.run(config)
    _apply_query_analysis(config, query_analysis)

    hyde = phase2_hyde.run(config, query_analysis)
    chunks = phase3_retrieval.run(config, hyde)

    symbol_chunks = phase_symbol_search.run(config, query_analysis)
    chunks = merge_chunks(chunks, symbol_chunks)

    # Layer 2 integration: if Query Understanding selected a functional_map entry,
    # seed the pool with all its files (score boost) before iterative retrieval.
    related_function = (query_analysis or {}).get("related_function")
    if related_function:
        repo = Path(config["repoPath"]).resolve()
        fmap_path = harvester_root(repo) / "functional_map.json"
        if fmap_path.exists():
            try:
                fmap = __import__("json").loads(fmap_path.read_text(encoding="utf-8"))
                funcs = fmap.get("functions") or []
                fn = next(
                    (
                        f
                        for f in funcs
                        if isinstance(f, dict) and f.get("validated") and str(f.get("id")) == str(related_function)
                    ),
                    None,
                )
                if fn and fmap.get("functionalMapReady") and isinstance(fn.get("files"), list):
                    seeds: list[dict] = []
                    for file_rel in fn["files"]:
                        fp = repo / str(file_rel)
                        if not fp.exists() or not fp.is_file():
                            continue
                        try:
                            content = fp.read_text(encoding="utf-8", errors="replace")
                        except OSError:
                            continue
                        chunks_sl = chunk_text_sliding(
                            content,
                            int(config.get("chunkSize", 400)),
                            int(config.get("chunkOverlap", 50)),
                        )
                        for s, e, text in chunks_sl:
                            if not text.strip():
                                continue
                            seeds.append(
                                {
                                    "file_path": str(file_rel).replace("\\", "/"),
                                    "start_line": int(s),
                                    "end_line": int(e),
                                    "text": text,
                                    "score": 0.95,
                                    "language": language_for_ext(Path(str(file_rel)).suffix),
                                    "source": "functional_seed",
                                }
                            )
                    if seeds:
                        chunks = merge_chunks(seeds, chunks)
            except Exception:
                pass

    chunks = phase_iterative.run(config, chunks)

    search_hints = (query_analysis or {}).get("search_hints") or []

    # Also extend grep search_hints with the selected function terms.
    if related_function:
        repo = Path(config["repoPath"]).resolve()
        fmap_path = harvester_root(repo) / "functional_map.json"
        if fmap_path.exists():
            try:
                fmap = __import__("json").loads(fmap_path.read_text(encoding="utf-8"))
                funcs = fmap.get("functions") or []
                fn = next(
                    (
                        f
                        for f in funcs
                        if isinstance(f, dict) and f.get("validated") and str(f.get("id")) == str(related_function)
                    ),
                    None,
                )
                if fn and fmap.get("functionalMapReady") and isinstance(fn.get("terms"), dict):
                    extra = fn["terms"].get("domainConcepts") or []
                    if isinstance(extra, list):
                        search_hints = list({*search_hints, *extra})[:25]
            except Exception:
                pass

    grep_chunks = phase_grep.run(config, chunks, search_hints=search_hints)
    chunks = merge_chunks(chunks, grep_chunks)

    chunks = phase3b_rerank.run(config, chunks)

    test_files = phase_tests.run(config, chunks)
    chunks = phase_structure.run(config, chunks)
    chunks, negative_chunks = phase_negative.run(config, chunks)

    deps = phase_deps.run(config, chunks)
    confidence = phase_confidence.run(config, chunks)

    result = assembler.run(
        config,
        chunks,
        deps,
        tests=test_files,
        negative=negative_chunks,
        confidence=confidence,
        query_analysis=query_analysis,
    )

    all_files = sorted({c["file_path"] for c in chunks} | {d["file_path"] for d in deps})
    fp_entry = phase_fingerprint.run(
        config,
        config.get("cardId", "context"),
        all_files,
        len(chunks),
        confidence,
    )

    return {
        "outputFile": str(result["md"]),
        "jsonFile": str(result.get("json", "")),
        "txtFile": str(result.get("txt", "")),
        "chunksCount": len(chunks),
        "depsCount": len(deps),
        "testsCount": len(test_files),
        "confidenceScore": confidence.get("score") if confidence else None,
        "fingerprint": fp_entry.get("fingerprint"),
        "fingerprintStatus": config.get("fingerprintStatus"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Context Harvester orchestrator")
    parser.add_argument("--config", required=True, help="Path to config JSON")
    parser.add_argument(
        "--action",
        required=True,
        choices=[
            "rebuild_index",
            "generate_context",
            "incremental_index",
            "check_fingerprint",
            "functional_analysis",
            "refresh_graph_viz",
            "dev_run_phase",
            "roslyn_scan",
        ],
    )
    args = parser.parse_args()

    try:
        config = load_config(args.config)
        if args.action == "rebuild_index":
            index_run = rebuild_index(config)
            emit({"event": "done", "indexRun": index_run})
        elif args.action == "incremental_index":
            index_run = incremental_index(config)
            emit({"event": "done", "indexRun": index_run})
        elif args.action == "functional_analysis":
            phase_graph.run(config)
            graph_report.run(config)
            emit({"event": "done"})
        elif args.action == "refresh_graph_viz":
            from functional_map import refresh_graph_json

            refresh_graph_json(config["repoPath"])
            emit({"event": "done"})
        elif args.action == "check_fingerprint":
            from phase_fingerprint import check_fingerprint
            card = config.get("cardId", "")
            files = config.get("fingerprintFiles") or []
            status = check_fingerprint(config["repoPath"], card, files)
            emit({"event": "fingerprint", **status})
        elif args.action == "generate_context":
            out = generate_context(config)
            emit({"event": "done", **out})
        elif args.action == "dev_run_phase":
            from dev_phases import run_phase

            phase = config.get("devPhase") or ""
            out = run_phase(config, phase)
            emit({"event": "done", **out})
        elif args.action == "roslyn_scan":
            import roslyn_scan

            out = roslyn_scan.run(config)
            emit({"event": "done", **out})
        return 0
    except Exception as e:
        emit({"event": "error", "message": str(e)})
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
