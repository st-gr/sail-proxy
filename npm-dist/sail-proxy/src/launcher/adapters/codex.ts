import { HarnessAdapter, LaunchContext, LaunchPlan } from './types';
import { prepareCodexCatalog } from '../codex-catalog';
import { resolveBinary } from '../which';

const MODEL = 'gpt-5.6-sol';   // /responses auto-resolves to gpt-5.6-sol--deployed on the gateway
const KEY_ENV = 'SAILPROXY_KEY';

export const codexAdapter: HarnessAdapter = {
  name: 'codex',
  async locate() {
    return resolveBinary('codex', 'Install it from https://github.com/openai/codex or your usual channel.');
  },
  async plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan> {
    const notes: string[] = [];
    const overrides = [
      '-c', 'model_provider=sail-proxy',
      '-c', `model_providers.sail-proxy.name="sail-proxy"`,
      '-c', `model_providers.sail-proxy.base_url="${ctx.rootUrl}/openai/v1"`,
      '-c', `model_providers.sail-proxy.env_key="${KEY_ENV}"`,
      '-c', `model_providers.sail-proxy.wire_api="responses"`,
      '-c', `model=${MODEL}`,
    ];
    if (ctx.webSearch) {
      const cat = prepareCodexCatalog(MODEL);
      if ('catalogPath' in cat) {
        overrides.push('-c', 'web_search=live', '-c', `model_catalog_json="${cat.catalogPath}"`);
      } else {
        notes.push(cat.note);
      }
    }
    return { fileEdits: [], env: { [KEY_ENV]: ctx.apiKey }, notes, argv: [...overrides, ...passthrough] };
  },
};
