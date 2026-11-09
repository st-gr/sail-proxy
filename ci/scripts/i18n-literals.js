#!/usr/bin/env node
/**
 * An inventory of hard-coded cockpit texts (dev tool, not shipped).
 *
 *   node ci/scripts/i18n-literals.js [--summary] [appDir|file ...]
 *
 * Without arguments it scans every services/admin/app/<app>/webapp (the FE extension code lives
 * there too). It reports, per file, the user-visible texts that do not come from an i18n bundle:
 *
 * - XML views and fragments: text-like attributes (text, title, placeholder, tooltip, …) whose value
 *   is not a binding, the literal part of a mixed value ("Last Updated: {x}") and quoted literals
 *   inside an expression binding ("{= ${a} + ' (b)'}").
 * - Controllers and other scripts: string and template literals passed to MessageBox.*,
 *   MessageToast.show and the setText/setTitle/… setters, and the values of text-like properties
 *   in object literals (new Dialog({ title }), new Text({ text }), VizFrame titles, …).
 *   Arguments of nested text()/getText() calls are bundle keys and are not reported.
 *
 * A hit counts only when it holds a letter. Technical strings (icons, CSS classes, model names, the
 * native language names, …) are excused by i18n-literals.allowlist.json next to this file:
 *   { "global": [{ "pattern": "<regex>", "reason": "…" }],
 *     "files": { "<path from the repo root>": [{ "pattern": "<regex>", "reason": "…" }] } }
 * Patterns match the reported text. Exit code 1 while non-allowlisted hits remain.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'services', 'admin', 'app');
const DEFAULT_ALLOWLIST = path.join(__dirname, 'i18n-literals.allowlist.json');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'i18n', 'localService', 'annotations', 'mockData']);

const XML_ATTRIBUTES = new Set([
  'text', 'title', 'placeholder', 'tooltip', 'noDataText', 'label', 'headerText', 'description',
  'subtitle', 'subTitle', 'subheader', 'header', 'infoText', 'emptyText', 'ariaLabel', 'valueStateText',
  'footerText', 'additionalText', 'info', 'intro', 'htmlText', 'customTextOn', 'customTextOff',
  'currentLocationText', 'buttonText', 'confirmButtonText', 'cancelButtonText', 'footer', 'unit', 'alt',
  'beginButton', 'endButton'
]);
const SCRIPT_PROPERTIES = new Set([
  'text', 'title', 'placeholder', 'tooltip', 'noDataText', 'headerText', 'subtitle', 'subTitle',
  'subheader', 'infoText', 'emptyText', 'htmlText', 'label', 'ariaLabel', 'valueStateText', 'footerText',
  'additionalText', 'description', 'buttonText', 'confirmButtonText', 'cancelButtonText'
]);
const SETTERS = new Set([
  'setText', 'setTitle', 'setPlaceholder', 'setTooltip', 'setNoDataText', 'setHeaderText', 'setSubtitle',
  'setSubheader', 'setDescription', 'setInfoText', 'setHtmlText', 'setLabel', 'setValueStateText',
  'setFooterText', 'setAdditionalText', 'setInfo'
]);
/** A call whose arguments are bundle keys: text("k"), this._text("k"), getText("k"), …. */
const KEY_CALL = /^_?(get)?text$/i;
const LETTER = /\p{L}/u;
/** camelCase or dotted, no spaces: a bundle key handed on to a text helper ("formMapKeyPlaceholder"). */
const KEY_SHAPED = /^[a-z][a-z0-9]*(?:[A-Z_.][A-Za-z0-9]*)+$/;

function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------------------- XML

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Index of the "}" closing the binding that opens at value[start] ("{"), or -1. */
function closingBrace(value, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The hard-coded texts in one attribute value: the literal part, and literals in expression bindings. */
function attributeLiterals(value) {
  const found = [];
  let literal = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      literal += value[++i];
      continue;
    }
    if (c !== '{') {
      literal += c;
      continue;
    }
    const end = closingBrace(value, i);
    if (end < 0) {
      literal += value.slice(i);
      break;
    }
    const binding = value.slice(i, end + 1);
    if (/^\{:?=/.test(binding)) {
      // Strip the ${...} property bindings first: a quoted string inside one is
      // binding metadata (path:'x', targetType:'any', formatter:'.f'), never a
      // display literal. Display literals sit outside them ("${a} ? 'Yes' : 'No'").
      const expression = binding.replace(/\$\{[^}]*\}/g, ' ');
      const quoted = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
      let m;
      while ((m = quoted.exec(expression))) {
        const text = m[1] !== undefined ? m[1] : m[2];
        if (LETTER.test(text)) found.push(text);
      }
    }
    literal += ' ';
    i = end;
  }
  const trimmed = literal.replace(/\s+/g, ' ').trim();
  if (LETTER.test(trimmed)) found.unshift(trimmed);
  return found;
}

