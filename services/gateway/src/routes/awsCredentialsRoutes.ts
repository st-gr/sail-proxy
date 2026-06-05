import * as express from 'express';
import * as awsApiKeysController from '../controllers/awsApiKeysController';
import { gatewayStandaloneOnlyAuth } from '../middlewares/gatewayServiceAuth';

const router: express.Router = express.Router();

// Apply standalone-only authentication middleware
router.use(gatewayStandaloneOnlyAuth);

/**
 * @swagger
 * /aws/api-keys:
 *   post:
 *     summary: Create new AWS credentials
 *     description: Generate new AWS access key ID and secret access key for authentication
 *     tags: [AWS Authentication]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User identifier (optional)
 *                 example: "user123"
 *     responses:
 *       201:
 *         description: AWS credentials created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 AWS_ACCESS_KEY_ID:
 *                   type: string
 *                   description: AWS-style access key ID
 *                   example: "AKIAIOSFODNN7EXAMPLE"
 *                 AWS_SECRET_ACCESS_KEY:
 *                   type: string
 *                   description: AWS-style secret access key
 *                   example: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
 *       500:
 *         description: Internal server error
 */
router.post('/', awsApiKeysController.createAwsCredentials);

/**
 * @swagger
 * /aws/api-keys:
 *   get:
 *     summary: List AWS credentials
 *     description: Retrieve all AWS credentials (without secret keys)
 *     tags: [AWS Authentication]
 *     responses:
 *       200:
 *         description: List of AWS credentials
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Credential ID
 *                   accessKeyId:
 *                     type: string
 *                     description: AWS access key ID
 *                   userId:
 *                     type: string
 *                     description: User identifier
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                     description: Creation timestamp
 *                   isActive:
 *                     type: boolean
 *                     description: Whether the credential is active
 *       500:
 *         description: Internal server error
 */
router.get('/', awsApiKeysController.listAwsCredentials);

/**
 * @swagger
 * /aws/api-keys/{accessKeyId}:
 *   delete:
 *     summary: Revoke AWS credentials
 *     description: Revoke AWS credentials by access key ID
 *     tags: [AWS Authentication]
 *     parameters:
 *       - in: path
 *         name: accessKeyId
 *         required: true
 *         schema:
 *           type: string
 *         description: AWS access key ID to revoke
 *     responses:
 *       200:
 *         description: Credentials revoked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Credentials revoked successfully"
 *       404:
 *         description: Credentials not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:accessKeyId', awsApiKeysController.revokeAwsCredentials);

/**
 * @swagger
 * /aws/api-keys/set-keys:
 *   patch:
 *     summary: Set AWS credential keys (for restoration)
 *     description: Update the access key ID and secret access key for an existing credential
 *     tags: [AWS Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - credentialId
 *               - accessKeyId
 *               - secretAccessKey
 *             properties:
 *               credentialId:
 *                 type: string
 *                 description: Credential ID to update
 *                 example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *               accessKeyId:
 *                 type: string
 *                 description: AWS-style access key ID (AKIA...)
 *                 example: "AKIAIOSFODNN7EXAMPLE"
 *               secretAccessKey:
 *                 type: string
 *                 description: AWS-style secret access key (40 characters)
 *                 example: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
 *     responses:
 *       200:
 *         description: Credentials updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Credentials updated successfully"
 *       400:
 *         description: Validation error or duplicate access key
 *       404:
 *         description: Credential not found
 *       500:
 *         description: Internal server error
 */
router.patch('/set-keys', awsApiKeysController.setAwsCredentialKeys);

export default router;