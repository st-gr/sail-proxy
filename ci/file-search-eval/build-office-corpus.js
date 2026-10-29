#!/usr/bin/env node
/**
 * Builds the Office part of the file_search evaluation corpus: one PowerPoint deck and one Excel
 * workbook about an invented cold-chain operator. Every name, place and figure in them is made up,
 * so no passage repeats anything in the documentation chapters and each answer has one file.
 *
 * The files are written by this script byte for byte, with no Office application or library: a
 * stored (uncompressed) zip with fixed dates holding the parts file_search reads (presentation,
 * slides, notes; workbook, sheets, shared strings, styles). They are not complete Office packages
 * (no slide masters, layouts or themes), so PowerPoint may refuse to open the deck; the gateway's
 * reader needs none of those parts. Two runs, on any machine and Node version, give identical bytes.
 *
 * Usage: node ci/file-search-eval/build-office-corpus.js
 *   writes corpus/pptx/*.pptx and corpus/xlsx/*.xlsx and replaces their entries in corpus/manifest.json
 *   (build-corpus.js calls officeFiles() as part of a full rebuild).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'corpus');
const SOURCE = 'ci/file-search-eval/build-office-corpus.js';
const OFFICE_KINDS = ['pptx', 'xlsx'];

// ---------------------------------------------------------------------------------------------
// A stored zip with fixed dates
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [[name, string]] in order -> zip bytes (method 0, DOS date 1980-01-01 00:00). */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time 00:00
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_DOCREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_TYPE = (t) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;

function rels(list) {
  return `${XML}<Relationships xmlns="${NS_REL}">${list.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${REL_TYPE(type)}" Target="${esc(target)}"/>`).join('')}</Relationships>`;
}

function contentTypes(defaults, overrides) {
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('')
    + overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')
    + '</Types>';
}

// ---------------------------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------------------------

const DECK_FILE = 'pptx/quillmere-operations-review.pptx';

/** title, body: paragraphs (a string with \n = line breaks in one paragraph), table, notes, hidden. */
const SLIDES = [
  { title: 'Quillmere Cold Chain: operations review', body: ['Autumn planning cycle', 'Prepared by the network planning desk'] },
  { title: 'Agenda', body: ['Temperature control', 'Depot capacity', 'Fleet', 'Packaging', 'Alarm handling', 'Customer service levels'] },
  {
    title: 'Temperature excursions',
    body: [
      'Reefer units at Kestrel Yard logged 14 excursions above 8 °C this cycle, all of them shorter than 20 minutes.',
      'Most excursions started while trailers waited at dock door 6 with the door seal deflated.',
    ],
    notes: ['The probe recalibration interval moved from 90 to 45 days after the second cold-room audit.'],
  },
  {
    title: 'Depot capacity',
    body: ['Dock doors and peak throughput per depot:'],
    table: [
      ['Depot', 'Dock doors', 'Peak pallets per hour'],
      ['Kestrel Yard', '18', '240'],
      ['Feldspar Depot', '11', '150'],
      ['Marrow Point', '7', '95'],
    ],
    notes: ['Marrow Point closes its night shift during the winter thaw because the access road floods.'],
  },
  { title: 'Part two: fleet and packaging', body: [] },
  {
    title: 'Fleet electrification',
    body: [
      'Six of the forty-two tractor units now run on battery packs charged overnight at Feldspar Depot.',
      'Range on the coastal loop stays above 310 km with the reefer running.',
    ],
  },
  {
    hidden: true,
    title: 'Draft: canal barge pilot',
    body: ['The canal barge pilot was paused because the lock schedule allowed only two crossings per day.'],
  },
  {
    title: 'Packaging',
    body: [
      'Insulated totes made from pressed straw replaced polystyrene boxes on the pharmacy routes.',
      'A tote keeps vaccines between 2 and 8 °C for 36 hours\nwith two frozen gel bricks in the lid pocket.',
    ],
  },
  {
    title: 'Door alarm escalation',
    body: [
      'Every cold-room door alarm escalates to the duty phone after 4 minutes and to the regional desk after 12 minutes.',
      'A silenced alarm re-arms itself after 30 minutes.',
    ],
    notes: ['Alarm tests run every second Tuesday at 05:40, before the first outbound wave.'],
  },
  {
    title: 'Customer service levels',
    table: [
      ['Route family', 'On-time delivery', 'Temperature compliance'],
      ['Pharmacy', '97.8%', '99.6%'],
      ['Grocery', '94.1%', '98.9%'],
      ['Florist', '91.5%', '97.2%'],
    ],
  },
  {
    title: 'Next steps',
    body: [
      'Fit door-seal pressure sensors at Kestrel Yard before the spring peak.',
      'Trial a fourth shift pattern at Feldspar Depot with staggered break windows.',
    ],
  },
  {
    title: 'Questions',
    body: [],
    notes: ['The review closes with the depot leads voting on the winter staffing rota by a show of hands.'],
  },
];

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

function paragraphs(texts) {
  return texts.map((t) => `<a:p>${t.split('\n').map((line, i) =>
    `${i ? '<a:br/>' : ''}<a:r><a:rPr lang="en-GB"/><a:t>${esc(line)}</a:t></a:r>`).join('')}</a:p>`).join('');
}

function shape(id, name, placeholder, texts) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr>`
    + `${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs(texts)}</p:txBody></p:sp>`;
}

