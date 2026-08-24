import os, re

paths = {
    "agent-exec": r"C:/Users/jar71/AppData/Local/Programs/cursor/resources/app/extensions/cursor-agent-exec/dist/main.js",
    "workbench": r"C:/Users/jar71/AppData/Local/Programs/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js",
}

needles = [
    "loop_detected", "no_loop_detected", "AgentLoopError",
    "looping", "Unrecoverable agent", "system_reminder",
    "have been flagged", "Repeated", "check_messages",
    "consecutive", "same tool", "identical",
]

for label, p in paths.items():
    print("\n########", label, "########")
    if not os.path.exists(p):
        print("MISSING:", p)
        continue
    print("size:", os.path.getsize(p))
    with open(p, "r", encoding="utf-8", errors="ignore") as f:
        data = f.read()
    for n in needles:
        idx = [m.start() for m in re.finditer(re.escape(n), data)]
        print(f"\n=== {n!r}: {len(idx)} hits ===")
        for i in idx[:4]:
            snip = data[i-160:i+220]
            snip = snip.replace("\n", " ")
            print(f"[{i}] ...{snip}...")
