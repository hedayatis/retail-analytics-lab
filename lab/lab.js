/* ===========================================================================
   Retail Analytics Lab - page logic.

   Two WebAssembly runtimes are loaded lazily, only when the visitor asks for
   them: webR (R 4.6) and Pyodide. Both resolve to a local ./vendor/ copy when
   one is present, and otherwise to jsDelivr - so the page works offline for
   development and from a static host in production without a code change.
   =========================================================================== */
"use strict";

const RUNTIME = {
  // webr.js is the BROWSER esm build; webr.mjs is the Node one and imports
  // "path"/"url", which a browser cannot resolve. The package's own
  // exports map marks webr.js as the "browser" condition.
  webr:    { local: "vendor/webr/",    probe: "webr.js", entry: "webr.js",
             cdn: "https://cdn.jsdelivr.net/npm/webr@0.6.0/dist/" },
  pyodide: { local: "vendor/pyodide/", probe: "pyodide.mjs", entry: "pyodide.mjs",
             cdn: "https://cdn.jsdelivr.net/npm/pyodide@314.0.6/" },
};

const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t);
  if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const SVGNS = "http://www.w3.org/2000/svg";
const sv = (t, a) => { const n = document.createElementNS(SVGNS, t);
  for (const k in a) n.setAttribute(k, a[k]); return n; };
const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const gbp = (v) => "£" + Math.round(v).toLocaleString("en-GB");
const gbpC = (v) => Math.abs(v) >= 1e6 ? "£" + (v / 1e6).toFixed(2) + "M"
                  : Math.abs(v) >= 1e3 ? "£" + (v / 1e3).toFixed(0) + "k"
                  : "£" + v.toFixed(0);
const num = (v) => Number(v).toLocaleString("en-GB");

let DATA = null, SOURCES = null;

/* ------------------------------------------------------------------ theme */
$("#theme").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const dark = cur === "dark" ||
    (!cur && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
  renderCharts();
};

/* ------------------------------------------------- tiny syntax highlighter */
function highlight(code, lang) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const kw = {
    py: /\b(from|import|def|class|return|if|elif|else|for|while|in|not|and|or|None|True|False|with|as|try|except|raise|lambda|yield|assert|dataclass)\b/g,
    r:  /\b(function|if|else|for|while|return|NULL|NA|TRUE|FALSE|in|source|library)\b/g,
    sql:/\b(WITH|SELECT|FROM|WHERE|GROUP BY|ORDER BY|JOIN|LEFT JOIN|CROSS JOIN|ON|USING|AS|CASE|WHEN|THEN|ELSE|END|CREATE|OR REPLACE|TABLE|DISTINCT|COUNT|SUM|MIN|MAX|ROUND|COALESCE|CAST|INTEGER|VARCHAR|DATE|TIMESTAMP|BOOLEAN|UNNEST|GENERATE_SERIES|QUANTILE_CONT|PRINTF|MODE|MEDIAN|EXTRACT|DATE_DIFF|ROW_NUMBER|OVER|PARTITION BY|INTERVAL)\b/gi,
  }[lang] || /$^/;
  let out = esc(code);
  const stash = []; const keep = (s) => " " + (stash.push(s) - 1) + " ";
  out = out.replace(lang === "sql" ? /--[^\n]*/g : /#[^\n]*/g,
                    (m) => keep('<span class="tok-com">' + m + "</span>"));
  out = out.replace(/(&quot;|&#39;|"|')(?:(?!\1)[^\n\\]|\\.)*\1/g,
                    (m) => keep('<span class="tok-str">' + m + "</span>"));
  out = out.replace(kw, (m) => '<span class="tok-kw">' + m + "</span>");
  out = out.replace(/\b\d+(\.\d+)?\b/g, (m) => '<span class="tok-num">' + m + "</span>");
  return out.replace(/ (\d+) /g, (_, i) => stash[+i]);
}
const setCode = (node, code, lang) => { node.innerHTML = highlight(code, lang); };

