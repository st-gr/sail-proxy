// Redaction at the presentation layer: a map of real → mock values applied to text (casts, pages) and
// a browser overlay that applies the same map to the live DOM. Generic patterns run after the map.
// A Kyma cluster host, matched from its first character; the placeholder cluster c-abc123 (shown on purpose, like
// the 203.0.113.0/24 documentation range) is no cluster host.
export const CLUSTER_HOST = /(?<![a-z0-9.-])(?![a-z0-9.-]*\bc-abc123\.kyma\.ondemand\.com)[a-z0-9.-]+\.kyma\.ondemand\.com/gi;
export const GENERIC = [
  [CLUSTER_HOST, 'sail.example.com'],
  [/\b(?!127\.)(?!203\.0\.113\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, '203.0.113.7'],
  [/\b[a-z0-9-]+\.authentication\.[a-z0-9-]+\.hana\.ondemand\.com\b/gi, 'auth.example.sap'],
  // Azure OpenAI (classic Cognitive Services) keys: 32 lower-case hex characters, with at least one letter and one
  // digit. Request and trace ids of the same shape are masked too, which a screen never needs to show. The newer
  // 84-character Azure keys have no published shape to match on; they are masked by the map only.
  [/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{32}\b/g, '••••••••']
];
// AWS-shaped access key ids become a neutral placeholder (no access-key-shaped literal in the repository).
export const ACCESS_KEY_ID = [/\bAKIA[0-9A-Z]{16}\b/g, 'DEMO-ACCESS-KEY-ID'];
// Any API key value (the gateway's keys start with sk-) becomes one demo key, so a key created in the
// cockpit and the same key typed in a cast read the same. sk-demo-… values are the documentation's.
export const API_KEY = [/\bsk-(?!demo-)[A-Za-z0-9_-]{20,}\b/g, 'sk-demo-00000000000000000000'];
// SAP AI Core deployment ids (16 lower-case hex characters with at least one letter, so a 16-digit
// number stays) become demo-deployment-<n>, numbered by first appearance, the same id always the same.
export const DEPLOYMENT_ID = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{16}\b/g;

export function applyMap(text, map) {
  let out = text;
  for (const key of Object.keys(map).filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(key).join(map[key]);
  for (const [re, rep] of GENERIC) out = out.replace(re, rep);
  out = out.replace(ACCESS_KEY_ID[0], ACCESS_KEY_ID[1]);
  out = out.replace(API_KEY[0], API_KEY[1]);
  const ids = new Map();
  out = out.replace(DEPLOYMENT_ID, (id) => { if (!ids.has(id)) ids.set(id, `demo-deployment-${ids.size + 1}`); return ids.get(id); });
  return out;
}

export function overlaySource(map) {
  const entries = JSON.stringify(Object.entries(map).filter(([k]) => k).sort((a, b) => b[0].length - a[0].length));
  return `(() => {
  if (window.__sailRedact) return; window.__sailRedact = true;
  const entries = ${entries};
  const generic = [[new RegExp(${JSON.stringify(CLUSTER_HOST.source)}, 'gi'), 'sail.example.com'], [/\\b(?!127\\.)(?!203\\.0\\.113\\.)(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, '203.0.113.7'], [/\\b[a-z0-9-]+\\.authentication\\.[a-z0-9-]+\\.hana\\.ondemand\\.com\\b/gi, 'auth.example.sap'], [/\\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{32}\\b/g, '••••••••']];
  const ids = new Map();
  const fix = (s) => {
    let o = s; for (const [k, v] of entries) o = o.split(k).join(v); for (const [re, rep] of generic) o = o.replace(re, rep);
    o = o.replace(/\\bAKIA[0-9A-Z]{16}\\b/g, 'DEMO-ACCESS-KEY-ID');
    o = o.replace(/\\bsk-(?!demo-)[A-Za-z0-9_-]{20,}\\b/g, 'sk-demo-00000000000000000000');
    return o.replace(/\\b(?=[0-9a-f]*[a-f])[0-9a-f]{16}\\b/g, (id) => { if (!ids.has(id)) ids.set(id, 'demo-deployment-' + (ids.size + 1)); return ids.get(id); });
  };
  const node = (n) => {
    if (n.nodeType === 3) { const t = fix(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; return; }
    if (n.nodeType !== 1) return;
    if (n.hasAttribute && n.hasAttribute('title')) { const t = fix(n.getAttribute('title')); if (t !== n.getAttribute('title')) n.setAttribute('title', t); }
    if ((n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') && n.value) { const t = fix(n.value); if (t !== n.value) n.value = t; }
    for (const c of n.childNodes) node(c);
  };
  node(document.body);
  new MutationObserver((ms) => { for (const m of ms) { for (const a of m.addedNodes) node(a); if (m.type === 'characterData') node(m.target); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  // A script that sets an input's value (a UI5 Select writes its key into a hidden input) fires no mutation: sweep.
  if (window.setInterval && document.querySelectorAll) window.setInterval(() => {
    for (const el of document.querySelectorAll('input, textarea')) if (el.value) { const t = fix(el.value); if (t !== el.value) el.value = t; }
  }, 200);
})();`;
}

// The dev mocks' domains: the only e-mail domains a page, a cast or a committed file (check.js) may show.
export const ALLOWED_EMAIL_DOMAINS = 'example\\.com|example\\.org|example\\.net|test\\.com|localhost';
export const NON_EXAMPLE_EMAIL = new RegExp(`\\b[A-Za-z0-9._%+-]+@(?!(?:${ALLOWED_EMAIL_DOMAINS})\\b)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b`);

// Names a leak by the mock value it should have shown (or the pattern), never by the real value.
export function redactionMisses(text, m) {
  const misses = [];
  for (const [real, mock] of Object.entries(m)) if (real && text.includes(real)) misses.push(`map entry shown as "${mock}"`);
  if (new RegExp(GENERIC[0][0].source, 'i').test(text)) misses.push('cluster host');
  if (new RegExp(GENERIC[1][0].source).test(text)) misses.push('IPv4 address');
  if (new RegExp(GENERIC[2][0].source, 'i').test(text)) misses.push('SAP auth host');
  if (new RegExp(GENERIC[3][0].source).test(text)) misses.push('azure key');
  if (NON_EXAMPLE_EMAIL.test(text)) misses.push('non-example email');
  if (new RegExp(ACCESS_KEY_ID[0].source).test(text)) misses.push('access key id');
  if (new RegExp(API_KEY[0].source).test(text)) misses.push('api key');
  if (new RegExp(DEPLOYMENT_ID.source).test(text)) misses.push('deployment id');
  return misses;
}

// What a reader can see or hover: the body text, input values and title attributes. Runs in the page
// (page.evaluate serializes it), so it only uses its argument.
export function pageText(doc) {
  const values = Array.from(doc.querySelectorAll('input, textarea')).map((e) => e.value).filter(Boolean);
  const titles = Array.from(doc.querySelectorAll('[title]')).map((e) => e.getAttribute('title')).filter(Boolean);
  return [doc.body.innerText, ...values, ...titles].join('\n');
}
