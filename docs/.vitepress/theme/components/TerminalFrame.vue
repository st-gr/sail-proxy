<script setup lang="ts">
import { defineClientComponent } from 'vitepress';
// asciinema-player touches the window at import; VitePress renders pages on the server, so the player
// is a client-only component.
const TerminalPlayer = defineClientComponent(() => import('./TerminalPlayer.vue'));
defineProps<{ video: string; name: string; title?: string }>();
</script>

<template>
  <figure class="terminal-frame">
    <div class="bar"><i></i><i></i><i></i><span>{{ title ?? 'Terminal' }}</span></div>
    <!-- the padding sits outside the player: fit: 'width' sizes the terminal to this box's content width -->
    <div class="term"><TerminalPlayer :video="video" :name="name" /></div>
    <figcaption v-if="$slots.default"><slot /></figcaption>
  </figure>
</template>

<style scoped>
.terminal-frame { margin: 1.5rem 0; border-radius: 10px; overflow: hidden; background: #0B1F33; box-shadow: 0 8px 28px rgba(0, 0, 0, .25); }
.bar { height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: #0F2A47; color: #8FD0FF; font-size: 13px; }
.bar i { width: 10px; height: 10px; border-radius: 50%; background: #33B1FF; opacity: .55; display: block; }
.bar span { margin-left: 6px; }
figcaption { padding: .6rem .9rem; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); font-size: .9rem; font-style: italic; }
:deep(.asciinema-player-theme-sail) { --term-color-foreground: #E6EEF7; --term-color-background: #0B1F33;
  --term-color-0: #0B1F33; --term-color-1: #FF7A7A; --term-color-2: #7CE38B; --term-color-3: #FFD77A; --term-color-4: #4DB1FF; --term-color-5: #D7A6FF; --term-color-6: #7FE0E8; --term-color-7: #E6EEF7;
  --term-color-8: #5B6B7B; --term-color-9: #FF9A9A; --term-color-10: #9CF0A8; --term-color-11: #FFE5A0; --term-color-12: #7FC8FF; --term-color-13: #E6C3FF; --term-color-14: #A8ECF2; --term-color-15: #FFFFFF; }
.term { padding: 8px 10px 12px; }
</style>
