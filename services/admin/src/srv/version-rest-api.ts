/**
 * /api/version - the running version, the installation type and whether the cockpit's update check is
 * on. Admin only: 401 without a signed-in identity, 403 for a signed-in user without the admin role.
 */
import express from 'express';
import { getAdminVersion } from '../services/adminVersion';
import { installType, updateCheckEnabled } from '../services/installInfo';
import { adminOf } from './admin-caller';

const router: express.Router = express.Router();

router.get('/', (req, res) => {
  if (!adminOf(req, res)) return;
  res.status(200).json({ version: getAdminVersion(), installType: installType(), updateCheck: updateCheckEnabled() });
});

module.exports = router;
