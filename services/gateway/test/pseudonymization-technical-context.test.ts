/**
 * Technical-context suppression (spec 2026-08-25-pseudonymization-precision, task 1).
 *
 * The incident this guards against: a request made almost entirely of BW/ABAP object
 * names and SQL masked 110 distinct values, saturating the prompt until the model began
 * inventing its own MASKED_ tokens. Every case below is a SHAPE taken from that payload,
 * never a value — the identifiers, ids, names and mail addresses here are synthetic.
 */
import {
  isTechnicalSpan,
  hasTriggerWord,
  hasPersonContext,
  EXEMPT_FROM_SUPPRESSION,
} from '../src/plugins/pseudonymization/detectors/technicalContext';
import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { DEFAULT_MASKING_CONFIG } from '../src/plugins/pseudonymization/defaultMaskingConfig';
import { MaskingConfig, EntityMatch } from '../src/plugins/pseudonymization/types';

/** Classify `span` at its first occurrence in `text` (defaults to the span alone). */
function classify(span: string, text?: string) {
  const haystack = text ?? span;
  const start = haystack.indexOf(span);
  expect(start).toBeGreaterThanOrEqual(0);
  return isTechnicalSpan(haystack, start, start + span.length);
}

describe('isTechnicalSpan — span shape', () => {
  it('vetoes SAP/BW object names', () => {
    expect(classify('ZPC_FICA_TRAN_DAILY').technical).toBe(true);
    expect(classify('RSPROCESS').technical).toBe(true);
    expect(classify('INFOAREA').technical).toBe(true);
    expect(classify('ZCA_C06').technical).toBe(true);
  });

  it('vetoes a 25-character uppercase request id', () => {
    expect(classify('DGCSH86VQSKEXIK70LO0HJI3A').technical).toBe(true);
  });

  it('vetoes camelCase and mixed identifier shapes', () => {
    expect(classify('getUserName')).toEqual({ technical: true, reason: 'camelCase' });
    expect(classify('Some_Value2')).toEqual({ technical: true, reason: 'identifier' });
  });

  it('leaves ordinary person names alone', () => {
    expect(classify('John Smith').technical).toBe(false);
    expect(classify('Ana Lucia Fernandez').technical).toBe(false);
  });

  // A name at the end of a sentence is followed by '.', which must NOT read as glue —
  // otherwise the most common position for a real name in prose is silently exempted.
  it('does not treat sentence-final punctuation as glue', () => {
    expect(classify('John Smith', 'The reviewer was John Smith.').technical).toBe(false);
    expect(classify('John Smith', 'The reviewer was John Smith, who signed off.').technical).toBe(false);
  });

  // A multi-token run is vetoed only when EVERY token is technical: the PROPN-run
  // heuristic glues neighbouring identifiers into one "name" ("DAILY RSPROCESS ZCUBE").
  it('vetoes a run made only of identifiers, but not a mixed run', () => {
    expect(classify('RSPROCESS INFOAREA DATASOURCE').technical).toBe(true);
    expect(classify('Anna RSPROCESS').technical).toBe(false);
  });

  // A short upper-case token is evidence for NOTHING: three characters cannot separate an
  // SAP namespace prefix from a person's initial. Treated as evidence, it cleared whole
  // identifier runs — an all-identifier run with one "ZFI" in it went back to being a
  // person, which is 46 masks on a 40-line BW listing.
  it('lets a short upper-case token ride along inside an identifier run', () => {
    expect(classify('RSPROCESS INFOAREA ZFI DGCSH86VQSKEXIK70LO0HJI3A').technical).toBe(true);
    expect(classify('ZCO BW RSPROCESS').technical).toBe(true);
    expect(classify('ZFI RSPROCESS ZCO').technical).toBe(true);
  });

  // …and it must not veto on its own either, or an initialled name stops masking.
  it('never vetoes on short upper-case tokens alone', () => {
    expect(classify('J. R. Smith', 'Dr. J. R. Smith signed the report.').technical).toBe(false);
    expect(classify('ZFI ZCO').technical).toBe(false);
    expect(classify('BW').technical).toBe(false);
  });
});

