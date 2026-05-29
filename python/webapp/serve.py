#!/usr/bin/env python3
"""Server di sviluppo locale per la webapp Context Harvester.
Serve i file statici e risponde alle API con i mock JSON.

Uso:
    cd python/webapp
    python serve.py
    # apri http://localhost:3456/?mock=1
"""

import json
import os
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(BASE_DIR))
WEBVIEW_VENDOR = os.path.join(PROJECT_ROOT, "webview", "vendor")

# Mappa endpoint -> file mock
API_MOCKS = {
    "/api/status": "static/mock/status.json",
    "/api/graph": "static/mock/graph.json",
    "/api/functions": "static/mock/functions.json",
    "/api/analysis": "static/mock/analysis.json",
    "/api/graph/analysis": "static/mock/analysis.json",
    "/api/symbols": "static/mock/symbols.json",
}

PREFIX_MOCKS = {
    "/api/graph/file": "static/mock/graph-file.json",
    "/api/graph/detail": "static/mock/graph-detail.json",
    "/api/graph/search": "static/mock/graph-search.json",
    "/api/graph/expand": "static/mock/graph-expand.json",
    "/api/graph/impact": "static/mock/graph-impact.json",
    "/api/graph/api-links": "static/mock/graph-api-links.json",
    "/api/graph/path": "static/mock/graph-path.json",
    "/api/graph/label-first": "static/mock/graph.json",
    "/api/graph/label-first/save": "static/mock/functions.json",
}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Strip query string from path
        if "?" in path:
            path = path.split("?")[0]
        # Serve /static/ da BASE_DIR
        if path.startswith("/static/"):
            rel = path[1:]  # togli lo slash iniziale
            return os.path.join(BASE_DIR, rel)
        # Serve /vendor/ da BASE_DIR, con fallback a webview/vendor
        if path.startswith("/vendor/"):
            rel = path[1:]  # es. vendor/sigma/sigma.min.js
            local = os.path.join(BASE_DIR, rel)
            if os.path.exists(local):
                return local
            # fallback alla cartella webview del progetto
            sub = path[8:]  # togli /vendor/ (8 chars)
            alt = os.path.join(WEBVIEW_VENDOR, sub)
            print(f"  [vendor] {path} -> {alt} (exists={os.path.exists(alt)})")
            if os.path.exists(alt):
                return alt
            return local  # lascia che dia 404
        # Serve / come templates/index.html
        if path == "/" or path.startswith("/?"):
            return os.path.join(BASE_DIR, "templates", "index.html")
        return super().translate_path(path)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        # Strip cache-buster query string from static file paths
        if "?" in self.path and not path.startswith("/api/"):
            path = self.path.split("?")[0]

        # API mock
        if path in API_MOCKS:
            return self._serve_json(API_MOCKS[path])
        for prefix, mock_file in PREFIX_MOCKS.items():
            if path.startswith(prefix):
                return self._serve_json(mock_file)

        if path.endswith(".map"):
            self.send_response(204)
            self.end_headers()
            return

        # Override to add no-cache headers for static files
        self._no_cache_do_GET()

    def _no_cache_do_GET(self):
        path = self.translate_path(self.path)
        import mimetypes
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        try:
            with open(path, "rb") as f:
                data = f.read()
        except (FileNotFoundError, IsADirectoryError):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        for prefix, mock_file in PREFIX_MOCKS.items():
            if path.startswith(prefix):
                return self._serve_json(mock_file)
        self.send_error(404)

    def _serve_json(self, rel_path):
        full = os.path.join(BASE_DIR, rel_path)
        if not os.path.exists(full):
            self.send_error(404)
            return
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        # stampa richieste in modo leggibile
        print(f"  [{self.command}] {fmt % args}")


if __name__ == "__main__":
    port = 3456
    addr = ("", port)
    httpd = HTTPServer(addr, Handler)
    print(f"\n🚀  Server avviato su http://localhost:{port}/")
    print(f"📂  Root: {BASE_DIR}")
    print(f"👉  Apri: http://localhost:{port}/?mock=1\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋  Server fermato.")
