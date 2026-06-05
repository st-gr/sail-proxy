export interface ServiceKey {
  serviceurls: {
    AI_API_URL: string;
  };
  appname: string;
  clientid: string;
  clientsecret: string;
  identityzone: string;
  identityzoneid: string;
  url: string;
  'credential-type': string;
}

export interface ParsedConfig {
  SAP_AI_CORE_URL: string;
  AUTH_URL: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  SAP_AI_REGION: string;
  SAP_AI_RESOURCE_GROUP: string;
  PORT: string;
  GATEWAY_STANDALONE: string;
  OLLAMA_AUTOSTART: string;
}