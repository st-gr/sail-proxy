/**
 * The pure text mapping behind the Connections custom actions: which i18n key a connection test
 * result shows, and which secret fields (with which label) the credential dialog asks for.
 */
import fs from 'fs';
import path from 'path';
import { defaultFamily as serverDefaultFamily, FAMILIES } from '../../../src/services/connectionValidation';
import { defaultFamily, testResultText, secretFields, secretLabelKey, credentialErrorKey, familyOptions, CREDENTIAL_ERROR_KEYS,
  activationErrorKey, ACTIVATION_ERROR_KEYS, serviceKeyText, serviceKeyProblem, SERVICE_KEY_MAX_LENGTH } from '../webapp/ext/model/connectionTexts';

describe('connectionTexts', () => {
  it('every reason has a key and unknown reasons fall back', () => {
    expect(testResultText({ ok: true })).toEqual({ key: 'test.ok', args: [] });
    const reasons = ['no_credential', 'unauthorized', 'forbidden', 'not_found', 'unreachable', 'timeout', 'upstream_error', 'gateway_unreachable', 'inactive', 'not_supported'];
    for (const reason of reasons) expect([reason, testResultText({ ok: false, reason }).key]).toEqual([reason, `test.${reason}`]);
    expect(testResultText({ ok: false, reason: 'weird' }).key).toBe('test.unknown');
    expect(testResultText({ ok: false }).key).toBe('test.unknown');
  });

  it('carries the status and the code for the error keys', () => {
    expect(testResultText({ ok: false, reason: 'unauthorized', status: 401, code: 'invalid_api_key' }).args).toEqual(['401', 'invalid_api_key']);
    expect(testResultText({ ok: false, reason: 'unauthorized' }).args).toEqual(['', '']);
    for (const reason of ['no_credential', 'timeout', 'unreachable', 'gateway_unreachable', 'weird']) expect([reason, testResultText({ ok: false, reason, status: 500 }).args]).toEqual([reason, []]);
  });

  it('bedrock with access keys asks for a session token too', () => {
    expect(secretFields('bedrock', 'access-key')).toEqual(['secret', 'sessionToken']);
    expect(secretFields('bedrock', 'bearer')).toEqual(['secret']);
    expect(secretFields('openai', null)).toEqual(['secret']);
    expect(secretFields('azure-openai', 'api-key')).toEqual(['secret']);
  });

  it('labels follow type and auth mode', () => {
    expect(secretLabelKey('azure-openai', 'api-key')).toBe('credential.apiKey');
    expect(secretLabelKey('azure-openai', 'entra-client-secret')).toBe('credential.clientSecret');
    expect(secretLabelKey('bedrock', 'access-key')).toBe('credential.secretAccessKey');
    expect(secretLabelKey('bedrock', 'bearer')).toBe('credential.bedrockApiKey');
    expect(secretLabelKey('openai', null)).toBe('credential.apiKey');
    expect(secretLabelKey('anthropic', null)).toBe('credential.apiKey');
  });

  it('defaultFamily follows the server rule for every provider type', () => {
    for (const type of ['openai', 'azure-openai', 'anthropic', 'bedrock'] as const) expect([type, defaultFamily(type)]).toEqual([type, serverDefaultFamily(type)]);
  });

  it('a known setCredential refusal has its own text; anything else keeps the server text', () => {
    expect(credentialErrorKey({ error: { code: 'credential_key_missing' } })).toBe('credential.error.keyMissing');
    expect(credentialErrorKey({ error: { code: 'secret_required' } })).toBe('credential.required');
    expect(credentialErrorKey({ error: { code: 'session_token_not_applicable' } })).toBe('credential.error.sessionTokenNotApplicable');
    expect(credentialErrorKey({ error: { code: 'connection_not_found' } })).toBe('credential.error.notFound');
    for (const other of [{ error: { code: '500' } }, { error: {} }, {}, null, undefined, new Error('x')]) expect(credentialErrorKey(other)).toBeNull();
  });

  it('an SAP AI Core service key the server cannot parse has its own text', () => {
    expect(credentialErrorKey({ error: { code: 'service_key_invalid', message: 'Missing required field: clientid' } })).toBe('serviceKey.error.invalid');
  });

  it('a key of another tenant for the active SAP AI Core connection has its own text', () => {
    expect(credentialErrorKey({ error: { code: 'tenant_mismatch' } })).toBe('serviceKey.error.tenantMismatch');
  });

  it('activate and deactivate refusals have their own texts; anything else keeps the server text', () => {
    expect(activationErrorKey({ error: { code: 'test_required' } })).toBe('activation.error.testRequired');
    expect(activationErrorKey({ error: { code: 'no_credential' } })).toBe('activation.error.noCredential');
    expect(activationErrorKey({ error: { code: 'connection_not_found' } })).toBe('credential.error.notFound');
    for (const other of [{ error: { code: 'service_key_invalid' } }, { error: { code: 'secret_required' } }, {}, null, new Error('x')]) expect(activationErrorKey(other)).toBeNull();
  });

  it('the service key is the pasted text, else the file text, trimmed; nothing when both are empty', () => {
    expect(serviceKeyText(null, '  {"a":1}\n')).toBe('{"a":1}');
    expect(serviceKeyText('{"file":1}\n', '')).toBe('{"file":1}');
    expect(serviceKeyText('{"file":1}', '{"pasted":1}')).toBe('{"pasted":1}');
    expect(serviceKeyText(null, '   ')).toBeNull();
    expect(serviceKeyText('  ', '')).toBeNull();
  });

  it('a missing or over-long service key is refused before the call (the action takes 8000 characters)', () => {
    expect(SERVICE_KEY_MAX_LENGTH).toBe(8000);
    expect(serviceKeyProblem(null)).toBe('serviceKey.required');
    expect(serviceKeyProblem('x'.repeat(8001))).toBe('serviceKey.error.tooLarge');
    expect(serviceKeyProblem('x'.repeat(8000))).toBeNull();
  });

  it('the family list offers the server families, each with a text key', () => {
    expect(familyOptions().map((f) => f.key)).toEqual([...FAMILIES]);
    for (const f of familyOptions()) expect(f.textKey).toBe(`addModel.family.${f.key}`);
  });
});

