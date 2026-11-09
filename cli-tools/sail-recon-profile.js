'use strict';
const zlib = require('zlib');

const DEFAULT_CONFIG = Object.freeze({
  model: 'anthropic--claude-4.5-sonnet--deployed',
  maxTokens: 64,
  cacheContextTokens: 100000,
  cacheReadRepeats: 3000,
  cacheWriteDistinct: 200,
  imageCount: 200,
  imageWidth: 1540,
  imageHeight: 1540,
  // Matches the gateway's per-image constant (imageTokenOverhead() default, IMAGE_TOKEN_OVERHEAD
  // env). Verified 2026-09-03: smoke image cell captured 12185 = 110*110 + 85.
  imageOverhead: 85,
  baselineCount: 500,
  baselinePromptTokens: 2000,
});

function resolveConfig(overrides) {
  return Object.freeze({ ...DEFAULT_CONFIG, ...(overrides || {}) });
}

function fillerText(approxTokens) {
  return 'token '.repeat(Math.max(0, approxTokens)).trim();
}

function imageTokens(w, h, overhead) {
  const cap = (x) => Math.min(x, 1540);
  return Math.ceil(cap(w) / 14) * Math.ceil(cap(h) / 14) + (overhead || 0);
}

// --- minimal zero-dep solid-color PNG encoder ---
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function makeSolidPng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  // compression/filter/interlace = 0
  const raw = Buffer.alloc(h * (1 + w * 3)); // each row: 1 filter byte + w*RGB, all zero = black
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function baseBody(cfg, content) {
  return { model: cfg.model, max_tokens: cfg.maxTokens, temperature: 0, messages: [{ role: 'user', content }] };
}
function buildBaselineRequest(cfg) {
  return baseBody(cfg, [{ type: 'text', text: fillerText(cfg.baselinePromptTokens) }]);
}
function buildImageRequest(cfg, pngBase64) {
  return baseBody(cfg, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
    { type: 'text', text: 'Describe in one word.' },
  ]);
}
function buildCacheWriteRequest(cfg, nonce) {
  return baseBody(cfg, [
    { type: 'text', text: `${nonce} ${fillerText(cfg.cacheContextTokens)}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'ok?' },
  ]);
}
function buildCacheReadRequest(cfg) {
  return baseBody(cfg, [
    { type: 'text', text: fillerText(cfg.cacheContextTokens), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'ok?' },
  ]);
}

const http = require('http');
const https = require('https');

function isModelAvailable(modelList, target) {
  return Array.isArray(modelList) && modelList.some((m) => m && m.id === target);
}
function evalCacheHit(usages) {
  let reads = 0, hit = false;
  for (const u of usages || []) {
    const n = (u && u.cache_read_input_tokens) || 0;
    if (n > 0) { hit = true; reads += n; }
  }
  return { hit, reads };
}
function evalImageCapture(capturedImageTokens, sentImages) {
  return { captured: capturedImageTokens > 0, gap: sentImages > 0 && capturedImageTokens === 0 };
}
function planCells(cfg, tier) {
  const n = (real) => (tier === 'smoke' ? 2 : real);
  return [
    { name: 'baseline', count: n(cfg.baselineCount) },
    { name: 'cache-write', count: n(cfg.cacheWriteDistinct) },
    { name: 'cache-read', count: n(cfg.cacheReadRepeats) },
    { name: 'image', count: n(cfg.imageCount) },
  ];
}
function parseArgs(argv) {
  const out = { tier: 'smoke', gatewayUrl: 'http://localhost:3000', key: process.env.RECON_API_KEY, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') out.tier = 'full';
    else if (a === '--smoke') out.tier = 'smoke';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--gateway') out.gatewayUrl = argv[++i];
    else if (a === '--key') out.key = argv[++i];
  }
  return out;
}

// Thin I/O — not unit-tested; exercised by --smoke / --dry-run.
function httpJson(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(u, { method, headers: { 'content-type': 'application/json', ...(headers || {}) } }, (res) => {
      let data = ''; res.on('data', (d) => (data += d));
      res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('request timeout after 120s')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.key) { console.error('Missing RECON_API_KEY / --key'); process.exit(1); }
  const cfg = resolveConfig({});
  const authHeaders = { 'x-api-key': args.key };

  // Deployment gate (hard): the gateway must serve the target model.
  const models = await httpJson('GET', `${args.gatewayUrl}/v1/models`, authHeaders);
  const list = (models.json && (models.json.data || models.json)) || [];
  if (!isModelAvailable(list, cfg.model)) {
    console.error(`DEPLOYMENT GATE FAILED: ${cfg.model} not served by ${args.gatewayUrl}. ` +
      `Cross-check with: node cli-tools/sail-model-deploy.js  (SAP-side deployment list).`);
    process.exit(2);
  }

  const cells = planCells(cfg, args.tier);
  const usages = [];
  // The image is a fixed-dimension solid PNG, identical for every image request, so build it
  // once rather than re-encoding (and re-deflating ~w*h*3 bytes) on every iteration.
  const imagePngBase64 = makeSolidPng(cfg.imageWidth, cfg.imageHeight).toString('base64');
  for (const cell of cells) {
    console.log(`Cell ${cell.name}: ${cell.count} request(s)`);
    for (let i = 0; i < cell.count; i++) {
      let body;
      if (cell.name === 'baseline') body = buildBaselineRequest(cfg);
      else if (cell.name === 'cache-write') body = buildCacheWriteRequest(cfg, `w${Date.now()}-${i}`);
      else if (cell.name === 'cache-read') body = buildCacheReadRequest(cfg);
      else body = buildImageRequest(cfg, imagePngBase64);
      if (args.dryRun) continue;
      const res = await httpJson('POST', `${args.gatewayUrl}/anthropic/v1/messages`, authHeaders, body);
      if (res.status < 200 || res.status >= 300) {
        const bodySlice = res.json ? JSON.stringify(res.json).slice(0, 200) : '';
        console.warn(`  WARNING: ${cell.name} request ${i} got non-2xx status ${res.status}${bodySlice ? `: ${bodySlice}` : ''}`);
      }
      const u = (res.json && res.json.usage) || {};
      if (cell.name === 'cache-read') usages.push(u);
    }
    if (cell.name === 'cache-read' && !args.dryRun) {
      const hit = evalCacheHit(usages);
      if (!hit.hit) { console.error('CACHE-HIT SELF-CHECK FAILED: no cache_read_input_tokens > 0; cell void.'); process.exit(3); }
      console.log(`  cache-read self-check OK: ${hit.reads} cache-read tokens observed`);
    }
  }
  console.log('Profile run complete. Run the reporter after the SAP bill posts.');
}

if (require.main === module) { main().catch((e) => { console.error(e); process.exit(1); }); }

module.exports = {
  DEFAULT_CONFIG, resolveConfig, fillerText, imageTokens, makeSolidPng,
  buildBaselineRequest, buildImageRequest, buildCacheWriteRequest, buildCacheReadRequest,
  isModelAvailable, evalCacheHit, evalImageCapture, planCells, parseArgs,
};