describe('isTechnicalSpan — surrounding context', () => {
  it('vetoes a Title-Case run inside a code fence', () => {
    const text = 'prose about Anna Schmidt\n\n```\nconst Rate Limiter = 1;\n```\n';
    expect(classify('Rate Limiter', text)).toEqual({ technical: true, reason: 'code-fence' });
    expect(classify('Anna Schmidt', text).technical).toBe(false);
  });

  it('vetoes a column name in a SQL statement but keeps a quoted literal', () => {
    const text = "SELECT NAME, MASKED FROM ZCA_C06 WHERE OWNER = 'Smith'";
    expect(classify('OWNER', text)).toEqual({ technical: true, reason: 'sql' });
    expect(classify('Smith', text).technical).toBe(false);
  });

  it('vetoes a JSON key but keeps the JSON value', () => {
    const text = '{ "customer": "Smith" }';
    expect(classify('customer', text)).toEqual({ technical: true, reason: 'json-key' });
    expect(classify('Smith', text).technical).toBe(false);
  });

  it('vetoes a span inside a URL', () => {
    expect(classify('Anna-Karenina', 'see https://example.invalid/Anna-Karenina for the list'))
      .toEqual({ technical: true, reason: 'url' });
  });

  it('vetoes a span inside a file path', () => {
    expect(classify('Alice', 'tail /var/log/Alice for the trace'))
      .toEqual({ technical: true, reason: 'path' });
  });

  it('vetoes a span glued to code punctuation', () => {
    expect(classify('Smith', 'Smith(x)')).toEqual({ technical: true, reason: 'glued' });
    expect(classify('Smith', 'Smith.Jones')).toEqual({ technical: true, reason: 'glued' });
    expect(classify('Jones', 'Smith.Jones')).toEqual({ technical: true, reason: 'glued' });
  });

  // The PROPN-run heuristic routinely cuts a run out of the middle of an underscore
  // identifier ("INFOAREA ZFI" out of "INFOAREA ZFI_GLOBAL"): the trailing '_' is the
  // only evidence left that the span is half of an object name.
  it('vetoes a span glued to an underscore identifier', () => {
    expect(classify('INFOAREA ZFI', 'against INFOAREA ZFI_GLOBAL today'))
      .toEqual({ technical: true, reason: 'glued' });
  });
});

describe('hasTriggerWord', () => {
  const words = ['license', 'licence', 'DL', 'driver'] as const;

  it('finds a trigger word before the match', () => {
    const text = 'license no. X12345678';
    expect(hasTriggerWord(text, text.indexOf('X12345678'), words)).toBe(true);
  });

  it('is false for a bare value with no trigger word', () => {
    const text = 'X12345678';
    expect(hasTriggerWord(text, 0, words)).toBe(false);
  });

  it('only looks backwards, and only inside the window', () => {
    const after = 'X12345678 is the license';
    expect(hasTriggerWord(after, 0, words)).toBe(false);

    const far = `license${' '.repeat(120)}X12345678`;
    expect(hasTriggerWord(far, far.indexOf('X12345678'), words)).toBe(false);
    expect(hasTriggerWord(far, far.indexOf('X12345678'), words, 200)).toBe(true);
  });

  it('requires a whole-word trigger, not a substring', () => {
    const text = 'handling ABC12345';
    expect(hasTriggerWord(text, text.indexOf('ABC12345'), words)).toBe(false);
  });
});

describe('hasPersonContext', () => {
  const noMatches: EntityMatch[] = [];

  it('is true near an honorific or a salutation', () => {
    const text = 'Dear Mr Torres, your Independent membership is noted.';
    const at = text.indexOf('Independent');
    expect(hasPersonContext(text, at, at + 'Independent'.length, noMatches)).toBe(true);
  });

  it('is true near a detected person', () => {
    const text = 'Miguel Torres is Independent.';
    const at = text.indexOf('Independent');
    const person: EntityMatch = {
      original: 'Miguel Torres', type: 'profile-person', start: 0, end: 13, priority: 2,
      confidence: 0.35,
    };
    expect(hasPersonContext(text, at, at + 'Independent'.length, [person])).toBe(true);
  });

  it('is false in technical prose with no person anywhere near', () => {
    const text = 'The Independent chain step ZPC_FICA_TRAN_DAILY reported state R.';
    const at = text.indexOf('Independent');
    expect(hasPersonContext(text, at, at + 'Independent'.length, noMatches)).toBe(false);
  });
});

