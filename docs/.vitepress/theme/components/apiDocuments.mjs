// The four OpenAPI documents the API reference page shows, in its selector's order. sync-openapi.mjs copies them
// to docs/public/openapi/, so the page loads them from the site's own base path.
export const API_DOCUMENTS = [
  { file: 'gateway.yaml', name: 'Gateway' },
  { file: 'admin-odata.json', name: 'Admin OData' },
  { file: 'admin-rest.yaml', name: 'Admin REST' },
  { file: 'ollama.yaml', name: 'Ollama' }
];

// Swagger UI's stylesheet, copied next to the documents by sync-openapi.mjs.
export const SWAGGER_CSS = '/openapi/swagger-ui.css';

export function documentUrls(withBase) {
  return API_DOCUMENTS.map(({ file, name }) => ({ url: withBase(`/openapi/${file}`), name }));
}
