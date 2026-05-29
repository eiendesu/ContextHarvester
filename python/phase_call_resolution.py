"""Call edge resolution — Fase 1 (direct match) + Fase 2 (DI resolution) + Fase 3 (semantic).

Produces call_edges_resolved.json in .context-harvester/.
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from common import emit_progress

logger = logging.getLogger(__name__)


def clean_target_name(raw: str) -> str:
    """Normalizza il nome del target dal codice sorgente a un nome classe candidato."""
    name = raw.removeprefix("this.")
    name = name.lstrip("_")
    if name:
        name = name[0].upper() + name[1:]
    if "<" in name:
        m = re.search(r"<(\w+)>", name)
        if m:
            name = m.group(1)
    return name


def resolve_phase1(raw_calls: list[dict[str, Any]], name_lookup: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Match diretto su name_lookup.byClassName."""
    resolved: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []

    by_class = name_lookup.get("byClassName", {})
    by_class_lower = name_lookup.get("byClassNameLower", {})
    node_to_class = name_lookup.get("nodeToClass", {})
    node_to_file = name_lookup.get("nodeToFile", {})

    for call in raw_calls:
        clean = clean_target_name(call.get("targetClassRaw", ""))
        node_id = by_class.get(clean)
        if not node_id:
            node_id = by_class_lower.get(clean.lower())

        if node_id:
            resolved.append({
                **call,
                "toNodeId": node_id,
                "toClass": node_to_class.get(node_id, ""),
                "toFile": node_to_file.get(node_id, ""),
                "resolvedBy": "direct",
            })
        else:
            unresolved.append(call)

    return resolved, unresolved


