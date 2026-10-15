// Report text helpers for the report versions API (routes/reports.js).
//
// - splitAiSections: the AI report markdown (ai-analysis generate_report) into its
//   narrative sections, leaving out the patient/findings header tables and the
//   AI disclaimer, which are not part of what the radiologist edits.
// - sanitizeReportHtml: radiologist HTML reduced to an allowlist of tags with no
//   attributes (except table spans), so a saved report can never carry script.
// - editPercent: word-level change between the AI draft and a saved version.

const SKIP_SECTION = /^(all findings|tabular summary)/i;
const DISCLAIMER = /\n+-{3,}\s*\n+_?this report was generated with ai assistance[\s\S]*$/i;

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';

/** [{ key, title, markdown }] from the AI report markdown. */
function splitAiSections(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n').replace(DISCLAIMER, '');
  const parts = text.split(/^##[ \t]+(.+?)[ \t]*$/m);   // [before, title1, body1, title2, body2, …]
  const sections = [];
  const seen = new Set();
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].replace(/[*_#]/g, '').trim();
    if (!title || SKIP_SECTION.test(title)) continue;
    const body = (parts[i + 1] || '').replace(/\n+-{3,}\s*$/g, '').trim();
    let key = slug(title);
    while (seen.has(key)) key += '_';
    seen.add(key);
    sections.push({ key, title, markdown: body });
  }
  return sections;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decodeEntities = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  const key = e.toLowerCase();
  if (key in ENTITIES) return ENTITIES[key];
  if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16) || 32);
  if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)) || 32);
  return m;
});

/** Plain text of markdown: markers, table pipes and links removed. */
function markdownToText(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
    .replace(/[#*_`>|]/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain text of HTML. */
function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain text of the AI draft's editable sections, titles included (matches the editor's <h2>s). */
function aiSectionsText(sections) {
  return sections.map((s) => `${s.title} ${markdownToText(s.markdown)}`).join(' ').replace(/\s+/g, ' ').trim();
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'hr', 'span', 'div',
]);
const SPAN_ATTR = /\b(colspan|rowspan)\s*=\s*["']?(\d{1,2})["']?/gi;

/** Allowlisted tags only, attributes dropped (table spans kept). */
function sanitizeReportHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|svg|math|template|noscript)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, name, attrs) => {
      const lower = name.toLowerCase();
      if (!ALLOWED_TAGS.has(lower)) return '';
      if (tag.startsWith('</')) return `</${lower}>`;
      let kept = '';
      if (lower === 'td' || lower === 'th') {
        for (const m of attrs.matchAll(SPAN_ATTR)) kept += ` ${m[1].toLowerCase()}="${m[2]}"`;
      }
      return `<${lower}${kept}${/\/\s*$/.test(attrs) ? ' /' : ''}>`;
    })
    .replace(/<(?![a-z/])/gi, '&lt;');                   // stray "<" left by removed markup
}

const tokens = (text) => String(text || '')
  .toLowerCase()
  .replace(/\[verify:[^\]]*\]/g, ' ')
  .match(/[a-z0-9]+(?:[.'][a-z0-9]+)*/g) || [];

/**
 * Share of the AI draft changed, 0–100: word-level edit distance over the longer
 * text. Rolling-row Levenshtein; very long texts are compared on their first 8 000
 * words each (reports are far shorter).
 */
function editPercent(aiText, savedText) {
  const a = tokens(aiText).slice(0, 8000);
  const b = tokens(savedText).slice(0, 8000);
  if (!a.length && !b.length) return 0;
  if (!a.length || !b.length) return 100;
  const ids = new Map();
  const id = (w) => { if (!ids.has(w)) ids.set(w, ids.size); return ids.get(w); };
  const A = Int32Array.from(a, id);
  const B = Int32Array.from(b, id);
  let prev = new Int32Array(B.length + 1);
  let cur = new Int32Array(B.length + 1);
  for (let j = 0; j <= B.length; j += 1) prev[j] = j;
  for (let i = 1; i <= A.length; i += 1) {
    cur[0] = i;
    const ai = A[i - 1];
    for (let j = 1; j <= B.length; j += 1) {
      const sub = prev[j - 1] + (ai === B[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    [prev, cur] = [cur, prev];
  }
  return Math.min(100, Math.round((prev[B.length] / Math.max(A.length, B.length)) * 1000) / 10);
}

module.exports = { splitAiSections, markdownToText, htmlToText, aiSectionsText, sanitizeReportHtml, editPercent };
