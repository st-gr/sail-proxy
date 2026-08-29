/**
 * The labelled corpus for the precision/recall evaluation harness
 * (spec 2026-08-25-pseudonymization-precision, task 4).
 *
 * Three sets, mined from the payload-log SHAPES of the 2026-08-25 saturation incident and
 * from the task 1-3 test suites that fixed it — never from a payload log itself. Every
 * identifier, name, mail address, phone number, IBAN and credential here is synthetic;
 * every domain is `.invalid`.
 *
 *   - `technical`  — SAP/BW object names, SQL, JSON, logs, paths, code fences: the
 *     machinery the incident's request was built from, scored for PRECISION. A few of
 *     these documents carry real PII too (an email inside a JSON payload, a name in a
 *     quoted SQL literal) so precision is a meaningful ratio and not division by zero.
 *   - `prose`      — names, emails, phones, addresses and credentials as they appear in
 *     ordinary requests: sentences, tables, CSV, bullets, signatures, chat, saturated
 *     rosters. Scored for RECALL.
 *   - `mixed`      — the incident's own shape: a request built almost entirely of
 *     technical noise with a small number of real people in it. Used for the combined
 *     precision+recall check and the wall-time budget.
 *
 * A case's `labels` list every span that SHOULD be masked, with the entity type a correct
 * detector would give it. A span the detector fires that is NOT in `labels` is a false
 * positive; a labelled span the detector misses is a false negative — see scorer.ts.
 *
 * Two label policies, both deliberate:
 *
 *   1. A label is present whenever the span is GENUINELY someone's personal data, even
 *      where the shipped detector is known to miss it (a name inside a code fence, a path,
 *      or split by a double space). Missing it costs RECALL, never precision, so labelling
 *      it honestly documents the gap without breaking the technical-set precision gate.
 *      Every such case below is commented with why it is expected to miss.
 *   2. A Title-Case product name (`Watson Studio`, `Redis Sentinel`) or an ordinary noun
 *      phrase (`Data Transfer Process`) is labelled NOT PII — i.e. left out of `labels`
 *      entirely — even on the cases where today's detector masks it anyway. That is the
 *      precision cost the coordinator asked to be recorded honestly rather than hidden by
 *      curating it out of the corpus.
 */

export interface EntityLabel {
  start: number;
  end: number;
  type: string;
  value: string;
}

export interface CorpusCase {
  id: string;
  text: string;
  labels: EntityLabel[];
  /** Why a labelled span is expected to be missed today, when that is the point of the case. */
  note?: string;
}

export interface CorpusSet {
  name: 'technical' | 'prose' | 'mixed';
  cases: CorpusCase[];
}

/**
 * Label the span at the `occurrence`-th (0-based) occurrence of `value` in `text`.
 * Throws if `value` is not found — a corpus case with a label that does not match its own
 * text is a bug in the corpus, and it must fail loudly rather than silently score wrong.
 */
export function at(text: string, value: string, type: string, occurrence = 0): EntityLabel {
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(value, idx + 1);
    if (idx < 0) {
      throw new Error(`corpus label not found (occurrence ${occurrence}): ${JSON.stringify(value)} in ${JSON.stringify(text)}`);
    }
  }
  return { start: idx, end: idx + value.length, type, value };
}

// ---------------------------------------------------------------------------------------
// technical set — scored for PRECISION
// ---------------------------------------------------------------------------------------

const T_JSON_1 = [
  '{',
  '  "chain": "ZPC_FICA_TRAN_DAILY",',
  '  "requestId": "DGCSH86VQSKEXIK70LO0HJI3A",',
  '  "customer": {',
  '    "name": "Miguel Torres",',
  '    "email": "miguel.torres@example.invalid",',
  '    "phone": "+1 (555) 010-4477"',
  '  }',
  '}',
].join('\n');