/* --------------------------------------------------------------- rendering */
function renderStats() {
  const m = DATA.meta, box = $("#stat-strip");
  const rows = [
    [num(m.rows_raw), "raw transaction lines"],
    [num(m.rows_sales), "clean sales lines"],
    [num(m.rows_returns), "return lines"],
    [num(m.customers), "identified customers"],
    [gbpC(m.revenue_gbp), "clean sales revenue"],
    [m.date_min.slice(0, 7) + " to " + m.date_max.slice(0, 7), "trading window"],
  ];
  box.replaceChildren(...rows.map(([v, l]) => {
    const d = el("div", "stat"); d.append(el("div", "v", v), el("div", "l", l)); return d;
  }));
}

function table(node, cols, rows, fmt = {}) {
  node.replaceChildren();
  const thead = el("thead"), tr = el("tr");
  cols.forEach((c) => tr.append(el("th", null, c.label)));
  thead.append(tr); node.append(thead);
  const tb = el("tbody");
  rows.forEach((r) => {
    const row = el("tr");
    cols.forEach((c) => row.append(el("td", null, (fmt[c.key] || String)(r[c.key], r))));
    tb.append(row);
  });
  node.append(tb);
}

function renderLedger() {
  table($("#tbl-ledger"),
    [{ key: "rule", label: "rule" }, { key: "rows_before", label: "rows in" },
     { key: "rows_removed", label: "removed" }, { key: "rows_after", label: "rows out" },
     { key: "pct_removed", label: "% removed" },
     { key: "gross_value_removed", label: "gross value" }],
    DATA.ledger,
    { rows_before: num, rows_removed: num, rows_after: num,
      pct_removed: (v) => Number(v).toFixed(3) + "%",
      gross_value_removed: (v) => Number(v) === 0 ? "—" : gbp(v) });
  const dup = DATA.ledger.find((r) => r.rule === "exact_duplicate");
  $("#ledger-note").innerHTML =
    "<b>The expensive judgement call:</b> " + num(dup.rows_removed) +
    " byte-identical invoice lines (same invoice, product, timestamp, quantity and " +
    "price) across 5,391 invoices. Treating them as double-scanned records removes " +
    gbp(dup.gross_value_removed) + " of apparent revenue. The opposite reading, that a " +
    "customer genuinely scanned the same item twice on one invoice, is defensible too; " +
    "what is not defensible is making the choice silently. The ledger prices it so a " +
    "reviewer can overrule it in one line.";
}

function renderDQ() {
  const rows = [
    { check: "row count >= 1,000,000", sev: "ERROR", n: "1,067,371", res: "pass" },
    { check: "invoice matches ^[AC]?\\d{6}$", sev: "ERROR", n: "0 bad", res: "pass" },
    { check: "date inside published window", sev: "ERROR", n: "0 bad", res: "pass" },
    { check: "exact duplicate rows", sev: "WARN", n: "34,335", res: "warn" },
    { check: "fct_sales revenue identity", sev: "ERROR", n: "0 bad", res: "pass" },
    { check: "rfm_customers primary key", sev: "ERROR", n: "0 dup", res: "pass" },
    { check: "segment in allowed set", sev: "ERROR", n: "0 bad", res: "pass" },
    { check: "retention_pct within 0-100", sev: "ERROR", n: "0 bad", res: "pass" },
  ];
  table($("#tbl-dq"),
    [{ key: "check", label: "clause" }, { key: "sev", label: "severity" },
     { key: "n", label: "observed" }, { key: "res", label: "" }],
    rows, { res: (v) => v === "pass" ? "✓" : "!" });
}

