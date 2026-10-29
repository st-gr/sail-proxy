import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import VideoEmbed from './components/VideoEmbed.vue';
import TerminalFrame from './components/TerminalFrame.vue';
import ApiReference from './components/ApiReference.vue';
import './fonts.css';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VideoEmbed', VideoEmbed);
    app.component('TerminalFrame', TerminalFrame);
    app.component('ApiReference', ApiReference);
  }
} satisfies Theme;