function scanXml(source) {
  // Blank out comments (keeping newlines) so commented-out markup is not reported.
  const clean = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const hits = [];
  const attr = /\s([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attr.exec(clean))) {
    const name = m[2];
    if (!XML_ATTRIBUTES.has(name)) continue;
    const raw = m[3] !== undefined ? m[3] : m[4];
    for (const text of attributeLiterals(decodeEntities(raw))) {
      hits.push({ line: lineAt(clean, m.index + 1), kind: 'attribute', where: name, text });
    }
  }
  return hits;
}

// ------------------------------------------------------------------------------------- scripts

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
function unescapeChar(c) {
  return Object.prototype.hasOwnProperty.call(ESCAPES, c) ? ESCAPES[c] : c;
}

/** A small JS/TS tokenizer: strings, templates (static text only), identifiers, punctuation. */
function tokenize(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  const last = () => tokens[tokens.length - 1];
  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') { const e = source.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') { text += unescapeChar(source[j + 1]); j += 2; continue; }
        if (source[j] === '\n') break;
        text += source[j++];
      }
      tokens.push({ type: 'str', text, start: i });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let text = '';
      while (j < n && source[j] !== '`') {
        if (source[j] === '\\') { text += unescapeChar(source[j + 1]); j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            const d = source[j];
            if (d === '{') depth++;
            else if (d === '}') depth--;
            else if (d === '"' || d === "'" || d === '`') {
              const q = d;
              j++;
              while (j < n && source[j] !== q) j += source[j] === '\\' ? 2 : 1;
            }
            j++;
          }
          text += '${…}';
          continue;
        }
        text += source[j++];
      }
      tokens.push({ type: 'tpl', text, start: i });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const prev = last();
      const regexAllowed = !prev || (prev.type === 'punc' && REGEX_PRECEDERS.has(prev.text)) ||
        (prev.type === 'ident' && REGEX_KEYWORDS.has(prev.text));
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== '\n') {
          const d = source[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(source[j])) j++;
        tokens.push({ type: 'regex', text: source.slice(i, j), start: i });
        i = j;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j])) j++;
      tokens.push({ type: 'ident', text: source.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(source[j])) j++;
      tokens.push({ type: 'num', text: source.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (c === '=' && source[i + 1] === '>') { tokens.push({ type: 'punc', text: '=>', start: i }); i += 2; continue; }
    if (c === '?' && source[i + 1] === '.') { tokens.push({ type: 'punc', text: '.', start: i }); i += 2; continue; }
    tokens.push({ type: 'punc', text: c, start: i });
    i++;
  }
  return tokens;
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

/** Index of the token closing the bracket at tokens[start]. */
function matching(tokens, start) {
  const open = tokens[start].text;
  const close = OPEN[open];
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'punc') continue;
    if (t.text === open) depth++;
    else if (t.text === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function isPunc(token, text) {
  return token && token.type === 'punc' && token.text === text;
}

/** True when tokens[i] is an operand of ===, !==, == or != (an id compared, never displayed). */
function compared(tokens, i) {
  const before = isPunc(tokens[i - 1], '=') && (isPunc(tokens[i - 2], '=') || isPunc(tokens[i - 2], '!'));
  const after = (isPunc(tokens[i + 1], '=') || isPunc(tokens[i + 1], '!')) && isPunc(tokens[i + 2], '=');
  return before || after;
}

/**
 * The literal tokens in tokens[from, to), skipping nested text()/getText() calls (their
 * arguments are bundle keys), function bodies (a callback's own calls are matched on their own)
 * and object keys.
 */
function literalsIn(tokens, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.type === 'ident' && KEY_CALL.test(t.text) && isPunc(tokens[i + 1], '(')) {
      i = matching(tokens, i + 1);
      continue;
    }
    if (isPunc(t, '{') && (isPunc(tokens[i - 1], '=>') || isPunc(tokens[i - 1], ')'))) {
      i = matching(tokens, i);
      continue;
    }
    // A string before ':' is an object key only after '{' or ','; after anything else it is a ternary branch.
    const objectKey = isPunc(tokens[i + 1], ':') && (isPunc(tokens[i - 1], '{') || isPunc(tokens[i - 1], ','));
    if ((t.type === 'str' || t.type === 'tpl') && !objectKey && !compared(tokens, i)) out.push(t);
  }
  return out;
}

/** The callee a "(" at tokens[i + 1] belongs to, when its arguments are user-visible texts. */
function textCall(tokens, i) {
  const name = tokens[i].text;
  const dotted = isPunc(tokens[i - 1], '.');
  const owner = dotted && tokens[i - 2] && tokens[i - 2].type === 'ident' ? tokens[i - 2].text : null;
  if (owner === 'MessageBox') return `MessageBox.${name}`;
  if (owner === 'MessageToast' && name === 'show') return 'MessageToast.show';
  if (dotted && SETTERS.has(name)) return name;
  return null;
}

function scanScript(source) {
  const tokens = tokenize(source);
  const seen = new Set();
  const hits = [];
  const report = (token, kind, where) => {
    if (seen.has(token.start)) return;
    const text = token.text;
    if (!LETTER.test(text.replace(/\$\{…\}/g, '')) || KEY_SHAPED.test(text)) return;
    seen.add(token.start);
    hits.push({ line: lineAt(source, token.start), kind, where, text });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'ident' && isPunc(tokens[i + 1], '(')) {
      const callee = textCall(tokens, i);
      if (callee) {
        const end = matching(tokens, i + 1);
        for (const lit of literalsIn(tokens, i + 2, end)) report(lit, 'call', callee);
      }
      continue;
    }
    // A text-like property in an object literal: { title: "…" }; not a ternary's "a ? text : b".
    const isKey = (t.type === 'ident' || t.type === 'str') && SCRIPT_PROPERTIES.has(t.text);
    if (isKey && isPunc(tokens[i + 1], ':') && (isPunc(tokens[i - 1], '{') || isPunc(tokens[i - 1], ','))) {
      const first = tokens[i + 2];
      if (!first || isPunc(first, '{') || isPunc(first, '[')) continue;
      let end = i + 2;
      for (; end < tokens.length; end++) {
        const v = tokens[end];
        if (v.type !== 'punc') continue;
        if (OPEN[v.text]) { end = matching(tokens, end); continue; }
        if (v.text === ',' || v.text === '}' || v.text === ')' || v.text === ']' || v.text === ';') break;
      }
      for (const lit of literalsIn(tokens, i + 2, end)) report(lit, 'property', t.text);
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

// ----------------------------------------------------------------------------- files, allowlist

function scanFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  return file.endsWith('.xml') ? scanXml(source) : scanScript(source);
}

function collectFiles(target, out = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.(xml|ts|js)$/.test(target) && !target.endsWith('.d.ts')) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    collectFiles(path.join(target, entry.name), out);
  }
  return out;
}

