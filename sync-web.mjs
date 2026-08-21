// Copies the web app from the project root into www/ (Capacitor webDir)
// before any native sync/build, so the root files stay the single source of truth.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const web = join(root, "www");

rmSync(web, { recursive: true, force: true });
mkdirSync(web, { recursive: true });

const files = ["index.html", "app.js", "styles.css", "manifest.json", "capacitor.config.json"];
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
