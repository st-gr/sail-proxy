<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as AsciinemaPlayer from 'asciinema-player';
import 'asciinema-player/dist/bundle/asciinema-player.css';

// Every committed cast, bundled as text; the frame picks its own by video and name.
const casts = import.meta.glob('../../../../screencast/videos/*/casts/*.cast', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const props = defineProps<{ video: string; name: string }>();
const el = ref<HTMLElement | null>(null);
const missing = ref(false);
let player: { dispose(): void } | null = null;
const lastSecond = (text: string) => { const lines = text.trim().split('\n'); return lines.length > 1 ? JSON.parse(lines[lines.length - 1])[0] : 0; };

onMounted(() => {
  const key = Object.keys(casts).find((k) => k.endsWith(`/${props.video}/casts/${props.name}.cast`));
  if (!key || !el.value) { missing.value = true; return; }
  const data = casts[key];
  const header = JSON.parse(data.split('\n')[0]);
  player = AsciinemaPlayer.create({ data }, el.value, {
    cols: header.width, rows: header.height, poster: `npt:${lastSecond(data)}`, idleTimeLimit: 2, fit: 'width', theme: 'sail', preload: true,
    terminalFontFamily: "'JetBrains Mono', Menlo, Consolas, monospace"
  });
});
onBeforeUnmount(() => { player?.dispose(); });
</script>

<template>
  <div v-if="missing" class="missing">No cast {{ video }}/{{ name }}</div>
  <div v-else ref="el"></div>
</template>
