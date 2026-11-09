import * as fs from 'fs';
import * as path from 'path';
import { ENGLISH_MESSAGES, Translator, formatPattern, messageTranslator } from '../webapp/model/validationTexts';
import { validateSection, validateSinkNames, fieldErrorOf } from '../webapp/model/validateSection';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { buildDescriptors, Descriptor } from '../webapp/model/schemaForm';
import { schemaTexts } from '../webapp/model/schemaTexts';
import apiConfigSchema from '../webapp/model/apiConfigSchema';

/** The bundle's raw values, read as UI5 reads them (no escapes are used in these keys). */
function bundle(lang: string): Record<string, string> {
  const file = path.join(__dirname, '..', 'webapp', 'i18n', lang ? `i18n_${lang}.properties` : 'i18n.properties');
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** What `ConfigForm` hands in: the bundle's raw text, or the key itself for a key it does not have. */
function lookupOf(lang: string): (key: string) => string {
  const texts = bundle(lang);
  return key => texts[key] ?? key;
}

const de: Translator = messageTranslator(lookupOf('de'));

const numberSchema = { type: 'object', properties: { batch_size: { type: 'integer', minimum: 1 }, mode: { type: 'string', enum: ['auto', 'off'] } }, required: ['mode'] };

describe('validation messages: formatting', () => {
  it('formats a pattern the way UI5 formatMessage does', () => {
    expect(formatPattern("at ''{0}'': {1}", ['/a', 'b'])).toBe("at '/a': b");
    expect(formatPattern("each other''s", [])).toBe("each other's");
    expect(formatPattern('must be >= {0}', [5])).toBe('must be >= 5');
  });

  it('keeps the backend English without a lookup, and for a key the bundle lacks', () => {
    expect(messageTranslator()).toBe(ENGLISH_MESSAGES);
    expect(messageTranslator(key => key)('validationMinimum', ['3'])).toBe('must be >= 3');
    expect(messageTranslator(() => undefined)('validationAt', ['/x', 'y'])).toBe("Schema validation error at '/x': y");
  });

  it('reads the English bundle exactly as the English defaults', () => {
    const en = messageTranslator(lookupOf(''));
    const errors = validateSection(numberSchema, { batch_size: 0, mode: 'sometimes' }, '/s', en);
    expect(errors).toEqual(validateSection(numberSchema, { batch_size: 0, mode: 'sometimes' }, '/s'));
    expect(errors).toEqual([
      "Schema validation error at '/s/batch_size': must be >= 1",
      "Schema validation error at '/s/mode': must be equal to one of the allowed values"
    ]);
  });
});

describe('validation messages: German', () => {
  it('words a value below its minimum and a value outside its enum in German', () => {
    expect(validateSection(numberSchema, { batch_size: 0, mode: 'sometimes' }, '/s', de)).toEqual([
      'Fehler bei der Schemaprüfung an "/s/batch_size": muss >= 1 sein',
      'Fehler bei der Schemaprüfung an "/s/mode": muss einem der zulässigen Werte entsprechen'
    ]);
  });

  it('keeps type names, patterns and property names verbatim inside the German text', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' }, p: { type: 'string', pattern: '^[a-z]+$' } } };
    expect(validateSection(schema, { n: 'x', p: 'A' }, '', de)).toEqual([
      'Fehler bei der Schemaprüfung an "/n": muss vom Typ integer sein',
      'Fehler bei der Schemaprüfung an "/p": muss dem Muster "^[a-z]+$" entsprechen'
    ]);
  });

  it('reads a German message back onto its field, a missing property one segment deeper', () => {
    const [below, , missing] = validateSection(numberSchema, { batch_size: 0, mode: 'sometimes' }, '/s', de)
      .concat(validateSection(numberSchema, {}, '/s', de));
    expect(fieldErrorOf(below, de)).toEqual({ pointer: '/s/batch_size', reason: 'muss >= 1 sein', missing: false });
    expect(fieldErrorOf(missing, de)).toEqual({
      pointer: '/s/mode', reason: 'muss die erforderliche Eigenschaft "mode" enthalten', missing: true
    });
  });

  it('words and reads back a duplicate sink name in German', () => {
    const [message] = validateSinkNames({ sinks: [{ name: 'a' }, { name: 'a' }] }, '/o/siem', de);
    expect(message).toMatch(/^Doppelter Sink-Name an "\/o\/siem\/sinks\/1\/name": "a" wird bereits von Sink #0 verwendet\./);
    expect(fieldErrorOf(message, de)).toEqual({ pointer: '/o/siem/sinks/1/name', reason: message, missing: false });
  });

  it('words the gate\'s own document-level messages in German', () => {
    expect(evaluateApiConfigDocument(apiConfigSchema, [], de).errors).toEqual(['Fehler bei der Schemaprüfung an "root": muss vom Typ object sein']);
    expect(evaluateApiConfigDocument(apiConfigSchema, { api_config: { siem: {} } }, de).errors).toEqual([
      'Fehler bei der Schemaprüfung an "/api_config": darf keine zusätzlichen Eigenschaften haben ("siem")'
    ]);
  });

  it('names the allowed settings of a provider in German, the list verbatim', () => {
    const schema = { type: 'object', propertyNames: { enum: ['a', 'b'] } };
    expect(validateSection(schema, { c: 1 }, '/p', de)).toEqual([
      'Fehler bei der Schemaprüfung an "/p/c": die Eigenschaft "c" gehört nicht zu den Einstellungen, die dieser Anbieter liest (zulässig: a, b)'
    ]);
  });

  it('says in German why the form shows a value as JSON', () => {
    const schema = { type: 'object', properties: { size: { type: 'integer' } } };
    const texts = schemaTexts(lookupOf('de'));
    const [raw] = buildDescriptors(schema, { size: 'big' }, '/x', () => undefined, { texts });
    expect((raw as Extract<Descriptor, { kind: 'raw' }>).reason).toBe('Typ "integer" erwartet, "string" erhalten.');
    const [english] = buildDescriptors(schema, { size: 'big' }, '/x', () => undefined);
    expect((english as Extract<Descriptor, { kind: 'raw' }>).reason).toBe('Expected type "integer", got "string".');
  });
});

describe.each([['default', ''], ['de', 'de'], ['es', 'es'], ['fr', 'fr'], ['it', 'it'], ['nl', 'nl'], ['pt', 'pt']])('validation messages: %s bundle', (_name, lang) => {
  const t = messageTranslator(lookupOf(lang));

  it('reads every message it writes back onto the field it concerns', () => {
    const messages = validateSection(numberSchema, { batch_size: 0 }, '/s', t);
    expect(messages.map(m => fieldErrorOf(m, t))).toEqual([
      { pointer: '/s/mode', reason: t('validationRequired', ['mode']), missing: true },
      { pointer: '/s/batch_size', reason: t('validationMinimum', ['1']), missing: false }
    ]);
    const [duplicate] = validateSinkNames({ sinks: [{ name: 'a' }, { name: 'a' }] }, '/o', t);
    expect(fieldErrorOf(duplicate, t)).toMatchObject({ pointer: '/o/sinks/1/name', missing: false });
  });
});
