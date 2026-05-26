"""Resolve dependency files from using/import statements."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from common import emit_progress, rel_path


CS_USING = re.compile(r"^\s*using\s+([\w.]+)\s*;", re.M)
TS_IMPORT = re.compile(r"""import\s+.*?from\s+['"]([^'"]+)['"]""", re.M)


def _resolve_cs_using(repo: Path, namespace: str, all_cs: dict[str, Path]) -> Path | None:
    ns_path = namespace.replace(".", "/")
    candidate = repo / f"{ns_path}.cs"
    if candidate.exists():
        return candidate
    for rel, p in all_cs.items():
        if rel.replace("\\", "/").endswith(f"/{namespace.split('.')[-1]}.cs"):
            return p
    return None


def _resolve_ts_import(repo: Path, importer: Path, imp: str) -> Path | None:
    base = importer.parent
    if imp.startswith("."):
        for ext in ("", ".ts", ".tsx", ".js"):
            c = (base / imp).with_suffix(ext) if ext else base / imp
            if c.exists():
                return c
            c2 = base / f"{imp}{ext}"
            if c2.exists():
                return c2
    return None


def _public_signatures_cs(text: str) -> str:
    lines = []
    for m in re.finditer(
        r"^\s*(public\s+(?:static\s+)?(?:class|interface|enum)\s+\w+.*)$|"
        r"^\s*public\s+[\w<>,\s\[\]]+\s+\w+\s*\([^)]*\)\s*[{;]",
        text,
        re.M,
    ):
        lines.append(m.group(0).strip())
    return "\n".join(lines[:80]) if lines else text[:4000]


def _public_signatures_ts(text: str) -> str:
    lines = []
    for m in re.finditer(
        r"^\s*export\s+(?:default\s+)?(?:function|class|const|interface)\s+.+$",
        text,
        re.M,
    ):
        lines.append(m.group(0).strip())
    return "\n".join(lines[:80]) if lines else text[:4000]


def run(config: dict[str, Any], chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not config.get("enableDependencyGraph", True):
        return []

    emit_progress("deps", "Dependency graph")
    repo = Path(config["repoPath"]).resolve()
    depth = int(config.get("dependencyDepth", 1))
    if depth < 1:
        return []

    seen_files = {c["file_path"] for c in chunks}
    deps: list[dict[str, Any]] = []
    deps_paths: set[str] = set()

    all_cs = {rel_path(p, repo): p for p in repo.rglob("*.cs") if p.is_file()}

    for rel in list(seen_files):
        fp = repo / rel
        if not fp.exists():
            continue
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        targets: list[Path] = []
        if fp.suffix.lower() == ".cs":
            for ns in CS_USING.findall(text):
                if ns.startswith("System"):
                    continue
                resolved = _resolve_cs_using(repo, ns, all_cs)
                if resolved:
                    targets.append(resolved)
        elif fp.suffix.lower() in (".ts", ".tsx"):
            for imp in TS_IMPORT.findall(text):
                resolved = _resolve_ts_import(repo, fp, imp)
                if resolved:
                    targets.append(resolved)

        for target in targets:
            trel = rel_path(target, repo)
            if trel in seen_files or trel in deps_paths:
                continue
            deps_paths.add(trel)
            try:
                content = target.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            line_count = content.count("\n") + 1
            if line_count > 200:
                if target.suffix.lower() == ".cs":
                    content = _public_signatures_cs(content)
                else:
                    content = _public_signatures_ts(content)
            deps.append({
                "file_path": trel,
                "text": content,
                "language": target.suffix.lstrip("."),
            })

    return deps
