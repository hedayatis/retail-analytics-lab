import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {highlight} from '../highlight.mjs';
import {sum,ratio,isCompleteMonth,revenueView,segmentView,countryView,retentionView,compareResults} from '../insights.mjs';

const data=JSON.parse(fs.readFileSync(new URL('../data/results.json',import.meta.url)));
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const plain=s=>s.replace(/<span class="tok-\w+">/g,'').replace(/<\/span>/g,'')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

test('highlighter preserves comments and strings without control-code placeholders',()=>{
  for(const [lang,code] of [['py','# Example comment\nname = "example 42"'],
    ['sql',"-- revenue\nSELECT 'abc', 42 FROM sales"],['r','x <- "hello" # a comment']]){
    const out=highlight(code,lang);assert.equal(plain(out),code);assert.ok(!out.includes('\u0001'));
  }
});
test('highlighter preserves multiline strings, quotes and escaped strings',()=>{
  const code='"""Contracts for every boundary.\nDo not change <this>."""\nx = "a\\\"b"';
  assert.equal(plain(highlight(code,'py')),code);
});
test('highlighter escapes HTML instead of injecting source markup',()=>{
  const code='# <script>alert(1)</script> & <img onerror="x">';
  const out=highlight(code,'py');assert.ok(!out.includes('<script>'));assert.ok(!out.includes('<img'));
  assert.equal(plain(out),code);
});
test('all shipped code previews preserve their source',()=>{
  const sources=JSON.parse(fs.readFileSync(new URL('../data/sources.json',import.meta.url)));
  for(const [name,code] of Object.entries(sources)){
    assert.equal(plain(highlight(code,name.endsWith('.sql')?'sql':name.endsWith('.R')?'r':'py')),code,name);
  }
});
test('complete-month detection excludes December 2011 and respects leap years',()=>{
  assert.ok(isCompleteMonth('2011-11',data.meta));assert.ok(!isCompleteMonth('2011-12',data.meta));
  assert.ok(!isCompleteMonth('2009-11',data.meta));
  assert.ok(!isCompleteMonth('2020-02',{date_min:'2020-02-01',date_max:'2020-02-28'}));
  assert.ok(isCompleteMonth('2020-02',{date_min:'2020-02-01',date_max:'2020-02-29'}));
});
test('default period is 24 complete months; including partial month reconciles revenue',()=>{
  assert.equal(revenueView(data).rows.length,24);
  const all=revenueView(data,'all',false);assert.equal(all.rows.length,25);
  assert.ok(Math.abs(all.revenue-data.meta.revenue_gbp)<0.02);
});
test('year filters work and a single month is supported',()=>{
  assert.equal(revenueView(data,'2011').rows.length,11);
  assert.equal(revenueView(data,'2010').rows.length,12);
  assert.equal(revenueView(data,'2009').rows.length,1);
});
test('average order value is weighted by orders, not mean monthly averages',()=>{
  const v=revenueView(data);assert.equal(v.aov,v.revenue/v.orders);
  assert.notEqual(v.aov,sum(v.rows,'aov')/v.rows.length);
});
test('YoY uses latest complete month even when partial month is shown',()=>{
  const v=revenueView(data,'2011',false);assert.equal(v.latest.invoice_month,'2011-11');
  const prior=data.monthly.find(r=>r.invoice_month==='2010-11');
  assert.equal(v.yoy,v.latest.revenue/prior.revenue-1);
  assert.equal(revenueView(data,'2009').yoy,null);
});
test('empty selections and zero denominators are explicit, not NaN',()=>{
  const v=revenueView(data,'2099');assert.equal(v.rows.length,0);assert.equal(v.aov,null);assert.equal(v.yoy,null);
  assert.equal(ratio(0,0),null);
});
test('segment shares use attributed revenue and customer totals',()=>{
  const v=segmentView(data);assert.equal(v.customers,data.meta.customers);
  assert.ok(Math.abs(sum(v.rows,'customer_share')-100)<1e-8);
  assert.ok(Math.abs(sum(v.rows,'revenue_share')-100)<1e-8);
  assert.ok(v.coverage<1);assert.ok(v.unattributed>0);
  assert.ok(Math.abs(v.unattributed+v.revenue-data.meta.revenue_gbp)<0.01);
});
test('country shares include all other markets and reconcile to all sales',()=>{
  const rows=countryView(data);assert.equal(rows.length,11);
  assert.equal(rows.at(-1).country,'Other countries');
  assert.ok(Math.abs(sum(rows,'share')-100)<1e-8);
});
test('retention weights cohort sizes rather than averaging percentages',()=>{
  const fixture={meta:{date_min:'2020-01-01',date_max:'2020-04-30'},cohort_matrix:[
    {cohort_month:'2020-01',cohort_size:10,'M+1':50},
    {cohort_month:'2020-02',cohort_size:90,'M+1':10}]};
  const r=retentionView(fixture)[1];assert.equal(r.retention,14);assert.equal(r.customers,100);
});
test('retention excludes censored cells but includes observed zero',()=>{
  const fixture={meta:{date_min:'2020-01-01',date_max:'2020-04-30'},cohort_matrix:[
    {cohort_month:'2020-01',cohort_size:10,'M+1':0},
    {cohort_month:'2020-02',cohort_size:90,'M+1':null}]};
  const r=retentionView(fixture)[1];assert.equal(r.retention,0);assert.equal(r.customers,10);
});
test('retention excludes partial observation months and empty ages',()=>{
  const fixture={meta:{date_min:'2020-01-01',date_max:'2020-03-15'},cohort_matrix:[
    {cohort_month:'2020-01',cohort_size:10,'M+1':50},
    {cohort_month:'2020-02',cohort_size:90,'M+1':10}]};
  assert.equal(retentionView(fixture)[1].retention,50);
  assert.equal(retentionView(fixture)[12].retention,null);
  assert.equal(retentionView(data,'2011')[12].retention,null);
});
test('all full-cohort M+0 values equal 100 and no rate exceeds 100',()=>{
  const r=retentionView(data);assert.equal(r[0].retention,100);assert.equal(r[0].cohorts,24);
  assert.ok(r.every(x=>x.retention===null || (x.retention>=0 && x.retention<=100)));
});
const row={customer_id:1,recency_days:2,frequency:3,r_score:4,f_score:5,m_score:4,segment:'Champions',monetary:123.45};
test('sample comparison sorts by customer identifier',()=>{
  const rows=[row,{...row,customer_id:2}];assert.ok(compareResults(rows,[...rows].reverse()).passed);
});
test('sample comparison rejects mismatches and unequal row counts',()=>{
  assert.ok(!compareResults([row],[{...row,frequency:4}]).passed);
  assert.ok(!compareResults([row],[row,{...row,customer_id:2}]).passed);
});
test('sample comparison treats invalid money, empty arrays and duplicate IDs as failures',()=>{
  assert.ok(!compareResults([row],[{...row,monetary:NaN}]).passed);
  assert.ok(!compareResults([row],[{...row,monetary:null}]).passed);
  assert.throws(()=>compareResults([],[]));assert.throws(()=>compareResults([row,row],[row,row]));
});
test('monetary comparison tolerance is half a penny',()=>{
  assert.ok(compareResults([row],[{...row,monetary:123.454}]).passed);
  assert.ok(!compareResults([row],[{...row,monetary:123.456}]).passed);
});
test('dashboard is before optional code and scripts are collapsed by default',()=>{
  assert.ok(html.indexOf('id="dashboard"')<html.indexOf('id="implementation"'));
  const tag=html.match(/<details[^>]*id="implementation"[^>]*>/)[0];assert.ok(!/\bopen\b/.test(tag));
  const start=html.indexOf(tag),end=html.indexOf('</details>',start);
  for(const id of ['r-code','py-code','code-contract','code-sql']){
    const index=html.indexOf('id="'+id+'"');assert.ok(index>start&&index<end,id);
  }
  assert.ok(!html.includes('5,852-customer columns'));
});
test('HTML IDs are unique and all local section links resolve',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  for(const [,id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id),id);
});
test('direct DOM hooks used by JavaScript exist in the HTML',()=>{
  for(const file of ['lab.js','dashboard.mjs']){
    const js=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    for(const [,id] of js.matchAll(/\$\(["']#([\w-]+)["']\)/g)) assert.ok(html.includes('id="'+id+'"'),file+': '+id);
  }
});
test('version metadata agrees across repository and browser',()=>{
  const version=fs.readFileSync(new URL('../../VERSION',import.meta.url),'utf8').trim();
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
  assert.equal(pkg.version,version);assert.ok(html.includes('v'+version));
  assert.ok(fs.readFileSync(new URL('../../pyproject.toml',import.meta.url),'utf8').includes('version = "'+version+'"'));
});