function tableFrame(id, rows) {
  const cols = rows[0].map(() => '<a:gridCol w="2438400"/>').join('');
  const body = rows.map((row) => `<a:tr h="370840">${row.map((cell) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs([cell])}</a:txBody><a:tcPr/></a:tc>`).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr/><p:nvPr/>`
    + '</p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="7315200" cy="1483360"/></p:xfrm>'
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid>${cols}</a:tblGrid>`
    + `${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slideXml(slide) {
  const shapes = [shape(2, 'Title', 'title', [slide.title])];
  if (slide.body && slide.body.length) shapes.push(shape(3, 'Content', 'body', slide.body));
  if (slide.table) shapes.push(tableFrame(4, slide.table));
  return `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_DOCREL}" xmlns:p="${NS_P}"${slide.hidden ? ' show="0"' : ''}>`
    + '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + `${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(notes) {
  return `${XML}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_DOCREL}" xmlns:p="${NS_P}"><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + `${shape(2, 'Slide Image', 'sldImg', [])}${shape(3, 'Notes', 'body', notes)}</p:spTree></p:cSld></p:notes>`;
}

function buildDeck() {
  const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
  const parts = [];
  const overrides = [['/ppt/presentation.xml', `${PML}.presentation.main+xml`]];
  SLIDES.forEach((slide, i) => {
    const n = i + 1;
    overrides.push([`/ppt/slides/slide${n}.xml`, `${PML}.slide+xml`]);
    if (slide.notes) overrides.push([`/ppt/notesSlides/notesSlide${n}.xml`, `${PML}.notesSlide+xml`]);
  });
  parts.push(['[Content_Types].xml', contentTypes([
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml'],
  ], overrides)]);
  parts.push(['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])]);
  parts.push(['ppt/presentation.xml', `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_DOCREL}" xmlns:p="${NS_P}">`
    + `<p:sldIdLst>${SLIDES.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>`
    + '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>']);
  parts.push(['ppt/_rels/presentation.xml.rels', rels(SLIDES.map((_, i) => [`rId${i + 1}`, 'slide', `slides/slide${i + 1}.xml`]))]);
  SLIDES.forEach((slide, i) => {
    const n = i + 1;
    parts.push([`ppt/slides/slide${n}.xml`, slideXml(slide)]);
    if (slide.notes) {
      parts.push([`ppt/slides/_rels/slide${n}.xml.rels`, rels([['rId1', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]])]);
      parts.push([`ppt/notesSlides/notesSlide${n}.xml`, notesXml(slide.notes)]);
    }
  });
  return storedZip(parts);
}

// ---------------------------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------------------------

const BOOK_FILE = 'xlsx/quillmere-maintenance-ledger.xlsx';

/** Excel's 1900 date serial of a UTC date. */
const serial = (iso) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const date = (iso) => ({ n: serial(iso), s: 1 });
const percent = (v) => ({ n: v, s: 2 });

