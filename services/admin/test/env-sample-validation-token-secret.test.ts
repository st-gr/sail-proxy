/**
 * AWS SigV4 through the admin only works when the gateway and the admin share one non-default
 * VALIDATION_TOKEN_SECRET (the admin hands signing keys only to the gateway's service JWT). Both
 * .env.sample files must therefore show the same placeholder and say that it must match.
 *
 * @see ../.env.sample
 * @see ../../gateway/.env.sample
 */
import * as fs from 'fs';
import * as path from 'path';

const SERVICES = path.resolve(__dirname, '..', '..');

function sample(service: string): string {
  return fs.readFileSync(path.join(SERVICES, service, '.env.sample'), 'utf8');
}

function secretValue(content: string): string | undefined {
  return /^VALIDATION_TOKEN_SECRET=(.*)$/m.exec(content)?.[1];
}

/** The comment lines directly above the VALIDATION_TOKEN_SECRET line. */
function commentAbove(content: string): string {
  const lines = content.split('\n');
  const i = lines.findIndex(line => line.startsWith('VALIDATION_TOKEN_SECRET='));
  const comments: string[] = [];
  for (let j = i - 1; j >= 0 && lines[j].startsWith('#'); j--) comments.unshift(lines[j]);
  return comments.join('\n');
}

describe('VALIDATION_TOKEN_SECRET in the .env.sample files', () => {
  const admin = sample('admin');
  const gateway = sample('gateway');

  it('uses the same placeholder in the admin and the gateway sample', () => {
    expect(secretValue(admin)).toBeDefined();
    expect(secretValue(gateway)).toBe(secretValue(admin));
  });

  it.each([['admin', admin], ['gateway', gateway]])('the %s sample says both services need the same generated value for AWS SigV4', (_name, content) => {
    const comment = commentAbove(content);
    expect(comment).toMatch(/same/i);
    expect(comment).toMatch(/SigV4/);
  });
});
