/**
 * AWS Credentials Restoration Tests
 *
 * Test suite for AWS credential restoration endpoints including:
 * - Creating credentials with ID in response
 * - Setting credential keys for restoration
 * - Duplicate checking
 * - Validation
 */

import { describe, beforeEach, it, expect, jest } from '@jest/globals';
import {
  createAwsCredentials,
  findAwsCredentialByAccessKeyId,
  setAwsCredentialKeys,
  listAwsCredentials,
  awsCredentials
} from '../src/services/awsCredentialsService';

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

describe('AWS Credentials Restoration', () => {
  beforeEach(() => {
    // Clear the in-memory credentials array before each test
    awsCredentials.length = 0;
  });

  describe('createAwsCredentials', () => {
    it('should return credential ID in response', async () => {
      const response = await createAwsCredentials('test-user');

      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('AWS_ACCESS_KEY_ID');
      expect(response).toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(response).toHaveProperty('AWS_REGION');

      // Verify ID format (UUID)
      expect(response.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // Verify access key format
      expect(response.AWS_ACCESS_KEY_ID).toMatch(/^AKIA[A-Z0-9]{16}$/);

      // Verify secret key format (40 hex chars)
      expect(response.AWS_SECRET_ACCESS_KEY).toHaveLength(40);
      expect(response.AWS_SECRET_ACCESS_KEY).toMatch(/^[0-9a-f]{40}$/);

      // Verify region
      expect(response.AWS_REGION).toBeDefined();
    });

    it('should create unique credentials for each call', async () => {
      const cred1 = await createAwsCredentials('user1');
      const cred2 = await createAwsCredentials('user2');

      expect(cred1.id).not.toBe(cred2.id);
      expect(cred1.AWS_ACCESS_KEY_ID).not.toBe(cred2.AWS_ACCESS_KEY_ID);
      expect(cred1.AWS_SECRET_ACCESS_KEY).not.toBe(cred2.AWS_SECRET_ACCESS_KEY);
    });

    it('should store credential in memory with correct structure', async () => {
      const response = await createAwsCredentials('test-user');

      expect(awsCredentials).toHaveLength(1);

      const stored = awsCredentials[0];
      expect(stored.id).toBe(response.id);
      expect(stored.accessKeyId).toBe(response.AWS_ACCESS_KEY_ID);
      expect(stored.userId).toBe('test-user');
      expect(stored.isActive).toBe(true);
      expect(stored.secretHash).toBeDefined();
      expect(stored.salt).toBeDefined();
      expect(stored.reconstructedSecret).toBe(response.AWS_SECRET_ACCESS_KEY);
    });
  });

  describe('findAwsCredentialByAccessKeyId', () => {
    it('should find existing credential by accessKeyId', async () => {
      const created = await createAwsCredentials('user1');

      const found = await findAwsCredentialByAccessKeyId(created.AWS_ACCESS_KEY_ID);

      expect(found).toBeDefined();
      expect(found?.accessKeyId).toBe(created.AWS_ACCESS_KEY_ID);
      expect(found?.id).toBe(created.id);
    });

    it('should return undefined for non-existent accessKeyId', async () => {
      const found = await findAwsCredentialByAccessKeyId('AKIAINVALIDKEY123456');

      expect(found).toBeUndefined();
    });

    it('should exclude credential with matching excludeId', async () => {
      const created = await createAwsCredentials('user1');

      const found = await findAwsCredentialByAccessKeyId(
        created.AWS_ACCESS_KEY_ID,
        created.id
      );

      expect(found).toBeUndefined();
    });

    it('should find credential when excludeId is different', async () => {
      const created = await createAwsCredentials('user1');

      const found = await findAwsCredentialByAccessKeyId(
        created.AWS_ACCESS_KEY_ID,
        'different-id'
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });
  });

  describe('setAwsCredentialKeys', () => {
    it('should successfully update credential keys', async () => {
      const created = await createAwsCredentials('user1');

      const newAccessKeyId = 'AKIAIOSFODNN7EXAMPLE';
      const newSecretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

      const result = await setAwsCredentialKeys(
        created.id,
        newAccessKeyId,
        newSecretAccessKey
      );

      expect(result).toBe(true);

      // Verify the credential was updated
      const updated = awsCredentials[0];
      expect(updated.accessKeyId).toBe(newAccessKeyId);
      expect(updated.reconstructedSecret).toBe(newSecretAccessKey);

      // Verify new hash was generated
      expect(updated.secretHash).toBeDefined();
      expect(updated.salt).toBeDefined();

      // Hash should be different from original (different salt)
      expect(updated.secretHash).not.toBe(created.id);
    });

    it('should return false for non-existent credential ID', async () => {
      const result = await setAwsCredentialKeys(
        'non-existent-id',
        'AKIAIOSFODNN7EXAMPLE',
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
      );

      expect(result).toBe(false);
    });

    it('should maintain other credential properties', async () => {
      const created = await createAwsCredentials('user1');
      const originalUserId = awsCredentials[0].userId;
      const originalIsActive = awsCredentials[0].isActive;
      const originalCreatedAt = awsCredentials[0].createdAt;

      await setAwsCredentialKeys(
        created.id,
        'AKIAIOSFODNN7EXAMPLE',
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
      );

      const updated = awsCredentials[0];
      expect(updated.userId).toBe(originalUserId);
      expect(updated.isActive).toBe(originalIsActive);
      expect(updated.createdAt).toEqual(originalCreatedAt);
    });

    it('should regenerate salt and hash with new credentials', async () => {
      const created = await createAwsCredentials('user1');
      const originalSalt = awsCredentials[0].salt;
      const originalHash = awsCredentials[0].secretHash;

      await setAwsCredentialKeys(
        created.id,
        'AKIAIOSFODNN7EXAMPLE',
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
      );

      const updated = awsCredentials[0];
      expect(updated.salt).not.toBe(originalSalt);
      expect(updated.secretHash).not.toBe(originalHash);
    });
  });

  describe('Restoration workflow', () => {
    it('should simulate complete restoration flow', async () => {
      // Step 1: Create initial credential
      const original = await createAwsCredentials('test-user');

      // Save the keys (simulating persistence to JSON)
      const savedAccessKeyId = original.AWS_ACCESS_KEY_ID;
      const savedSecretAccessKey = original.AWS_SECRET_ACCESS_KEY;

      // Simulate gateway restart - clear memory
      awsCredentials.length = 0;

      // Step 2: Restoration - Create with random keys
      const restored = await createAwsCredentials('test-user');

      // Verify new random keys were generated
      expect(restored.AWS_ACCESS_KEY_ID).not.toBe(savedAccessKeyId);
      expect(restored.AWS_SECRET_ACCESS_KEY).not.toBe(savedSecretAccessKey);

      // Step 3: Restore original keys
      const updated = await setAwsCredentialKeys(
        restored.id,
        savedAccessKeyId,
        savedSecretAccessKey
      );

      expect(updated).toBe(true);

      // Verify original keys are restored
      const final = awsCredentials[0];
      expect(final.accessKeyId).toBe(savedAccessKeyId);
      expect(final.reconstructedSecret).toBe(savedSecretAccessKey);
      expect(final.userId).toBe('test-user');
      expect(final.isActive).toBe(true);
    });

    it('should handle multiple credentials restoration', async () => {
      // Create multiple credentials
      const cred1 = await createAwsCredentials('user1');
      const cred2 = await createAwsCredentials('user2');
      const cred3 = await createAwsCredentials('user3');

      // Save keys
      const saved = [
        { id: cred1.id, accessKeyId: cred1.AWS_ACCESS_KEY_ID, secret: cred1.AWS_SECRET_ACCESS_KEY },
        { id: cred2.id, accessKeyId: cred2.AWS_ACCESS_KEY_ID, secret: cred2.AWS_SECRET_ACCESS_KEY },
        { id: cred3.id, accessKeyId: cred3.AWS_ACCESS_KEY_ID, secret: cred3.AWS_SECRET_ACCESS_KEY }
      ];

      // Simulate restart
      awsCredentials.length = 0;

      // Restore all credentials
      const newCred1 = await createAwsCredentials('user1');
      const newCred2 = await createAwsCredentials('user2');
      const newCred3 = await createAwsCredentials('user3');

      await setAwsCredentialKeys(newCred1.id, saved[0].accessKeyId, saved[0].secret);
      await setAwsCredentialKeys(newCred2.id, saved[1].accessKeyId, saved[1].secret);
      await setAwsCredentialKeys(newCred3.id, saved[2].accessKeyId, saved[2].secret);

      // Verify all are restored
      expect(awsCredentials).toHaveLength(3);
      expect(awsCredentials[0].accessKeyId).toBe(saved[0].accessKeyId);
      expect(awsCredentials[1].accessKeyId).toBe(saved[1].accessKeyId);
      expect(awsCredentials[2].accessKeyId).toBe(saved[2].accessKeyId);
    });
  });

  describe('Duplicate detection', () => {
    it('should detect duplicate accessKeyId', async () => {
      const cred1 = await createAwsCredentials('user1');
      const cred2 = await createAwsCredentials('user2');

      // Try to set cred2 to have the same accessKeyId as cred1
      const duplicate = await findAwsCredentialByAccessKeyId(
        cred1.AWS_ACCESS_KEY_ID,
        cred2.id
      );

      expect(duplicate).toBeDefined();
      expect(duplicate?.id).toBe(cred1.id);
    });

    it('should not detect duplicate when excluding own ID', async () => {
      const cred1 = await createAwsCredentials('user1');

      const duplicate = await findAwsCredentialByAccessKeyId(
        cred1.AWS_ACCESS_KEY_ID,
        cred1.id
      );

      expect(duplicate).toBeUndefined();
    });
  });

  describe('listAwsCredentials', () => {
    it('should list credentials with ID field', async () => {
      await createAwsCredentials('user1');
      await createAwsCredentials('user2');

      const list = await listAwsCredentials();

      expect(list).toHaveLength(2);
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('accessKeyId');
      expect(list[0]).toHaveProperty('userId');
      expect(list[0]).toHaveProperty('createdAt');
      expect(list[0]).toHaveProperty('isActive');

      // Should not include secrets
      expect(list[0]).not.toHaveProperty('secretHash');
      expect(list[0]).not.toHaveProperty('secretAccessKey');
      expect(list[0]).not.toHaveProperty('reconstructedSecret');
    });
  });

  describe('Edge cases', () => {
    it('should handle rapid sequential operations', async () => {
      const cred = await createAwsCredentials('user1');

      // Rapid updates
      await setAwsCredentialKeys(cred.id, 'AKIA1111111111111111', '1111111111111111111111111111111111111111');
      await setAwsCredentialKeys(cred.id, 'AKIA2222222222222222', '2222222222222222222222222222222222222222');
      await setAwsCredentialKeys(cred.id, 'AKIA3333333333333333', '3333333333333333333333333333333333333333');

      const final = awsCredentials[0];
      expect(final.accessKeyId).toBe('AKIA3333333333333333');
      expect(final.reconstructedSecret).toBe('3333333333333333333333333333333333333333');
    });

    it('should maintain credential count during restoration', async () => {
      // Create 5 credentials
      for (let i = 0; i < 5; i++) {
        await createAwsCredentials(`user${i}`);
      }

      expect(awsCredentials).toHaveLength(5);

      // Update all of them
      for (let i = 0; i < 5; i++) {
        await setAwsCredentialKeys(
          awsCredentials[i].id,
          `AKIA${String(i).repeat(16)}`,
          `${String(i).repeat(40)}`
        );
      }

      // Count should remain the same
      expect(awsCredentials).toHaveLength(5);
    });
  });
});
