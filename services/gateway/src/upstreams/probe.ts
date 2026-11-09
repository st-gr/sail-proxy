/**
 * The GET calls a connection test and a model listing make: bounded by a 10 s timeout, never
 * throwing on an HTTP status, and turning any outcome into a reason code without upstream text.
 */
import axios, { AxiosResponse } from 'axios';
import { TestResult, UpstreamAuthError } from './types';

export const PROBE_TIMEOUT_MS = 10_000;

export function probe(url: string, headers: Record<string, string>): Promise<AxiosResponse> {
  return axios.get(url, { headers, timeout: PROBE_TIMEOUT_MS, validateStatus: () => true });
}

export function resultOf(response: AxiosResponse): TestResult {
  const status = response.status;
  if (status < 400) return { ok: true };
  if (status === 401) return { ok: false, error: { reason: 'unauthorized', status } };
  if (status === 403) return { ok: false, error: { reason: 'forbidden', status } };
  if (status === 404) return { ok: false, error: { reason: 'not_found', status } };
  const code = response.data?.error?.code;
  return { ok: false, error: { reason: 'upstream_error', status, ...(typeof code === 'string' ? { code } : {}) } };
}

/** A transport failure (or a refused Entra token) as a reason code. */
export function failureOf(error: any): TestResult {
  if (error instanceof UpstreamAuthError) {
    return { ok: false, error: { reason: error.status === 403 ? 'forbidden' : 'unauthorized', status: error.status } };
  }
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') return { ok: false, error: { reason: 'timeout' } };
  return { ok: false, error: { reason: 'unreachable' } };
}

export async function runTest(request: () => Promise<{ url: string; headers: Record<string, string> }>): Promise<TestResult> {
  try {
    const { url, headers } = await request();
    return resultOf(await probe(url, headers));
  } catch (error) {
    return failureOf(error);
  }
}

export const trimSlash = (url: string): string => url.replace(/\/+$/, '');
