#!/usr/bin/env python3
"""Layer 4 — MCP server + Graph Web App (FastAPI on single port)."""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config_loader import load_config
from functional_map import find_function, get_graph_stats, load as load_functional_map, validated_functions
from graph_http import create_http_app, set_config
from common import harvester_root

_config: dict[str, Any] = {}
_last_call: dict[str, Any] = {"tool": "", "duration_s": 0}


def _cfg() -> dict[str, Any]:
    return _config


def _index_meta(repo: Path) -> dict[str, Any]:
    p = harvester_root(repo) / "index_meta.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _run_generate(card_id: str, feature_input: str, profile: str, focus: list[str], include_docs: bool) -> str:
    import orchestrator

    cfg = dict(_cfg())
    cfg["cardId"] = card_id
    cfg["featureInput"] = feature_input
    cfg["activeProfile"] = profile or cfg.get("activeProfile", "laptop-balanced")
    cfg["focusBackend"] = "backend" in focus
    cfg["focusFrontend"] = "frontend" in focus
    cfg["focusSql"] = "sql" in focus
    cfg["includeDocsInRetrieval"] = include_docs
    cfg["enableFunctionalAnalysis"] = cfg.get("enableFunctionalAnalysis", True)

    out = orchestrator.generate_context(cfg)
    summary = (
        f"Generated {out.get('outputFile', '')}\n"
        f"Chunks: {out.get('chunksCount', 0)} | Deps: {out.get('depsCount', 0)} | "
        f"Tests: {out.get('testsCount', 0)}"
    )
    if out.get("confidenceScore") is not None:
        summary += f" | Confidence: {out['confidenceScore']}/10"
    return summary


def _run_search(query: str, top_k: int, focus: list[str]) -> list[dict[str, Any]]:
    import phase3_retrieval

    cfg = dict(_cfg())
    cfg["topK"] = top_k
    cfg["featureInput"] = query
    cfg["focusBackend"] = "backend" in focus
    cfg["focusFrontend"] = "frontend" in focus
    cfg["focusSql"] = "sql" in focus
    chunks = phase3_retrieval.run(cfg, [query])
    return [
        {
            "file": c.get("file_path"),
            "start_line": c.get("start_line"),
            "end_line": c.get("end_line"),
            "score": round(float(c.get("score", 0)), 4),
            "preview": (c.get("text") or "")[:200],
        }
        for c in chunks[:top_k]
    ]


def create_mcp_server():
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as e:
        raise ImportError("mcp package not installed. Run: pip install mcp") from e

    mcp = FastMCP("context-harvester", stateless_http=True, json_response=True)

    @mcp.tool()
    def generate_context(
        card_id: str,
        feature_input: str,
        profile: str = "laptop-balanced",
        focus: list[str] | None = None,
        include_docs: bool = False,
    ) -> str:
        """Generate context markdown for a feature card."""
        import time

        t0 = time.time()
        focus = focus or ["backend", "frontend", "sql"]
        result = _run_generate(card_id, feature_input, profile, focus, include_docs)
        _last_call.update({"tool": "generate_context", "card_id": card_id, "duration_s": round(time.time() - t0, 1)})
        return result

    @mcp.tool()
    def search_codebase(
        query: str,
        top_k: int = 10,
        focus: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Direct vector search without HyDE."""
        import time

        t0 = time.time()
        focus = focus or ["backend", "frontend", "sql"]
        result = _run_search(query, top_k, focus)
        _last_call.update({"tool": "search_codebase", "duration_s": round(time.time() - t0, 1)})
        return result

    @mcp.tool()
    def get_function_info(function_name: str) -> dict[str, Any]:
        """Return nodes, files, and terms for a mapped function."""
        fmap = load_functional_map(_cfg()["repoPath"])
        fn = find_function(fmap, function_name)
        if not fn:
            return {"error": f"Function not found: {function_name}"}
        return {
            "id": fn.get("id"),
            "name": fn.get("name"),
            "source": fn.get("source"),
            "validated": fn.get("validated"),
            "files": fn.get("files", []),
            "godNodes": fn.get("godNodes", []),
            "terms": fn.get("terms", {}),
            "nodes": fn.get("nodes", [])[:50],
        }

    @mcp.tool()
    def get_index_status() -> dict[str, Any]:
        """Return index metadata and active profile."""
        repo = Path(_cfg()["repoPath"])
        meta = _index_meta(repo)
        return {
            "repoPath": str(repo),
            "activeProfile": _cfg().get("activeProfile"),
            "lastIndexed": meta.get("lastIndexed"),
            "totalFiles": meta.get("totalFiles"),
            "symbolsIndexed": meta.get("symbolsIndexed"),
            "graph": get_graph_stats(repo),
        }

    @mcp.tool()
    def list_functions() -> list[dict[str, str]]:
        """List validated functions from functional_map.json."""
        fmap = load_functional_map(_cfg()["repoPath"])
        return [
            {
                "id": str(f.get("id", "")),
                "name": str(f.get("name", "")),
                "source": str(f.get("source", "leiden")),
            }
            for f in validated_functions(fmap)
        ]

    return mcp


def main() -> int:
    global _config
    parser = argparse.ArgumentParser(description="Context Harvester MCP + Graph server")
    parser.add_argument("--config", required=True, help="Path to config JSON")
    parser.add_argument("--port", type=int, default=3456)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    try:
        _config = load_config(args.config)
        set_config(_config)
        mcp = create_mcp_server()
        import uvicorn

        mcp_asgi = mcp.streamable_http_app()
        app = create_http_app(mcp_asgi)
        base_url = f"http://{args.host}:{args.port}"
        print(
            json.dumps({
                "event": "mcp_started",
                "url": f"{base_url}/mcp",
                "webapp": base_url,
            }),
            flush=True,
        )
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
        return 0
    except Exception as e:
        print(json.dumps({"event": "error", "message": str(e)}), flush=True)
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
