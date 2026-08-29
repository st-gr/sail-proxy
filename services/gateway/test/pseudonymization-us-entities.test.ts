import { describe, it, expect } from '@jest/globals';
import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { MaskingConfig } from '../src/plugins/pseudonymization/types';
import { OPT_IN_ENTITY_TYPES } from '../src/plugins/pseudonymization/entityToggles';

function cfg(types: string[]): MaskingConfig {
  return { method: 'pseudonymization', entities: types.map(type => ({ type })) };
}
const found = (text: string, c: MaskingConfig) => detectEntities(text, c).map(m => `${m.original}[${m.type}]`);

describe('profile-itin', () => {
  const c = cfg(['profile-itin']);

  it('masks ITINs across the IRS-assigned group ranges', () => {
    expect(found('ITIN 912-70-1234 on file.', c)).toEqual(['912-70-1234[profile-itin]']);
    expect(found('ITIN 900-88-5555 on file.', c)).toEqual(['900-88-5555[profile-itin]']);
  });

  it('does not match an SSN-shaped value', () => {
    expect(found('SSN 123-45-6789.', c)).toEqual([]);
  });

  it('does not match an out-of-range group', () => {
    expect(found('Number 900-69-0000.', c)).toEqual([]);
  });

  // An all-zero serial is never a real ITIN; profile-ssn already guards the same
  // shape with (?!0000) and this pattern must match it.
  it('does not match an all-zero serial', () => {
    expect(found('Reference 900-50-0000 in the ledger.', c)).toEqual([]);
  });

  // The SSN pattern already excludes 9xx. Pin that so a later edit to either
  // pattern cannot silently create an overlap.
  it('never double-matches with profile-ssn', () => {
    const both = cfg(['profile-itin', 'profile-ssn']);
    expect(found('ITIN 912-70-1234 and SSN 123-45-6789.', both).sort()).toEqual(
      ['123-45-6789[profile-ssn]', '912-70-1234[profile-itin]'],
    );
  });

  // Walk every group value 50-99 and assert detection exactly matches the
  // IRS-assigned ranges (50-65, 70-88, 90-92, 94-99). A test that only checks
  // one value (e.g. 91) would not catch a gap elsewhere in the set.
  it('matches exactly the IRS-assigned group ranges across 50-99', () => {
    const irsGroups = new Set<number>();
    for (let g = 50; g <= 65; g++) irsGroups.add(g);
    for (let g = 70; g <= 88; g++) irsGroups.add(g);
    for (let g = 90; g <= 92; g++) irsGroups.add(g);
    for (let g = 94; g <= 99; g++) irsGroups.add(g);

    for (let group = 50; group <= 99; group++) {
      const groupStr = String(group).padStart(2, '0');
      const value = `912-${groupStr}-1234`;
      const result = found(`ITIN ${value} on file.`, c);
      if (irsGroups.has(group)) {
        expect(result).toEqual([`${value}[profile-itin]`]);
      } else {
        expect(result).toEqual([]);
      }
    }
  });
});

describe('profile-bank-account (ABA routing)', () => {
  const c = cfg(['profile-bank-account']);

  it('masks a checksum-valid routing number in context', () => {
    expect(found('Routing number: 021000021', c)).toEqual(['021000021[profile-bank-account]']);
    expect(found('ABA 011401533 for the transfer.', c)).toEqual(['011401533[profile-bank-account]']);
  });

  it('rejects a checksum-invalid number even in context', () => {
    expect(found('Routing number: 123456789', c)).toEqual([]);
    expect(found('Routing number: 021000022', c)).toEqual([]);
  });

  // Anchoring is what keeps 9-digit order numbers out. A checksum alone passes
  // ~1 in 10 arbitrary 9-digit runs.
  it('does not mask a bare 9-digit number with no context word', () => {
    expect(found('Order 021000021 shipped today.', c)).toEqual([]);
  });

  // The context word must be its own token, not a substring of an ordinary word
  // ("Ababa", "gaba"). Measured false positives before the \b anchor was added.
  it('does not mask a routing-shaped number inside an unrelated word', () => {
    expect(found('Shipped from Addis Ababa 021000021', c)).toEqual([]);
    expect(found('The gaba levels were reported as 021000021', c)).toEqual([]);
  });
});

describe('profile-medical-license (DEA)', () => {
  const c = cfg(['profile-medical-license']);

  it('masks a checksum-valid DEA number', () => {
    expect(found('DEA AB1234563 issued.', c)).toEqual(['AB1234563[profile-medical-license]']);
  });

  it('rejects a wrong check digit', () => {
    expect(found('DEA AB1234567 issued.', c)).toEqual([]);
  });

  // The checksum alone is not selective enough (~8.6% of arbitrary 2-letter+7-digit
  // strings pass it — commit hashes, order references). Both values below are
  // checksum-valid (confirmed against deaCheck); the anchor, not the checksum, is
  // what must keep them unmasked.
  it('does not mask a checksum-valid DEA-shaped value with no context word', () => {
    expect(found('Commit da9634103 was reverted.', c)).toEqual([]);
    expect(found('Order reference PO1000001 confirmed.', c)).toEqual([]);
  });

  // "DEA#" (no space before the label token) is a standard pharmacy/EHR abbreviation.
  it('masks a checksum-valid DEA number with the no-space "DEA#" label', () => {
    expect(found('DEA# AB1234563', c)).toEqual(['AB1234563[profile-medical-license]']);
  });

  // Pins the \bDEA\b boundary the label's \s* still relies on: a run-on like
  // "DEAnumber" (no boundary right after DEA) must not match, even though the
  // separator between DEA and the label token is now optional.
  it('does not mask a run-on label with no boundary after DEA', () => {
    expect(found('DEAnumber AB1234563', c)).toEqual([]);
  });
});