/* ------------------------------------------------------------- the diagram */
function renderArch() {
  const W = 1000, H = 190, box = $("#arch");
  const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: "100%",
    role: "img", "aria-label": "Five-stage pipeline with a contract on every boundary" });
  const stages = [
    ["onlineretail2.rda", "donor file + SHA-256"],
    ["ingest", "typed frame"],
    ["clean", "rule ladder + ledger"],
    ["warehouse", "DuckDB star schema"],
    ["analytics", "RFM / cohorts"],
  ];
  const contracts = ["raw_transactions", "fct_sales + fct_returns", "integrity checks",
                     "rfm_customers + cohort_retention"];
  const bw = 168, gap = (W - stages.length * bw) / (stages.length - 1), y = 44, bh = 56;
  stages.forEach((s, i) => {
    const x = i * (bw + gap);
    svg.append(sv("rect", { x: x, y: y, width: bw, height: bh, rx: 9,
      fill: i === 0 ? "transparent" : cssv("--surface"),
      stroke: i === 0 ? cssv("--line-2") : cssv("--accent"),
      "stroke-width": i === 0 ? 1 : 1.5,
      "stroke-dasharray": i === 0 ? "4 3" : "" }));
    const t1 = sv("text", { x: x + bw / 2, y: y + 24, "text-anchor": "middle",
      fill: cssv("--ink"), "font-size": 13.5, "font-weight": 640,
      "font-family": "ui-monospace, monospace" });
    t1.textContent = s[0]; svg.append(t1);
    const t2 = sv("text", { x: x + bw / 2, y: y + 42, "text-anchor": "middle",
      fill: cssv("--ink-3"), "font-size": 11 });
    t2.textContent = s[1]; svg.append(t2);
    if (i < stages.length - 1) {
      const ax = x + bw, aw = gap;
      svg.append(sv("path", { d: "M" + (ax + 6) + "," + (y + bh / 2) +
        " L" + (ax + aw - 10) + "," + (y + bh / 2),
        stroke: cssv("--line-2"), "stroke-width": 1.5 }));
      svg.append(sv("path", { d: "M" + (ax + aw - 10) + "," + (y + bh / 2) + " l-6,-4 v8 z",
        fill: cssv("--line-2") }));
      const c = sv("text", { x: ax + aw / 2, y: y + bh / 2 - 12, "text-anchor": "middle",
        fill: cssv("--accent-2"), "font-size": 9.5, "font-weight": 600 });
      c.textContent = "contract"; svg.append(c);
      const c2 = sv("text", { x: ax + aw / 2, y: y + bh + 16, "text-anchor": "middle",
        fill: cssv("--ink-3"), "font-size": 9, "font-family": "ui-monospace, monospace" });
      c2.textContent = contracts[i]; svg.append(c2);
    }
  });
  const foot = sv("text", { x: W / 2, y: H - 14, "text-anchor": "middle",
    fill: cssv("--ink-3"), "font-size": 11 });
  foot.textContent =
    "every boundary is validated before the next stage runs - an ERROR aborts the pipeline";
  svg.append(foot);
  box.replaceChildren(svg);
}

/* ---------------------------------------------------------------- charts */
function barChart(node, rows, opts) {
  const label = opts.label, value = opts.value;
  const fmt = opts.fmt || gbpC, height = opts.height || 26;
  const W = node.clientWidth || 520, lw = 138, vr = 66;
  const H = rows.length * height + 26;
  const max = Math.max.apply(null, rows.map((r) => r[value]).concat([1]));
  const iw = Math.max(40, W - lw - vr);
  const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H });
  [0, max / 2, max].forEach((t) => {
    const x = lw + (t / max) * iw;
    svg.append(sv("line", { x1: x, x2: x, y1: 4, y2: rows.length * height + 2,
      stroke: t === 0 ? cssv("--line-2") : cssv("--line"), "stroke-width": 1 }));
  });
  rows.forEach((r, i) => {
    const y = i * height + 6, bh = Math.min(16, height - 10);
    const w = (r[value] / max) * iw, rad = Math.min(4, w / 2);
    const g = sv("g", {});
    g.append(sv("path", { d: "M" + lw + "," + y +
      " L" + (lw + Math.max(0, w - rad)) + "," + y +
      " Q" + (lw + w) + "," + y + " " + (lw + w) + "," + (y + rad) +
      " L" + (lw + w) + "," + (y + bh - rad) +
      " Q" + (lw + w) + "," + (y + bh) + " " + (lw + Math.max(0, w - rad)) + "," + (y + bh) +
      " L" + lw + "," + (y + bh) + " Z", fill: cssv("--accent") }));
    const lt = sv("text", { x: lw - 9, y: y + bh / 2 + 4, "text-anchor": "end",
      fill: cssv("--ink"), "font-size": 11.5 });
    lt.textContent = r[label]; g.append(lt);
    const vt = sv("text", { x: lw + w + 7, y: y + bh / 2 + 4,
      fill: cssv("--ink-2"), "font-size": 11.5 });
    vt.textContent = fmt(r[value]); g.append(vt);
    const ttl = sv("title", {}); ttl.textContent = r[label] + ": " + fmt(r[value]);
    g.append(ttl); svg.append(g);
  });
  node.replaceChildren(svg);
}