/** Cells: a string, a number, or {n, s} (a number with a cell style: 1 = date, 2 = percent). */
const SHEETS = [
  {
    name: 'Work orders',
    rows: [
      ['Order', 'Asset', 'Task', 'Opened', 'Hours', 'Parts cost'],
      ['WO-2201', 'CR-01', 'Defrost evaporator coil in cold room 1 and clear the drain line', date('2026-02-03'), 2.5, 118.4],
      ['WO-2202', 'TR-17', 'Replace cracked reefer fan blade on trailer 17', date('2026-02-05'), 1.75, 264],
      ['WO-2203', 'DD-06', 'Re-inflate and patch the dock door 6 seal bladder', date('2026-02-11'), 3, 89.9],
      ['WO-2204', 'FL-03', 'Swap the forklift 3 battery for the spare from bay K', date('2026-02-12'), 0.5, 0],
      ['WO-2205', 'CR-03', 'Replace door gasket on cold room 3 after frost build-up on the hinge side', date('2026-03-14'), 3.5, 412.8],
      ['WO-2206', 'CH-02', 'Top up glycol in chiller 2 and log the refractometer reading', date('2026-03-19'), 1, 57.25],
      ['WO-2207', 'TR-09', 'Calibrate the trailer 9 data logger against the reference probe', date('2026-04-02'), 0.75, 0],
      ['WO-2208', 'CR-05', 'Seal the conduit gap above cold room 5 where moisture entered the ceiling panel', date('2026-04-21'), 4.25, 176.6],
      ['WO-2209', 'GN-01', 'Load-test the standby generator for ninety minutes at seventy percent', date('2026-05-06'), 2, 0],
      ['WO-2210', 'DD-02', 'Adjust the dock leveller lip on door 2 that scraped pallet bases', date('2026-05-15'), 1.5, 33.1],
    ],
  },
  {
    name: 'Spare parts',
    rows: [
      ['Part code', 'Description', 'Bin', 'On hand', 'Reorder at'],
      ['SP-114', 'Evaporator fan motor, 230 V, reversible shaft', 'K-04', 3, 2],
      ['SP-131', 'Door gasket, magnetic, 2.1 m, food-safe grey', 'K-11', 6, 4],
      ['SP-140', 'Glycol concentrate, 20 litre drum', 'Yard shed', 9, 5],
      ['SP-152', 'Seal bladder patch kit for dock shelters', 'K-02', 12, 6],
      ['SP-167', 'Reference temperature probe, certified to 0.1 °C', 'Safe', 2, 1],
    ],
  },
  {
    name: 'Surcharges',
    rows: [
      ['Region', 'Fuel surcharge', 'Night delivery surcharge'],
      ['Coastal loop', percent(0.0625), percent(0.04)],
      ['Upland routes', percent(0.081), percent(0.055)],
      ['Island ferry', percent(0.112), percent(0.09)],
    ],
  },
  {
    name: 'Archive 2025',
    hidden: true,
    rows: [
      ['Note'],
      ['The old ammonia plant at Marrow Point was decommissioned and its machine room now stores pallet wrap.'],
    ],
  },
];

const column = (i) => String.fromCharCode(65 + i);

function buildBook() {
  const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const shared = [];
  const index = new Map();
  const sharedId = (s) => {
    if (!index.has(s)) { index.set(s, shared.length); shared.push(s); }
    return index.get(s);
  };
  const sheetXml = (sheet) => {
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      const ref = `${column(c)}${r + 1}`;
      if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${sharedId(v)}</v></c>`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${v.s}"><v>${v.n}</v></c>`;
    }).join('')}</row>`).join('');
    return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_DOCREL}">`
      + `<sheetData>${rows}</sheetData></worksheet>`;
  };
  const sheets = SHEETS.map(sheetXml); // fills the shared strings in sheet order
  const parts = [];
  parts.push(['[Content_Types].xml', contentTypes([
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml'],
  ], [
    ['/xl/workbook.xml', `${SML}.sheet.main+xml`],
    ...SHEETS.map((_, i) => [`/xl/worksheets/sheet${i + 1}.xml`, `${SML}.worksheet+xml`]),
    ['/xl/sharedStrings.xml', `${SML}.sharedStrings+xml`],
    ['/xl/styles.xml', `${SML}.styles+xml`],
  ])]);
  parts.push(['_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']])]);
  parts.push(['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_DOCREL}"><sheets>`
    + SHEETS.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>']);
  const n = SHEETS.length;
  parts.push(['xl/_rels/workbook.xml.rels', rels([
    ...SHEETS.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]),
    [`rId${n + 1}`, 'sharedStrings', 'sharedStrings.xml'],
    [`rId${n + 2}`, 'styles', 'styles.xml'],
  ])]);
  sheets.forEach((xml, i) => parts.push([`xl/worksheets/sheet${i + 1}.xml`, xml]));
  parts.push(['xl/sharedStrings.xml', `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">`
    + shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + '</sst>']);
  // Cell styles: 0 general, 1 date (built-in format 14), 2 percent with two decimals (built-in 10).
  parts.push(['xl/styles.xml', `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="10" applyNumberFormat="1"/></cellXfs>'
    + '</styleSheet>']);
  return storedZip(parts);
}

/** The Office corpus files: [{ file, source, kind, bytes }]. */
function officeFiles() {
  return [
    { file: DECK_FILE, source: SOURCE, kind: 'pptx', bytes: buildDeck() },
    { file: BOOK_FILE, source: SOURCE, kind: 'xlsx', bytes: buildBook() },
  ];
}

/** Writes the Office files and replaces their manifest entries; the other entries stay as they are. */
function main() {
  const manifestFile = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).filter((e) => !OFFICE_KINDS.includes(e.kind));
  for (const kind of OFFICE_KINDS) fs.rmSync(path.join(OUT, kind), { recursive: true, force: true });
  for (const { file, source, kind, bytes } of officeFiles()) {
    const target = path.join(OUT, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    manifest.push({ file, source, kind, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    console.log(`${kind.padEnd(8)} ${file} (${bytes.length} bytes)`);
  }
  manifest.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { officeFiles, OFFICE_KINDS, SOURCE, crc32, storedZip };
