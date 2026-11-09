export type DeployTarget = 'local' | 'docker' | 'btp' | 'xsa';

export interface ConfigOptions {
  deployTarget: DeployTarget;
  serviceName: string;
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  maxRequestSize: string;
  sapBindings?: any;
  xsaBindings?: any;
}

export interface DatabaseConfig {
  host: string;  
  port: number;
  database: string;
  username?: string;
  password?: string;
}

export interface LoggingConfig {  
  level: string;
  format: string;
  transports: string[];
}
