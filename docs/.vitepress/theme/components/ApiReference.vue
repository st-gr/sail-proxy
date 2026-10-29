<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { withBase } from 'vitepress';
import { documentUrls, SWAGGER_CSS } from './apiDocuments.mjs';

const documents = documentUrls(withBase);
const selected = ref(documents[0].url);
const container = ref<HTMLElement | null>(null);
const failed = ref('');
let SwaggerUI: ((options: Record<string, unknown>) => unknown) | null = null;

function render() {
  if (!SwaggerUI || !container.value) return;
  SwaggerUI({
    domNode: container.value,
    url: selected.value,
    supportedSubmitMethods: [],
    validatorUrl: null,
    deepLinking: false,
    defaultModelsExpandDepth: 0,
    docExpansion: 'list'
  });
}

onMounted(async () => {
  try {
    // Exception to the top-level-imports rule: Swagger UI touches window and document when its module loads, so
    // VitePress's server-side render cannot import it; it is loaded in the browser only, from the pinned package.
    // Its stylesheet is a public file (sync-openapi.mjs copies it), linked here so it loads on this page only: a CSS
    // asset in the bundle would become the stylesheet VitePress links on every page in place of the site's own.
    const bundle = await import('swagger-ui-dist/swagger-ui-es-bundle.js');
    if (!document.querySelector('link[data-swagger-ui]')) {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: withBase(SWAGGER_CSS) });
      link.dataset.swaggerUi = '';
      document.head.append(link);
    }
    SwaggerUI = bundle.default;
    render();
  } catch (error) {
    failed.value = String(error);
  }
});

watch(selected, render);
</script>

<template>
  <div class="api-reference vp-raw">
    <label class="picker">
      <span>Document</span>
      <select v-model="selected">
        <option v-for="d in documents" :key="d.url" :value="d.url">{{ d.name }}</option>
      </select>
      <a :href="selected" download>Download</a>
    </label>
    <p v-if="failed" class="failed">The API reference could not be loaded: {{ failed }}</p>
    <div ref="container" class="swagger-host"></div>
  </div>
</template>

<style scoped>
.api-reference { margin-top: 1.5rem; }
.picker { display: flex; align-items: center; gap: .75rem; font-size: .95rem; }
.picker select { padding: .35rem .6rem; border: 1px solid var(--vp-c-border); border-radius: 6px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); font: inherit; }
.picker a { color: var(--vp-c-brand-1); }
.failed { color: var(--vp-c-danger-1); }

/* Swagger UI's own stylesheet is light only; these follow the site's colours in both themes. */
.swagger-host :deep(.swagger-ui) { font-family: var(--vp-font-family-base); color: var(--vp-c-text-1); }
.swagger-host :deep(.swagger-ui .info .title),
.swagger-host :deep(.swagger-ui .info p),
.swagger-host :deep(.swagger-ui .info li),
.swagger-host :deep(.swagger-ui .opblock-tag),
.swagger-host :deep(.swagger-ui .opblock-tag small),
.swagger-host :deep(.swagger-ui .opblock .opblock-summary-path),
.swagger-host :deep(.swagger-ui .opblock .opblock-summary-description),
.swagger-host :deep(.swagger-ui .opblock-description-wrapper p),
.swagger-host :deep(.swagger-ui .opblock-external-docs-wrapper p),
.swagger-host :deep(.swagger-ui .opblock-title_normal p),
.swagger-host :deep(.swagger-ui .markdown p),
.swagger-host :deep(.swagger-ui .markdown li),
.swagger-host :deep(.swagger-ui .renderedMarkdown p),
.swagger-host :deep(.swagger-ui .renderedMarkdown li),
.swagger-host :deep(.swagger-ui .opblock .opblock-section-header h4),
.swagger-host :deep(.swagger-ui .tab li),
.swagger-host :deep(.swagger-ui table thead tr th),
.swagger-host :deep(.swagger-ui table thead tr td),
.swagger-host :deep(.swagger-ui .parameter__name),
.swagger-host :deep(.swagger-ui .parameter__type),
.swagger-host :deep(.swagger-ui .parameter__in),
.swagger-host :deep(.swagger-ui .response-col_status),
.swagger-host :deep(.swagger-ui .response-col_links),
.swagger-host :deep(.swagger-ui .responses-inner h4),
.swagger-host :deep(.swagger-ui .responses-inner h5),
.swagger-host :deep(.swagger-ui .model-title),
.swagger-host :deep(.swagger-ui .model),
.swagger-host :deep(.swagger-ui section.models h4),
.swagger-host :deep(.swagger-ui .servers-title),
.swagger-host :deep(.swagger-ui .servers > label),
.swagger-host :deep(.swagger-ui label),
.swagger-host :deep(.swagger-ui .btn) { color: var(--vp-c-text-1); }
.swagger-host :deep(.swagger-ui a),
.swagger-host :deep(.swagger-ui .info a) { color: var(--vp-c-brand-1); }
.swagger-host :deep(.swagger-ui .opblock-tag) { border-bottom-color: var(--vp-c-divider); }
.swagger-host :deep(.swagger-ui .scheme-container),
.swagger-host :deep(.swagger-ui .opblock .opblock-section-header) { background: var(--vp-c-bg-soft); box-shadow: none; }
.swagger-host :deep(.swagger-ui section.models),
.swagger-host :deep(.swagger-ui section.models .model-container) { border-color: var(--vp-c-divider); background: transparent; }
.swagger-host :deep(.swagger-ui .opblock-body pre),
.swagger-host :deep(.swagger-ui .markdown code),
.swagger-host :deep(.swagger-ui .renderedMarkdown code) { background: var(--vp-code-block-bg); color: var(--vp-c-text-1); }
.swagger-host :deep(.swagger-ui select),
.swagger-host :deep(.swagger-ui input) { background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); border-color: var(--vp-c-border); }
.swagger-host :deep(.swagger-ui svg:not(:root)) { fill: currentColor; }
</style>
