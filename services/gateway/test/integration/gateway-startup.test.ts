/**
 * Integration Tests for Gateway Startup Behavior
 * Tests the gateway initialization in different modes and configurations
 * 
 * ⚠️ DISABLED: This test spawns real gateway/admin processes and has the following issues:
 * - Takes 30+ seconds to run per test case
 * - Frequently times out waiting for service startup
 * - Causes port conflicts and async cleanup issues
 * - Should be refactored to use service mocks instead of process spawning
 * 
 * This test is excluded in jest.config.json until properly refactored.
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// Test-scoped config channel: publishing on the production channel of the shared
// Valkey would deliver test config events to any LIVE gateway on this machine
// (this once wiped a live gateway's active config). The spawned gateway under
// test is pointed at this channel via the CONFIG_CHANGE_CHANNEL env override.
const TEST_CONFIG_CHANNEL = 'sap-llm-gateway:config-changed-test';
import axios from 'axios';
import Redis from 'iovalkey';
import { getAvailablePorts } from '../../../../libs/test-utils/src/port-utils';

describe('Gateway Startup Behavior', () => {
  let gatewayProcess: ChildProcess | null = null;
  let valkeyClient: Redis | null = null;
  let adminServerProcess: ChildProcess | null = null;
  let GATEWAY_PORT: number;
  let ADMIN_PORT: number;
  
  const VALKEY_URL = process.env.TEST_VALKEY_URL || 'redis://localhost:6379';
  const TEST_TIMEOUT = 15000; // Reduced from 30s

  beforeAll(async () => {
    // Get available ports to avoid conflicts
    [GATEWAY_PORT, ADMIN_PORT] = await getAvailablePorts(2, 3000);
    
    // Setup test Valkey connection
    try {
      valkeyClient = new Redis(VALKEY_URL);
      await valkeyClient.ping();
    } catch (error) {
      console.warn('Valkey not available for testing:', error);
      valkeyClient = null;
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await stopGateway();
    await stopAdminServer();
  });

  const cleanup = async () => {
    await stopGateway();
    await stopAdminServer();
    if (valkeyClient) {
      await valkeyClient.quit();
      valkeyClient = null;
    }
  };

  const stopGateway = async () => {
    if (gatewayProcess) {
      gatewayProcess.kill('SIGTERM');
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          gatewayProcess?.kill('SIGKILL');
          resolve();
        }, 2000);
        
        gatewayProcess?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      
      gatewayProcess = null;
    }
  };

  const stopAdminServer = async () => {
    if (adminServerProcess) {
      adminServerProcess.kill('SIGTERM');
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          adminServerProcess?.kill('SIGKILL');
          resolve();
        }, 2000);
        
        adminServerProcess?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      
      adminServerProcess = null;
    }
  };

  const startGateway = async (env: Record<string, string> = {}): Promise<{
    process: ChildProcess;
    ready: Promise<boolean>;
    logs: string[];
  }> => {
    const logs: string[] = [];
    let readyResolve: (value: boolean) => void;
    const readyPromise = new Promise<boolean>((resolve) => {
      readyResolve = resolve;
    });

    const gatewayEnv = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: GATEWAY_PORT.toString(),
      HOST: 'localhost',
      CONFIG_CHANGE_CHANNEL: TEST_CONFIG_CHANNEL,
      ...env
    };

    gatewayProcess = spawn('node', ['dist/services/gateway/src/index.js'], {
      cwd: path.join(__dirname, '../../'),
      env: gatewayEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let startupCompleted = false;
    let errorOccurred = false;

    gatewayProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      logs.push(output);
      console.log(`[Gateway] ${output.trim()}`);
      
      if (output.includes('Server listening on') && !startupCompleted) {
        startupCompleted = true;
        readyResolve(true);
      }
    });

    gatewayProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      logs.push(`ERROR: ${output}`);
      console.error(`[Gateway Error] ${output.trim()}`);
      
      if (output.includes('Failed to initialize') && !startupCompleted) {
        errorOccurred = true;
        readyResolve(false);
      }
    });

    gatewayProcess.on('exit', (code) => {
      if (!startupCompleted && !errorOccurred) {
        console.log(`[Gateway] Process exited with code ${code}`);
        readyResolve(false);
      }
    });

    return {
      process: gatewayProcess,
      ready: readyPromise,
      logs
    };
  };

  const startMockAdminServer = async (): Promise<ChildProcess> => {
    return new Promise((resolve, reject) => {
      const mockServer = spawn('node', ['-e', `
        const express = require('express');
        const app = express();
        app.use(express.json());
        
        // Mock configuration endpoint
        app.post('/odata/v4/AdminService/getActiveConfiguration', (req, res) => {
          console.log('[Mock Admin] Configuration requested');
          res.json({
            success: true,
            config: {
              id: 'test-config-1',
              name: 'Test Configuration',
              data: {
                openai: {
                  substitute_models: [
                    { from: "GPT-4", to: "o1" }
                  ],
                  emulate_streaming_for_models: []
                },
                anthropic: {
                  substitute_models: [
                    { from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" }
                  ],
                  emulate_streaming_for_models: ["anthropic--claude-3.7-sonnet"]
                }
              }
            },
            version: 1
          });
        });
        
        const server = app.listen(${ADMIN_PORT}, () => {
          console.log('[Mock Admin] Server started on port ${ADMIN_PORT}');
        });
        
        process.on('SIGTERM', () => {
          console.log('[Mock Admin] Shutting down');
          server.close();
          process.exit(0);
        });
      `], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      mockServer.stdout?.on('data', (data) => {
        console.log(`[Mock Admin] ${data.toString().trim()}`);
        if (data.toString().includes('Server started')) {
          adminServerProcess = mockServer;
          resolve(mockServer);
        }
      });

      mockServer.stderr?.on('data', (data) => {
        console.error(`[Mock Admin Error] ${data.toString().trim()}`);
      });

      mockServer.on('exit', (code) => {
        console.log(`[Mock Admin] Process exited with code ${code}`);
      });

      setTimeout(() => reject(new Error('Mock admin server timeout')), 5000);
    });
  };

  const waitForHealthCheck = async (port: number, maxAttempts: number = 5): Promise<boolean> => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get(`http://localhost:${port}/health`, {
          timeout: 1500
        });
        if (response.status === 200) {
          return true;
        }
      } catch (error) {
        // Ignore and retry
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  };

  describe('Standalone Mode', () => {
    test('should start successfully in standalone mode', async () => {
      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'true',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'false'
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true);
      
      // Verify health endpoint is accessible
      const healthCheck = await waitForHealthCheck(GATEWAY_PORT);
      expect(healthCheck).toBe(true);
      
      // Check logs for standalone mode indicators
      const logContent = logs.join('\n');
      expect(logContent).toContain('standalone mode');
      expect(logContent).not.toContain('waiting for configuration from Admin Service');
    }, TEST_TIMEOUT);

    test('should use local configuration file in standalone mode', async () => {
      // Create a test config file
      const testConfigPath = path.join(__dirname, '../../api_config.json');
      const testConfig = {
        api_config: {
          openai: {
            substitute_models: [{ from: "test-model", to: "real-model" }]
          }
        }
      };
      
      fs.writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

      try {
        const { ready, logs } = await startGateway({
          GATEWAY_STANDALONE: 'true',
          CONFIG_FILE_PATH: testConfigPath
        });

        const isReady = await Promise.race([
          ready,
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
        ]);

        expect(isReady).toBe(true);
        
        const logContent = logs.join('\n');
        expect(logContent).toContain('Loaded configuration from local file');
      } finally {
        // Clean up test config file
        if (fs.existsSync(testConfigPath)) {
          fs.unlinkSync(testConfigPath);
        }
      }
    }, TEST_TIMEOUT);
  });

  describe('Non-Standalone Mode', () => {
    test('should handle Valkey connection failure and use HTTP fallback', async () => {
      // Start mock admin server first
      await startMockAdminServer();
      await new Promise(resolve => setTimeout(resolve, 1000));

      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'false',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        ADMIN_SERVICE_URL: `http://localhost:${ADMIN_PORT}`,
        VALKEY_URL: 'redis://invalid-host:6379', // Invalid host to test connection failure
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true);
      
      const logContent = logs.join('\n');
      // Since Valkey URL is present, it will try event-driven config first
      expect(logContent).toContain('Non-standalone mode with Valkey available - waiting for configuration');
      // When events timeout, it should fall back to HTTP
      expect(logContent).toContain('Failed to receive configuration via events');
      expect(logContent).toContain('falling back to HTTP');
    }, TEST_TIMEOUT);

    test('should wait for Valkey events when Valkey is available', async () => {
      if (!valkeyClient) {
        console.log('Skipping Valkey test - Valkey not available');
        return;
      }

      // Start mock admin server
      await startMockAdminServer();
      await new Promise(resolve => setTimeout(resolve, 1000));

      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'false',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        ADMIN_SERVICE_URL: `http://localhost:${ADMIN_PORT}`,
        VALKEY_URL: VALKEY_URL
      });

      // Wait a bit for startup
      await new Promise(resolve => setTimeout(resolve, 2000));

      const logContent = logs.join('\n');
      expect(logContent).toContain('Non-standalone mode with Valkey available - waiting for configuration');
      expect(logContent).toContain('Valkey available - configuration will be loaded via events');

      // Simulate config change event from admin service
      const configEvent = {
        eventType: 'configuration-activated',
        configId: 'test-config-1',
        configName: 'Test Configuration',
        version: 1,
        configData: {
          openai: {
            substitute_models: [{ from: "GPT-4", to: "o1" }]
          },
          anthropic: {
            substitute_models: [{ from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" }]
          }
        }
      };

      await valkeyClient.publish(TEST_CONFIG_CHANNEL, JSON.stringify(configEvent));

      // Now the gateway should start
      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10000))
      ]);

      expect(isReady).toBe(true);
    }, TEST_TIMEOUT);

    test('should fallback to HTTP when Valkey events timeout', async () => {
      if (!valkeyClient) {
        console.log('Skipping Valkey timeout test - Valkey not available');
        return;
      }

      // Start mock admin server
      await startMockAdminServer();
      await new Promise(resolve => setTimeout(resolve, 1000));

      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'false',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        ADMIN_SERVICE_URL: `http://localhost:${ADMIN_PORT}`,
        VALKEY_URL: VALKEY_URL
      });

      // Don't send Valkey event - let it timeout and fallback to HTTP
      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15000))
      ]);

      expect(isReady).toBe(true);
      
      const logContent = logs.join('\n');
      expect(logContent).toContain('Failed to receive configuration via events');
      expect(logContent).toContain('falling back to HTTP');
    }, 20000);
  });

  describe('Error Handling', () => {
    test('should handle admin service unavailable gracefully', async () => {
      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'false',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        ADMIN_SERVICE_URL: 'http://localhost:9999', // Non-existent port
        // No VALKEY_URL to avoid event waiting
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true); // Should still start with fallback config
      
      const logContent = logs.join('\n');
      expect(logContent).toContain('Failed to fetch configuration');
      expect(logContent).toContain('Using default configuration');
    }, TEST_TIMEOUT);

    test('should handle invalid environment variables gracefully', async () => {
      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'false',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        ADMIN_SERVICE_URL: 'invalid-url',
        UNIFIED_AUTH_REQUEST_TIMEOUT_MS: 'not-a-number'
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true);
      
      const logContent = logs.join('\n');
      expect(logContent).toContain('Invalid integer value');
    }, TEST_TIMEOUT);
  });

  describe('Configuration Detection', () => {
    test('should detect standalone mode with GATEWAY_STANDALONE=true', async () => {
      const { ready, logs } = await startGateway({
        GATEWAY_STANDALONE: 'true',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true', // This should be ignored
        ADMIN_SERVICE_URL: `http://localhost:${ADMIN_PORT}`,
        VALKEY_URL: VALKEY_URL
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true);
      
      const logContent = logs.join('\n');
      expect(logContent).toContain('standalone mode');
    }, TEST_TIMEOUT);

    test('should detect standalone mode when unified token system disabled', async () => {
      const { ready, logs } = await startGateway({
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'false',
        ADMIN_SERVICE_URL: `http://localhost:${ADMIN_PORT}`,
        VALKEY_URL: VALKEY_URL
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true);
      
      const logContent = logs.join('\n');
      expect(logContent).toContain('standalone mode');
    }, TEST_TIMEOUT);

    test('should detect standalone mode when ADMIN_SERVICE_URL missing', async () => {
      const { ready, logs } = await startGateway({
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        // ADMIN_SERVICE_URL intentionally omitted
        VALKEY_URL: VALKEY_URL
      });

      const isReady = await Promise.race([
        ready,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), TEST_TIMEOUT))
      ]);

      expect(isReady).toBe(true);
      
      const logContent = logs.join('\n');
      expect(logContent).toContain('standalone mode');
    }, TEST_TIMEOUT);
  });
});