describe('EXEMPT_FROM_SUPPRESSION', () => {
  it('never vetoes operator intent or checksum/format-validated PII', () => {
    for (const type of [
      'custom', 'profile-email', 'profile-ip-address', 'profile-url',
      'profile-iban', 'profile-credit-card-number', 'profile-ssn', 'profile-itin',
      // Operator-configured, one tier down: an org needs a configured legal-form suffix,
      // a location needs a literal from the gazetteer. Neither guesses.
      'profile-org', 'profile-location',
    ]) {
      expect(EXEMPT_FROM_SUPPRESSION.has(type)).toBe(true);
    }
  });

  it('does not exempt the categories the incident saturated', () => {
    expect(EXEMPT_FROM_SUPPRESSION.has('profile-person')).toBe(false);
    expect(EXEMPT_FROM_SUPPRESSION.has('profile-driverlicense')).toBe(false);
    expect(EXEMPT_FROM_SUPPRESSION.has('profile-political-group')).toBe(false);
  });

  // An email inside a code fence is still an email: exemption must beat the classifier.
  it('keeps an exempt type masked even in a technical context', () => {
    const text = '```\ncontact = "anna.schmidt@example.invalid"\n```';
    const found = detectEntities(text, { method: 'pseudonymization', entities: [{ type: 'profile-email' }] });
    expect(found.map(m => m.original)).toEqual(['anna.schmidt@example.invalid']);
  });

  // The whole set, pinned. A type dropped from it here fails loudly instead of silently
  // unmasking a category — which is exactly how credentials were lost in round 1: a
  // secret is opaque by construction, so the identifier and camelCase rules match every
  // well-formed one.
  it('is exactly this set', () => {
    expect([...EXEMPT_FROM_SUPPRESSION].sort()).toEqual([
      'custom',
      'profile-credit-card-number',
      'profile-email',
      'profile-iban',
      'profile-ip-address',
      'profile-itin',
      'profile-location',
      'profile-org',
      'profile-ssn',
      'profile-url',
      'profile-username-password',
    ]);
  });
});

/**
 * Credentials. Every shape below was masked before the classifier existed and must stay
 * masked: `SECRETVALUE` is an ALL-CAPS word, `MY_SECRET_KEY` an underscore identifier,
 * `correctHorseBatteryStaple` camelCase, `QZTVKNMRPLDGHBWJC742` a long opaque upper-case
 * run — the shape rules match all four, and a secret has no shape that does not look
 * technical.
 *
 * The opaque case is a 20-character access-key SHAPE, not AWS's `AKIA…` documentation
 * value: a literal beginning `AKIA` trips secret scanners wherever this repo is pushed,
 * and the rule under test is the length/character class, not the prefix.
 */
describe('credentials survive the classifier', () => {
  const credsOnly: MaskingConfig = {
    method: 'pseudonymization',
    entities: [{ type: 'profile-username-password' }],
  };

  const cases: Array<[string, string]> = [
    ['password: SECRETVALUE', 'SECRETVALUE'],
    ['password: MY_SECRET_KEY', 'MY_SECRET_KEY'],
    ['token: QZTVKNMRPLDGHBWJC742', 'QZTVKNMRPLDGHBWJC742'],
    ['apiKey: abc123DEF456ghi789JKL', 'abc123DEF456ghi789JKL'],
    ['password: correctHorseBatteryStaple', 'correctHorseBatteryStaple'],
    ['password=SECRETVALUE', 'SECRETVALUE'],
    ['{"password": "SECRETVALUE"}', 'SECRETVALUE'],
    ['Bearer ABCDEFGHIJKLMNOP', 'ABCDEFGHIJKLMNOP'],
  ];

  it.each(cases)('masks the secret in %s', (text, secret) => {
    const found = detectEntities(text, credsOnly);
    expect(found.map(m => `${m.original}[${m.type}]`))
      .toContain(`${secret}[profile-username-password]`);
  });

  // Type matters as much as the mask: with the person tier also on, the credential rule
  // must win the span. A Bearer token masked as MASKED_PERSON is a wrong-category leak.
  it('claims a Bearer token as a credential, not as a person', () => {
    const both: MaskingConfig = {
      method: 'pseudonymization',
      entities: [{ type: 'profile-username-password' }, { type: 'profile-person' }],
    };
    const found = detectEntities('Bearer ABCDEFGHIJKLMNOP', both);
    expect(found.map(m => `${m.original}[${m.type}]`))
      .toEqual(['ABCDEFGHIJKLMNOP[profile-username-password]']);
  });
});

