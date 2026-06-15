#!/usr/bin/env python3
"""Pack jefr-cursor VSIX without Node.js (zip + manifest)."""
from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extension"
OUT = ROOT / "jefr-cursor.vsix"

INCLUDE = [
    EXT / "package.json",
    EXT / "dist" / "extension.js",
    EXT / "dist" / "mcp-server.mjs",
    EXT / "dist" / "webview.js",
    EXT / "dist" / "webview.css",
    EXT / "media" / "icon.svg",
    EXT / "rules" / "mcp-messenger.mdc",
    EXT / "preview-console.html",
    EXT / "HOW_IT_WORKS.md",
]


def main() -> None:
    if OUT.exists():
        OUT.unlink()
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(ROOT / "[Content_Types].xml", "[Content_Types].xml")
        zf.write(ROOT / "extension.vsixmanifest", "extension.vsixmanifest")
        for path in INCLUDE:
            if not path.exists():
                raise FileNotFoundError(path)
            arc = "extension/" + path.relative_to(EXT).as_posix()
            zf.write(path, arc)
    print(f"Created {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
