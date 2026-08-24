#!/usr/bin/env node
/**
 * Copy repo automation/ into extension/automation/ so the VSIX ships
 * cdp.py / workflow.py (and their JS helpers) next to the extension.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, "..");
const srcDir = path.resolve(extRoot, "..", "automation");
const destDir = path.join(extRoot, "automation");

const SKIP = new Set([
  "__pycache__",
  "elements.txt",
  "README.md",
]);

function shouldSkip(name) {
  if (SKIP.has(name)) return true;
  if (name.startsWith("batch_log_")) return true;
  if (name.endsWith(".pyc")) return true;
  return false;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

if (!fs.existsSync(srcDir)) {
  console.error(`sync-automation: source missing: ${srcDir}`);
  process.exit(1);
}

fs.rmSync(destDir, { recursive: true, force: true });
copyTree(srcDir, destDir);

const must = ["cdp.py", "workflow.py", "mcp_alive.py", "layout.js", "tile_helpers.js"];
for (const f of must) {
  if (!fs.existsSync(path.join(destDir, f))) {
    console.error(`sync-automation: missing required file after copy: ${f}`);
    process.exit(1);
  }
}

console.log(`sync-automation: copied ${srcDir} → ${destDir}`);