const T_JSON_2 = '{ "owner": "Priya Raman", "iban": "DE89 3704 0044 0532 0130 00", "note": "chain ZPC_MM_STOCK_NIGHTLY" }';

const T_JSON_3 = '{ "audit": "ZBW_DELTA_QUEUE_MONITOR", "reviewer": "Ana Ruiz", "email": "ana.ruiz@example.invalid" }';

const T_EMAIL_JSON = '{"contact": "reachable at anna.schmidt@example.invalid for the incident ZPC_FICA_TRAN_HOURLY"}';

const T_SQL_UPPER = "SELECT NAME, EMAIL FROM ZCUSTOMER_MASTER WHERE NAME = 'Elena Ruiz' AND EMAIL = 'elena.ruiz@example.invalid';";

const T_SQL_UPPER_2 = "UPDATE ZDSO_SD_ORDERS SET OWNER = 'Miguel Torres', CONTACT = 'miguel.torres@example.invalid' WHERE ID = 42;";

const T_SQL_LOWER_UNQUOTED = 'select name from Ferreira Nakamura where id = 1';

const T_SQL_LOWER_QUOTED = "update zca_c06 set owner = 'Elena Nakamura' where id = 1";

const T_LOG_SINGLE = '2026-08-24 09:12:01 INFO chain=ZPC_FICA_TRAN_DAILY owner: Anna Schmidt request=DGCSH86VQSKEXIK70LO0HJI3A';

// Double space inside the NAME itself (not merely after the log level): wink-nlp's
// tokeniser drops the PROPN run entirely when it is split by a double space, so this is a
// genuine RECALL loss — task 2/3 flagged it as harness input, this is where it lands.
// A single space (T_LOG_SINGLE, above) is unaffected.
const T_LOG_DOUBLE = '2026-08-24 09:12:05 INFO  chain=ZPC_SD_BILLING_DAILY  owner: Miguel  Torres  request=QWMTP41BZLNFUJRK92XVYCDA7';

const T_LOG_2 = '2026-08-24 09:15:22 INFO chain=ZDSO_MM_STOCK owner: Priya Raman request=LTFJB39XKWZQNRMPVH51CDGYU';

const T_LOG_CRED = '2026-08-24 09:12:09 WARN password: SECRETVALUE for service account svc-fica';

// A name embedded in a path/URL: task 1's classifier vetoes the span on purpose (a name
// INSIDE machinery is not provably a value about a person), which is a documented
// recall trade-off, not a bug. Labelled so the harness reports the cost rather than
// hiding it.
const T_PATH = 'tail /var/log/Alice for the trace';

const T_URL = 'See https://example.invalid/profile/Priya-Raman for details.';

const T_FENCE_PROSE = 'prose about Anna Schmidt\n\n```\nconst Rate Limiter = 1;\n```\n';

// Same trade-off as T_PATH: a name inside a fenced code block is vetoed by design.
const T_FENCE_NAME = '```\nDear Ferreira Nakamura, please review.\n```';

const T_PRODUCT_DOWNLOAD = 'Download Watson Studio from https://example.invalid/dl today.';

const T_PRODUCT_2 = 'Redis Sentinel handled the failover automatically.';

