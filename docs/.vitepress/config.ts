import { defineConfig } from 'vitepress';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sidebar } from './sidebar';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));

export default defineConfig({
  title: 'SAIL-PROXY',
  description: 'The SAP AI Core LLM gateway for the tools you already use: OpenAI, Anthropic, Bedrock, OpenRouter and Ollama API formats, per-user keys, usage and cost.',
  base: '/sail-proxy/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['superpowers/**', 'competitive/**', 'notes/**', '.generated/**', '**/README.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/sail-proxy/favicon-32x32.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/sail-proxy/favicon-16x16.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/sail-proxy/apple-touch-icon.png' }],
    ['meta', { property: 'og:image', content: 'https://st-gr.github.io/sail-proxy/og-image.png' }],
    ['meta', { name: 'theme-color', content: '#0064D9' }]
  ],
  markdown: { lineNumbers: false },
  themeConfig: {
    logo: { src: '/logo-badge.svg', alt: 'sail-proxy' },
    siteTitle: 'Documentation',
    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '^/guide/' },
      { text: 'Deploy', link: '/deploy/', activeMatch: '^/deploy/' },
      { text: 'Reference', link: '/reference/', activeMatch: '^/reference/' },
      { text: 'Developer', link: '/developer/', activeMatch: '^/developer/' },
      { text: 'Changelog', link: '/changelog' },
      { text: `v${pkg.version}`, link: '/changelog' }
    ],
    sidebar,
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: 'github', link: 'https://github.com/st-gr/sail-proxy' }],
    editLink: { pattern: 'https://github.com/st-gr/sail-proxy/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    footer: {
      message: 'Released under the AGPL-3.0 License. Not developed by or endorsed by SAP SE.',
      copyright: 'SAP, SAP AI Core and SAP BTP are trademarks of SAP SE. See <a href="/sail-proxy/developer/attribution">attribution</a>.'
    }
  }
});
