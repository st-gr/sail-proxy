/**
 * AWS Credentials API Integration Tests
 *
 * Integration tests for AWS credential restoration endpoints:
 * - POST /aws/api-keys (with ID in response)
 * - PATCH /aws/api-keys/set-keys (restoration endpoint)
 * - Validation and error handling
 */

import { describe, beforeAll, afterAll, beforeEach, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express, { Express } from 'express';
import awsCredentialsRoutes from '../../src/routes/awsCredentialsRoutes';
import { awsCredentials } from '../../src/services/awsCredentialsService';

// Mock logger
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
  })
}));

// Mock standalone auth middleware
jest.mock('../../src/middlewares/gatewayServiceAuth', () => ({
  gatewayStandaloneOnlyAuth: (req: any, res: any, next: any) => next()
}));

describe('AWS Credentials API Integration', () => {
  let app: Express;
  // ONE listening server for the whole file; every request below goes through
  // it. Passing the app to supertest instead stands up an EPHEMERAL server per
  // call and tears it down when the response completes — under `forceExit: true`
  // plus workers competing for cores, that teardown races the response still
  // being written and the client reads a closed socket. It surfaces as
  // `Parse Error: Expected HTTP/, RTSP/ or ICE/` or `socket hang up` on a
  // passing assertion, intermittently: ~4% of full-suite runs under load,
  // across five suites that all shared this shape.
  let server: import('http').Server;

  beforeAll((done) => {
    // Setup express app with routes
    app = express();
    app.use(express.json());
    app.use('/aws/api-keys', awsCredentialsRoutes);
    server = app.listen(0, () => done());
  });

  afterAll((done) => { server.close(() => done()); });

  beforeEach(() => {
    // Clear credentials before each test
    awsCredentials.length = 0;
  });

  describe('POST /aws/api-keys', () => {
    it('should create credentials and return ID', async () => {
      const response = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' })
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('AWS_ACCESS_KEY_ID');
      expect(response.body).toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(response.body).toHaveProperty('AWS_REGION');

      // Verify ID format
      expect(response.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // Verify access key format
      expect(response.body.AWS_ACCESS_KEY_ID).toMatch(/^AKIA[A-Z0-9]{16}$/);

      // Verify secret length
      expect(response.body.AWS_SECRET_ACCESS_KEY).toHaveLength(40);
    });

    it('should create credentials without userId', async () => {
      const response = await request(server)
        .post('/aws/api-keys')
        .send({})
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('AWS_ACCESS_KEY_ID');
    });

    it('should create unique credentials on multiple calls', async () => {
      const response1 = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'user1' });

      const response2 = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'user2' });

      expect(response1.body.id).not.toBe(response2.body.id);
      expect(response1.body.AWS_ACCESS_KEY_ID).not.toBe(response2.body.AWS_ACCESS_KEY_ID);
    });
  });

  describe('PATCH /aws/api-keys/set-keys', () => {
    it('should successfully update credential keys', async () => {
      // Create a credential first
      const createResponse = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      const credentialId = createResponse.body.id;

      // Update the keys
      const updateResponse = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId,
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        })
        .expect(200);

      expect(updateResponse.body).toEqual({
        success: true,
        message: 'Credentials updated successfully'
      });

      // Verify the credential was actually updated
      expect(awsCredentials[0].accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(awsCredentials[0].reconstructedSecret).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    });

    it('should return 404 for non-existent credential ID', async () => {
      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: 'non-existent-id',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        })
        .expect(404);

      expect(response.body.error.message).toBe('Credential not found');
    });

    it('should validate accessKeyId format', async () => {
      const createResponse = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: createResponse.body.id,
          accessKeyId: 'INVALID_FORMAT',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        })
        .expect(400);

      expect(response.body.error.type).toBe('validation_error');
      expect(response.body.error.message).toContain('Invalid accessKeyId format');
    });

    it('should validate secretAccessKey length', async () => {
      const createResponse = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: createResponse.body.id,
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'too-short'
        })
        .expect(400);

      expect(response.body.error.type).toBe('validation_error');
      expect(response.body.error.message).toContain('Invalid secretAccessKey length');
    });

    it('should detect duplicate accessKeyId', async () => {
      // Create two credentials
      const cred1 = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'user1' });

      const cred2 = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'user2' });

      // Try to update cred2 with cred1's accessKeyId
      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: cred2.body.id,
          accessKeyId: cred1.body.AWS_ACCESS_KEY_ID,
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        })
        .expect(400);

      expect(response.body.error.type).toBe('duplicate_error');
      expect(response.body.error.message).toBe('AccessKeyId already exists');
    });

    it('should allow updating own accessKeyId', async () => {
      const createResponse = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      const originalAccessKeyId = createResponse.body.AWS_ACCESS_KEY_ID;

      // Update with the same accessKeyId should work
      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: createResponse.body.id,
          accessKeyId: originalAccessKeyId,
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /aws/api-keys', () => {
    it('should list credentials with ID field', async () => {
      // Create some credentials
      await request(server).post('/aws/api-keys').send({ userId: 'user1' });
      await request(server).post('/aws/api-keys').send({ userId: 'user2' });

      const response = await request(server)
        .get('/aws/api-keys')
        .expect(200);

      expect(response.body.credentials).toHaveLength(2);
      expect(response.body.credentials[0]).toHaveProperty('id');
      expect(response.body.credentials[0]).toHaveProperty('accessKeyId');
      expect(response.body.credentials[0]).toHaveProperty('userId');

      // Should not expose secrets
      expect(response.body.credentials[0]).not.toHaveProperty('secretAccessKey');
      expect(response.body.credentials[0]).not.toHaveProperty('secretHash');
    });
  });

  describe('DELETE /aws/api-keys/:accessKeyId', () => {
    it('should revoke credentials', async () => {
      const createResponse = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      const accessKeyId = createResponse.body.AWS_ACCESS_KEY_ID;

      await request(server)
        .delete(`/aws/api-keys/${accessKeyId}`)
        .expect(200);

      // Verify credential is marked inactive
      expect(awsCredentials[0].isActive).toBe(false);
    });

    it('should return 404 for non-existent credential', async () => {
      await request(server)
        .delete('/aws/api-keys/AKIAINVALIDKEY123456')
        .expect(404);
    });
  });

  describe('Complete restoration workflow', () => {
    it('should support full create-restore cycle', async () => {
      // Step 1: Create initial credential
      const original = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      const savedId = original.body.id;
      const savedAccessKeyId = original.body.AWS_ACCESS_KEY_ID;
      const savedSecretAccessKey = original.body.AWS_SECRET_ACCESS_KEY;

      // Simulate restart - clear memory
      awsCredentials.length = 0;

      // Step 2: Create new credential with random keys
      const restored = await request(server)
        .post('/aws/api-keys')
        .send({ userId: 'test-user' });

      expect(restored.body.id).not.toBe(savedId);
      expect(restored.body.AWS_ACCESS_KEY_ID).not.toBe(savedAccessKeyId);

      // Step 3: Restore original keys
      await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: restored.body.id,
          accessKeyId: savedAccessKeyId,
          secretAccessKey: savedSecretAccessKey
        })
        .expect(200);

      // Verify restoration
      expect(awsCredentials[0].accessKeyId).toBe(savedAccessKeyId);
      expect(awsCredentials[0].reconstructedSecret).toBe(savedSecretAccessKey);
    });

    it('should restore multiple credentials', async () => {
      // Create multiple credentials
      const creds = [];
      for (let i = 0; i < 3; i++) {
        const response = await request(server)
          .post('/aws/api-keys')
          .send({ userId: `user${i}` });
        creds.push({
          id: response.body.id,
          accessKeyId: response.body.AWS_ACCESS_KEY_ID,
          secretAccessKey: response.body.AWS_SECRET_ACCESS_KEY
        });
      }

      // Simulate restart
      awsCredentials.length = 0;

      // Restore all
      for (let i = 0; i < 3; i++) {
        const newCred = await request(server)
          .post('/aws/api-keys')
          .send({ userId: `user${i}` });

        await request(server)
          .patch('/aws/api-keys/set-keys')
          .send({
            credentialId: newCred.body.id,
            accessKeyId: creds[i].accessKeyId,
            secretAccessKey: creds[i].secretAccessKey
          });
      }

      // Verify all restored
      expect(awsCredentials).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(awsCredentials[i].accessKeyId).toBe(creds[i].accessKeyId);
      }
    });
  });

  describe('Error handling', () => {
    it('should handle malformed JSON', async () => {
      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }')
        .expect(400);
    });

    it('should handle missing required fields', async () => {
      const response = await request(server)
        .patch('/aws/api-keys/set-keys')
        .send({
          credentialId: 'some-id'
          // Missing accessKeyId and secretAccessKey
        })
        .expect(400);
    });
  });
});