const TECHNICAL_SET: CorpusSet = {
  name: 'technical',
  cases: [
    {
      id: 'sap-bw-identifier-run',
      text: 'RSPROCESS INFOAREA ZFI DGCSH86VQSKEXIK70LO0HJI3A',
      labels: [],
    },
    {
      id: 'sap-bw-object-name',
      text: 'the chain ZPC_FICA_TRAN_DAILY failed again overnight in RSPROCESS.',
      labels: [],
    },
    {
      id: 'title-case-business-phrase-1',
      text: 'The Data Transfer Process failed overnight.',
      labels: [],
    },
    {
      id: 'title-case-business-phrase-2',
      text: 'ZPC_FICA_TRAN_DAILY RSPROCESS Process Chain FICA DGCSH86VQSKEXIK70LO0HJI3A R',
      labels: [],
    },
    {
      id: 'json-payload-1',
      text: T_JSON_1,
      labels: [
        at(T_JSON_1, 'Miguel Torres', 'profile-person'),
        at(T_JSON_1, 'miguel.torres@example.invalid', 'profile-email'),
        at(T_JSON_1, '+1 (555) 010-4477', 'profile-phone'),
      ],
    },
    {
      id: 'json-payload-2',
      text: T_JSON_2,
      labels: [
        at(T_JSON_2, 'Priya Raman', 'profile-person'),
        at(T_JSON_2, 'DE89 3704 0044 0532 0130 00', 'profile-iban'),
      ],
    },
    {
      id: 'json-payload-3',
      text: T_JSON_3,
      labels: [
        at(T_JSON_3, 'Ana Ruiz', 'profile-person'),
        at(T_JSON_3, 'ana.ruiz@example.invalid', 'profile-email'),
      ],
    },
    {
      id: 'json-email-value',
      text: T_EMAIL_JSON,
      labels: [at(T_EMAIL_JSON, 'anna.schmidt@example.invalid', 'profile-email')],
    },
    {
      id: 'sql-upper-quoted-literals',
      text: T_SQL_UPPER,
      labels: [
        at(T_SQL_UPPER, 'Elena Ruiz', 'profile-person'),
        at(T_SQL_UPPER, 'elena.ruiz@example.invalid', 'profile-email'),
      ],
    },
    {
      id: 'sql-upper-quoted-literals-2',
      text: T_SQL_UPPER_2,
      labels: [
        at(T_SQL_UPPER_2, 'Miguel Torres', 'profile-person'),
        at(T_SQL_UPPER_2, 'miguel.torres@example.invalid', 'profile-email'),
      ],
    },
    {
      id: 'sql-lower-unquoted-table-position',
      text: T_SQL_LOWER_UNQUOTED,
      labels: [at(T_SQL_LOWER_UNQUOTED, 'Ferreira Nakamura', 'profile-person')],
      note: 'lower-case SQL, name unquoted in table position — no data-literal bonus, scores '
        + '0.35 < 0.5 default threshold. Expected miss (recall only, does not affect precision).',
    },
    {
      id: 'sql-lower-quoted-literal',
      text: T_SQL_LOWER_QUOTED,
      labels: [at(T_SQL_LOWER_QUOTED, 'Elena Nakamura', 'profile-person')],
    },
    {
      id: 'log-line-single-space',
      text: T_LOG_SINGLE,
      labels: [at(T_LOG_SINGLE, 'Anna Schmidt', 'profile-person')],
    },
    {
      id: 'log-line-double-space',
      text: T_LOG_DOUBLE,
      labels: [at(T_LOG_DOUBLE, 'Miguel  Torres', 'profile-person')],
      note: 'double space INSIDE the name — wink-nlp drops the PROPN run entirely. Expected '
        + 'miss (recall only); see the module doc comment above T_LOG_DOUBLE.',
    },
    {
      id: 'log-line-labelled-field',
      text: T_LOG_2,
      labels: [at(T_LOG_2, 'Priya Raman', 'profile-person')],
    },
    {
      id: 'log-line-credential',
      text: T_LOG_CRED,
      labels: [at(T_LOG_CRED, 'SECRETVALUE', 'profile-username-password')],
    },
    {
      id: 'name-inside-path',
      text: T_PATH,
      labels: [at(T_PATH, 'Alice', 'profile-person')],
      note: 'name inside a file path — vetoed by task 1s classifier (reason: path). Expected '
        + 'miss (recall only); a deliberate trade-off, not a bug.',
    },
    {
      id: 'url-with-name-slug',
      text: T_URL,
      labels: [at(T_URL, 'https://example.invalid', 'profile-url')],
    },
    {
      id: 'code-fence-with-prose-name',
      text: T_FENCE_PROSE,
      labels: [at(T_FENCE_PROSE, 'Anna Schmidt', 'profile-person')],
    },
    {
      id: 'code-fence-with-name-inside',
      text: T_FENCE_NAME,
      labels: [at(T_FENCE_NAME, 'Ferreira Nakamura', 'profile-person')],
      note: 'name inside a code fence — vetoed by task 1s classifier (reason: code-fence). '
        + 'Expected miss (recall only); a deliberate trade-off, not a bug.',
    },
    {
      id: 'product-name-download-sentence',
      text: T_PRODUCT_DOWNLOAD,
      labels: [at(T_PRODUCT_DOWNLOAD, 'https://example.invalid', 'profile-url')],
      note: 'THE canonical residual false positives, recorded on purpose: "Watson Studio" '
        + 'masks as profile-person@0.5 and "today" masks as profile-driverlicense@0.7 (the DL '
        + 'trigger word plus a weak pattern). Both are Title-Case/word false positives, both '
        + 'left unlabelled deliberately — see the module doc comment on label policy 2.',
    },
    {
      id: 'product-name-sentence',
      text: T_PRODUCT_2,
      labels: [],
      note: '"Redis Sentinel" masks as profile-person@0.5 today — a Title-Case product name, '
        + 'deliberately left unlabelled (not PII) so the harness counts it as the false '
        + 'positive it is. See the module doc comment on label policy 2.',
    },
    {
      id: 'itin',
      text: 'ITIN 912-70-1234 on file for the audit record ZPC_MM_STOCK_NIGHTLY.',
      labels: [at('ITIN 912-70-1234 on file for the audit record ZPC_MM_STOCK_NIGHTLY.', '912-70-1234', 'profile-itin')],
    },
    {
      id: 'medical-license',
      text: 'DEA AB1234563 issued for the pharmacy chain RSPROCESS.',
      labels: [at('DEA AB1234563 issued for the pharmacy chain RSPROCESS.', 'AB1234563', 'profile-medical-license')],
    },
    {
      id: 'national-id-trigger',
      text: 'NI: AB123456C recorded against employee id ZCA_C06.',
      labels: [at('NI: AB123456C recorded against employee id ZCA_C06.', 'AB123456C', 'profile-nationalid')],
    },
    {
      id: 'bank-account-aba',
      text: 'ABA 011401533 for the transfer to chain ZTRAN_SD_STAGE.',
      labels: [at('ABA 011401533 for the transfer to chain ZTRAN_SD_STAGE.', '011401533', 'profile-bank-account')],
    },
    {
      id: 'ssn',
      text: 'SSN 234-56-7890 was recorded for the applicant of record ZPC_SD_BILLING_DAILY.',
      labels: [at('SSN 234-56-7890 was recorded for the applicant of record ZPC_SD_BILLING_DAILY.', '234-56-7890', 'profile-ssn')],
    },
    {
      id: 'phone-in-technical-sentence',
      text: 'Contact +1 (555) 019-2231 regarding chain ZBW_CHAIN_RESTART_LOG.',
      labels: [at('Contact +1 (555) 019-2231 regarding chain ZBW_CHAIN_RESTART_LOG.', '+1 (555) 019-2231', 'profile-phone')],
    },
    {
      id: 'passport-in-technical-sentence',
      text: 'Passport number: X7654321 recorded against ticket ZPC_FICA_LOAD_DELTA.',
      labels: [at('Passport number: X7654321 recorded against ticket ZPC_FICA_LOAD_DELTA.', 'X7654321', 'profile-passport')],
    },
    {
      id: 'driverlicense-in-technical-sentence',
      text: "Driver's license number: D1122334 filed with request ZDSO_SD_ORDERS.",
      labels: [at("Driver's license number: D1122334 filed with request ZDSO_SD_ORDERS.", 'D1122334', 'profile-driverlicense')],
    },
    {
      id: 'ssn-in-technical-sentence',
      text: 'SSN 345-67-8901 was verified against record RSPCCHAIN.',
      labels: [at('SSN 345-67-8901 was verified against record RSPCCHAIN.', '345-67-8901', 'profile-ssn')],
    },
    {
      id: 'iban-in-technical-sentence',
      text: 'IBAN DE89 3704 0044 0532 0130 00 covers the reversal linked to chain ZPC_MM_STOCK_NIGHTLY.',
      labels: [at(
        'IBAN DE89 3704 0044 0532 0130 00 covers the reversal linked to chain ZPC_MM_STOCK_NIGHTLY.',
        'DE89 3704 0044 0532 0130 00', 'profile-iban',
      )],
    },
    {
      id: 'json-payload-4',
      text: '{ "auditor": "Sofia Marchetti", "note": "review of ZCUBE_FICA_TOTALS" }',
      labels: [at('{ "auditor": "Sofia Marchetti", "note": "review of ZCUBE_FICA_TOTALS" }', 'Sofia Marchetti', 'profile-person')],
    },
    {
      id: 'json-payload-5',
      text: '{"customer": {"name": "Noah Fischer", "email": "noah.fischer@example.invalid", "phone": "+1 (555) 044-7789"}, "chain": "ZDSO_SD_ORDERS"}',
      labels: [
        at('{"customer": {"name": "Noah Fischer", "email": "noah.fischer@example.invalid", "phone": "+1 (555) 044-7789"}, "chain": "ZDSO_SD_ORDERS"}', 'Noah Fischer', 'profile-person'),
        at('{"customer": {"name": "Noah Fischer", "email": "noah.fischer@example.invalid", "phone": "+1 (555) 044-7789"}, "chain": "ZDSO_SD_ORDERS"}', 'noah.fischer@example.invalid', 'profile-email'),
        at('{"customer": {"name": "Noah Fischer", "email": "noah.fischer@example.invalid", "phone": "+1 (555) 044-7789"}, "chain": "ZDSO_SD_ORDERS"}', '+1 (555) 044-7789', 'profile-phone'),
      ],
    },
    {
      id: 'sql-upper-quoted-literals-3',
      text: "SELECT NAME, PHONE FROM ZTRAN_SD_STAGE WHERE NAME = 'Diego Fontana' AND PHONE = '+1 (555) 088-1234';",
      labels: [
        at("SELECT NAME, PHONE FROM ZTRAN_SD_STAGE WHERE NAME = 'Diego Fontana' AND PHONE = '+1 (555) 088-1234';", 'Diego Fontana', 'profile-person'),
        at("SELECT NAME, PHONE FROM ZTRAN_SD_STAGE WHERE NAME = 'Diego Fontana' AND PHONE = '+1 (555) 088-1234';", '+1 (555) 088-1234', 'profile-phone'),
      ],
    },
    {
      id: 'bank-account-aba-2',
      text: 'Routing number: 011401533 linked to chain ZDSO_MM_STOCK.',
      labels: [at('Routing number: 011401533 linked to chain ZDSO_MM_STOCK.', '011401533', 'profile-bank-account')],
    },
    {
      id: 'medical-license-2',
      text: 'DEA# AB1234563 filed against ticket ZTRAN_FICA_STAGE.',
      labels: [at('DEA# AB1234563 filed against ticket ZTRAN_FICA_STAGE.', 'AB1234563', 'profile-medical-license')],
    },
  ],
};

