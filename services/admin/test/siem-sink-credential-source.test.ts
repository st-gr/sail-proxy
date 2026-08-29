import { createDatadogSink } from '../src/siem/sinks/datadogSink';
import { createS3Sink } from '../src/siem/sinks/s3Sink';
import { createAzureSentinelSink } from '../src/siem/sinks/azureSentinelSink';
import { createGcsPubSubSink } from '../src/siem/sinks/gcsPubSubSink';
import { createOtelSink } from '../src/siem/sinks/otelSink';
import { resolveSiemDispatch } from '../src/siem/siemConfigResolver';

describe('sinks resolve secrets through the injected resolver', () => {
  const stored = new Map<string, string>([
    ['SIEM_DATADOG_API_KEY', 'dd-from-store'],
    ['SIEM_S3_ACCESS_KEY_ID', 'AKIA-FROM-STORE'],
    ['SIEM_S3_SECRET_ACCESS_KEY', 's3-secret-from-store'],
    ['SIEM_AZURE_CLIENT_SECRET', 'azure-from-store'],
    ['SIEM_GCS_SERVICE_ACCOUNT_JSON', '{"client_email":"a@example.invalid","private_key":"k"}'],
    ['SIEM_OTEL_HEADERS', '{"authorization":"Bearer otel-from-store"}'],
    ['SIEM_WEBHOOK_TOKEN', 'webhook-from-store'],
  ]);
  const getSecret = (n: string) => stored.get(n);

  it('datadog validateConfig passes on a stored key with the env unset', () => {
    delete process.env.SIEM_DATADOG_API_KEY;
    const sink = createDatadogSink({
      name: 'datadog', site: 'datadoghq.com', apiKeyEnv: 'SIEM_DATADOG_API_KEY', getSecret,
    });
    expect(sink.validateConfig()).toEqual([]);
  });

  it('s3 validateConfig passes on stored credentials with the env unset', () => {
    delete process.env.SIEM_S3_ACCESS_KEY_ID;
    delete process.env.SIEM_S3_SECRET_ACCESS_KEY;
    const sink = createS3Sink({
      name: 's3', bucket: 'example-archive', region: 'us-east-1', prefix: 'p',
      accessKeyIdEnv: 'SIEM_S3_ACCESS_KEY_ID',
      secretAccessKeyEnv: 'SIEM_S3_SECRET_ACCESS_KEY',
      getSecret,
    });
    expect(sink.validateConfig()).toEqual([]);
  });

  it('azure sentinel validateConfig passes on a stored secret with the env unset', () => {
    delete process.env.SIEM_AZURE_CLIENT_SECRET;
    const sink = createAzureSentinelSink({
      name: 'azure_sentinel',
      dcrEndpoint: 'https://dce.example.invalid',
      dcrImmutableId: 'dcr-00000000000000000000000000000000',
      streamName: 'Custom-SailProxy_CL',
      tenantId: '00000000-0000-0000-0000-000000000000',
      clientId: '00000000-0000-0000-0000-000000000000',
      clientSecretEnv: 'SIEM_AZURE_CLIENT_SECRET',
      getSecret,
    });
    expect(sink.validateConfig()).toEqual([]);
  });

  it('gcs pubsub validateConfig passes on a stored service account with the env unset', () => {
    delete process.env.SIEM_GCS_SERVICE_ACCOUNT_JSON;
    const sink = createGcsPubSubSink({
      name: 'gcs_pubsub', projectId: 'example-project', topicId: 'topic',
      serviceAccountJsonEnv: 'SIEM_GCS_SERVICE_ACCOUNT_JSON', getSecret,
    });
    expect(sink.validateConfig()).toEqual([]);
  });

  it('otel resolves headers from the store with the env unset', () => {
    delete process.env.SIEM_OTEL_HEADERS;
    const sink = createOtelSink({
      name: 'otel', endpoint: 'https://collector.example.invalid/v1/logs',
      headersEnv: 'SIEM_OTEL_HEADERS', getSecret,
    });
    expect(sink.validateConfig()).toEqual([]);
  });

  it('webhook receives its token from the resolver, not the env', () => {
    delete process.env.SIEM_WEBHOOK_TOKEN;
    const resolved = resolveSiemDispatch(
      {
        enabled: true, batch_size: 10, interval_ms: 1000,
        sinks: [{
          name: 'webhook', type: 'webhook', enabled: true,
          url: 'https://siem.example.invalid/ingest', token_env: 'SIEM_WEBHOOK_TOKEN',
        }],
      },
      getSecret,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.warnings).toEqual([]);
  });

  it('a sink with only an env var and no stored credential reports it as missing', () => {
    process.env.SIEM_DATADOG_API_KEY = 'dd-from-env';
    const sink = createDatadogSink({
      name: 'datadog', site: 'datadoghq.com', apiKeyEnv: 'SIEM_DATADOG_API_KEY',
      getSecret: () => undefined,
    });
    expect(sink.validateConfig()).toHaveLength(1);
    delete process.env.SIEM_DATADOG_API_KEY;
  });
});
