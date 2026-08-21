// Copies the web app from the project root into www/ (Capacitor webDir)
// before any native sync/build, so the root files stay the single source of truth.
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const web = join(root, "www");
const checkOnly = process.argv.includes("--check");

const files = ["index.html", "shelf-core.js", "reader-shim.js", "reader-libs.js", "pdf.worker.mjs", "app.js", "styles.css", "manifest.json", "capacitor.config.json"];

if (checkOnly) {
  const stale = files.filter((f) => {
    const src = join(root, f);
    const dest = join(web, f);
    return !existsSync(src) || !existsSync(dest) || !readFileSync(src).equals(readFileSync(dest));
  });
  if (stale.length) {
    console.error(`[sync-web] stale or missing: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log("[sync-web] www/ is current");
  process.exit(0);
}

rmSync(web, { recursive: true, force: true });
mkdirSync(web, { recursive: true });

for (const f of files) {
  const src = join(root, f);
  if (!existsSync(src)) {
    console.error(`[sync-web] missing ${f}`);
    process.exit(1);
  }
  cpSync(src, join(web, f));
}

if (existsSync(join(root, "icons"))) {
  cpSync(join(root, "icons"), join(web, "icons"), { recursive: true });
}

console.log("[sync-web] staged www/ for Capacitor");
