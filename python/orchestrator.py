#!/usr/bin/env python3
"""Single entry point for Context Harvester — called from VS Code extension."""
from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

# Ensure python/ is on path when run as script
sys.path.insert(0, str(Path(__file__).resolve().parent))

from config_loader import load_config
from common import emit

import phase0_vocabulary
import phase1_index
import phase2_hyde
import phase3_retrieval
import phase3b_rerank
import phase_grep
import phase_deps
import assembler


def rebuild_index(config: dict) -> None:
    phase0_vocabulary.run(config)
    phase1_index.run(config)


def incremental_index(config: dict) -> None:
    config["incremental"] = True
    phase1_index.run(config)


def generate_context(config: dict) -> tuple[str, int, int]:
    hyde = phase2_hyde.run(config)
    chunks = phase3_retrieval.run(config, hyde)
    chunks = phase3b_rerank.run(config, chunks)
    grep_chunks = phase_grep.run(config, chunks)
    chunks.extend(grep_chunks)
    chunks.sort(key=lambda c: c.get("score", 0), reverse=True)
    top_k = int(config.get("topK", 10))
    chunks = chunks[:top_k]
    deps = phase_deps.run(config, chunks)
    out = assembler.run(config, chunks, deps)
    return str(out), len(chunks), len(deps)


def main() -> int:
    parser = argparse.ArgumentParser(description="Context Harvester orchestrator")
    parser.add_argument("--config", required=True, help="Path to config JSON")
    parser.add_argument(
        "--action",
        required=True,
        choices=["rebuild_index", "generate_context", "incremental_index"],
    )
    args = parser.parse_args()

    try:
        config = load_config(args.config)
        if args.action == "rebuild_index":
            rebuild_index(config)
            emit({"event": "done"})
        elif args.action == "incremental_index":
            incremental_index(config)
            emit({"event": "done"})
        elif args.action == "generate_context":
            out_file, chunks_count, deps_count = generate_context(config)
            emit({
                "event": "done",
                "outputFile": out_file,
                "chunksCount": chunks_count,
                "depsCount": deps_count,
            })
        return 0
    except Exception as e:
        emit({"event": "error", "message": str(e)})
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
