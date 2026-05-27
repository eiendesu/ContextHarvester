"""FastAPI routes for Graph Web App + REST API (v4)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

_config: dict[str, Any] = {}


def set_config(config: dict[str, Any]) -> None:
    global _config
    _config = config


def _cfg() -> dict[str, Any]:
    return _config


def _repo() -> Path:
    return Path(_cfg()["repoPath"]).resolve()


def create_http_app(mcp_app=None) -> FastAPI:
    """Create FastAPI app with graph routes; optionally mount MCP ASGI app at /mcp."""
    root = Path(__file__).resolve().parent
    webapp_dir = root / "webapp"
    static_dir = webapp_dir / "static"
    templates_dir = webapp_dir / "templates"

    app = FastAPI(title="Context Harvester Graph", version="0.5.0")

    if mcp_app is not None:
        app.mount("/mcp", mcp_app)

    # ── Static / SPA ─────────────────────────────────────────────
    @app.get("/")
    async def index():
        index_path = templates_dir / "index.html"
        if index_path.is_file():
            return FileResponse(index_path)
        return JSONResponse({"error": "webapp not found"}, status_code=404)

    if static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    vendor_vis = root.parent / "webview" / "vendor" / "vis-network"
    if vendor_vis.is_dir():
        app.mount("/vendor/vis-network", StaticFiles(directory=str(vendor_vis)), name="vis-vendor")

    @app.get("/api/graph")
    async def api_graph():
        from functional_map import build_groups_metadata, group_label_for_id, load as load_fmap

        p = _repo() / ".context-harvester" / "graph.json"
        if not p.is_file():
            return JSONResponse({"nodes": [], "edges": [], "groups": [], "error": "graph.json missing"})
        graph = json.loads(p.read_text(encoding="utf-8"))
        fmap = load_fmap(_repo())
        functions = fmap.get("functions") or []
        if not graph.get("groups"):
            graph["groups"] = build_groups_metadata(functions)
        id_to_name = {
            str(f["id"]): str(f.get("name") or f["id"])
            for f in functions
            if isinstance(f, dict) and f.get("validated") and f.get("id")
        }
        for node in graph.get("nodes") or []:
            grp = node.get("group", "unassigned")
            if not node.get("groupLabel"):
                node["groupLabel"] = group_label_for_id(str(grp), id_to_name)
        return JSONResponse(graph)

    @app.get("/api/graph/impact/{node_id:path}")
    async def api_impact(node_id: str, max_depth: int = 3):
        from graph_analyses import impact_analysis

        return JSONResponse(impact_analysis(_repo(), node_id, max_depth=max_depth))

    @app.get("/api/graph/file")
    async def api_graph_file():
        p = _repo() / ".context-harvester" / "graph_file.json"
        if not p.is_file():
            return JSONResponse({"nodes": [], "edges": [], "error": "graph_file.json missing — run reindex + functional analysis"})
        return JSONResponse(json.loads(p.read_text(encoding="utf-8")))

    @app.get("/api/graph/detail")
    async def api_graph_detail():
        p = _repo() / ".context-harvester" / "graph_detail.json"
        if not p.is_file():
            return JSONResponse({"nodes": [], "edges": [], "error": "graph_detail.json missing"})
        return JSONResponse(json.loads(p.read_text(encoding="utf-8")))

    @app.get("/api/graph/expand")
    async def api_graph_expand(file: str):
        harv = _repo() / ".context-harvester"
        exp_p = harv / "graph_expansion_index.json"
        det_p = harv / "graph_detail.json"
        if not exp_p.is_file() or not det_p.is_file():
            return JSONResponse({"nodes": [], "edges": [], "error": "v5 graph artifacts missing"})
        expansion = json.loads(exp_p.read_text(encoding="utf-8"))
        detail = json.loads(det_p.read_text(encoding="utf-8"))
        entry = (expansion.get("files") or {}).get(file) or {}
        ids = set(entry.get("nodeIds") or [])
        nodes = [n for n in (detail.get("nodes") or []) if n.get("id") in ids]
        edges = [
            e for e in (detail.get("edges") or [])
            if e.get("source") in ids or e.get("target") in ids
        ]
        return JSONResponse({"file": file, "nodes": nodes, "edges": edges})

    @app.get("/api/graph/impact-v2/{node_id:path}")
    async def api_impact_v2(
        node_id: str,
        max_depth: int = 3,
        direction: str = "downstream",
        mode: str = "transitive",
    ):
        from graph_v2 import impact_analysis_v2

        return JSONResponse(
            impact_analysis_v2(
                _repo(),
                node_id,
                max_depth=max_depth,
                direction=direction,
                mode=mode,
            )
        )

    @app.get("/api/graph/api-links")
    async def api_graph_links():
        p = _repo() / ".context-harvester" / "api_links.json"
        if not p.is_file():
            return JSONResponse({"links": [], "count": 0})
        return JSONResponse(json.loads(p.read_text(encoding="utf-8")))

    @app.get("/api/graph/analysis")
    async def api_analysis(recalculate: bool = False):
        from graph_analyses import load_cached_analyses, run_all_analyses

        if recalculate:
            return JSONResponse(run_all_analyses(_cfg()))
        cached = load_cached_analyses(_repo())
        if cached:
            return JSONResponse(cached)
        return JSONResponse(run_all_analyses(_cfg()))

    @app.post("/api/graph/label-first")
    async def api_label_first(body: dict[str, Any]):
        from label_first import run_label_first

        user_input = str(body.get("input") or body.get("labelInput") or "")
        depth = body.get("depth")
        max_nodes = body.get("maxNodes")
        try:
            result = run_label_first(
                _cfg(),
                user_input,
                depth=int(depth) if depth is not None else None,
                max_nodes=int(max_nodes) if max_nodes is not None else None,
            )
            return JSONResponse(result)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=400)

    @app.post("/api/graph/label-first/save")
    async def api_label_first_save(body: dict[str, Any]):
        from label_first import save_label_first_function

        try:
            fn = save_label_first_function(
                _cfg(),
                str(body.get("name") or body.get("labelInput") or "Funzione"),
                str(body.get("labelInput") or ""),
                list(body.get("nodes") or []),
                traversal_depth=int(body.get("traversalDepth") or 2),
            )
            return JSONResponse({"ok": True, "function": fn})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=400)

    @app.get("/api/functions")
    async def api_functions_list():
        from functional_map import load

        return JSONResponse(load(_repo()))

    @app.get("/api/functions/{fn_id}")
    async def api_function_get(fn_id: str):
        from functional_map import find_function, load

        fmap = load(_repo())
        fn = find_function(fmap, fn_id)
        if not fn:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse(fn)

    @app.delete("/api/functions/{fn_id}")
    async def api_function_delete(fn_id: str):
        from functional_map import load, save

        fmap = load(_repo())
        before = len(fmap.get("functions") or [])
        fmap["functions"] = [
            f for f in (fmap.get("functions") or [])
            if str(f.get("id")) != fn_id
        ]
        if len(fmap["functions"]) == before:
            return JSONResponse({"error": "not found"}, status_code=404)
        fmap["functionalMapReady"] = any(
            f.get("validated") for f in fmap["functions"]
        )
        save(_repo(), fmap)
        from functional_map import refresh_graph_json

        refresh_graph_json(_repo())
        return JSONResponse({"ok": True})

    @app.get("/api/status")
    async def api_status():
        from functional_map import get_graph_stats, load

        repo = _repo()
        meta_path = repo / ".context-harvester" / "index_meta.json"
        meta = {}
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        fmap = load(repo)
        funcs = fmap.get("functions") or []
        analysis_path = repo / ".context-harvester" / "graph_analysis.json"
        analysis_counts = {}
        if analysis_path.is_file():
            try:
                a = json.loads(analysis_path.read_text(encoding="utf-8"))
                analysis_counts = a.get("counts") or {}
            except Exception:
                pass
        return JSONResponse({
            "repoPath": str(repo),
            "graph": get_graph_stats(repo),
            "functionsCount": len(funcs),
            "functionalMapReady": bool(fmap.get("functionalMapReady")),
            "indexMeta": meta,
            "analysisCounts": analysis_counts,
        })

    @app.websocket("/ws/graph")
    async def ws_graph(websocket: WebSocket):
        await websocket.accept()
        try:
            while True:
                message = await websocket.receive_json()
                action = message.get("action")
                if action == "label_first":
                    from label_first import label_first_stream

                    for chunk in label_first_stream(
                        _cfg(),
                        str(message.get("input") or ""),
                        depth=message.get("depth"),
                        max_nodes=message.get("maxNodes"),
                    ):
                        await websocket.send_json(chunk)
                elif action == "impact":
                    from graph_analyses import impact_analysis

                    result = impact_analysis(
                        _repo(),
                        str(message.get("node_id") or ""),
                        max_depth=int(message.get("max_depth") or 3),
                    )
                    await websocket.send_json({"stage": "done", **result})
                else:
                    await websocket.send_json({"error": f"unknown action: {action}"})
        except WebSocketDisconnect:
            pass
        except Exception as e:
            try:
                await websocket.send_json({"stage": "error", "message": str(e)})
            except Exception:
                pass

    return app