// UI5 formats a text that is read with arguments like java.text.MessageFormat: a straight apostrophe is a quote
// and disappears. fr/it/nl texts therefore use the typographic one; no-placeholder keys are read without arguments.
describe('app bundles', () => {
  const dir = path.resolve(__dirname, '../webapp/i18n');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.properties'));
  const values = (file: string): Record<string, string> => Object.fromEntries(
    fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  it('has no straight apostrophe in a fr, it or nl text', () => {
    for (const file of files.filter((f) => /_(fr|it|nl)\./.test(f))) {
      for (const [key, value] of Object.entries(values(file))) expect([file, key, value.includes("'")]).toEqual([file, key, false]);
    }
  });

  it('has a text for every test key and the placeholders only where the key takes the status', () => {
    for (const file of files) {
      const texts = values(file);
      for (const reason of ['no_credential', 'unauthorized', 'forbidden', 'not_found', 'unreachable', 'timeout', 'upstream_error', 'gateway_unreachable', 'inactive', 'not_supported']) {
        const { key, args } = testResultText({ ok: false, reason, status: 400 });
        expect([file, key, typeof texts[key]]).toEqual([file, key, 'string']);
        expect([file, key, texts[key].includes('{0}')]).toEqual([file, key, args.length > 0]);
      }
      expect([file, typeof texts['test.unknown']]).toEqual([file, 'string']);
    }
  });

  it('has a text for every credential error and family', () => {
    for (const file of files) {
      const texts = values(file);
      for (const key of [...Object.values(CREDENTIAL_ERROR_KEYS), ...Object.values(ACTIVATION_ERROR_KEYS), ...familyOptions().map((f) => f.textKey), 'emptyValue',
        'serviceKey.required', 'serviceKey.error.tooLarge', 'serviceKey.error.unreadable', 'serviceKey.error.notJson', 'serviceKey.saved',
        'activate.confirm', 'activate.confirmTitle', 'activate.done', 'deactivate.done', 'activate', 'deactivate', 'setServiceKey']) {
        expect([file, key, typeof texts[key]]).toEqual([file, key, 'string']);
        expect([file, key, texts[key].includes('{0}')]).toEqual([file, key, false]);
      }
    }
  });
});
