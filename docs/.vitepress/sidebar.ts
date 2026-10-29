import type { DefaultTheme } from 'vitepress';

export const sidebar: DefaultTheme.Sidebar = {
  '/guide/': [
    { text: 'Getting started', items: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Quick start', link: '/guide/quick-start' },
      { text: 'Features', link: '/guide/features' },
      { text: 'Roles', link: '/guide/roles' }
    ] },
    { text: 'Clients', collapsed: false, items: [
      { text: 'Claude Code', link: '/guide/clients/claude-code' },
      { text: 'Claude Desktop', link: '/guide/clients/claude-desktop' },
      { text: 'Codex CLI', link: '/guide/clients/codex' },
      { text: 'opencode', link: '/guide/clients/opencode' },
      { text: 'GitHub Copilot', link: '/guide/clients/github-copilot' },
      { text: 'Gemini CLI and SDK', link: '/guide/clients/gemini' },
      { text: 'pi', link: '/guide/clients/pi' },
      { text: 'OpenAI Realtime API', link: '/guide/clients/realtime' },
      { text: 'Tabular prediction (SAP-RPT)', link: '/guide/clients/tabular-prediction' },
      { text: 'Open WebUI', link: '/guide/clients/open-webui' },
      { text: 'AnythingLLM', link: '/guide/clients/anythingllm' },
      { text: 'n8n', link: '/guide/clients/n8n' },
      { text: 'OpenShell sandboxes', link: '/guide/clients/openshell' },
      { text: 'Other clients', link: '/guide/clients/other-clients' }
    ] },
    { text: 'Admin Cockpit', collapsed: false, items: [
      { text: 'Overview', link: '/guide/cockpit/overview' },
      { text: 'API keys', link: '/guide/cockpit/api-keys' },
      { text: 'AWS credentials', link: '/guide/cockpit/aws-credentials' },
      { text: 'Usage analytics', link: '/guide/cockpit/usage-analytics' },
      { text: 'Security notifications', link: '/guide/cockpit/security-notifications' },
      { text: 'Model library and entitlements', link: '/guide/cockpit/model-library' },
      { text: 'Grounding', link: '/guide/cockpit/grounding' },
      { text: 'Users and quotas', link: '/guide/cockpit/users-quotas' },
      { text: 'Tool governance', link: '/guide/cockpit/tool-governance' },
      { text: 'Connections', link: '/guide/cockpit/connections' },
      { text: 'Gateway configuration', link: '/guide/cockpit/configuration' },
      { text: 'Operations and audit trail', link: '/guide/cockpit/operations' }
    ] },
    { text: 'Help', items: [
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
      { text: 'FAQ', link: '/guide/faq' },
      { text: 'Videos', link: '/guide/videos' }
    ] }
  ],
  '/deploy/': [
    { text: 'Deploy', items: [
      { text: 'Deployment options', link: '/deploy/overview' },
      { text: 'Standalone CLI', link: '/deploy/cli' },
      { text: 'Docker Compose', link: '/deploy/docker' },
      { text: 'SAP BTP Kyma', link: '/deploy/kyma' },
      { text: 'Kyma prerequisites', link: '/deploy/kyma-prerequisites' }
    ] },
    { text: 'Operate', items: [
      { text: 'Authentication providers', link: '/deploy/authentication', items: [
        { text: 'GitHub', link: '/deploy/auth-github' },
        { text: 'LDAP', link: '/deploy/auth-ldap' },
        { text: 'Okta', link: '/deploy/auth-okta' }
      ] },
      { text: 'File storage for file_search', link: '/deploy/file-storage' },
      { text: 'Database migration', link: '/deploy/database-migration' },
      { text: 'Backup, restore and upgrade', link: '/deploy/backup-and-upgrade' }
    ] }
  ],
  '/reference/': [
    { text: 'Reference', items: [
      { text: 'API endpoints', link: '/reference/api-endpoints' },
      { text: 'API reference', link: '/reference/api' },
      { text: 'API examples', link: '/reference/api-examples' },
      { text: 'API authentication', link: '/reference/authentication' },
      { text: 'Gateway configuration reference', link: '/reference/configuration' },
      { text: 'Environment variables', link: '/reference/environment-variables' },
      { text: 'Ollama API', link: '/reference/ollama-api' }
    ] }
  ],
  '/developer/': [
    { text: 'Getting started', items: [
      { text: 'Development setup', link: '/developer/setup' },
      { text: 'Windows development setup', link: '/developer/windows-setup' },
      { text: 'Workspace layout', link: '/developer/workspace-layout' }
    ] },
    { text: 'Services', items: [
      { text: 'Architecture', link: '/developer/architecture' },
      { text: 'Gateway service', link: '/developer/gateway' },
      { text: 'Running and testing the gateway', link: '/developer/gateway-testing' },
      { text: 'Admin service (CAP)', link: '/developer/admin-cockpit' },
      { text: 'UI5 application development', link: '/developer/ui5-apps' },
      { text: 'Ollama service', link: '/developer/ollama-service' }
    ] },
    { text: 'Build and test', items: [
      { text: 'Docker images and build', link: '/developer/docker-images' },
      { text: 'The nginx image', link: '/developer/nginx' },
      { text: 'Testing strategy', link: '/developer/testing-strategy' },
      { text: 'Debugging and troubleshooting (developer)', link: '/developer/debugging' },
      { text: 'Release procedure', link: '/developer/release' }
    ] },
    { text: 'Internals', items: [
      { text: 'Plugin system', link: '/developer/plugins' },
      { text: 'Security implementation', link: '/developer/security' },
      { text: 'Pseudonymization security assessment', link: '/developer/pseudonymization-assessment' },
      { text: 'Tool governance internals', link: '/developer/tool-governance' },
      { text: 'Model library and entitlements internals', link: '/developer/model-library-entitlements' },
      { text: 'Connections internals', link: '/developer/connections' },
      { text: 'The hosted file_search tool', link: '/developer/file-search-tool' },
      { text: 'Reranker teacher datasets', link: '/developer/reranker-datasets' }
    ] },
    { text: 'Project', items: [
      { text: 'Contributing', link: '/developer/contributing' },
      { text: 'Attribution and trademarks', link: '/developer/attribution' }
    ] }
  ]
};
