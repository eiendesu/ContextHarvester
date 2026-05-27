"""Assemble final context markdown and optional exports."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from common import load_project_context

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


def _confidence_label(score: int) -> str:
    if score >= 9:
        return "Completo"
    if score >= 7:
        return "Buono — il contesto dovrebbe essere sufficiente"
    if score >= 5:
        return "Parziale"
    return "Insufficiente — contesto probabilmente incompleto"


def run(
    config: dict[str, Any],
    chunks: list[dict[str, Any]],
    deps: list[dict[str, Any]],
    tests: list[dict[str, Any]] | None = None,
    negative: list[dict[str, Any]] | None = None,
    confidence: dict[str, Any] | None = None,
    query_analysis: dict[str, Any] | None = None,
) -> dict[str, Path]:
    card_id = config.get("cardId", "context")
    template = config.get("fileNameTemplate", "{CARD}_context")
    base_name = template.replace("{CARD}", card_id)
    if base_name.endswith(".md"):
        base_name = base_name[:-3]

    output_dir = Path(config["outputPath"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    out_md = output_dir / f"{base_name}.md"

    feature = config.get("featureInput", "")
    feature_preview = feature.strip().split("\n")[0][:100]
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    project_ctx = load_project_context(config["repoPath"])

    lines = [
        f"# Context: {card_id}",
        f"**Feature:** {feature_preview}",
        f"**Generato:** {ts}",
        f"**Chunks:** {len(chunks)} | **Dipendenze:** {len(deps)}",
    ]

    if query_analysis:
        lines.append(
            f"**Query type:** {query_analysis.get('type', 'other')} | "
            f"**Areas:** {', '.join(query_analysis.get('areas', []))}"
        )
        if query_analysis.get("related_function"):
            lines.append(f"**Funzionalità:** {query_analysis.get('related_function')}")

    if confidence:
        score = int(confidence.get("score", 0))
        lines.extend([
            "",
            f"## 📊 Confidence Score: {score}/10",
            f"**Valutazione:** {_confidence_label(score)}",
        ])
        if confidence.get("notes"):
            lines.append(f"**Note:** {confidence['notes']}")
        if score < 5 and confidence.get("missing"):
            missing = ", ".join(confidence["missing"])
            lines.append(f"⚠️ Considera di aggiungere manualmente: {missing}")

    lines.extend(["", "---", "", "## Codice rilevante", ""])

    for c in chunks:
        score = c.get("score", 0)
        fp = c.get("file_path", "")
        level = c.get("level", "")
        level_tag = f" [{level}]" if level else ""
        s, e = c.get("start_line", 1), c.get("end_line", 1)
        lang = _fence(c.get("language", "text"))
        text = c.get("text", "").strip()
        lines.extend([
            f"### [{score:.2f}]{level_tag} `{fp}` (righe {s}–{e})",
            f"```{lang}",
            text,
            "```",
            "",
        ])

    if tests:
        lines.extend(["---", "", "## Test associati", ""])
        for t in tests:
            fp = t.get("file_path", "")
            src = t.get("source_file", "")
            lang = _fence(t.get("language", "text"))
            text = t.get("text", "").strip()
            lines.extend([
                f"### `{fp}` (per `{src}`)",
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

    if negative:
        lines.extend([
            "---",
            "",
            "## ⚠️ File probabilmente non rilevanti (non modificare)",
            "",
        ])
        for n in negative:
            fp = n.get("file_path", "")
            reason = n.get("negative_reason", "similarità media")
            lines.append(f"- `{fp}` — {reason}")

    if project_ctx:
        lines.extend(["---", "", "## Project Context", "", project_ctx, ""])

    md_text = "\n".join(lines)
    out_md.write_text(md_text, encoding="utf-8")

    result: dict[str, Path] = {"md": out_md}

    if config.get("exportJson"):
        out_json = output_dir / f"{base_name}.json"
        payload = {
            "card": card_id,
            "feature": feature,
            "generated": ts,
            "confidence": confidence.get("score") if confidence else None,
            "queryAnalysis": query_analysis,
            "chunks": chunks,
            "dependencies": deps,
            "tests": tests or [],
            "negativeContext": negative or [],
            "projectContext": project_ctx,
        }
        out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        result["json"] = out_json

    if config.get("exportTxt"):
        out_txt = output_dir / f"{base_name}.txt"
        out_txt.write_text(md_text, encoding="utf-8")
        result["txt"] = out_txt

    return result