function lineChart(node, rows, opts) {
  const x = opts.x, y = opts.y, fmt = opts.fmt || gbpC;
  const W = node.clientWidth || 520, H = 230, P = { t: 12, r: 14, b: 34, l: 52 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const max = Math.max.apply(null, rows.map((r) => r[y]));
  const mag = Math.pow(10, Math.floor(Math.log10(max / 4)));
  const s = [1, 2, 2.5, 5, 10].find((k) => k * mag >= max / 4) * mag;
  const ticks = []; for (let v = 0; v < max; v += s) ticks.push(v);
  ticks.push(ticks[ticks.length - 1] + s);
  const top = ticks[ticks.length - 1];
  const px = (i) => P.l + (i / (rows.length - 1)) * iw;
  const py = (v) => P.t + ih - (v / top) * ih;
  const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H });
  ticks.forEach((t) => {
    svg.append(sv("line", { x1: P.l, x2: W - P.r, y1: py(t), y2: py(t),
      stroke: t === 0 ? cssv("--line-2") : cssv("--line"), "stroke-width": 1 }));
    const tx = sv("text", { x: P.l - 7, y: py(t) + 4, "text-anchor": "end",
      fill: cssv("--ink-3"), "font-size": 10.5 });
    tx.textContent = fmt(t); svg.append(tx);
  });
  let d = "";
  rows.forEach((r, i) => { d += (i ? "L" : "M") + px(i) + "," + py(r[y]); });
  svg.append(sv("path", { d: d, fill: "none", stroke: cssv("--accent"),
    "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  rows.forEach((r, i) => {
    if (i % 3 === 0 || i === rows.length - 1) {
      const tx = sv("text", { x: px(i), y: H - P.b + 16, "text-anchor": "middle",
        fill: cssv("--ink-3"), "font-size": 10 });
      tx.textContent = String(r[x]).slice(2); svg.append(tx);
    }
    const c = sv("circle", { cx: px(i), cy: py(r[y]), r: 7, fill: "transparent" });
    const ttl = sv("title", {}); ttl.textContent = r[x] + ": " + gbp(r[y]);
    c.append(ttl); svg.append(c);
  });
  node.replaceChildren(svg);
}

function cohortHeat(node) {
  const rows = DATA.cohort_matrix;
  const idx = Object.keys(rows[0]).filter((k) => k.indexOf("M+") === 0)
    .sort((a, b) => +a.slice(2) - +b.slice(2)).slice(0, 13);
  const vals = [];
  rows.forEach((r) => idx.slice(1).forEach((k) => { if (r[k] != null) vals.push(r[k]); }));
  const max = Math.max.apply(null, vals.concat([1]));
  const ramp = ["--heat-0", "--heat-1", "--heat-2", "--heat-3",
                "--heat-4", "--heat-5", "--heat-6"].map(cssv);
  const t = el("table", "tbl");
  const head = el("tr");
  ["cohort", "size"].concat(idx).forEach((h) => head.append(el("th", null, h)));
  const th = el("thead"); th.append(head); t.append(th);
  const tb = el("tbody");
  rows.forEach((r) => {
    const tr = el("tr");
    tr.append(el("td", null, r.cohort_month));
    tr.append(el("td", null, num(r.cohort_size)));
    idx.forEach((k) => {
      const v = r[k], td = el("td", null, v == null ? "" : v.toFixed(0));
      if (v != null) {
        const b = v <= 0 ? 0 : Math.min(6, 1 + Math.floor((v / max) * 5.99));
        td.style.background = ramp[b];
        td.style.color = b >= 5 ? cssv("--surface") : cssv("--ink");
        td.title = r.cohort_month + " cohort, " + k + ": " + v + "% of " +
                   r.cohort_size + " still ordering";
      } else {
        td.style.opacity = ".35"; td.textContent = "·";
        td.title = "not observable yet (right-censored)";
      }
      tr.append(td);
    });
    tb.append(tr);
  });
  t.append(tb); node.replaceChildren(t);
}

