"""Load runtime config JSON passed from the VS Code extension."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_config(path: str | Path) -> dict[str, Any]:
    p = Path(path).resolve()
    with p.open(encoding="utf-8") as f:
        return json.load(f)
