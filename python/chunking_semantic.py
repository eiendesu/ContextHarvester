"""Semantic chunking via tree-sitter (optional phase1 enhancement)."""
from __future__ import annotations

from typing import Any

from common import chunk_text_sliding


def semantic_chunks(
    text: str, language: str, chunk_size: int, chunk_overlap: int
) -> list[tuple[int, int, str]]:
    """Return chunks; uses tree-sitter boundaries when possible."""
    ext = language.lower()
    if ext in ("typescript", "tsx", "javascript"):
        try:
            from ts_parser import _TS_AVAILABLE, _parser

            if _TS_AVAILABLE and _parser is not None:
                return _chunks_from_tree(text, chunk_size, chunk_overlap)
        except Exception:
            pass
    if ext in ("csharp", "cs"):
        # Roslyn could split by method; fallback to sliding for now
        pass
    return chunk_text_sliding(text, chunk_size, chunk_overlap)


def _chunks_from_tree(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    data = text.encode("utf-8", errors="replace")
    from ts_parser import _parser

    tree = _parser.parse(data)
    boundaries: list[int] = [0]
    root = tree.root_node

    def walk(node):
        if node.type in ("function_declaration", "class_declaration", "export_statement"):
            boundaries.append(node.start_byte)
        for i in range(node.child_count):
            walk(node.children[i])

    walk(root)
    boundaries.append(len(data))
    boundaries = sorted(set(boundaries))
    parts: list[str] = []
    for i in range(len(boundaries) - 1):
        part = data[boundaries[i] : boundaries[i + 1]].decode("utf-8", errors="replace").strip()
        if len(part) > 30:
            parts.append(part)
    if not parts:
        return chunk_text_sliding(text, chunk_size, chunk_overlap)
    merged: list[str] = []
    buf = ""
    for p in parts:
        if len(buf) + len(p) < chunk_size * 4:
            buf = (buf + "\n\n" + p).strip()
        else:
            if buf:
                merged.extend(chunk_text_sliding(buf, chunk_size, chunk_overlap))
            buf = p
    if buf:
        merged.extend(chunk_text_sliding(buf, chunk_size, chunk_overlap))
    return merged or chunk_text_sliding(text, chunk_size, chunk_overlap)