function renderCharts() {
  if (!DATA) return;
  const segs = DATA.segments.slice();
  barChart($("#chart-seg"), segs, { label: "segment", value: "total_monetary" });
  const champ = segs.find((s) => s.segment === "Champions");
  const totR = segs.reduce((a, s) => a + s.total_monetary, 0);
  const totC = segs.reduce((a, s) => a + s.customers, 0);
  $("#seg-note").textContent =
    "Champions are " + (100 * champ.customers / totC).toFixed(1) +
    "% of identified customers and hold " + (100 * champ.total_monetary / totR).toFixed(1) +
    "% of revenue (" + gbpC(champ.total_monetary) + "), averaging " +
    champ.avg_frequency.toFixed(1) + " orders each.";
  lineChart($("#chart-monthly"), DATA.monthly, { x: "invoice_month", y: "revenue" });
  cohortHeat($("#chart-cohort"));
  renderArch();
}

/* -------------------------------------------------- runtime base resolution */
async function resolveBase(kind) {
  const cfg = RUNTIME[kind];
  try {
    const r = await fetch(cfg.local + cfg.probe, { method: "HEAD" });
    // import() rejects bare specifiers, so hand back an absolute URL
    if (r.ok) return { base: new URL(cfg.local, location.href).href,
                       where: "local vendor copy" };
  } catch (e) { /* not vendored - fall through to the CDN */ }
  return { base: cfg.cdn, where: "jsDelivr CDN" };
}

function setStatus(prefix, text, state) {
  $("#" + prefix + "-status").textContent = text;
  $("#" + prefix + "-dot").className = "dot" + (state ? " " + state : "");
}

/* ------------------------------------------------------------------- webR */
let webRPromise = null;
async function getWebR(log) {
  if (webRPromise) return webRPromise;
  webRPromise = (async () => {
    const res = await resolveBase("webr");
    log("loading R runtime from " + res.where + " ...");
    const mod = await import(res.base + RUNTIME.webr.entry);
    const webR = new mod.WebR({ baseUrl: res.base });
    await webR.init();
    log(await webR.evalRString("R.version.string") + " ready");
    const csv = await (await fetch("data/sales_sample.csv")).text();
    await webR.FS.writeFile("/sample.csv", new TextEncoder().encode(csv));
    log("sample mounted: " + (csv.length / 1e6).toFixed(1) + " MB");
    return webR;
  })();
  return webRPromise;
}

/* ---------------------------------------------------------------- Pyodide */
let pyPromise = null;
async function getPy(log) {
  if (pyPromise) return pyPromise;
  pyPromise = (async () => {
    const res = await resolveBase("pyodide");
    log("loading Python runtime from " + res.where + " ...");
    const mod = await import(res.base + RUNTIME.pyodide.entry);
    const py = await mod.loadPyodide({ indexURL: res.base });
    log("Python " + py.version + " ready");
    const csv = await (await fetch("data/sales_sample.csv")).text();
    py.FS.writeFile("/sample.csv", csv);
    log("sample mounted: " + (csv.length / 1e6).toFixed(1) + " MB");
    return py;
  })();
  return pyPromise;
}

