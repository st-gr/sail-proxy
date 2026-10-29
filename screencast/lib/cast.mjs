// Terminal casts: a command list typed into a clean interactive bash on a pseudo-terminal (pty-host.py) at
// reading pace, the output timestamped into asciicast v2, every event scrubbed through the redaction map
// and the generic secret rules, and the joined text verified before anything is written.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { applyMap, redactionMisses, GENERIC, ACCESS_KEY_ID, API_KEY, DEPLOYMENT_ID } from './redact.mjs';
import { scan } from '../check.js';

export const CPS = 12;
export const PTY_HOST = join(dirname(fileURLToPath(import.meta.url)), 'pty-host.py');
export const SCRATCH_HOME = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'scratch');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After the map: a labelled secret value (also the asterisks a masked prompt echoes), then any long token
// (base64, hex, JWT); a generic rule may hit a harmless digest, which costs nothing. Colour codes and blanks between
// the label and the value, in any order (inquirer writes `:` code blank code), belong to the label; escape codes alone are no value, nor are a whole local URL (no
// credentials in it; a query or fragment ends the exemption, so a value in it stays masked) or the sail-proxy command after a label (a real host is still refused by the map and host checks).
export const MASK = '••••••••';
export const SCRUB = [
  [/((?:secret|password|passwd|token|cookie|api[_ -]?key)[a-z0-9_ -]*[ \t]*[:=](?:[ \t]|\x1b\[[0-9;]*m)*["']?)((?!=+(?![^\s"',;\x1b]))(?!\[[^\]\r\n]* [^\]\r\n]*\])(?!https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s\"'@?#]*)?(?=[\s\"',;\x1b]|$))(?!sail-proxy(?=[\s\"',;\x1b]|$))[^\s"',;\x1b][^\s"',;\x1b]{7,})/gi, `$1${MASK}`],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<redacted>']
];
export function scrub(text, map) {
  return SCRUB.reduce((t, [re, rep]) => t.replace(re, rep), applyMap(text, map));
}

// One replacement step over the events' joined text: a match that spans event boundaries puts its replacement
// into the first event it covers and removes the covered remainder from the following ones (timings unchanged).
function replaceAcross(parts, matches) {
  const ends = []; parts.reduce((n, p, i) => (ends[i] = n + p.length), 0);
  const starts = parts.map((p, i) => ends[i] - p.length);
  const out = parts.map(() => '');
  const copy = (from, to) => parts.forEach((p, i) => { const a = Math.max(from, starts[i]); const b = Math.min(to, ends[i]); if (b > a) out[i] += p.slice(a - starts[i], b - starts[i]); });
  let pos = 0;
  for (const { start, end, rep } of matches) {
    copy(pos, start);
    out[Math.max(0, ends.findIndex((e) => start < e))] += rep;
    pos = end;
  }
  copy(pos, ends[ends.length - 1] ?? 0);
  return out;
}
function literalMatches(text, key, rep) {
  const found = [];
  for (let i = key ? text.indexOf(key) : -1; i >= 0; i = text.indexOf(key, i + key.length)) found.push({ start: i, end: i + key.length, rep });
  return found;
}
function regexMatches(text, re, rep) {
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, rep: typeof rep === 'function' ? rep(m[0]) : rep.replace(/\$(\d)/g, (_, n) => m[n]) }));
}
// scrub() over the whole recording at once: the same steps as scrub (the map as applyMap runs it, then SCRUB),
// preceded by the typed values in `extra` ([real, shown] pairs), so a secret split over several events is caught.
// A cast definition's `blank` patterns: in each match in a recorded event ([t, output]) every printed character
// becomes a space and every escape sequence stays, so a line the video should not show (a transient warning) disappears
// without moving anything around it, redraws with cursor jumps included; each pattern replaces every match.
export function blankEvents(events, patterns = []) {
  if (!patterns.length) return events;
  return events.map(([t, text]) => [t, patterns.reduce((s, p) => s.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`), (m) => m.replace(/(\x1b\[[0-9;?]*[A-Za-z])|[^\r\n]/g, (c, esc) => esc || ' ')), text)]);
}

export function scrubEvents(events, map, extra = []) {
  let parts = events.map(([, s]) => s);
  const ids = new Map();
  const steps = [
    ...extra.filter(([real]) => real).sort((a, b) => b[0].length - a[0].length).map(([real, shown]) => (t) => literalMatches(t, real, shown)),
    ...Object.keys(map).filter(Boolean).sort((a, b) => b.length - a.length).map((k) => (t) => literalMatches(t, k, map[k])),
    ...[...GENERIC, ACCESS_KEY_ID, API_KEY].map(([re, rep]) => (t) => regexMatches(t, re, rep)),
    (t) => regexMatches(t, DEPLOYMENT_ID, (id) => { if (!ids.has(id)) ids.set(id, `demo-deployment-${ids.size + 1}`); return ids.get(id); }),
    ...SCRUB.map(([re, rep]) => (t) => regexMatches(t, re, rep))
  ];
  for (const step of steps) parts = replaceAcross(parts, step(parts.join('')));
  return events.map(([t], i) => [t, parts[i]]);
}

export function castHeader({ cols, rows, title, idleTimeLimit = 2 }) {
  return { version: 2, width: cols, height: rows, timestamp: Math.floor(Date.now() / 1000), idle_time_limit: idleTimeLimit, title, env: { SHELL: '/bin/bash', TERM: 'xterm-256color' } };
}

// Chunks that arrive within gapMs of the chunk before them are one event, so a value printed in one write is scrubbed whole.
export function coalesce(events, gapMs = 50) {
  const out = []; let prev = 0;
  for (const [t, s] of events) {
    const last = out[out.length - 1];
    if (last && (t - prev) * 1000 <= gapMs) last[1] += s; else out.push([t, s]);
    prev = t;
  }
  return out;
}

export const castText = (events) => events.map(([, s]) => s).join('');
export const serialize = (header, events) => [JSON.stringify(header), ...events.map(([t, s]) => JSON.stringify([Math.round(t * 1000) / 1000, 'o', s]))].join('\n') + '\n';
export function castSeconds(text) {
  const lines = text.trim().split('\n');
  return lines.length > 1 ? JSON.parse(lines[lines.length - 1])[0] : 0;
}

const KEYS = { enter: '\r', down: '\x1b[B', up: '\x1b[A', tab: '\t', space: ' ', esc: '\x1b', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-p': '\x10', 'ctrl-q': '\x11' };
export const keys = (text) => text.replace(/<([a-z-]+)>/g, (m, k) => (k in KEYS ? KEYS[k] : m));
const SECRETS_FILE = join(process.env.HOME ?? '', '.config', 'sail-docs', 'secrets.env');
// Values that cannot reach a running session's environment (a token exported after the session started) live in
// one file outside the tree; it must be private to the owner, and only KEY=value lines count.
const unquote = (v) => (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v);
export function secretsEnv(file = SECRETS_FILE) {
  if (!existsSync(file)) return {};
  if (statSync(file).mode & 0o077) throw new Error(`${file} must be mode 600`);
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), unquote(l.slice(l.indexOf('=') + 1).trim())]));
}
// A part of `send` may be { env, show }: the value is typed, and shown as `show` (default the mask) in the cast.
export function resolveSend(value, env, secrets = secretsEnv) {
  if (value && typeof value === 'object') {
    const v = env[value.env] || secrets()[value.env];
    if (!v) throw new Error(`${value.env} is not set (environment or ~/.config/sail-docs/secrets.env)`);
    return v;
  }
  return value;
}

// A prompt that redraws its whole line on every key (inquirer's input prompt) prints every prefix of a typed value,
// which the literal replacement of the whole value cannot find. For a part { env, show, redraw: true } the output
// that arrives while the k-th character is typed has every echoed prefix of 2 to k characters (outside escape
// sequences, followed by an escape sequence or the end of the chunk) replaced by the same share of `show`: a chunk
// may hold several redraws, or lag behind the keys. A one-character prefix is left alone (it would hit any digit).
const ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
export function maskRedraw(text, { real, shown, k }) {
  let out = text;
  for (let j = Math.min(k, real.length); j >= 2; j--) {
    const spans = [...out.matchAll(ESCAPE)].map((m) => [m.index, m.index + m[0].length]);
    const inEscape = (i) => spans.some(([a, b]) => i >= a && i < b);
    const prefix = real.slice(0, j); const rep = shown.slice(0, Math.max(1, Math.round((j * shown.length) / real.length)));
    let res = ''; let pos = 0;
    for (let i = out.indexOf(prefix); i >= 0; i = out.indexOf(prefix, i + 1)) {
      const end = i + prefix.length;
      if (i < pos || inEscape(i) || inEscape(end - 1) || !(end === out.length || out[end] === '\x1b')) continue;
      res += out.slice(pos, i) + rep; pos = end;
    }
    out = res + out.slice(pos);
  }
  return out;
}
// No prefix of a redrawn value from 4 characters on may survive.
const redrawLeft = (text, real) => { for (let n = 4; n < real.length; n++) if (text.includes(real.slice(0, n))) return true; return false; };

// The joined text as a reader would see it unwrapped: escape sequences removed, backspaces applied, a lone
// carriage return removed (with the space readline writes before the carriage return of a wrap), and a line
// joined with the next only where it reached the terminal edge (a hard wrap at `cols` columns). A value the
// terminal or readline broke across a wrap is whole again here; two ordinary output lines stay apart.
// A column move pads the text since the line's last carriage return up to that column (a move back adds nothing).
const toColumns = (line) => line.split(/(\x00\d+\x00)/).reduce((out, part) => {
  const col = /^\x00(\d+)\x00$/.exec(part);
  if (!col) return out + part;
  return out + ' '.repeat(Math.max(0, Number(col[1]) - 1 - (out.length - (out.lastIndexOf('\r') + 1))));
}, '');
const visible = (line) => [...line].reduce((n, ch) => (ch === '\t' ? n + 8 - (n % 8) : n + 1), 0);
export function unwrapped(text, cols = 100) {
  // An erased line (ESC [2K) is gone from the screen: what follows starts a line of its own (a prompt's redraw).
  let t = text
    .replace(/\x1b\[2K/g, '\n')
    // A cursor move right is how Ink clients (Claude Code) draw spaces: n columns of blank, not nothing.
    .replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat(Number(n || 1)))
    // ...and so is a move to column n (ESC [n G): Ink writes "shows ESC[9G both", skipping the space on screen.
    .replace(/\x1b\[(\d*)G/g, (m, n) => `\x00${n || 1}\x00`)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
  for (let p; p !== t;) { p = t; t = t.replace(/[^\x08\n]\x08/g, ''); } // backspace redraws: a character and its erasure cancel
  t = t.split('\n').map(toColumns).join('\n');
  // The edge decision looks at the cursor's line after its last lone carriage return (a spinner redraws from
  // column 0), and at that line alone, so one long line does not pull the following ones in.
  const lines = t.replace(/\r\n/g, '\n').split('\n');
  const width = (line) => visible(line.slice(line.lastIndexOf('\r') + 1));
  let out = '';
  lines.forEach((line, i) => {
    let text = line.replace(/ ?\r/g, '');
    const w = i < lines.length - 1 ? width(line) : 0;
    // At the edge readline may still write its wrap space: it never shows, the next line overwrites it.
    const space = w === cols + 1 && text.endsWith(' ');
    if (space) text = text.slice(0, -1);
    // A line wraps at the edge when its width is a whole number of rows; a wide character counts one column
    // here, so a line holding non-ASCII is joined from one column short of the edge on (fails closed).
    const edge = w > 0 && (space || w % cols === 0 || (/[^\x00-\x7f]/.test(line) && w >= cols - 1));
    out += text + (i < lines.length - 1 && !edge ? '\n' : '');
  });
  return out;
}
function textMisses(text, map, extra) {
  const hits = scan(['cast'], { map, readFile: () => text }).map((h) => h.pattern);
  const generic = [];
  if ([...text.matchAll(SCRUB[0][0])].some((m) => m[2] !== MASK)) generic.push('labelled secret');
  if (new RegExp(SCRUB[1][0].source).test(text)) generic.push('long token');
  const typed = extra.some(([real, , redraw]) => real && (text.includes(real) || (redraw && redrawLeft(text, real)))) ? ['typed value'] : [];
  return [...redactionMisses(text, map), ...hits.filter((p) => p !== 'redaction map value'), ...generic, ...typed];
}
// Map values, key patterns, hosts and addresses in the joined text (so a value split over two events is found)
// and in its unwrapped copy (so a value split by a line wrap is found). Also the SCRUB rules (a long token, a
// labelled secret not yet masked) and every typed value in `extra`. Findings name the pattern, never the value.
// `cols` is the cast's terminal width (its header's `width`).
export function verify(events, map, extra = [], cols = 100) {
  const text = castText(events);
  return [...new Set([...textMisses(text, map, extra), ...textMisses(unwrapped(text, cols), map, extra)])];
}

// A full-screen client (a TUI) colours and positions its text in pieces, so a waitFor is tried on the raw output and
// on the output without its escape sequences (CSI, OSC and charset selections).
const ESCAPES = /\x1b\[[0-9;?<=>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g;
// Spaces may be drawn as cursor moves (CSI n C); a string waitFor is also compared with all whitespace removed.
export const outputMatches = (buf, w) => {
  const test = (text) => (w instanceof RegExp ? w.test(text) : text.includes(w));
  const plain = buf.replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat(Number(n || 1))).replace(ESCAPES, '');
  if (test(buf) || test(plain)) return true;
  return typeof w === 'string' && plain.replace(/\s+/g, '').includes(w.replace(/\s+/g, ''));
};
const matches = outputMatches;
async function until(fn, ms, what, alive = () => {}) {
  const t = Date.now();
  while (!fn()) { alive(); if (Date.now() - t > ms) throw new Error(`timeout after ${ms} ms waiting for ${what}`); await sleep(50); }
}

export async function recordCast(def, { map = {}, env: outer = process.env, log = () => {} } = {}) {
  const { cols = 100, rows = 28, cwd = process.cwd(), env = {}, setup = [], commands = [], title = '', timeoutMs = 180000 } = def;
  // A definition without a HOME of its own gets a private scratch home, never the real one.
  const home = env.HOME ?? SCRATCH_HOME;
  if (!env.HOME) { mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700); }
  const shellEnv = { PATH: outer.PATH, HOME: home, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', PS1: '$ ', PS2: '> ', BASH_SILENCE_DEPRECATION_WARNING: '1', HISTFILE: '/dev/null', ...env };
  const child = spawn('python3', ['-I', PTY_HOST, String(cols), String(rows), '--', 'bash', '--noprofile', '--norc', '-i'], { cwd, env: shellEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const raw = []; const typed = []; let t0 = 0; let on = false; let err = ''; let failure = null; let redraw = null;
  child.stdout.setEncoding('utf8');
  // A chunk that arrives while a redrawn value is typed carries the state of that value (its k-th character typed).
  child.stdout.on('data', (s) => { buf += s; if (on) raw.push(redraw ? [(Date.now() - t0) / 1000, s, { ...redraw }] : [(Date.now() - t0) / 1000, s]); });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { failure = new Error(`cannot start the pty host: ${e.message}`); });
  child.stdin.on('error', (e) => { failure ??= new Error(`pty host stdin: ${e.message}${err.trim() ? ` (${err.trim().split('\n')[0]})` : ''}`); });
  // An early exit of the host or the shell is reported as that, with the host's stderr, not as a prompt timeout.
  const alive = () => {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`pty host exited with ${child.exitCode}${err.trim() ? `: ${err.trim().split('\n')[0]}` : ''}`);
  };
  const wait = (fn, ms, what) => until(fn, ms, what, alive);
  const prompt = (ms = timeoutMs) => wait(() => /\$ $/.test(buf), ms, 'the prompt');
  const type = async (text) => { for (const ch of text) { child.stdin.write(ch); await sleep(1000 / CPS); } };
  try {
    await prompt(15000);
    for (const c of setup) { buf = ''; child.stdin.write(`${c}\r`); await prompt(); log(`setup: ${c.split(' ')[0]}`); }
    buf = ''; child.stdin.write('clear\r'); await prompt(5000);
    t0 = Date.now(); on = true; raw.push([0, '$ ']);
    for (const c of commands) {
      const { cmd, input = [], holdMs = 1200, timeoutMs: cmdMs = timeoutMs } = typeof c === 'string' ? { cmd: c } : c;
      buf = ''; await type(cmd); child.stdin.write('\r'); log(`cmd: ${scrub(cmd, map)}`); // the console is no place for a real host either
      for (const step of input) {
        // A prompt that never comes is a wrong order or a changed text: fail fast, the raw log shows what was asked.
        await wait(() => matches(buf, step.waitFor), step.timeoutMs ?? Math.min(cmdMs, 120000), `"${step.waitFor}"`);
        buf = '';
        // Time to read what the client just showed before the next keys (playback caps an idle gap at 2 s).
        if (step.pauseMs) await sleep(step.pauseMs);
        for (const part of Array.isArray(step.send) ? step.send : [step.send]) {
          if (typeof part === 'string') { await type(keys(part)); continue; }
          const value = resolveSend(part, outer); const shown = part.show ?? MASK;
          typed.push([value, shown, !!part.redraw]);
          if (!part.redraw) { await type(value); continue; }
          redraw = { real: value, shown, k: 0 };
          for (const ch of value) { redraw.k++; child.stdin.write(ch); await sleep(1000 / CPS); }
          await sleep(200); redraw = null;
        }
      }
      await prompt(cmdMs); await sleep(holdMs);
    }
    on = false; child.stdin.write('exit\r'); await sleep(200); child.stdin.end();
  } catch (e) {
    // What the program printed up to the failure (a prompt that never came) is the operator's way to see why.
    e.raw = raw; throw e;
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  if (err.trim()) throw new Error(`pty host: ${err.trim().split('\n')[0]}`);
  const events = scrubEvents(coalesce(raw.map(([t, s, r]) => [t, r ? maskRedraw(s, r) : s])), map, typed).filter(([, s]) => s);
  return { header: castHeader({ cols, rows, title }), events, misses: verify(events, map, typed, cols), raw };
}
