import { getConfigPath } from '../utils/paths';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function prepareCodexCatalog(model: string, homeCatalogPath?: string):
  { catalogPath: string } | { skipped: true; note: string } {
  const src = homeCatalogPath || join(homedir(), '.codex', 'models_cache.json');
  if (!existsSync(src)) {
    return { skipped: true, note:
      `web_search skipped: no codex model catalog found. Seed it once with a run against OpenAI ` +
      `(e.g. OPENAI_API_KEY=<key> codex -c model_provider=openai -c model=${model} "hi"), then re-run. ` +
      `See docs/user/chapter-5-codex.md.` };
  }
  let cat: any;
  try { cat = JSON.parse(readFileSync(src, 'utf8')); } catch {
    return { skipped: true, note: `web_search skipped: ${src} did not parse as JSON.` };
  }
  if (!cat || typeof cat !== 'object' || !Array.isArray(cat.models)) {
    return { skipped: true, note: `web_search skipped: ${src} has no models[].` };
  }
  const entry = cat.models.find((m: any) => m && m.slug === model);
  if (!entry) return { skipped: true, note: `web_search skipped: model "${model}" not in ${src}.` };
  try {
    entry.use_responses_lite = false;
    const out = getConfigPath('codex-web-search-catalog.json');
    writeFileSync(out, JSON.stringify(cat, null, 2));
    return { catalogPath: out };
  } catch (e: any) {
    return { skipped: true, note: `web_search skipped: could not prepare catalog: ${e.message}` };
  }
}
