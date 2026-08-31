import {revenueView, segmentView, countryView, retentionView, sum} from './insights.mjs';

export function createDashboard({data, el, table, barChart, lineChart}) {
  const $ = s => document.querySelector(s);
  const num = v => Number(v).toLocaleString('en-GB');
  const money = v => v == null ? 'Not available' : new Intl.NumberFormat('en-GB',
    {style:'currency', currency:'GBP', maximumFractionDigits:0}).format(v);
  const pct = v => v == null ? 'Not available' : v.toFixed(1) + '%';
  const compact = v => v >= 1e6 ? '£' + (v / 1e6).toFixed(2) + 'M' : money(v);
  const segments = segmentView(data), countries = countryView(data);
  let state = {year:'all', complete:true, metric:'revenue'}, current;
  const metricNames = {revenue:'Sales revenue', orders:'Orders', aov:'Average order value'};
  function kpis(node, rows) {
    node.replaceChildren(...rows.map(([value, label, note]) => {
      const card = el('div','stat');
      card.append(el('div','v',value), el('div','l',label));
      if (note) card.append(el('div','tiny',note));
      return card;
    }));
  }
  function revenue() {
    current = revenueView(data, state.year, state.complete);
    const v = current;
    kpis($('#overview-kpis'), [
      [compact(v.revenue),'Sales revenue',v.rows.length + ' selected months'],
      [num(v.orders),'Orders','Distinct invoices within each month'],
      [money(v.aov),'Average order value','Selected revenue ÷ selected orders'],
      [v.yoy == null ? 'Not available' : (v.yoy >= 0 ? '+' : '') + pct(v.yoy * 100),
        'Latest complete month · YoY',v.latest ? v.latest.invoice_month + ' vs same month last year' : 'No complete month'],
    ]);
    $('#period-note').textContent = 'Applied: ' + (state.year === 'all' ? 'all available years' : state.year) +
      ' · ' + (state.complete ? 'complete months only' : 'includes partial months') +
      '. Only revenue KPIs and the trend are filtered. December 2011 covers days 1–9; it is never used for YoY.';
    $('#trend-title').textContent = 'Monthly ' + metricNames[state.metric].toLowerCase();
    const format = state.metric === 'orders' ? num : money;
    lineChart($('#chart-monthly'), v.rows, {x:'invoice_month', y:state.metric, fmt:format, label:$('#trend-title').textContent});
    table($('#monthly-table'), [{key:'invoice_month',label:'Month'},{key:'revenue',label:'Revenue'},
      {key:'orders',label:'Orders'},{key:'aov',label:'Avg order'},{key:'complete',label:'Coverage'}],
      v.rows, {revenue:money, orders:num, aov:money, complete:v=>v?'Complete':'Partial'});
  }
  function shareChart() {
    const box = $('#chart-shares'); box.replaceChildren();
    segments.rows.forEach(s => {
      const row = el('div','share-row'); row.append(el('div','share-label',s.segment));
      for (const [key, cls, label] of [['customer_share','customer-key','customers'],['revenue_share','revenue-key','revenue']]) {
        const track = el('div','share-track'), fill = el('span',cls), value = el('span','share-value',pct(s[key]));
        fill.style.width = s[key] + '%'; track.append(fill, value);
        track.setAttribute('aria-label',s.segment + ': ' + pct(s[key]) + ' of ' + label);
        row.append(track);
      }
      box.append(row);
    });
  }
  const actions = {
    'Champions':'Test priority service and retention outreach. Their high observed spend makes service failures worth investigating.',
    'Loyal customers':'Explore cross-selling relevant products and consistency of repeat orders before offering broad discounts.',
    'Cannot lose them':'Review historically valuable but inactive accounts. Test a small win-back campaign with a control group.',
    'Lost':'Investigate whether inactivity reflects churn, seasonality or a one-off purchase before spending on reacquisition.',
    'At risk':'Check declining engagement and contactability; evaluate targeted reactivation rather than assuming future loss.',
    'Potential loyalists':'Test a second-to-third purchase journey with relevant recommendations.',
    'Need attention':'Investigate purchase gaps and product fit; measure incremental lift against an untreated group.',
    'Hibernating':'Assess whether low-frequency customers have a reason to return before committing campaign budget.',
    'Promising':'Test a timely follow-up based on the recent order, then measure second-purchase conversion.',
    'New customers':'Test onboarding and post-purchase support; judge success by subsequent purchases, not clicks.',
  };
  function segmentDetail() {
    const s = segments.rows.find(r => r.segment === $('#segment-pick').value);
    if (!s) return;
    const box = $('#segment-detail'), grid = el('div','stats segment-stats');
    kpis(grid, [[num(s.customers),'Customers'],[money(s.spend),'Historical spend/customer'],
      [s.avg_recency_days.toFixed(0) + ' days','Mean time since last order'],[s.avg_frequency.toFixed(1),'Mean historical orders']]);
    box.replaceChildren(grid, el('p','chart-takeaway',actions[s.segment] || 'Investigate this segment before acting.'));
  }
  function retention() {
    const rows = retentionView(data, $('#cohort-year').value);
    lineChart($('#chart-retention'), rows.filter(r=>r.retention != null),
      {x:'age',y:'retention',fmt:pct,max:100,label:'Weighted repeat purchasing by cohort age'});
    table($('#retention-table'), [{key:'age',label:'Age'},{key:'retention',label:'Ordering (%)'},
      {key:'cohorts',label:'Eligible cohorts'},{key:'customers',label:'Eligible customers'}], rows,
      {retention:pct,cohorts:num,customers:num});
    const m1 = rows[1], m6 = rows[6];
    $('#retention-note').textContent = 'M+1: ' + pct(m1.retention) + ' across ' + num(m1.customers) +
      ' eligible customers. M+6: ' + pct(m6.retention) + ' across ' + num(m6.customers) +
      '. Approximate weighted averages use published cohort percentages rounded to two decimals.';
  }
  function insights() {
    const champion = segments.rows.find(s=>s.segment === 'Champions');
    const dormant = segments.rows.filter(s=>['At risk','Cannot lose them'].includes(s.segment));
    const duplicate = data.ledger.find(r=>r.rule === 'exact_duplicate');
    const cards = [
      ['Concentrated customer value', pct(champion.revenue_share),
        'of identified-customer revenue comes from Champions, who represent ' + pct(champion.customer_share) + ' of identified customers.'],
      ['Historical reactivation pool', compact(sum(dormant,'total_monetary')),
        'was spent by ' + num(sum(dormant,'customers')) + ' customers now labelled At risk or Cannot lose them. This is past spend, not recoverable revenue.'],
      ['Missing customer attribution', compact(segments.unattributed),
        'of sales revenue cannot be assigned to a customer. Customer-level findings do not cover this revenue.'],
      ['A material cleaning decision', compact(duplicate.gross_value_removed),
        'of apparent transaction value is removed by the exact-duplicate rule. Review the assumption in the audit ledger.'],
    ];
    $('#insight-cards').replaceChildren(...cards.map(([title,value,note])=>{
      const a=el('article','insight-card');a.append(el('h3',null,title),el('p','insight-value',value),el('p','small muted',note));return a;
    }));
    $('#seg-note').textContent = 'All percentages use identified customers and their attributed revenue only. Wider revenue bars indicate higher spend per customer relative to the overall identified-customer average.';
    const market=countries[0];
    $('#market-note').textContent = market.country + ' contributes ' + pct(market.share) +
      ' of full-history sales revenue. The concentration suggests testing geographic resilience; it does not establish future risk.';
    const box=$('#attribution-detail'), meter=el('div','coverage-meter');
    meter.setAttribute('role','img');meter.setAttribute('aria-label',pct(segments.coverage*100)+' of sales revenue attributed to customers');
    const fill=el('span');fill.style.width=(segments.coverage*100)+'%';meter.append(fill);
    box.replaceChildren(el('p','insight-value',pct(segments.coverage*100)),meter,
      el('p','small muted',money(segments.revenue)+' attributed out of '+money(data.meta.revenue_gbp)+' total sales revenue.'));
  }
  function render() {
    revenue(); retention(); shareChart(); segmentDetail();
    barChart($('#chart-country'), countries, {label:'country',value:'share',fmt:pct,height:24,title:'Country share of full-history sales revenue'});
    const names={exact_duplicate:'Exact duplicates',routed_to_returns:'Routed to returns',ledger_adjustment:'Ledger adjustments',
      non_product_stock_code:'Non-product lines',non_positive_price:'Non-positive price',missing_description:'No description',zero_value_return:'Zero-value returns'};
    barChart($('#chart-cleaning'),data.ledger.map(r=>({...r,name:names[r.rule]})),
      {label:'name',value:'rows_removed',fmt:num,height:34,title:'Rows affected by each cleaning rule'});
  }
  $('#segment-pick').replaceChildren(...segments.rows.map(s=>{const o=el('option',null,s.segment);o.value=s.segment;return o;}));
  $('#segment-pick').disabled=false;
  $('#segment-pick').onchange=segmentDetail;
  $('#cohort-year').onchange=retention;
  $('#analysis-controls').onsubmit=e=>{e.preventDefault();state={year:$('#period').value,complete:$('#complete-only').checked,metric:$('#metric').value};revenue();};
  $('#analysis-controls').onchange=()=>{$('#period-note').textContent='Selection changed. Press Update analysis to apply it to the revenue KPIs and monthly trend.';};
  $('#export-monthly').onclick=()=>{
    const lines=['month,revenue_gbp,orders,average_order_value_gbp,complete_month',...current.rows.map(r=>
      [r.invoice_month,r.revenue.toFixed(2),r.orders,r.aov?.toFixed(2)??'',r.complete].join(','))];
    const url=URL.createObjectURL(new Blob([lines.join('\n')+'\n'],{type:'text/csv;charset=utf-8'}));
    const a=el('a');a.href=url;a.download='retail-monthly-'+state.year+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  table($('#segment-table'),[{key:'segment',label:'Segment'},{key:'customers',label:'Customers'},
    {key:'customer_share',label:'Customer share'},{key:'total_monetary',label:'Revenue'},
    {key:'revenue_share',label:'Revenue share'},{key:'spend',label:'Spend/customer'}],segments.rows,
    {customers:num,customer_share:pct,total_monetary:money,revenue_share:pct,spend:money});
  insights(); render();
  return {render};
}
