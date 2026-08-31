/* ===========================================================================
   CI harness: run the repository's base-R implementations under webR and diff
   them against the Python outputs produced by `make pipeline`.

   R cannot be assumed installed on a CI runner, and installing it costs
   minutes. webR is an npm dependency that ships a complete R 4.6 as
   WebAssembly, so this harness gives a real R interpreter anywhere Node runs.

   Writes data/processed/rfm_r.csv and cohort_r.csv for tests/test_parity.py,
   and exits non-zero if R and Python disagree.
   =========================================================================== */
import { WebR } from "webr";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROC = path.join(ROOT, "data", "processed");

const need = (p) => {
  if (!fs.existsSync(p)) {
    console.error(`missing ${path.relative(ROOT, p)} — run \`make pipeline\` first`);
    process.exit(2);
  }
  return p;
};

const SALES = need(path.join(PROC, "sales_for_r.csv"));

console.log("booting webR …");
const webR = new WebR();
await webR.init();
console.log(" ", await webR.evalRString("R.version.string"));

await webR.FS.mkdir("/lab");
for (const [src, dest] of [
  [path.join(ROOT, "R", "rfm.R"), "/lab/rfm.R"],
  [path.join(ROOT, "R", "cohort.R"), "/lab/cohort.R"],
  [SALES, "/lab/sales.csv"],
]) {
  await webR.FS.writeFile(dest, new Uint8Array(fs.readFileSync(src)));
}
const mb = (fs.statSync(SALES).size / 1e6).toFixed(1);
console.log(`  mounted ${mb} MB of transactions into the WASM filesystem`);

const t0 = Date.now();
const summary = await webR.evalRString(`
  source('/lab/rfm.R'); source('/lab/cohort.R')
  sales <- read.csv('/lab/sales.csv',
                    colClasses = c('integer','character','Date','numeric'))
  rfm <- rfm_build(sales)
  ret <- cohort_build(sales)
  write.csv(rfm, '/lab/rfm_r.csv', row.names = FALSE)
  write.csv(ret, '/lab/cohort_r.csv', row.names = FALSE)
  sprintf('%d lines -> %d customers, %d cohort cells',
          nrow(sales), nrow(rfm), nrow(ret))
`);
console.log(`  ${summary}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);

for (const f of ["rfm_r.csv", "cohort_r.csv"]) {
  fs.writeFileSync(path.join(PROC, f),
    Buffer.from(await webR.FS.readFile("/lab/" + f)));
  console.log("  wrote data/processed/" + f);
}
await webR.close();

/* ------------------------------------------------------------ the diff ---- */
const csv = (p) => {
  const [head, ...lines] = fs.readFileSync(p, "utf8").trim().split("\n");
  const cols = head.split(",").map((c) => c.replace(/"/g, ""));
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    return Object.fromEntries(cols.map((c, i) =>
      [c, (cells[i] ?? "").replace(/^"|"$/g, "")]));
  });
};

let failures = 0;
function diff(label, a, b, key, cols, tol = {}) {
  const k = (r) => key.map((c) => r[c]).join("|");
  a = [...a].sort((x, y) => k(x) < k(y) ? -1 : 1);
  b = [...b].sort((x, y) => k(x) < k(y) ? -1 : 1);
  console.log(`\n${label}: R=${a.length} rows, Python=${b.length} rows`);
  if (a.length !== b.length) { console.log("  ROW COUNT MISMATCH"); failures++; return; }
  for (const c of cols) {
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      const t = tol[c];
      const same = t != null
        ? Math.abs(Number(a[i][c]) - Number(b[i][c])) <= t
        : String(a[i][c]) === String(b[i][c]);
      if (!same) n++;
    }
    if (n) failures++;
    console.log(`  ${c.padEnd(18)} mismatches: ${n}${n ? "  <-- FAIL" : ""}`);
  }
}

const pyRfm = need(path.join(PROC, "rfm_python.csv"));
const pyCoh = need(path.join(PROC, "cohort_python.csv"));

diff("RFM", csv(path.join(PROC, "rfm_r.csv")), csv(pyRfm), ["customer_id"],
  ["customer_id", "recency_days", "frequency", "monetary",
   "r_score", "f_score", "m_score", "rfm_cell", "segment"], { monetary: 0.005 });

diff("Cohort retention", csv(path.join(PROC, "cohort_r.csv")), csv(pyCoh),
  ["cohort_month", "month_index"],
  ["cohort_month", "month_index", "cohort_size", "active_customers", "retention_pct"],
  { retention_pct: 0.005 });

console.log(failures === 0
  ? "\nPARITY HOLDS — base R and Python agree on every column."
  : `\nPARITY BROKEN — ${failures} column(s) disagree.`);
process.exit(failures === 0 ? 0 : 1);
