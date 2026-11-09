/**
 * Model renames (providers.<name>.substitute_models) for the OpenAI-shaped routes.
 *
 * The anthropic, aws-bedrock, google and openrouter paths rename inside their own
 * controllers, each reading its own provider's list. /openai/v1/chat/completions and
 * /openai/v1/responses serve both the openai and the perplexity models, and the client's
 * name says nothing about which of the two it means (a 'from' is any name the client
 * sends), so both lists are consulted here: openai first, then perplexity, the first
 * that renames the model wins. Mounted directly in front of the controller, after auth,
 * tool governance and quota, the point at which the other providers rename; the OpenRouter
 * router, which shares handleChatCompletion, does not mount it.
 *
 * The rename replaces req.body.model, so from here on the request carries the upstream
 * name: it is what SAP AI Core receives, what the response reports back (as on the other
 * providers' paths) and what usage is recorded under, since cost is per real model.
 */
import { Request, Response, NextFunction, RequestHandler } from 'express';
import configService from '../services/configService';

/** Providers whose lists rename a model on the OpenAI-shaped routes, in lookup order. */
const OPENAI_COMPATIBLE_PROVIDERS = ['openai', 'perplexity'] as const;

export const substituteOpenAICompatibleModel: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const requested = req.body?.model;
  if (typeof requested === 'string' && requested) {
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      const renamed = configService.getSubstitutedModel(provider, requested);
      if (renamed !== requested) {
        req.body.model = renamed;
        break;
      }
    }
  }
  next();
};
