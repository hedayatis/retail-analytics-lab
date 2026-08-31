// Tokenize once; never re-process HTML or temporary numeric placeholders.
export function highlight(code, lang) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const keywords = new Set((lang === 'sql'
    ? 'WITH SELECT FROM WHERE GROUP BY ORDER JOIN LEFT CROSS ON USING AS CASE WHEN THEN ELSE END CREATE OR REPLACE TABLE DISTINCT COUNT SUM MIN MAX ROUND COALESCE CAST INTEGER VARCHAR DATE TIMESTAMP BOOLEAN UNNEST GENERATE_SERIES QUANTILE_CONT PRINTF MODE MEDIAN EXTRACT DATE_DIFF ROW_NUMBER OVER PARTITION INTERVAL'
    : lang === 'r' ? 'function if else for while return NULL NA TRUE FALSE in source library'
    : 'from import def class return if elif else for while in not and or None True False with as try except raise lambda yield assert dataclass').split(' '));
  const pattern = /(#[^\n]*|--[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  let out = '', end = 0;
  for (const match of String(code).matchAll(pattern)) {
    out += escape(code.slice(end, match.index));
    const token = match[0];
    const comment = lang === 'sql' ? token.startsWith('--') : token.startsWith('#');
    const kind = comment ? 'com' : /^["']/.test(token) ? 'str' : /^\d/.test(token) ? 'num'
      : keywords.has(lang === 'sql' ? token.toUpperCase() : token) ? 'kw' : null;
    out += kind ? '<span class="tok-' + kind + '">' + escape(token) + '</span>' : escape(token);
    end = match.index + token.length;
  }
  return out + escape(code.slice(end));
}
