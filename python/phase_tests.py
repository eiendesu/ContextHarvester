"""Find associated test files for chunks in the final pool."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from common import emit_progress, language_for_ext, rel_path


def _test_candidates(stem: str, ext: str) -> list[str]:
    base_names: list[str] = []
    if ext in (".cs",):
        base_names = [
            f"{stem}Tests.cs",
            f"{stem}Test.cs",
            f"Test{stem}.cs",
            f"{stem}Tests.cs",
        ]
    elif ext in (".ts", ".tsx"):
        base_names = [
            f"{stem}.test{ext}",
            f"{stem}.spec{ext}",
            f"{stem}.test.ts",
            f"{stem}.spec.ts",
        ]
    return base_names


def _find_test_file(repo: Path, source_rel: str) -> Path | None:
    fp = repo / source_rel
    if not fp.exists():
        return None
    stem = fp.stem
    ext = fp.suffix
    candidates = _test_candidates(stem, ext)
    for path in repo.rglob("*"):
        if not path.is_file():
            continue
        if path.name in candidates:
            return path
    return None


def _test_methods_only(text: str, lang: str) -> str:
    lines = text.splitlines()
    if lang in ("csharp", "cs"):
        methods = [ln.strip() for ln in lines if re_public_test(ln)]
    else:
        methods = [ln.strip() for ln in lines if re_test_fn(ln)]
    return "\n".join(methods) if methods else text[:2000]


RE_CS_TEST = re.compile(r"\[(?:Fact|Test|TestMethod|Theory)\]|void\s+Test\w+|void\s+\w+_Should")
RE_TS_TEST = re.compile(r"\b(?:it|test|describe)\s*\(|^\s*(?:async\s+)?function\s+test", re.I)


def re_public_test(line: str) -> bool:
    return bool(RE_CS_TEST.search(line))


def re_test_fn(line: str) -> bool:
    return bool(RE_TS_TEST.search(line))


def run(config: dict[str, Any], chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    emit_progress("tests", "Test associati")
    repo = Path(config["repoPath"]).resolve()
    tests: list[dict[str, Any]] = []
    seen: set[str] = set()

    for c in chunks:
        source_rel = c.get("file_path", "")
        if not source_rel or source_rel in seen:
            continue
        test_path = _find_test_file(repo, source_rel)
        if not test_path:
            continue
        trel = rel_path(test_path, repo)
        if trel in seen:
            continue
        seen.add(trel)
        try:
            text = test_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        line_count = text.count("\n") + 1
        lang = language_for_ext(test_path.suffix)
        if line_count > 150:
            text = _test_methods_only(text, lang)
        tests.append({
            "file_path": trel,
            "text": text,
            "language": lang,
            "source_file": source_rel,
        })

    return tests