/* ------------------------------------------------------------ run helpers */
function logger(node) {
  node.textContent = "";
  return (line, cls) => {
    node.append(el("span", cls || null, line + "\n"));
    node.scrollTop = node.scrollHeight;
  };
}

const R_DRIVER = [
  "",
  "# ---- driver (added by the lab; everything above is the repository file) ----",
  "sales <- read.csv('/sample.csv',",
  "                  colClasses = c('integer','character','Date','numeric'))",
  "rfm <- rfm_build(sales)",
  "cat(sprintf('%d transaction lines -> %d customers\\n', nrow(sales), nrow(rfm)))",
  "cat(sprintf('revenue in sample: %.2f\\n\\n', sum(sales$line_revenue)))",
  "s <- rfm_summarise(rfm)",
  "print(s[order(-s$total_monetary), ], row.names = FALSE)",
  "",
].join("\n");

const PY_DRIVER = [
  "",
  "# ---- driver (added by the lab; everything above is the repository file) ----",
  "import csv, json",
  "with open('/sample.csv', newline='') as fh:",
  "    rows = list(csv.DictReader(fh))",
  "rfm = build_from_rows(rows)",
  "print(f'{len(rows)} transaction lines -> {len(rfm)} customers')",
  "print(f\"revenue in sample: {sum(float(r['line_revenue']) for r in rows):.2f}\\n\")",
  "hdr = f\"{'segment':<21}{'customers':>10}{'avg_freq':>10}{'total_monetary':>16}\"",
  "print(hdr); print('-' * len(hdr))",
  "for s in summarise(rfm):",
  "    print(f\"{s['segment']:<21}{s['customers']:>10}\"",
  "          f\"{s['avg_frequency']:>10.2f}{s['total_monetary']:>16,.2f}\")",
  "_keys = ('customer_id','recency_days','frequency','monetary',",
  "         'r_score','f_score','m_score','segment')",
  "_result = json.dumps([{k: r[k] for k in _keys} for r in rfm])",
  "",
].join("\n");

async function runR(log) {
  const webR = await getWebR(log);
  await webR.FS.writeFile("/rfm.R", new TextEncoder().encode($("#r-code").value));
  log("\nrunning ...");
  const t0 = performance.now();
  const shelter = await new webR.Shelter();
  try {
    const out = await shelter.captureR("source('/rfm.R', local = FALSE)",
                                       { withAutoprint: true });
    out.output.forEach((o) => {
      if (o.type === "stdout" || o.type === "stderr") log(o.data);
    });
    log("\n[R finished in " + ((performance.now() - t0) / 1000).toFixed(1) + "s]", "ok");
  } finally { shelter.purge(); }
  const json = await webR.evalRString(
    "r <- rfm[order(rfm$customer_id), ]; " +
    "paste0('[', paste(sprintf('{\"customer_id\":%d,\"recency_days\":%d," +
    "\"frequency\":%d,\"monetary\":%.2f,\"r_score\":%d,\"f_score\":%d," +
    "\"m_score\":%d,\"segment\":\"%s\"}', r$customer_id, r$recency_days, " +
    "r$frequency, r$monetary, r$r_score, r$f_score, r$m_score, r$segment), " +
    "collapse=','), ']')");
  return JSON.parse(json);
}

async function runPy(log) {
  const py = await getPy(log);
  log("\nrunning ...");
  const t0 = performance.now();
  py.setStdout({ batched: (s) => log(s) });
  py.setStderr({ batched: (s) => log(s, "bad") });
  await py.runPythonAsync($("#py-code").value);
  log("\n[Python finished in " + ((performance.now() - t0) / 1000).toFixed(1) + "s]", "ok");
  return JSON.parse(py.globals.get("_result"));
}

/* ------------------------------------------------------------ page wiring */
$("#r-run").onclick = async () => {
  const log = logger($("#r-out")), btn = $("#r-run");
  btn.disabled = true; setStatus("r", "working...", "busy");
  try { await runR(log); setStatus("r", "ready", "ready"); }
  catch (e) { log("\n" + e, "bad"); setStatus("r", "error", "err"); }
  finally { btn.disabled = false; }
};

