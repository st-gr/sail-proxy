// Live probe for src/fileSearch/embedder.ts against the real SAP AI Core
// tenant. Deliberately a SEPARATE FILE from ../embedder.test.ts rather than a
// describe block appended to it: that file does `jest.mock('axios', ...)`
// and `jest.mock('../../src/services/configService', ...)` at module scope,
// and Jest module mocks are file-scoped — there is no way for one describe
// block in that file to see the real network and real config while its
// sibling tests keep the mocks. This file imports nothing mocked, exactly
// like the other live suites in this directory (e.g. blobStore.test.ts,
// teacherLogging.test.ts) which use a real Postgres instead of a mocked
// `pg`.
//
// Why this suite exists at all: this class of defect has bitten this feature
// twice already — orchestration rejecting `input_type` with HTTP 400, and the
// query-rewriter's model id rejected the same way — and BOTH times every
// mocked test was green while the first real request failed. Mocked
// fixtures encode assumptions about the response shape; only a live call
// proves those assumptions still hold for this tenant.
//
// RUNNING IT: `FILE_SEARCH_LIVE_PROBE=1` is the only variable you need to set. Do NOT
// source `services/gateway/.env` in your shell — CLIENT_ID's value contains a `!`,
// which zsh splits on, so `. ./.env` leaves the credential half-set and the resulting
// failure looks like a tenant problem rather than a shell one. This file loads it.
import * as path from 'path';
import * as dotenv from 'dotenv';

// Jest loads no `.env`: jest.config.json has no `setupFiles`, and the only
// `dotenv/config` import in the tree is `src/index.ts`, which no test pulls in. Without
// this the probe arms, reaches embed(), and dies on "No SAP AI Core orchestration
// deployment available for embeddings" — because CLIENT_ID / CLIENT_SECRET / AUTH_URL /
// SAP_AI_AUTO_DISCOVER_DEPLOYMENT are simply absent from process.env. That reads as a
// tenant or credential fault when nothing is wrong with either, and it is why this
// probe sat unrun from the day it was written until 2026-08-05.
// `override: false` so an explicitly exported value still wins over the file.
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: false });

import { embed } from '../../../src/fileSearch/embedder';
import configService from '../../../src/services/configService';

const LIVE_PROBE = process.env.FILE_SEARCH_LIVE_PROBE;
const live = LIVE_PROBE ? describe : describe.skip;

if (!LIVE_PROBE) {
  // Announce the skip loudly, the same way the DSN-gated suites in this
  // directory do — a silent skip here would turn a green run into one that
  // has verified nothing about the real /v2/embeddings response shape.
  // eslint-disable-next-line no-console
  console.warn(
    '[embedder.test.ts] SKIPPED — FILE_SEARCH_LIVE_PROBE is not set. '
    + 'The embedder is NOT verified against the live SAP AI Core tenant by '
    + 'this run; only the mocked assumptions in ../embedder.test.ts are '
    + 'covered.',
  );
}

live('embedder against the live tenant', () => {
  it('embeds a batch and returns vectors of the configured dimension', async () => {
    const result = await embed(['alpha', 'beta'], 'query');

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(configService.getFileSearchConfig().embeddingDimensions);
    expect(result.vectors[1]).toHaveLength(configService.getFileSearchConfig().embeddingDimensions);
    // Distinct inputs must not collapse to identical vectors — a cheap
    // sanity check that the tenant returned real embeddings, not a stub.
    expect(result.vectors[0]).not.toEqual(result.vectors[1]);
  }, 30_000);
});
