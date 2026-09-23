/**
 * SAP-RPT tabular prediction (spec 2026-09-22). Same chain as the other families minus tool
 * governance - there are no tools in a tabular request - and with NO hook execution: the
 * controller never consults hooks.defaults or models.overrides.<model>.hooks.
 *
 * `createUnifiedTokenAuth()` and `quotaEnforcement` answer 401/429 in the OpenAI envelope
 * everywhere else in the gateway; this route must answer in the SAP shape throughout, so
 * `shapeMiddlewareErrors` is mounted FIRST to reshape those two middlewares' refusals before they
 * reach the client. SAP's own relayed responses pass through it untouched.
 */
import express from 'express';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import * as sapRptController from '../controllers/sapRptController';
import { shapeMiddlewareErrors } from '../sapRpt/shapeMiddlewareErrors';

const router: express.Router = express.Router();
const auth = createUnifiedTokenAuth();

router.use(shapeMiddlewareErrors);
router.post('/:model/predict', auth, quotaEnforcement, sapRptController.predict);
router.post('/:model/predict-parquet', auth, quotaEnforcement, sapRptController.predictParquet);

export default router;
