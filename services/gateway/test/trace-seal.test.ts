import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLICLY_KNOWN_SEAL_SECRETS,
  isSealEnvelope,
  openSealed,
  sealKeyStatus,
  sealText,
} from '@libs/trace-seal';

const strongKey = () => randomBytes(32).toString('hex');
const envWith = (key?: string): NodeJS.ProcessEnv => (key === undefined ? {} : { METADATA_ENCRYPTION_KEY: key });
const sampleValue = (service: string): string => {
  const file = readFileSync(join(__dirname, '..', '..', service, '.env.sample'), 'utf8');
  const match = file.match(/^METADATA_ENCRYPTION_KEY=(.*)$/m);
  if (!match) throw new Error(`no METADATA_ENCRYPTION_KEY line in ${service}`);
  return match[1].trim();
};

describe('trace-seal', () => {
  describe('sealText / openSealed', () => {
    it('round-trips with a generated key', () => {
      const env = envWith(strongKey());
      const opened = openSealed(sealText('Jane Roe wrote jane.roe@example.org', env), env);
      expect(opened).toEqual({ ok: true, text: 'Jane Roe wrote jane.roe@example.org' });
    });

    it('seals one text differently each time', () => {
      const env = envWith(strongKey());
      expect(sealText('same', env)).not.toBe(sealText('same', env));
    });

    it('never puts the plain text in the envelope and uses the v1 shape', () => {
      const env = envWith(strongKey());
      const sealed = sealText('Jane Roe', env);
      expect(sealed).not.toContain('Jane Roe');
      const parsed = JSON.parse(sealed);
      expect(Object.keys(parsed).sort()).toEqual(['ct', 'iv', 'tag', 'v']);
      expect(parsed.v).toBe(1);
      expect(Buffer.from(parsed.iv, 'base64')).toHaveLength(12);
    });

    it('reports keys-differ for another key', () => {
      const sealed = sealText('x', envWith(strongKey()));
      expect(openSealed(sealed, envWith(strongKey()))).toEqual({ ok: false, reason: 'keys-differ' });
    });

    it('reports keys-differ for a changed byte', () => {
      const env = envWith(strongKey());
      const parsed = JSON.parse(sealText('some longer text', env));
      const ct = Buffer.from(parsed.ct, 'base64');
      ct[0] ^= 1;
      parsed.ct = ct.toString('base64');
      expect(openSealed(JSON.stringify(parsed), env)).toEqual({ ok: false, reason: 'keys-differ' });
    });

    it('reports malformed for text that is not an envelope', () => {
      const env = envWith(strongKey());
      expect(openSealed('not json', env)).toEqual({ ok: false, reason: 'malformed' });
      expect(openSealed('{"v":2,"iv":"","tag":"","ct":""}', env)).toEqual({ ok: false, reason: 'malformed' });
      expect(openSealed('{"v":1,"iv":"AA==","tag":"AA==","ct":"AA=="}', env)).toEqual({ ok: false, reason: 'malformed' });
      expect(openSealed('null', env)).toEqual({ ok: false, reason: 'malformed' });
      expect(openSealed('', env)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('reports malformed for envelope fields that are not strings, never throwing', () => {
      const env = envWith(strongKey());
      const parsed = JSON.parse(sealText('x', env));
      for (const field of ['iv', 'tag', 'ct']) {
        for (const value of [1, null, true, {}, ['AA==']]) {
          const envelope = JSON.stringify({ ...parsed, [field]: value });
          expect(() => openSealed(envelope, env)).not.toThrow();
          expect(openSealed(envelope, env)).toEqual({ ok: false, reason: 'malformed' });
        }
      }
      expect(openSealed('{"v":1,"iv":1,"tag":1,"ct":1}', env)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('reports malformed for a garbled or truncated tag, never throwing', () => {
      const env = envWith(strongKey());
      const parsed = JSON.parse(sealText('some longer text', env));
      const garbled = [parsed.tag.slice(0, 10), parsed.tag.slice(0, -4), '!!not*base64!!', ''];
      for (const tag of garbled) {
        const envelope = JSON.stringify({ ...parsed, tag });
        expect(() => openSealed(envelope, env)).not.toThrow();
        expect(openSealed(envelope, env)).toEqual({ ok: false, reason: 'malformed' });
      }
    });

    it('opens a seal made with the variable unset when it is the dev fallback', () => {
      const sealed = sealText('x', {});
      expect(openSealed(sealed, envWith('dev-key-change-in-production'))).toEqual({ ok: true, text: 'x' });
    });
  });

  describe('isSealEnvelope', () => {
    it('is true for what sealText gives, also for an empty text', () => {
      const env = envWith(strongKey());
      expect(isSealEnvelope(sealText('Jane Roe', env))).toBe(true);
      expect(isSealEnvelope(sealText('', env))).toBe(true);
    });
    it('is false for clear text, other shapes and fields that are not base64 of the right size', () => {
      const env = envWith(strongKey());
      const parsed = JSON.parse(sealText('x', env));
      for (const value of [
        undefined, null, 42, '', 'Jane Roe', 'null', '[]', JSON.stringify({ text: 'Jane Roe' }),
        JSON.stringify({ ...parsed, v: 2 }), JSON.stringify({ ...parsed, extra: 'Jane Roe' }),
        JSON.stringify({ ...parsed, ct: 'Jane Roe' }), JSON.stringify({ ...parsed, iv: 1 }),
        JSON.stringify({ ...parsed, iv: 'AA==' }), JSON.stringify({ ...parsed, tag: parsed.tag.slice(0, -4) }),
        JSON.stringify({ v: 1, iv: parsed.iv, tag: parsed.tag }),
      ]) {
        expect(isSealEnvelope(value)).toBe(false);
      }
    });
  });

  describe('sealKeyStatus', () => {
    it('is strong for a generated key', () => {
      expect(sealKeyStatus(envWith(strongKey()))).toBe('strong');
    });
    it('is missing when unset or empty', () => {
      expect(sealKeyStatus({})).toBe('missing');
      expect(sealKeyStatus(envWith(''))).toBe('missing');
    });
    it('is too-short below 32 characters', () => {
      expect(sealKeyStatus(envWith('a'.repeat(31)))).toBe('too-short');
      expect(sealKeyStatus(envWith('a'.repeat(32)))).toBe('strong');
    });
    it('judges the trimmed value: whitespace-only is too-short, padding does not count', () => {
      expect(sealKeyStatus(envWith(' '))).toBe('too-short');
      expect(sealKeyStatus(envWith(' '.repeat(40)))).toBe('too-short');
      expect(sealKeyStatus(envWith('\t\n  \n'))).toBe('too-short');
      expect(sealKeyStatus(envWith(`${' '.repeat(20)}${'a'.repeat(20)}${' '.repeat(20)}`))).toBe('too-short');
      expect(sealKeyStatus(envWith(` ${'a'.repeat(32)} `))).toBe('strong');
      expect(sealKeyStatus(envWith(` dev-key-change-in-production${' '.repeat(10)}`))).toBe('publicly-known');
    });
    it('derives the key from the value as given, padding included', () => {
      const padded = ` ${strongKey()} `;
      const sealed = sealText('x', envWith(padded));
      expect(openSealed(sealed, envWith(padded))).toEqual({ ok: true, text: 'x' });
      expect(openSealed(sealed, envWith(padded.trim()))).toEqual({ ok: false, reason: 'keys-differ' });
    });
    it('is publicly-known for every sample value and the dev fallback', () => {
      expect(sealKeyStatus(envWith('dev-key-change-in-production'))).toBe('publicly-known');
      for (const service of ['admin', 'gateway']) {
        expect(sealKeyStatus(envWith(sampleValue(service)))).toBe('publicly-known');
      }
    });
    it('pins the precedence missing > publicly-known > too-short', () => {
      // 'dev-key-change-in-production' is 28 characters: known and short at once
      expect(sealKeyStatus(envWith('dev-key-change-in-production'))).toBe('publicly-known');
      expect(sealKeyStatus(envWith(''))).toBe('missing');
    });
  });

  it('lists every .env.sample value so the list cannot drift', () => {
    for (const service of ['admin', 'gateway']) {
      const value = sampleValue(service);
      if (value !== '') expect(PUBLICLY_KNOWN_SEAL_SECRETS).toContain(value);
    }
  });
});