/**
 * The dictionary person-context gate, pinned where it actually matters. Asserting the
 * helper alone left the gate itself inert: emptying PERSON_CONTEXT_REQUIRED kept the suite
 * green.
 */
describe('political-group needs a person nearby', () => {
  const config: MaskingConfig = {
    method: 'pseudonymization',
    entities: [{ type: 'profile-political-group' }, { type: 'profile-person' }],
  };

  it('does not mask an ordinary word used technically', () => {
    const found = detectEntities('The release is Independent of the build chain.', config);
    expect(found.filter(m => m.type === 'profile-political-group')).toEqual([]);
  });

  it('masks the same word next to a person', () => {
    const found = detectEntities('Mr Smith is Independent.', config);
    expect(found.map(m => `${m.original}[${m.type}]`))
      .toContain('Independent[profile-political-group]');
  });
});

/**
 * The end-to-end proof. Synthetic text with the incident's shape: 40 distinct SAP/BW
 * identifiers (object names, table names, 25-char request ids), 6 SQL statements, a JSON
 * payload — and exactly three names plus two mail addresses of real PII.
 */
const SAP_IDENTIFIERS = [
  'ZPC_FICA_TRAN_DAILY', 'ZPC_FICA_TRAN_HOURLY', 'ZPC_FICA_LOAD_DELTA', 'ZPC_SD_BILLING_DAILY',
  'ZPC_MM_STOCK_NIGHTLY', 'ZDSO_FICA_ITEMS', 'ZDSO_SD_ORDERS', 'ZDSO_MM_STOCK',
  'ZCUBE_FICA_TOTALS', 'ZMPRO_FICA_VIEW', 'ZTRAN_FICA_STAGE', 'ZTRAN_SD_STAGE',
  'ZCA_C06', 'ZFI_GLOBAL', 'ZSD_C01', 'ZMM_D02',
  'RSPROCESS', 'RSPCPROCESSLOG', 'RSPCCHAIN', 'RSPCLOGCHAIN', 'RSBKREQUEST', 'RSMONICDP',
  'INFOAREA', 'INFOPROV', 'INFOOBJECT', 'DATASOURCE', 'REQUID', 'DATAPAKID',
  'ZBW_DELTA_QUEUE_MONITOR', 'ZBW_CHAIN_RESTART_LOG',
  'DGCSH86VQSKEXIK70LO0HJI3A', 'QWMTP41BZLNFUJRK92XVYCDA7', 'HRKZD05WNQBTGXLMCE83VFPUJ',
  'NBVXQ72YRLTMWKJH64ZFDSPCA', 'LTFJB39XKWZQNRMPVH51CDGYU', 'PWSCK84MGVDXJTLRQZ26NBHYF',
  'YDNRM60HFQXKPLZWJB93CTVSG', 'KJQVT58BNZMHLXPWRD17FGCYS', 'MZXHC29TRVGKNDQLPS74BWJFY',
  'VGTLP73CKWYNMBXQZH08RDFJS',
];

const EXPECTED_PII = [
  'Anna Schmidt', 'Miguel Torres', 'Priya Raman',
  'anna.schmidt@example.invalid', 'miguel.torres@example.invalid',
];

