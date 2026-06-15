#!/usr/bin/env python3
"""Package jefr-cursor.vsix without npm/vsce."""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "jefr-cursor.vsix"

INCLUDE = [
    ROOT / "[Content_Types].xml",
    ROOT / "extension.vsixmanifest",
]

EXTENSION_FILES = [
    "package.json",
    "preview-console.html",
    "HOW_IT_WORKS.md",
    "dist/extension.js",
    "dist/mcp-server.mjs",
    "dist/webview.css",
    "dist/webview.js",
    "media/icon.svg",
    "rules/mcp-messenger.mdc",
]

ext = ROOT / "extension"
for rel in EXTENSION_FILES:
    p = ext / rel
    if not p.exists():
        raise SystemExit(f"missing: {p}")

with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for p in INCLUDE:
        zf.write(p, p.name)
    for rel in EXTENSION_FILES:
        p = ext / rel
        zf.write(p, f"extension/{rel.replace(chr(92), '/')}")

print(f"Created {OUT} ({OUT.stat().st_size} bytes)")
