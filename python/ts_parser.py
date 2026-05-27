"""TypeScript structural parser (tree-sitter) with regex fallback (v5)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_TS_AVAILABLE = False
_parser = None

try:
    from tree_sitter_languages import get_parser as _get_parser

    _parser = _get_parser("typescript")
    _TS_AVAILABLE = True
except Exception:
    _TS_AVAILABLE = False

_EXPORT_FN_RE = re.compile(r"\bexport\s+(?:async\s+)?function\s+(\w+)", re.I)
_IMPORT_RE = re.compile(
    r"""import\s+(?:type\s+)?(?:\{[^}]+\}|\w+)\s+from\s+['"]([^'"]+)['"]""",
)
_FETCH_RE = re.compile(
    r"""(?:fetch|axios\.(get|post|put|delete|patch))\s*\(\s*[`'"]([^`'"]+)[`'"]""",
    re.I,
)
_CALL_RE = re.compile(r"\b(\w+)\s*\(")


@dataclass
class TsFileAnalysis:
    path: str
    exports: list[dict[str, Any]] = field(default_factory=list)
    imports: list[dict[str, Any]] = field(default_factory=list)
    api_calls: list[dict[str, Any]] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    origin: str = "regex"


def _line(text: bytes, node) -> int:
    return text[: node.start_byte].count(b"\n") + 1


def parse_ts_file(rel: str, text: str) -> TsFileAnalysis:
    result = TsFileAnalysis(path=rel)
    if _TS_AVAILABLE and _parser is not None:
        try:
            return _parse_tree_sitter(rel, text, result)
        except Exception:
            pass
    return _parse_regex(rel, text, result)


def _parse_tree_sitter(rel: str, text: str, result: TsFileAnalysis) -> TsFileAnalysis:
    data = text.encode("utf-8", errors="replace")
    tree = _parser.parse(data)
    root = tree.root_node

    def walk(node):
        if node.type == "function_declaration":
            name_node = node.child_by_field_name("name")
            if name_node:
                name = data[name_node.start_byte : name_node.end_byte].decode("utf-8", errors="replace")
                result.exports.append(
                    {"name": name, "line": _line(data, node), "kind": "function"}
                )
        elif node.type == "lexical_declaration":
            txt = data[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
            m = re.search(r"export\s+const\s+(\w+)", txt)
            if m:
                result.exports.append(
                    {"name": m.group(1), "line": _line(data, node), "kind": "const"}
                )
        elif node.type == "import_statement":
            txt = data[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
            im = _IMPORT_RE.search(txt)
            if im:
                result.imports.append({"from": im.group(1), "line": _line(data, node)})
        elif node.type == "call_expression":
            txt = data[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
            if "fetch" in txt or "axios" in txt:
                fm = _FETCH_RE.search(txt)
                if fm:
                    verb = (fm.group(1) or "get").upper() if fm.group(1) else "GET"
                    url = fm.group(2) or ""
                    result.api_calls.append(
                        {"verb": verb, "url": url, "line": _line(data, node)}
                    )
            else:
                cm = _CALL_RE.search(txt)
                if cm:
                    result.calls.append({"name": cm.group(1), "line": _line(data, node)})
        for i in range(node.child_count):
            walk(node.children[i])

    walk(root)
    result.origin = "tree-sitter"
    return result


def _parse_regex(rel: str, text: str, result: TsFileAnalysis) -> TsFileAnalysis:
    for m in _EXPORT_FN_RE.finditer(text):
        result.exports.append(
            {"name": m.group(1), "line": text.count("\n", 0, m.start()) + 1, "kind": "function"}
        )
    for m in _IMPORT_RE.finditer(text):
        result.imports.append(
            {"from": m.group(1), "line": text.count("\n", 0, m.start()) + 1}
        )
    for m in _FETCH_RE.finditer(text):
        verb = (m.group(1) or "GET").upper() if m.group(1) else "GET"
        result.api_calls.append(
            {"verb": verb, "url": m.group(2), "line": text.count("\n", 0, m.start()) + 1}
        )
    result.origin = "regex"
    return result