const INCIDENT_SHAPED_TEXT = [
  'process chain review for the nightly load',
  '',
  'the chain ZPC_FICA_TRAN_DAILY failed again in RSPROCESS overnight, and the delta',
  'queue behind ZDSO_FICA_ITEMS is still filling. run ids were taken from',
  'RSPCPROCESSLOG and cross-checked against INFOAREA ZFI_GLOBAL, then against',
  'INFOPROV ZCUBE_FICA_TOTALS and DATASOURCE ZTRAN_FICA_STAGE.',
  '',
  'RSPCPROCESSLOG dump, columns are chain / process / infoprov / requid / state:',
  '',
  'ZPC_FICA_TRAN_DAILY RSPROCESS ZCUBE_FICA_TOTALS DGCSH86VQSKEXIK70LO0HJI3A R',
  'ZPC_FICA_TRAN_HOURLY RSPROCESS ZMPRO_FICA_VIEW QWMTP41BZLNFUJRK92XVYCDA7 G',
  'ZPC_FICA_LOAD_DELTA RSBKREQUEST ZDSO_FICA_ITEMS HRKZD05WNQBTGXLMCE83VFPUJ R',
  'ZPC_SD_BILLING_DAILY RSPCCHAIN ZDSO_SD_ORDERS NBVXQ72YRLTMWKJH64ZFDSPCA G',
  'ZPC_MM_STOCK_NIGHTLY RSPCLOGCHAIN ZDSO_MM_STOCK LTFJB39XKWZQNRMPVH51CDGYU X',
  'ZPC_FICA_TRAN_DAILY RSMONICDP ZTRAN_SD_STAGE PWSCK84MGVDXJTLRQZ26NBHYF R',
  'ZPC_FICA_LOAD_DELTA RSPROCESS ZCA_C06 YDNRM60HFQXKPLZWJB93CTVSG G',
  'ZPC_SD_BILLING_DAILY RSPROCESS ZSD_C01 KJQVT58BNZMHLXPWRD17FGCYS R',
  'ZPC_MM_STOCK_NIGHTLY RSBKREQUEST ZMM_D02 MZXHC29TRVGKNDQLPS74BWJFY G',
  'ZPC_FICA_TRAN_HOURLY RSPROCESS INFOOBJECT VGTLP73CKWYNMBXQZH08RDFJS X',
  '',
  'monitor objects: ZBW_DELTA_QUEUE_MONITOR ZBW_CHAIN_RESTART_LOG REQUID DATAPAKID',
  '',
  'statements that were executed during the analysis:',
  '',
  "SELECT REQUID, DATAPAKID, RECORD FROM ZDSO_FICA_ITEMS WHERE REQUID = 'DGCSH86VQSKEXIK70LO0HJI3A';",
  "SELECT CHAIN_ID, VARIANTE, TYPE FROM RSPCCHAIN WHERE CHAIN_ID = 'ZPC_FICA_TRAN_DAILY';",
  "UPDATE RSPCPROCESSLOG SET STATE = 'R' WHERE LOGID = 'QWMTP41BZLNFUJRK92XVYCDA7';",
  'DELETE FROM ZTRAN_FICA_STAGE WHERE REQUID IN (SELECT REQUID FROM RSBKREQUEST);',
  "SELECT INFOPROV, INFOAREA FROM ZCUBE_FICA_TOTALS WHERE INFOAREA = 'ZFI_GLOBAL';",
  "INSERT INTO ZBW_CHAIN_RESTART_LOG (CHAIN_ID, STATE) VALUES ('ZPC_MM_STOCK_NIGHTLY', 'X');",
  '',
  'the monitor payload that came back looked like this:',
  '',
  '{',
  '  "chain": "ZPC_FICA_TRAN_DAILY",',
  '  "process": "RSPROCESS",',
  '  "requid": "HRKZD05WNQBTGXLMCE83VFPUJ",',
  '  "state": "R",',
  '  "infoarea": "ZFI_GLOBAL"',
  '}',
  '',
  'Anna Schmidt owns the chain and wants the restart scheduled before the close.',
  'Miguel Torres already restarted the delta queue once and it failed the same way.',
  'Priya Raman is on call tonight and will watch the second attempt.',
  '',
  'reach anna.schmidt@example.invalid or miguel.torres@example.invalid with the outcome.',
].join('\n');

describe('incident-shaped request', () => {
  const config: MaskingConfig = DEFAULT_MASKING_CONFIG;

  it('carries 40 distinct SAP identifiers', () => {
    expect(new Set(SAP_IDENTIFIERS).size).toBe(40);
  });

  it('masks exactly the names and the mail addresses', () => {
    const values = detectEntities(INCIDENT_SHAPED_TEXT, config).map(m => m.original);
    expect([...new Set(values)].sort()).toEqual([...EXPECTED_PII].sort());
  });

  it('masks no SAP identifier and no SQL keyword', () => {
    const values = detectEntities(INCIDENT_SHAPED_TEXT, config).map(m => m.original);
    for (const id of SAP_IDENTIFIERS) {
      expect(values.some(v => v.includes(id))).toBe(false);
    }
    for (const keyword of ['SELECT', 'UPDATE', 'INSERT', 'DELETE', 'FROM', 'WHERE']) {
      expect(values.some(v => v.includes(keyword))).toBe(false);
    }
  });
});