$("#py-run").onclick = async () => {
  const log = logger($("#py-out")), btn = $("#py-run");
  btn.disabled = true; setStatus("py", "working...", "busy");
  try { await runPy(log); setStatus("py", "ready", "ready"); }
  catch (e) { log("\n" + e, "bad"); setStatus("py", "error", "err"); }
  finally { btn.disabled = false; }
};

$("#parity-run").onclick = async () => {
  const log = logger($("#parity-out")), btn = $("#parity-run");
  btn.disabled = true; setStatus("parity", "running both runtimes...", "busy");
  try {
    log("--- R -------------------------------------------------");
    const r = await runR(log);
    log("\n--- Python --------------------------------------------");
    const p = await runPy(log);
    log("\n--- diff ----------------------------------------------");
    log("rows: R=" + r.length + "  Python=" + p.length);
    if (r.length !== p.length) {
      log("ROW COUNT MISMATCH", "bad");
      setStatus("parity", "parity broken", "err");
      return;
    }
    let bad = 0;
    ["customer_id", "recency_days", "frequency",
     "r_score", "f_score", "m_score", "segment"].forEach((c) => {
      let n = 0;
      for (let i = 0; i < r.length; i++) {
        if (String(r[i][c]) !== String(p[i][c])) n++;
      }
      bad += n;
      log("  " + c.padEnd(14) + " mismatches: " + n, n ? "bad" : null);
    });
    let mm = 0;
    for (let i = 0; i < r.length; i++) {
      if (Math.abs(r[i].monetary - p[i].monetary) > 0.005) mm++;
    }
    bad += mm;
    log("  " + "monetary".padEnd(14) + " mismatches: " + mm +
        " (tolerance " + "£" + "0.005)", mm ? "bad" : null);
    log("");
    log(bad === 0
      ? "PARITY HOLDS - base R and Python agree on all " + r.length +
        " customers, every column."
      : "PARITY BROKEN - " + bad + " disagreements.", bad === 0 ? "ok" : "bad");
    setStatus("parity", bad === 0 ? "parity holds" : "parity broken",
              bad === 0 ? "ready" : "err");
  } catch (e) {
    log("\n" + e, "bad"); setStatus("parity", "error", "err");
  } finally { btn.disabled = false; }
};

$("#sql-pick").onchange = (e) => {
  $("#sql-name").textContent = "sql/" + e.target.value;
  setCode($("#code-sql"), SOURCES[e.target.value], "sql");
};

/* scroll spy */
const links = Array.prototype.slice.call(document.querySelectorAll("nav.toc a"));
const spy = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    links.forEach((a) => a.classList.toggle("on", a.hash === "#" + en.target.id));
  });
}, { rootMargin: "-45% 0px -50% 0px" });
document.querySelectorAll("main section").forEach((s) => spy.observe(s));

/* ------------------------------------------------------------------- boot */
(async function boot() {
  const loaded = await Promise.all([
    fetch("data/results.json").then((r) => r.json()),
    fetch("data/sources.json").then((r) => r.json()),
  ]);
  DATA = loaded[0]; SOURCES = loaded[1];
  renderStats(); renderLedger(); renderDQ(); renderCharts();
  setCode($("#code-contract"),
    SOURCES["schemas.py"].split("\n").slice(0, 46).join("\n"), "py");
  setCode($("#code-sql"), SOURCES["01_star_schema.sql"], "sql");
  $("#r-code").value = SOURCES["rfm.R"] + R_DRIVER;
  $("#py-code").value = SOURCES["rfm_stdlib.py"] + PY_DRIVER;
  $("#src-link").textContent = num(DATA.meta.sample_rows) + " sampled lines from " +
    num(DATA.meta.sample_customers) + " customers run in-browser";
  addEventListener("resize", () => {
    clearTimeout(window._rz);
    window._rz = setTimeout(renderCharts, 150);
  });
})();
