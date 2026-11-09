import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import modelService from '../services/modelService';

const logger = getDefaultLogger();
const DEPLOYED = '--deployed';

/**
 * The name a request should carry on a route with substitute_models. The shipped lists map client
 * names to `X--deployed`; on a tenant without that deployment orchestration still serves `X`, so
 * the plain name replaces the client's. From there on it is what the request looks up, reports and
 * records usage under, as with any rename (middlewares/modelSubstitution.ts). Reads the cached model
 * list: a lookup of the missing name would rebuild that list on every request.
 */
export async function withoutMissingDeployment(provider: string, model: string): Promise<string> {
  const target = configService.getSubstitutedModel(provider, model, { quiet: true });
  if (typeof target !== 'string' || !target.endsWith(DEPLOYED)) return model;
  try {
    const ids = new Set((await modelService.getModels()).data.map((m) => m.id));
    if (ids.has(target)) return model;
    const plain = target.slice(0, -DEPLOYED.length);
    if (!ids.has(plain)) return model;
    logger.info('SubstitutionFallback', `${target} is not deployed; serving ${model} as ${plain} through orchestration`);
    return plain;
  } catch (error: any) {
    logger.warn('SubstitutionFallback', `Could not read the model list for ${model}: ${error.message}`);
    return model;
  }
}
