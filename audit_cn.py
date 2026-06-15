#!/usr/bin/env python3
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def decode(s: str) -> str:
    return re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), s)


def main() -> int:
    skip = {"localize_en.py", "audit_cn.py", "audit_cn.txt"}
    issues: list[tuple[str, str]] = []
    plugin_msgs = {"读取失败", "未知消息类型"}

    for p in ROOT.rglob("*"):
        if not p.is_file() or p.name in skip or ".git" in p.parts:
            continue
        if p.suffix not in {".js", ".mjs", ".css", ".html", ".md", ".mdc", ".txt", ".json"}:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"[\u4e00-\u9fff]+|(?:\\u[0-9a-fA-F]{4}){2,}", text):
            frag = m.group()
            dec = decode(frag) if "\\u" in frag else frag
            if not any("\u4e00" <= c <= "\u9fff" for c in dec):
                continue
            if p.name == "mcp-server.mjs" and dec not in plugin_msgs and len(dec) > 8:
                continue  # bundled zod i18n, not plugin UI
            issues.append((str(p.relative_to(ROOT)), dec[:120]))

    print(f"Total user-facing Chinese strings: {len(issues)}")
    for path, s in issues:
        print(f"  {path}: {s}")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
