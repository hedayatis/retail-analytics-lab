/* ===========================================================================
   Retail Analytics Lab - page logic.

   Two WebAssembly runtimes are loaded lazily, only when the visitor asks for
   them: webR (R 4.6) and Pyodide. Both resolve to a local ./vendor/ copy when
   one is present, and otherwise to jsDelivr - so the page works offline for
   development and from a static host in production without a code change.
   =========================================================================== */
"use strict";
import {highlight} from "./highlight.mjs";
import {createDashboard} from "./dashboard.mjs";
import {isCompleteMonth, compareResults} from "./insights.mjs";

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

let DATA = null, SOURCES = null, dashboard = null;

/* ------------------------------------------------------------------ theme */
$("#theme").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const dark = cur === "dark" ||
    (!cur && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
  renderCharts();
};

/* ------------------------------------------------- tiny syntax highlighter */
const setCode = (node, code, lang) => { node.innerHTML = highlight(code, lang); };

/* --------------------------------------------------------------- rendering */
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
  const W = Math.max(280, node.clientWidth || 520), lw = W < 400 ? 114 : 138, vr = 64;
  const H = rows.length * height + 26;
  const max = Math.max.apply(null, rows.map((r) => r[value]).concat([1]));
  const iw = Math.max(40, W - lw - vr);
  const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, role: "img", "aria-label": opts.title || "Bar chart" });
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
  if (!rows.length) { node.textContent = "No fully observed data for this selection."; return; }
  const x = opts.x, y = opts.y, fmt = opts.fmt || gbpC;
  const W = Math.max(280, node.clientWidth || 520), H = 265, P = {t:18,r:16,b:36,l:72};
  const iw = W-P.l-P.r, ih = H-P.t-P.b;
  const top = opts.max || Math.max(1,...rows.map(r=>Number(r[y]) || 0))*1.1;
  const px = i => rows.length === 1 ? P.l+iw/2 : P.l+i/(rows.length-1)*iw;
  const py = v => P.t+ih-v/top*ih;
  const svg = sv("svg",{viewBox:"0 0 "+W+" "+H,width:"100%",height:H,
    role:"img","aria-label":opts.label || "Monthly trend"});
  for (let i=0;i<=4;i++) {
    const v=i*top/4;
    svg.append(sv("line",{x1:P.l,x2:W-P.r,y1:py(v),y2:py(v),stroke:cssv("--line")}));
    const text=sv("text",{x:P.l-8,y:py(v)+4,"text-anchor":"end",fill:cssv("--ink-2"),"font-size":10});
    text.textContent=fmt(v);svg.append(text);
  }
  svg.append(sv("path",{d:rows.map((r,i)=>(i?"L":"M")+px(i)+","+py(r[y])).join(" "),
    fill:"none",stroke:cssv("--accent"),"stroke-width":2.5}));
  const every=Math.max(1,Math.ceil(rows.length/(W<400?4:7)));
  rows.forEach((r,i)=>{
    if(i%every===0 || i===rows.length-1) {
      const text=sv("text",{x:px(i),y:H-10,"text-anchor":"middle",fill:cssv("--ink-2"),"font-size":10});
      text.textContent=String(r[x]).startsWith("M+")?r[x]:String(r[x]).slice(2);svg.append(text);
    }
    const c=sv("circle",{cx:px(i),cy:py(r[y]),r:4,fill:cssv(r.complete===false?"--accent-2":"--accent")});
    const title=sv("title",{});title.textContent=r[x]+": "+fmt(r[y])+(r.complete===false?" (partial month)":"");
    c.append(title);svg.append(c);
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
  t.setAttribute("aria-label", "Cohort retention percentages by months since first purchase");
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
        const hex = ramp[b].trim().replace("#","");
        const rgb = hex.length === 3 ? [...hex].map(c=>parseInt(c+c,16)) : [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));
        const lum = rgb.map(v=>v/255).map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2));
        const light = 0.2126*lum[0]+0.7152*lum[1]+0.0722*lum[2];
        td.style.color = light > 0.179 ? "#111111" : "#ffffff";
        const [year, month] = r.cohort_month.split("-").map(Number);
        const observed = new Date(Date.UTC(year,month-1+Number(k.slice(2)),1)).toISOString().slice(0,7);
        if (!isCompleteMonth(observed, DATA.meta)) {td.textContent += "*";td.setAttribute("aria-label",v+" percent, partial observation month");}
        td.title = r.cohort_month + " cohort, " + k + ": " + v + "% of " +
                   r.cohort_size + " ordering in this month";
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
  dashboard?.render();
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
  try { return await webRPromise; } catch (error) { webRPromise = null; throw error; }
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
  try { return await pyPromise; } catch (error) { pyPromise = null; throw error; }
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
function lockRuns(locked) {
  ["r-run","py-run","parity-run"].forEach(id=>$("#"+id).disabled=locked);
}
function showSample(rows, language) {
  const total=rows.reduce((n,r)=>n+Number(r.monetary),0);
  $("#live-summary").textContent=language+" completed: "+num(rows.length)+" sampled customers; "+gbp(total)+
    " sample sales revenue. These results do not update the full-history dashboard.";
  table($("#live-table"),[{key:"customer_id",label:"Customer"},{key:"recency_days",label:"Recency days"},
    {key:"frequency",label:"Orders"},{key:"monetary",label:"Historical spend"},{key:"segment",label:"Segment"}],
    rows.slice().sort((a,b)=>b.monetary-a.monetary),{monetary:gbp});
}
async function execute(kind) {
  lockRuns(true);
  $("#live-table").replaceChildren();
  $("#live-summary").textContent="Loading and running "+(kind==="both"?"R and Python":kind)+
    " locally in your browser. First-time runtime downloads can take a minute or longer.";
  setStatus("parity","Running…","busy");
  const log=logger($("#"+(kind==="R"?"r-out":kind==="Python"?"py-out":"parity-out")));
  try {
    if(kind==="both") {
      const r=await runR(log);setStatus("r","Completed","ready");
      const p=await runPy(log);setStatus("py","Completed","ready");
      const comparison=compareResults(r,p);
      comparison.checks.forEach(c=>log(c.column+": "+c.mismatches+" mismatches",c.mismatches?"bad":"ok"));
      log("Monetary tolerance: £0.005.");
      showSample(p,"R + Python");
      $("#live-summary").textContent=(comparison.passed?"Comparison passed":"Comparison failed")+": "+
        r.length+" R rows, "+p.length+" Python rows; "+comparison.checks.length+
        " columns checked. Results below are the Python sample output, not the full population.";
      setStatus("parity",comparison.passed?"All columns agree":"Results disagree",comparison.passed?"ready":"err");
    } else {
      const rows=await(kind==="R"?runR(log):runPy(log));
      showSample(rows,kind);setStatus(kind==="R"?"r":"py","Completed","ready");
      setStatus("parity",kind+" completed; comparison not run","ready");
    }
  } catch(error) {
    log(String(error),"bad");setStatus("parity","Run failed — see logs","err");
    $("#live-summary").textContent="The sample run failed. Your dashboard is still available. Check your connection and execution logs, then retry.";
  } finally {lockRuns(false);}
}
$("#r-run").onclick=()=>execute("R");
$("#py-run").onclick=()=>execute("Python");
$("#parity-run").onclick=()=>execute("both");

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
async function fetchJSON(path) {
  const response=await fetch(path);
  if(!response.ok) throw new Error(path+" returned HTTP "+response.status);
  return response.json();
}
async function boot() {
  const status=$("#load-status");
  try {
    DATA=await fetchJSON("data/results.json");
    dashboard=createDashboard({data:DATA,el,table,barChart,lineChart});
    renderLedger();renderCharts();
    $("#analyze-run").disabled=false;$("#export-monthly").disabled=false;
    status.textContent="Published full-population results loaded. Dashboard filters calculate immediately; language runtimes load only when requested.";
    status.classList.add("loaded");
  } catch(error) {
    status.replaceChildren(el("span",null,"Unable to load the analytical results. Check your connection, then "));
    const retry=el("button","ghost","Retry loading");retry.onclick=boot;status.append(retry);
    return;
  }
  try {
    SOURCES=await fetchJSON("data/sources.json");
    setCode($("#code-contract"),SOURCES["schemas.py"].split("\n").slice(0,46).join("\n"),"py");
    setCode($("#code-sql"),SOURCES["01_star_schema.sql"],"sql");
    $("#r-code").value=SOURCES["rfm.R"]+R_DRIVER;
    $("#py-code").value=SOURCES["rfm_stdlib.py"]+PY_DRIVER;
    $("#sample-note").textContent=num(DATA.meta.sample_rows)+" transaction lines from "+
      num(DATA.meta.sample_customers)+" customers run in your browser. The charts above use full-population aggregates and are not changed by sample runs.";
    lockRuns(false);setStatus("parity","Ready to compare","");
  } catch(error) {
    $("#live-summary").textContent="Sample source files could not load. Reload the page to retry; the analytical dashboard remains usable.";
  }
}
addEventListener("resize",()=>{
  clearTimeout(window._rz);window._rz=setTimeout(renderCharts,150);
});
boot();
