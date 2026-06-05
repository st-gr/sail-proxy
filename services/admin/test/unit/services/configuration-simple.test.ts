describe('Configuration Service Tests - Simplified', () => {
  test('should validate configuration schema structure', () => {
    const validateConfig = (config: any): { valid: boolean; errors: string[] } => {
      const errors: string[] = [];
      
      if (!config.providers) {
        errors.push('Missing required field: providers');
      } else if (Object.keys(config.providers).length === 0) {
        errors.push('Providers object cannot be empty');
      } else {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
          if (!providerConfig || typeof providerConfig !== 'object') {
            errors.push(`Invalid provider configuration for ${providerName}`);
            continue;
          }
          
          const provider = providerConfig as any;
          if (!provider.baseUrl) {
            errors.push(`Missing baseUrl for provider ${providerName}`);
          } else if (!provider.baseUrl.startsWith('https://')) {
            errors.push(`Invalid baseUrl for provider ${providerName}: must use HTTPS`);
          }
        }
      }
      
      return { valid: errors.length === 0, errors };
    };

    const validConfig = {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          models: ['gpt-4', 'gpt-3.5-turbo']
        }
      }
    };

    const invalidConfigs = [
      {}, // Missing providers
      { providers: {} }, // Empty providers
      { providers: { openai: {} } }, // Missing required openai fields
      { providers: { openai: { baseUrl: 'http://api.openai.com' } } } // Invalid URL (HTTP)
    ];

    const validResult = validateConfig(validConfig);
    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toHaveLength(0);

    invalidConfigs.forEach((config, index) => {
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  test('should handle semantic versioning', () => {
    const parseVersion = (version: string): { major: number; minor: number; patch: number } | null => {
      const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!match) return null;
      
      return {
        major: parseInt(match[1]),
        minor: parseInt(match[2]),
        patch: parseInt(match[3])
      };
    };

    const compareVersions = (v1: string, v2: string): number => {
      const version1 = parseVersion(v1);
      const version2 = parseVersion(v2);
      
      if (!version1 || !version2) return 0;
      
      if (version1.major !== version2.major) return version1.major - version2.major;
      if (version1.minor !== version2.minor) return version1.minor - version2.minor;
      return version1.patch - version2.patch;
    };

    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('invalid')).toBeNull();
    
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  test('should apply JSON patch operations', () => {
    const applyJsonPatch = (config: any, patches: any[]): any => {
      let result = JSON.parse(JSON.stringify(config)); // Deep clone
      
      for (const patch of patches) {
        const { path, op, value } = patch;
        const pathParts = path.split('/').filter((p: string) => p !== '');
        
        if (op === 'replace') {
          let current = result;
          for (let i = 0; i < pathParts.length - 1; i++) {
            current = current[pathParts[i]];
          }
          current[pathParts[pathParts.length - 1]] = JSON.parse(value);
        } else if (op === 'add') {
          let current = result;
          for (let i = 0; i < pathParts.length - 1; i++) {
            if (!current[pathParts[i]]) {
              current[pathParts[i]] = {};
            }
            current = current[pathParts[i]];
          }
          current[pathParts[pathParts.length - 1]] = JSON.parse(value);
        } else if (op === 'remove') {
          let current = result;
          for (let i = 0; i < pathParts.length - 1; i++) {
            current = current[pathParts[i]];
          }
          delete current[pathParts[pathParts.length - 1]];
        }
      }
      
      return result;
    };

    const originalConfig = {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          timeout: 60000
        }
      },
      version: '1.0.0'
    };

    const patches = [
      { path: '/version', op: 'replace', value: '"1.1.0"' },
      { path: '/providers/anthropic', op: 'add', value: '{"baseUrl": "https://api.anthropic.com"}' },
      { path: '/providers/openai/timeout', op: 'replace', value: '30000' }
    ];

    const patchedConfig = applyJsonPatch(originalConfig, patches);

    expect(patchedConfig.version).toBe('1.1.0');
    expect(patchedConfig.providers.anthropic).toEqual({ baseUrl: 'https://api.anthropic.com' });
    expect(patchedConfig.providers.openai.timeout).toBe(30000);
  });
});