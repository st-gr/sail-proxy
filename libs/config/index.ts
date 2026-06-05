import { ConfigOptions, DeployTarget } from './types';
import * as path from 'path';
import * as fs from 'fs';

export class ConfigLoader {
  private deployTarget: DeployTarget;
  private serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.deployTarget = (process.env.DEPLOY_TARGET as DeployTarget) || 'local';
  }

  loadConfig(): ConfigOptions {
    const baseConfig = this.loadBaseConfig();
    const targetConfig = this.loadTargetConfig();
    const serviceConfig = this.loadServiceConfig();

    // Merge configs with proper defaults
    const mergedConfig = {
      ...baseConfig,
      ...targetConfig,
      ...serviceConfig,
      deployTarget: this.deployTarget,
      serviceName: this.serviceName
    };

    // Ensure all required properties are set
    return {
      deployTarget: mergedConfig.deployTarget,
      serviceName: mergedConfig.serviceName,
      port: mergedConfig.port || 3000,
      host: mergedConfig.host || '0.0.0.0',
      logLevel: mergedConfig.logLevel || 'info',
      maxRequestSize: mergedConfig.maxRequestSize || '10mb',
      sapBindings: mergedConfig.sapBindings,
      xsaBindings: mergedConfig.xsaBindings
    };
  }

  private loadBaseConfig(): Partial<ConfigOptions> {
    return {
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      maxRequestSize: '10mb'
    };
  }

  private loadTargetConfig(): Partial<ConfigOptions> {
    switch (this.deployTarget) {
      case 'local':
        return {
          host: process.env.HOST || '127.0.0.1',
          port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
          logLevel: 'debug'
        };
      case 'docker':
        return {
          host: process.env.HOST || '0.0.0.0',
          port: process.env.PORT ? parseInt(process.env.PORT) : 3000
        };
      case 'btp':
        return {
          host: process.env.HOST || '0.0.0.0',
          port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
          logLevel: 'warn',
          sapBindings: this.loadSAPBindings()
        };
      case 'xsa':
        return {
          host: process.env.HOST || '0.0.0.0',
          port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
          logLevel: 'error',
          xsaBindings: this.loadXSABindings()
        };
      default:
        return {};
    }
  }

  private loadServiceConfig(): Partial<ConfigOptions> {
    const configPath = path.join(
      process.cwd(),
      'services',
      this.serviceName,
      'config',
      `${this.deployTarget}.json`
    );

    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (error) {
        console.warn(`Failed to load service config from ${configPath}:`, error);
      }
    }

    return {};
  }

  private loadSAPBindings(): any {
    if (process.env.VCAP_SERVICES) {
      try {
        return JSON.parse(process.env.VCAP_SERVICES);
      } catch (error) {
        console.warn('Failed to parse VCAP_SERVICES:', error);
      }
    }
    return {};
  }

  private loadXSABindings(): any {
    if (process.env.HANA_SERVICE_NAME) {
      return {
        hana: {
          name: process.env.HANA_SERVICE_NAME,
          schema: process.env.HANA_SCHEMA
        }
      };
    }
    return {};
  }
}

export { DeployTarget, ConfigOptions } from './types';