// ---------------------------------------------------------------------------------------
// prose set — scored for RECALL
// ---------------------------------------------------------------------------------------

const P_SIGNATURE = 'Regards,\nFerreira Nakamura\nSenior Auditor';

const P_ROSTER_COUNT = 41; // >= the saturation_warn default (40): also the saturation fixture.
function buildRoster(count: number): { text: string; labels: EntityLabel[] } {
  const lines: string[] = [];
  const labels: EntityLabel[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const value = `Ferreira Nakamura${i} Rossi`;
    const line = `- ${value}`;
    labels.push({ start: offset + 2, end: offset + 2 + value.length, type: 'profile-person', value });
    lines.push(line);
    offset += line.length + 1; // '\n'
  }
  return { text: lines.join('\n'), labels };
}
const ROSTER = buildRoster(P_ROSTER_COUNT);

const P_TABLE_ROW = '| Ferreira Nakamura | Auditor | 2026 |';
const P_CSV_LINE = 'Ferreira Nakamura,Auditor,2026-08-24';
const P_BULLET_LIST = '- Ferreira Nakamura\n- Priya Raman';
const P_CHAT_PREFIX = 'Ferreira Nakamura: I will send the filing tonight.';
const P_SUBJECT = 'Subject: Ferreira Nakamura';
const P_JSON_VALUE = '{ "owner": "Ferreira Nakamura", "state": "R" }';
const P_SQL_LITERAL = "SELECT OWNER FROM ZCA_C06 WHERE OWNER = 'Ferreira Nakamura';";
const P_LINK_BEFORE = 'See https://intranet.example.invalid/filings — Ferreira Nakamura signed it.';
const P_LINK_AFTER = 'Ferreira Nakamura signed it — see https://intranet.example.invalid/filings.';
const P_PATH_BESIDE = 'Ferreira Nakamura attached /var/log/filing.txt to the ticket.';
const P_ALLCAPS_DEAR = 'Dear JOHN SMITH, your request is approved.';
const P_ALLCAPS_DEAR_2 = 'Dear MARIA SCHNEIDER, your request is approved.';
const P_ALLCAPS_DEAR_LOW = 'Dear MARIA LOW,';
const P_BARE_NAME = 'Ferreira Nakamura signed the filing.';
const P_BARE_NAME_2 = 'Barack Obama visited Berlin last spring.';
const P_HONORIFIC = 'Dear Anna Karenina, welcome aboard.';
const P_SWALLOWED_HONORIFIC = 'I spoke with Dr. Watson about the results.';
const P_CONTACT_ADJACENT = 'Ferreira Nakamura (f.n@example.invalid) signed the filing.';
const P_PASSPORT_TRIGGER = 'Passport number: X1234567 was issued to Ferreira Nakamura.';
const P_LICENSE_TRIGGER = "Driver's license number: D9876543 belongs to Ferreira Nakamura.";
const P_NI_TRIGGER = 'NI: AB123456C was recorded for Ferreira Nakamura.';
const P_IBAN_SENTENCE = 'Ferreira Nakamura paid using IBAN DE89 3704 0044 0532 0130 00.';
const P_CRED_FENCE = '```\npassword: SECRETVALUE\n```';
const P_CRED_SQL = "UPDATE ZCA_C06 SET PWD = 'x' WHERE password: SECRETVALUE;";
const P_CRED_YAML = 'credentials:\n  password: SECRETVALUE\n  user: svc-fica';
const P_LOG_LEVEL_LINE = '2026-08-24 12:00:03 INFO  Ferreira Nakamura signed the filing';
const P_SHOUTED_DEPT = 'The ACCOUNTING team says Ferreira Nakamura signed.';