def resolve_phase2(unresolved: list[dict[str, Any]], name_lookup: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """DI resolution: interfaccia -> implementazione concreta."""
    resolved: list[dict[str, Any]] = []
    still_unresolved: list[dict[str, Any]] = []

    by_class = name_lookup.get("byClassName", {})
    interfaces = name_lookup.get("interfaces", {})
    node_to_class = name_lookup.get("nodeToClass", {})
    node_to_file = name_lookup.get("nodeToFile", {})

    for call in unresolved:
        clean = clean_target_name(call.get("targetClassRaw", ""))
        concrete_class = interfaces.get(clean)

        if not concrete_class and clean.startswith("I") and len(clean) > 1:
            candidate = clean[1:]
            concrete_class = by_class.get(candidate)
            if concrete_class:
                concrete_class = candidate

        if concrete_class:
            node_id = by_class.get(concrete_class)
            if node_id:
                resolved.append({
                    **call,
                    "toNodeId": node_id,
                    "toClass": concrete_class,
                    "toFile": node_to_file.get(node_id, ""),
                    "resolvedBy": "di_resolution",
                })
                continue

        still_unresolved.append(call)

    return resolved, still_unresolved


def resolve_all_call_edges(
    raw_cs: list[dict[str, Any]],
    raw_ts: list[dict[str, Any]],
    name_lookup: dict[str, Any],
    settings: dict[str, Any],
) -> list[dict[str, Any]]:
    """Orchestra Fase 1 e Fase 2; Fase 3 non implementata in questa versione base."""
    all_raw = raw_cs + raw_ts
    all_resolved: list[dict[str, Any]] = []

    # FASE 1
    resolved_1, unresolved = resolve_phase1(all_raw, name_lookup)
    all_resolved.extend(resolved_1)
    emit_progress("call_resolution", f"Fase 1: {len(resolved_1)} risolti, {len(unresolved)} irrisolti", 1, 3)

    # FASE 2
    if settings.get("enableDIResolution", True) and unresolved:
        resolved_2, unresolved = resolve_phase2(unresolved, name_lookup)
        all_resolved.extend(resolved_2)
        emit_progress("call_resolution", f"Fase 2: +{len(resolved_2)} risolti, {len(unresolved)} irrisolti", 2, 3)

    # FASE 3 — Semantic resolution (opzionale, default off)
    if settings.get("enableSemanticResolution", False) and unresolved:
        timeout = settings.get("semanticTimeoutSeconds", 120)
        unresolved_cs = [c for c in unresolved if str(c.get("fromFile", "")).endswith(".cs")]
        unresolved_ts = [c for c in unresolved if str(c.get("fromFile", "")).endswith((".ts", ".tsx"))]

        if unresolved_cs:
            resolved_3_cs = _resolve_phase3_csharp(unresolved_cs, settings.get("roslynPath"), timeout)
            all_resolved.extend(resolved_3_cs)
            emit_progress("call_resolution", f"Fase 3 C#: +{len(resolved_3_cs)} risolti", 3, 3)

        if unresolved_ts and settings.get("enableTypeScriptSemantic", True):
            resolved_3_ts = _resolve_phase3_typescript(unresolved_ts, timeout)
            all_resolved.extend(resolved_3_ts)
            emit_progress("call_resolution", f"Fase 3 TS: +{len(resolved_3_ts)} risolti", 3, 3)

    total = len(all_raw)
    coverage = len(all_resolved) / total * 100 if total > 0 else 0
    emit_progress("call_resolution", f"Completato: {len(all_resolved)}/{total} ({coverage:.1f}%)", 3, 3)

    return all_resolved


def _resolve_phase3_csharp(unresolved_cs: list[dict[str, Any]], roslyn_path: str | None, timeout: int) -> list[dict[str, Any]]:
    """Invoke RoslynHarvester with --resolve-semantic flag (placeholder — requires Compilation support)."""
    # Phase 3 C# requires a Compilation which RoslynHarvester does not yet build in the basic mode.
    # This is a stub that can be enabled when Program.cs is upgraded to use MSBuildWorkspace.
    logger.info("Phase 3 C# semantic resolution skipped — requires MSBuildWorkspace/Compilation support")
    return []


def _resolve_phase3_typescript(unresolved_ts: list[dict[str, Any]], timeout: int) -> list[dict[str, Any]]:
    """Invoke ts_semantic_resolver via Node.js."""
    if not unresolved_ts:
        return []
    try:
        resolver_path = Path(__file__).resolve().parent.parent / "tools" / "ts_semantic_resolver" / "index.js"
        if not resolver_path.is_file():
            logger.warning("ts_semantic_resolver/index.js not found")
            return []

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(unresolved_ts, f)
            temp_input = f.name

        result = subprocess.run(
            ["node", str(resolver_path), temp_input],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        Path(temp_input).unlink(missing_ok=True)

        if result.returncode != 0:
            logger.warning("TS semantic resolution failed: %s", result.stderr[:500])
            return []

        parsed = json.loads(result.stdout or "[]")
        return parsed if isinstance(parsed, list) else []
    except FileNotFoundError:
        logger.warning("node not found — TS semantic resolution disabled")
        return []
    except Exception as exc:
        logger.warning("TS semantic resolution error: %s", exc)
        return []


def save_call_edge_results(
    repo: Path,
    resolved: list[dict[str, Any]],
    raw_cs: list[dict[str, Any]],
    raw_ts: list[dict[str, Any]],
) -> None:
    """Salva call_edges_resolved.json, raw files e stats in .context-harvester."""
    harv = repo / ".context-harvester"
    harv.mkdir(parents=True, exist_ok=True)

    (harv / "call_edges_raw_cs.json").write_text(
        json.dumps({"calls": raw_cs}, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (harv / "call_edges_raw_ts.json").write_text(
        json.dumps({"calls": raw_ts}, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (harv / "call_edges_resolved.json").write_text(
        json.dumps({"calls": resolved}, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    total = len(raw_cs) + len(raw_ts)
    stats = {
        "total": total,
        "resolved": len(resolved),
        "coverage": round(len(resolved) / total * 100, 1) if total > 0 else 0,
    }
    (harv / "call_resolution_stats.json").write_text(
        json.dumps(stats, indent=2, ensure_ascii=False), encoding="utf-8"
    )
