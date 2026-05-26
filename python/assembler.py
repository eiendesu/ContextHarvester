"""Assemble final context markdown file."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LANG_FENCE = {
    "csharp": "csharp",
    "cs": "csharp",
    "typescript": "typescript",
    "tsx": "tsx",
    "ts": "typescript",
    "sql": "sql",
    "markdown": "markdown",
    "md": "markdown",
    "python": "python",
    "javascript": "javascript",
}


def _fence(lang: str) -> str:
    return LANG_FENCE.get(lang.lower(), lang or "text")


def run(
    config: dict[str, Any],
    chunks: list[dict[str, Any]],
    deps: list[dict[str, Any]],
) -> Path:
    card_id = config.get("cardId", "context")
    template = config.get("fileNameTemplate", "{CARD}_context")
    name = template.replace("{CARD}", card_id)
    if not name.endswith(".md"):
        name += ".md"

    output_dir = Path(config["outputPath"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / name

    feature = config.get("featureInput", "")
    feature_preview = feature.strip().split("\n")[0][:100]
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [
        f"# Context: {card_id}",
        f"**Feature:** {feature_preview}",
        f"**Generato:** {ts}",
        f"**Chunks:** {len(chunks)} | **Dipendenze:** {len(deps)}",
        "",
        "---",
        "",
        "## Codice rilevante",
        "",
    ]

    for c in chunks:
        score = c.get("score", 0)
        fp = c.get("file_path", "")
        s, e = c.get("start_line", 1), c.get("end_line", 1)
        lang = _fence(c.get("language", "text"))
        text = c.get("text", "").strip()
        lines.extend([
            f"### [{score:.2f}] `{fp}` (righe {s}–{e})",
            f"```{lang}",
            text,
            "```",
            "",
        ])

    if deps:
        lines.extend(["---", "", "## File dipendenti", ""])
        for d in deps:
            fp = d.get("file_path", "")
            lang = _fence(d.get("language", "text"))
            text = d.get("text", "").strip()
            lines.extend([
                f"### `{fp}`",
                f"```{lang}",
                text,
                "```",
                "",
            ])

    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path
