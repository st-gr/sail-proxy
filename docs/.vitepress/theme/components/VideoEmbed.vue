<script setup lang="ts">
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';
import catalog from '../../../../screencast/videos/catalog.json';

const props = defineProps<{ video: string }>();
const entry = computed(() => catalog.find((v) => v.id === props.video));
const playing = ref(false);
const startAt = ref(0);
const label = (t: number) => { const r = Math.round(t); return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`; };
const minutes = computed(() => (entry.value?.duration ? `${Math.round(entry.value.duration / 60)} min` : `about ${Math.round((entry.value?.targetSeconds ?? 0) / 60)} min`));
const embed = computed(() => `https://www.youtube-nocookie.com/embed/${entry.value?.youtubeId}?autoplay=1&rel=0&start=${Math.floor(startAt.value)}`);
const play = (t = 0) => { startAt.value = t; playing.value = true; };
</script>

<template>
  <div v-if="!entry" class="video-embed missing">Unknown video "{{ video }}"</div>
  <figure v-else class="video-embed">
    <div class="frame">
      <iframe v-if="playing && entry.youtubeId" :src="embed" :title="entry.title" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
      <button v-else-if="entry.youtubeId" type="button" class="poster" :style="entry.poster ? { backgroundImage: `url(${withBase(`/videos/${entry.id}.jpg`)})` } : {}" :aria-label="`Play ${entry.title}`" @click="play(0)">
        <span class="play">▶</span><span class="dur">{{ minutes }}</span>
      </button>
      <div v-else class="soon"><img :src="withBase('/logo-badge.svg')" alt="" width="110"><span>Coming soon · {{ minutes }}</span></div>
    </div>
    <figcaption>
      <strong>{{ entry.title }}</strong> — {{ entry.subtitle }}
      <ol class="chapters">
        <li v-for="c in entry.chapters" :key="c.title">
          <!-- A button, not <a href="#">: VitePress routes "#" to the top of the page. -->
          <button v-if="c.t !== null && entry.youtubeId" type="button" class="jump" @click="play(c.t)">{{ label(c.t) }}</button>
          <span v-else-if="c.t !== null" class="t">{{ label(c.t) }}</span>
          {{ c.title }}
        </li>
      </ol>
      <a v-if="entry.vtt" :href="withBase(`/videos/${entry.id}.vtt`)">Subtitles (WebVTT)</a>
    </figcaption>
  </figure>
</template>

<style scoped>
.video-embed { margin: 1.5rem 0; }
.frame { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: radial-gradient(120% 120% at 0% 0%, #123A62 0%, #0B1F33 55%, #081626 100%); box-shadow: 0 8px 28px rgba(0, 0, 0, .25); }
.frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.poster { position: absolute; inset: 0; width: 100%; border: 0; cursor: pointer; background: #0B1F33 center / cover no-repeat; color: #fff; }
.play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 84px; height: 84px; border-radius: 50%; background: rgba(11, 31, 51, .85); box-shadow: 0 0 0 4px #33B1FF; font-size: 32px; line-height: 84px; }
.dur, .soon span { position: absolute; right: 14px; bottom: 12px; padding: 4px 10px; border-radius: 6px; background: rgba(11, 31, 51, .85); color: #fff; font-size: 14px; }
.soon { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.chapters { margin: .5rem 0 0; padding-left: 1.25rem; font-size: .92rem; }
.chapters .jump, .chapters .t { font-variant-numeric: tabular-nums; margin-right: .5rem; }
.chapters .jump { padding: 0; border: 0; background: none; font: inherit; color: var(--vp-c-brand-1); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.chapters .jump:hover { color: var(--vp-c-brand-2); }
.missing { color: var(--vp-c-danger-1); }
</style>
