"""Exact keyword grep to supplement vector retrieval."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from common import emit_progress, iter_repo_files, load_vocabulary, merge_exclude_folders, rel_path


def _keywords_from_feature(feature: str, vocab: dict[str, list[str]]) -> list[str]:
    found: set[str] = set()
    all_terms: list[str] = []
    for key in ("classes", "interfaces", "components", "tables", "procedures", "feature_flags"):
        all_terms.extend(vocab.get(key, []))
    for term in all_terms:
        if len(term) >= 3 and term.lower() in feature.lower():
            found.add(term)
    # Also extract PascalCase / snake identifiers from feature text
    for m in re.findall(r"\b[A-Z][a-zA-Z0-9]{2,}\b|\b[A-Z]{2,}_[A-Z0-9_]+\b", feature):
        found.add(m)
    return sorted(found)[:15]


def _grep_ripgrep(repo: Path, keyword: str, exclude_folders: list[str]) -> list[dict[str, Any]]:
    if not shutil.which("rg"):
        return []
    globs = [f"!{f}/**" for f in exclude_folders]
    cmd = ["rg", "--json", "-n", "--max-count", "5", keyword, str(repo), *globs]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return []
    matches: list[dict[str, Any]] = []
    for line in out.stdout.splitlines():
        try:
            obj = json.loads(line)
            if obj.get("type") != "match":
                continue
            data = obj["data"]
            path = Path(data["path"]["text"])
            line_no = data["line_number"]
            matches.append({"path": path, "line": line_no})
        except (json.JSONDecodeError, KeyError):
            continue
    return matches


def _grep_python(repo: Path, keyword: str, files: list[Path]) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    pattern = re.compile(re.escape(keyword))
    for path in files:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            if pattern.search(line):
                matches.append({"path": path, "line": i})
                if len(matches) >= 5:
                    break
    return matches


def _context_chunk(repo: Path, path: Path, line_no: int, keyword: str) -> dict[str, Any]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    start = max(1, line_no - 10)
    end = min(len(lines), line_no + 10)
    text = "\n".join(lines[start - 1 : end])
    return {
        "file_path": rel_path(path, repo),
        "start_line": start,
        "end_line": end,
        "text": text,
        "score": 0.75,
        "language": path.suffix.lstrip("."),
    }


def run(
    config: dict[str, Any],
    existing_chunks: list[dict[str, Any]],
    indexed_files: list[Path] | None = None,
    search_hints: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not config.get("enableGrep", True):
        return []

    emit_progress("grep", "Grep parallelo")
    repo = Path(config["repoPath"]).resolve()
    vocab = load_vocabulary(repo)
    feature = config.get("featureInput", "")
    keywords = _keywords_from_feature(feature, vocab)
    if search_hints:
        keywords = sorted(set(keywords + [h for h in search_hints if len(h) >= 2]))[:20]
    if not keywords:
        return []

    exclude = merge_exclude_folders(config.get("excludeFolders"))
    existing_keys = {f"{c['file_path']}:{c['start_line']}" for c in existing_chunks}

    if indexed_files is None:
        indexed_files = list(
            iter_repo_files(
                repo,
                exclude,
                config.get("includeExtensions", []),
                config.get("excludeExtensions", []),
                code_only=True,
            )
        )

    extra: list[dict[str, Any]] = []
    for kw in keywords:
        matches = _grep_ripgrep(repo, kw, exclude) or _grep_python(repo, kw, indexed_files)
        for m in matches[:5]:
            rel = rel_path(m["path"], repo)
            key = f"{rel}:{m['line']}"
            if key in existing_keys:
                continue
            chunk = _context_chunk(repo, m["path"], m["line"], kw)
            existing_keys.add(key)
            extra.append(chunk)
    return extra
