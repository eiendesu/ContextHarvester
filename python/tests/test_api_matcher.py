"""Tests for API matching (v5)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api_matcher import build_api_links


def test_exact_route_match():
    repo = Path("/tmp/unused")
    clients = {
        "clients": [
            {
                "id": "c1",
                "file": "src/api/contracts.ts",
                "function": "getContracts",
                "method": "GET",
                "route": "/api/contracts",
                "routeKey": "GET /api/contracts",
            }
        ]
    }
    backend = {
        "endpoints": [
            {
                "id": "e1",
                "file": "Controllers/ContractsController.cs",
                "method": "GET",
                "route": "/api/contracts",
                "routeKey": "GET /api/contracts",
                "qualifiedName": "ContractsController.Get",
            }
        ]
    }
    result = build_api_links(repo, clients, backend)
    assert result["count"] == 1
    assert result["links"][0]["confidence"] == 1.0
    assert result["links"][0]["certain"] is True
