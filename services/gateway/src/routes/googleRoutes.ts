/**
 * Google Gemini API routes with unified authentication.
 *
 * Mounted twice — `/google/v1beta` and `/google/v1` — because the `@google/genai`
 * SDK builds `<baseUrl>/<apiVersion>/models/<model>:<method>` and defaults its
 * apiVersion to v1beta. Express receives `<model>:<method>` as ONE path segment;
 * `parseModelMethod` splits it back apart in the controller.
 */
import express from 'express';
import * as googleController from '../controllers/googleController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { geminiError } from '../services/googleGeminiService';

const router: express.Router = express.Router();

const googleAuth = createUnifiedTokenAuth();
const googleServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.google);

router.post('/models/:modelAndMethod',
  googleAuth,
  googleServiceAuth,
  quotaEnforcement,
  googleController.handleGemini
);

// Everything else under the mount — `:countTokens`, a GET, `cachedContents`,
// batch embeddings — in the Gemini error shape rather than Express's HTML 404,
// which a Gemini client cannot parse. Deliberately unauthenticated: it reveals
// nothing but the route list.
router.use((_req: express.Request, res: express.Response) => {
  res.status(404).json(geminiError(404,
    'Not found. This gateway serves POST /google/{v1beta|v1}/models/<model>:<method> for '
    + 'generateContent, streamGenerateContent and embedContent.'));
});

export default router;
