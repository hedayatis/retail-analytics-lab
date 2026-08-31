// Pure calculations over the published full-population aggregates.
export const sum = (rows, key) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);
export const ratio = (a, b) => b > 0 ? a / b : null;
export function isCompleteMonth(month, meta) {
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return month + '-01' >= meta.date_min && end <= meta.date_max;
}
export function revenueView(data, year = 'all', completeOnly = true) {
  const rows = data.monthly.filter(r =>
    (year === 'all' || r.invoice_month.startsWith(year + '-')) &&
    (!completeOnly || isCompleteMonth(r.invoice_month, data.meta)))
    .map(r => ({...r, aov: ratio(r.revenue, r.orders), complete: isCompleteMonth(r.invoice_month, data.meta)}))
    .sort((a, b) => a.invoice_month.localeCompare(b.invoice_month));
  const revenue = sum(rows, 'revenue'), orders = sum(rows, 'orders');
  const latest = rows.filter(r => r.complete).at(-1);
  const prior = latest && data.monthly.find(r => r.invoice_month ===
    (Number(latest.invoice_month.slice(0, 4)) - 1) + latest.invoice_month.slice(4));
  const yoy = prior && isCompleteMonth(prior.invoice_month, data.meta) && prior.revenue > 0
    ? latest.revenue / prior.revenue - 1 : null;
  return {rows, revenue, orders, aov: ratio(revenue, orders), latest, yoy};
}
export function segmentView(data) {
  const revenue = sum(data.segments, 'total_monetary'), customers = sum(data.segments, 'customers');
  const rows = data.segments.map(s => ({...s,
    revenue_share: 100 * (ratio(s.total_monetary, revenue) ?? 0),
    customer_share: 100 * (ratio(s.customers, customers) ?? 0), spend: ratio(s.total_monetary, s.customers),
  })).sort((a, b) => b.total_monetary - a.total_monetary);
  return {rows, revenue, customers, unattributed: Math.max(0, data.meta.revenue_gbp - revenue),
    coverage: ratio(revenue, data.meta.revenue_gbp)};
}
export function countryView(data) {
  const rows = data.by_country.map(r => ({...r, share: 100 * (ratio(r.line_revenue, data.meta.revenue_gbp) ?? 0)}));
  const other = Math.max(0, data.meta.revenue_gbp - sum(rows, 'line_revenue'));
  if (other > 0.01) rows.push({country: 'Other countries', line_revenue: other, share: 100 * other / data.meta.revenue_gbp});
  return rows;
}
function observationMonth(cohort, age) {
  const [y, m] = cohort.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + age, 1)).toISOString().slice(0, 7);
}
export function retentionView(data, year = 'all') {
  const cohorts = data.cohort_matrix.filter(r => year === 'all' || r.cohort_month.startsWith(year + '-'));
  return Array.from({length: 13}, (_, age) => {
    // Null is censored, not zero. Exclude partial observation/acquisition months.
    const eligible = cohorts.filter(r => r['M+' + age] != null &&
      isCompleteMonth(r.cohort_month, data.meta) && isCompleteMonth(observationMonth(r.cohort_month, age), data.meta));
    const denominator = sum(eligible, 'cohort_size');
    const numerator = eligible.reduce((n, r) => n + r['M+' + age] * r.cohort_size, 0);
    return {age: 'M+' + age, retention: ratio(numerator, denominator), customers: denominator, cohorts: eligible.length};
  });
}
export function compareResults(r, p) {
  if (!Array.isArray(r) || !Array.isArray(p)) throw new Error('Expected customer result arrays');
  if (!r.length || !p.length) throw new Error('Empty results cannot establish parity');
  const sort = rows => rows.slice().sort((a, b) => Number(a.customer_id) - Number(b.customer_id));
  const left = sort(r), right = sort(p);
  const unique = rows => new Set(rows.map(x => String(x.customer_id))).size === rows.length;
  if (!unique(left) || !unique(right)) throw new Error('Duplicate customer identifiers');
  const columns = ['customer_id', 'recency_days', 'frequency', 'r_score', 'f_score', 'm_score', 'segment', 'monetary'];
  const checks = columns.map(column => ({column, mismatches: Math.abs(left.length - right.length) +
    left.slice(0, Math.min(left.length, right.length)).filter((row, i) => {
      if (row[column] == null || right[i][column] == null) return true;
      if (column === 'monetary') return !Number.isFinite(Number(row[column])) || !Number.isFinite(Number(right[i][column])) ||
        Math.abs(Number(row[column]) - Number(right[i][column])) > 0.005;
      return String(row[column]) !== String(right[i][column]);
    }).length}));
  return {checks, passed: checks.every(c => c.mismatches === 0), rows: left.length};
}