describe('profile-driverlicense (trigger-word boundaries)', () => {
  const c = cfg(['profile-driverlicense']);

  it('still masks a labelled licence number', () => {
    expect(found("driver's license number: D9876543", c)).toEqual(['D9876543[profile-driverlicense]']);
    expect(found('DL 12345678 on file.', c)).toEqual(['12345678[profile-driverlicense]']);
    expect(found('Driver licence no. A1234567', c)).toEqual(['A1234567[profile-driverlicense]']);
  });

  // The "DL" alternative carried no word boundaries and the rule is case-insensitive, so
  // it matched the "dl" INSIDE an ordinary word and the following [A-Z0-9-]{5,15} ate the
  // rest of it. Both values below were masked as DRIVERS_LICENSE by the unfixed rule
  // (measured: "middleware" -> "eware", "RSADLDNAME" -> "DNAME") — the likeliest source
  // of the 83 DRIVERS_LICENSE placeholders in the 2026-08-25 saturation incident.
  it('does not match "dl" inside an ordinary word', () => {
    expect(found('the middleware layer was replaced', c)).toEqual([]);
    expect(found('RSADLDNAME table was scanned', c)).toEqual([]);
    expect(found('a needless comparison of ABC12345', c)).toEqual([]);
  });
});

describe('profile-nationalid (context anchoring)', () => {
  const c = cfg(['profile-nationalid']);

  it('masks a UK NI number when the text says what it is', () => {
    expect(found('National Insurance number AB123456C on file.', c))
      .toEqual(['AB123456C[profile-nationalid]']);
    expect(found('national id: AB123456C', c).length).toBeGreaterThan(0);
  });

  // Two letters, six digits, one of A-D is a shape material numbers and part numbers hit
  // by accident; nothing about it is checksummed. Without an anchor it masked them.
  it('does not mask a NI-shaped value with no trigger word', () => {
    expect(found('Material MB012345A was shipped.', c)).toEqual([]);
    expect(found('Part ZS998877B is discontinued.', c)).toEqual([]);
  });

  // "NI" is the commonest label on a payslip or an HR form and was missing from the
  // trigger list, so the anchor turned the commonest real form into a false negative.
  it('accepts the bare "NI" label, with and without a colon', () => {
    expect(found('NI: AB123456C', c)).toEqual(['AB123456C[profile-nationalid]']);
    expect(found('NI AB123456C', c)).toEqual(['AB123456C[profile-nationalid]']);
  });

  // …and the type must be the national id, not a person: "NI AB123456C" is exactly the
  // shape the capitalised-run heuristic claims.
  it('claims the value as a national id, not as a person', () => {
    const withPerson = cfg(['profile-nationalid', 'profile-person']);
    expect(found('NI AB123456C', withPerson)).toEqual(['AB123456C[profile-nationalid]']);
  });

  // The 18-character CURP layout IS its validation, so it stays unconditional — the
  // anchor is for the weak pattern, not for every member of the category.
  it('still masks a bare CURP with no trigger word', () => {
    expect(found('Record HEGA850315HDFRRL08 was updated.', c))
      .toEqual(['HEGA850315HDFRRL08[profile-nationalid]']);
  });
});

describe('defaults', () => {
  it('ships the three checksummed types ON', () => {
    const { DEFAULT_MASKING_CONFIG } = require('../src/plugins/pseudonymization/defaultMaskingConfig');
    const types = DEFAULT_MASKING_CONFIG.entities.map((e: any) => e.type);
    expect(types).toContain('profile-itin');
    expect(types).toContain('profile-bank-account');
    expect(types).toContain('profile-medical-license');
  });
});

describe('profile-ip-address', () => {
  const on = cfg(['profile-ip-address']);

  it('is NOT enabled by default', () => {
    const { DEFAULT_MASKING_CONFIG } = require('../src/plugins/pseudonymization/defaultMaskingConfig');
    expect(DEFAULT_MASKING_CONFIG.entities.map((e: any) => e.type)).not.toContain('profile-ip-address');
    expect(OPT_IN_ENTITY_TYPES).toContain('profile-ip-address');
  });

  it('masks a public v4 address when enabled', () => {
    expect(found('Connect to 203.0.113.45 for access.', on)).toEqual(['203.0.113.45[profile-ip-address]']);
  });

  it('masks a public v6 address when enabled', () => {
    expect(found('Endpoint 2001:db8::8a2e:370:7334 is live.', on)).toEqual(['2001:db8::8a2e:370:7334[profile-ip-address]']);
  });

  it('never masks loopback, RFC1918 or link-local addresses', () => {
    for (const addr of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1']) {
      expect(found(`Bound to ${addr} locally.`, on)).toEqual([]);
    }
  });

  it('rejects an out-of-range octet', () => {
    expect(found('Version 999.888.777.666 released.', on)).toEqual([]);
  });

  // Both verified failing against a looser IPv6 pattern before this plan was written.
  it('does not match ordinary times or ratios', () => {
    expect(found('Meet at 12:30 today, ratio 3:4, elapsed 09:45:30.', on)).toEqual([]);
  });

  it('masks a compressed v6 address as ONE match, not two fragments', () => {
    const matches = found('Endpoint 2001:db8::8a2e:370:7334 is live.', on);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe('2001:db8::8a2e:370:7334[profile-ip-address]');
  });

  // Without this exemption, enabling profile-sensitive-data would silently switch on
  // every regex detector including this one, voiding its opt-in default.
  it('stays off when profile-sensitive-data is enabled', () => {
    expect(found('Connect to 203.0.113.45 for access.', cfg(['profile-sensitive-data']))).toEqual([]);
  });
});
