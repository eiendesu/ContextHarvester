"""Tests for route normalization (v5)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from route_normalize import expand_controller_token, normalize_path, route_key, segment_match_score


def test_normalize_path_params():
    assert normalize_path("/api/contracts/${id}") == "/api/contracts/{param}"


def test_expand_controller():
    assert "contracts" in expand_controller_token("api/[controller]", "ContractsController")


def test_route_key():
    assert route_key("POST", "/api/contracts/lead") == "POST /api/contracts/lead"


def test_segment_match():
    assert segment_match_score("/api/contracts/{param}", "/api/contracts/{param}") >= 0.9
