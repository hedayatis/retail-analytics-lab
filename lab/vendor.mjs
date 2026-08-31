/* Copy the webR and Pyodide runtimes out of node_modules into ./vendor/ so the
   lab runs fully offline. Without this the page falls back to jsDelivr, which
   is the right default for a static host. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  ["node_modules/webr/dist", "vendor/webr"],
  ["node_modules/pyodide", "vendor/pyodide"],
];
for (const [from, to] of jobs) {
  const src = path.join(HERE, from), dst = path.join(HERE, to);
  if (!fs.existsSync(src)) { console.error("missing", from, "- run npm install"); continue; }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log("vendored", to);
}