const PROSE_SET: CorpusSet = {
  name: 'prose',
  cases: [
    {
      id: 'bare-name-not-in-given-name-dictionary',
      text: P_BARE_NAME,
      labels: [at(P_BARE_NAME, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'bare-name-common',
      text: P_BARE_NAME_2,
      labels: [at(P_BARE_NAME_2, 'Barack Obama', 'profile-person')],
    },
    {
      id: 'salutation-honorific',
      text: P_HONORIFIC,
      labels: [at(P_HONORIFIC, 'Anna Karenina', 'profile-person')],
    },
    {
      id: 'honorific-swallowed-into-run',
      text: P_SWALLOWED_HONORIFIC,
      labels: [at(P_SWALLOWED_HONORIFIC, 'Dr. Watson', 'profile-person')],
    },
    {
      id: 'contact-adjacency',
      text: P_CONTACT_ADJACENT,
      labels: [
        at(P_CONTACT_ADJACENT, 'Ferreira Nakamura', 'profile-person'),
        at(P_CONTACT_ADJACENT, 'f.n@example.invalid', 'profile-email'),
      ],
    },
    {
      id: 'allcaps-dear-1',
      text: P_ALLCAPS_DEAR,
      labels: [at(P_ALLCAPS_DEAR, 'JOHN SMITH', 'profile-person')],
    },
    {
      id: 'allcaps-dear-2',
      text: P_ALLCAPS_DEAR_2,
      labels: [at(P_ALLCAPS_DEAR_2, 'MARIA SCHNEIDER', 'profile-person')],
    },
    {
      id: 'allcaps-dear-maria-low',
      text: P_ALLCAPS_DEAR_LOW,
      labels: [at(P_ALLCAPS_DEAR_LOW, 'MARIA LOW', 'profile-person')],
    },
    {
      id: 'signature-block',
      text: P_SIGNATURE,
      labels: [at(P_SIGNATURE, 'Ferreira Nakamura', 'profile-person')],
      note: '"Senior Auditor" also masks today (profile-person@0.65 — "Regards," reaches it '
        + 'as an honorific within the 40-char window). Left unlabelled deliberately: a job '
        + 'title is not PII, and this is a real precision defect the harness surfaces without '
        + 'fixing.',
    },
    {
      id: 'chat-prefix',
      text: P_CHAT_PREFIX,
      labels: [at(P_CHAT_PREFIX, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'subject-line',
      text: P_SUBJECT,
      labels: [at(P_SUBJECT, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'table-row',
      text: P_TABLE_ROW,
      labels: [at(P_TABLE_ROW, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'csv-line',
      text: P_CSV_LINE,
      labels: [at(P_CSV_LINE, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'bullet-list',
      text: P_BULLET_LIST,
      labels: [
        at(P_BULLET_LIST, 'Ferreira Nakamura', 'profile-person'),
        at(P_BULLET_LIST, 'Priya Raman', 'profile-person'),
      ],
    },
    {
      id: 'json-string-value',
      text: P_JSON_VALUE,
      labels: [at(P_JSON_VALUE, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'sql-string-literal',
      text: P_SQL_LITERAL,
      labels: [at(P_SQL_LITERAL, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'link-before-name',
      text: P_LINK_BEFORE,
      // profile-url captures scheme+host only, not the path — matches what detectRegexEntities
      // actually extracts (see also T_URL and T_PRODUCT_DOWNLOAD in the technical set).
      labels: [
        at(P_LINK_BEFORE, 'https://intranet.example.invalid', 'profile-url'),
        at(P_LINK_BEFORE, 'Ferreira Nakamura', 'profile-person'),
      ],
    },
    {
      id: 'link-after-name',
      text: P_LINK_AFTER,
      labels: [
        at(P_LINK_AFTER, 'Ferreira Nakamura', 'profile-person'),
        at(P_LINK_AFTER, 'https://intranet.example.invalid', 'profile-url'),
      ],
    },
    {
      id: 'path-beside-name',
      text: P_PATH_BESIDE,
      labels: [at(P_PATH_BESIDE, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'log-line-with-level',
      text: P_LOG_LEVEL_LINE,
      labels: [at(P_LOG_LEVEL_LINE, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'shouted-department-not-machinery',
      text: P_SHOUTED_DEPT,
      labels: [at(P_SHOUTED_DEPT, 'Ferreira Nakamura', 'profile-person')],
    },
    {
      id: 'passport-with-trigger',
      text: P_PASSPORT_TRIGGER,
      labels: [
        at(P_PASSPORT_TRIGGER, 'X1234567', 'profile-passport'),
        at(P_PASSPORT_TRIGGER, 'Ferreira Nakamura', 'profile-person'),
      ],
    },
    {
      id: 'driverlicense-with-trigger',
      text: P_LICENSE_TRIGGER,
      labels: [
        at(P_LICENSE_TRIGGER, 'D9876543', 'profile-driverlicense'),
        at(P_LICENSE_TRIGGER, 'Ferreira Nakamura', 'profile-person'),
      ],
    },
    {
      id: 'nationalid-with-trigger',
      text: P_NI_TRIGGER,
      labels: [
        at(P_NI_TRIGGER, 'AB123456C', 'profile-nationalid'),
        at(P_NI_TRIGGER, 'Ferreira Nakamura', 'profile-person'),
      ],
    },
    {
      id: 'iban-with-name',
      text: P_IBAN_SENTENCE,
      labels: [
        at(P_IBAN_SENTENCE, 'Ferreira Nakamura', 'profile-person'),
        at(P_IBAN_SENTENCE, 'DE89 3704 0044 0532 0130 00', 'profile-iban'),
      ],
    },
    {
      id: 'credential-in-code-fence',
      text: P_CRED_FENCE,
      labels: [at(P_CRED_FENCE, 'SECRETVALUE', 'profile-username-password')],
    },
    {
      id: 'credential-in-sql',
      text: P_CRED_SQL,
      labels: [at(P_CRED_SQL, 'SECRETVALUE', 'profile-username-password')],
    },
    {
      id: 'credential-in-yaml',
      text: P_CRED_YAML,
      labels: [
        at(P_CRED_YAML, 'SECRETVALUE', 'profile-username-password'),
        at(P_CRED_YAML, 'svc-fica', 'profile-username-password'),
      ],
    },
    {
      id: `saturated-roster-${P_ROSTER_COUNT}`,
      text: ROSTER.text,
      labels: ROSTER.labels,
      note: `${P_ROSTER_COUNT} distinct names, one above the default saturation_warn (40). Used `
        + 'both for recall (every name should mask) and, in precision.test.ts, for the '
        + 'saturation-stability property: the masked SET must be identical whether '
        + 'saturation_warn is 40 or 100.',
    },
  ],
};

// ---------------------------------------------------------------------------------------
// mixed set — the incident's own shape (technical machinery + a handful of real people)
// ---------------------------------------------------------------------------------------

/**
 * Synthetic text with the 2026-08-25 incident's shape: 40 distinct SAP/BW identifiers
 * (object names, table names, 25-char request ids), 6 SQL statements, a JSON payload —
 * and exactly three names plus two mail addresses of real PII. Identical in shape to the
 * fixture in test/pseudonymization-technical-context.test.ts (task 1), reused here as the
 * canonical mixed-set document and the wall-time budget's subject.
 */
export const INCIDENT_SHAPED_TEXT = [
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

const MIXED_SET: CorpusSet = {
  name: 'mixed',
  cases: [
    {
      id: 'incident-shaped-request',
      text: INCIDENT_SHAPED_TEXT,
      labels: [
        at(INCIDENT_SHAPED_TEXT, 'Anna Schmidt', 'profile-person'),
        at(INCIDENT_SHAPED_TEXT, 'Miguel Torres', 'profile-person'),
        at(INCIDENT_SHAPED_TEXT, 'Priya Raman', 'profile-person'),
        at(INCIDENT_SHAPED_TEXT, 'anna.schmidt@example.invalid', 'profile-email'),
        at(INCIDENT_SHAPED_TEXT, 'miguel.torres@example.invalid', 'profile-email'),
      ],
    },
  ],
};

export const CORPUS: CorpusSet[] = [TECHNICAL_SET, PROSE_SET, MIXED_SET];
export { TECHNICAL_SET, PROSE_SET, MIXED_SET };
