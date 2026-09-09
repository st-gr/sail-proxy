/**
 * Provider marks: one self-contained SVG data URI per provider on today's /v1/models list
 * (lobehub icons, MIT; SAP from simple-icons, CC0). Unknown providers fall back to initials.
 */
import { providerMark, PROVIDER_MARKS } from '../webapp/model/providerMarks';

const PROVIDERS = ['Amazon', 'Anthropic', 'Cohere', 'Google', 'Mistral AI', 'NVIDIA', 'OpenAI', 'Perplexity', 'SAP'];

describe('providerMark', () => {
  it('ships exactly the nine providers the gateway lists today', () => {
    expect(Object.keys(PROVIDER_MARKS).sort()).toEqual(PROVIDERS);
  });
  it.each(PROVIDERS)('%s is a self-contained, script-free SVG data URI with a fixed fill', (p) => {
    const m = providerMark(p);
    expect(m.src).toMatch(/^data:image\/svg\+xml;utf8,/);
    const svg = decodeURIComponent(m.src!.slice(m.src!.indexOf(',') + 1));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    expect(svg).toContain('fill="#32363a"');
    expect(svg).not.toMatch(/currentColor|<script|<title/);
    expect(m.initials).toBeUndefined();
  });
  it('derives initials for an unknown provider and never throws on empty input', () => {
    expect(providerMark('Acme Labs')).toEqual({ initials: 'AL' });
    expect(providerMark('unknown')).toEqual({ initials: 'UN' });
    expect(providerMark(undefined)).toEqual({ initials: '?' });
  });
});
