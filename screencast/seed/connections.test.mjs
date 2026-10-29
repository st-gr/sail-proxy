import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionSpecs, usageCall, sapTenantSpecs, hintMap, sapCalls } from './connections.mjs';

const ENV = {
  OPENAI_API_KEY: 'sk-demo-openai-0000000000000000000000',
  AZURE_OPENAI_ENDPOINT: 'https://example-resource.openai.azure.com', AZURE_OPENAI_API_KEY: 'fake-azure', AZURE_OPENAI_DEPLOYMENT: 'chat-small',
  ANTHROPIC_API_KEY: 'sk-demo-anthropic-000000000000000000',
  AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'anthropic.claude-haiku', AWS_BEARER_TOKEN_BEDROCK: 'fake-bearer'
};

test('one connection per provider whose credentials are present', () => {
  assert.deepEqual(connectionSpecs(ENV).map((s) => s.name), ['openai', 'azure', 'anthropic', 'bedrock']);
  assert.deepEqual(connectionSpecs({ ANTHROPIC_API_KEY: 'x' }).map((s) => s.name), ['anthropic']);
  assert.deepEqual(connectionSpecs({ AZURE_OPENAI_ENDPOINT: 'https://e', AZURE_OPENAI_API_KEY: 'k' }), [], 'azure needs a deployment');
});

test('azure publishes its deployment with api-key auth; bedrock uses the bearer token', () => {
  const [, azure, , bedrock] = connectionSpecs(ENV);
  assert.equal(azure.model, 'chat-small');
  assert.deepEqual(azure.fields, { endpoint: 'https://example-resource.openai.azure.com', authMode: 'api-key' });
  assert.deepEqual(bedrock.fields, { region: 'us-east-1', authMode: 'bearer' });
  assert.equal(bedrock.secret, 'fake-bearer');
});

test('usage calls go to the route of the model family; bedrock makes none', () => {
  const [openai, azure, anthropic, bedrock] = connectionSpecs(ENV);
  assert.equal(usageCall(openai).path, '/openai/v1/chat/completions');
  assert.equal(usageCall(azure).body.model, 'chat-small--azure');
  assert.equal(usageCall(anthropic).path, '/anthropic/v1/messages');
  assert.equal(usageCall(anthropic).body.model, 'claude-haiku-4-5-20251001--anthropic');
  assert.equal(usageCall(bedrock), null);
});

test('SAP tenants: the installation first, named a, b, productive, the key JSON as the secret', () => {
  const specs = sapTenantSpecs([{ clientid: 'one' }, { clientid: 'two' }]);
  assert.deepEqual(specs.map((s) => s.name), ['sap-tenant-a', 'sap-tenant-b']);
  assert.equal(specs[0].title, 'SAP AI Core (installation)');
  assert.equal(specs[1].title, 'SAP AI Core (tenant B)');
  assert.deepEqual(specs[1].fields, { productive: true });
  assert.equal(JSON.parse(specs[1].secret).clientid, 'two');
});

test('usage calls can carry a long prompt so the spend shows in cents', () => {
  const [openai] = connectionSpecs(ENV);
  const long = usageCall(openai, 1000).body.messages[0].content;
  assert.ok(long.length > 4000, 'about 1000 tokens of text');
  assert.ok(long.endsWith('Say hello in five words.'));
  assert.equal(usageCall(openai).body.messages[0].content, 'Say hello in five words.');
});

test('hintMap masks every stored credential hint except the bare ellipsis', () => {
  assert.deepEqual(hintMap([{ credentialHint: 'abcd…wxyz' }, { credentialHint: '…' }, { credentialHint: null }]), { 'abcd…wxyz': '••••…••••' });
});

test('SAP calls: one short call per tenant; with spend, the later tenants also get long calls on the spend model', () => {
  assert.deepEqual(sapCalls(0, 4, 'cheap', 'mid'), [{ model: 'cheap', tokens: 0 }]);
  assert.deepEqual(sapCalls(1, 0, 'cheap', 'mid'), [{ model: 'cheap', tokens: 0 }]);
  const b = sapCalls(1, 2, 'cheap', 'mid');
  assert.deepEqual(b, [{ model: 'cheap', tokens: 0 }, { model: 'mid', tokens: 25000 }, { model: 'mid', tokens: 25000 }]);
});