function defaultTargets() {
  return fs.readdirSync(APP_ROOT).sort()
    .map((app) => path.join(APP_ROOT, app, 'webapp'))
    .filter((dir) => fs.existsSync(dir));
}

function loadAllowlist(file) {
  if (!fs.existsSync(file)) return { global: [], files: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const compile = (entries, where) => (entries || []).map((entry) => {
    if (!entry.pattern || !entry.reason) throw new Error(`allowlist entry in ${where} needs a pattern and a reason`);
    return { pattern: new RegExp(entry.pattern, 'u'), reason: entry.reason };
  });
  const files = {};
  for (const [key, entries] of Object.entries(data.files || {})) files[key] = compile(entries, key);
  return { global: compile(data.global, 'global'), files };
}

/** Marks each hit allowlisted (or not) for the file at relPath (repo-relative, forward slashes). */
function applyAllowlist(hits, relPath, allowlist) {
  const entries = allowlist.global.concat(allowlist.files[relPath] || []);
  return hits.map((hit) => {
    const entry = entries.find((e) => e.pattern.test(hit.text));
    return entry ? { ...hit, allowed: entry.reason } : hit;
  });
}

function run(targets, { allowlistFile = DEFAULT_ALLOWLIST, root = REPO_ROOT } = {}) {
  const allowlist = loadAllowlist(allowlistFile);
  const files = [];
  for (const target of targets.length ? targets : defaultTargets()) collectFiles(path.resolve(target), files);
  return files.map((file) => {
    const rel = path.relative(root, file).split(path.sep).join('/');
    return { file: rel, hits: applyAllowlist(scanFile(file), rel, allowlist) };
  });
}

function main(argv, log = console.log) {
  const summary = argv.includes('--summary');
  const allowArg = argv.find((a) => a.startsWith('--allowlist='));
  const targets = argv.filter((a) => !a.startsWith('--'));
  const results = run(targets, allowArg ? { allowlistFile: path.resolve(allowArg.slice(12)) } : {});
  let open = 0;
  let allowed = 0;
  for (const { file, hits } of results) {
    const pending = hits.filter((h) => !h.allowed);
    open += pending.length;
    allowed += hits.length - pending.length;
    if (!pending.length) continue;
    log(`${file}: ${pending.length}`);
    if (summary) continue;
    for (const hit of pending) log(`  ${hit.line}\t${hit.where}\t${JSON.stringify(hit.text)}`);
  }
  log(`i18n-literals: ${open} hard-coded text(s) in ${results.filter((r) => r.hits.some((h) => !h.allowed)).length} ` +
    `of ${results.length} file(s); ${allowed} allowlisted`);
  return open > 0 ? 1 : 0;
}

module.exports = { scanXml, scanScript, attributeLiterals, tokenize, loadAllowlist, applyAllowlist, run, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
