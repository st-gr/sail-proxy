// The API reference (Swagger UI at /admin/api/docs/) for the teaser's "got Swagger?" beat: the gateway's routes,
// one operation opened, then the admin OData and REST definitions. Recorded on the local demo stack under the
// cockpit's section 7 number (no captions, so no step badge) and never part of the cockpit video:
// `node record.js 05-cockpit --steps swagger --first-section 7` writes out/05-cockpit/swagger/clips/section-7.mp4.
// The specs name only relative paths, localhost and 127.0.0.1; run frame-check.mjs on the clip anyway.
const DOCS = '/admin/api/docs/';

export default async ({ section, goto, click, wait, scroll, hold, end }) => {
  await section(7);
  await goto(DOCS);
  await wait(4000);
  await click('#operations-OpenAI-openaiCreateChatCompletion .opblock-summary');
  await wait(4000);
  await scroll(2400, { ms: 5000 }); // past the opened operation down the OpenAI, Anthropic and Gemini routes
  await wait(2000);
  await goto(`${DOCS}?urls.primaryName=Admin%20OData`);
  await wait(4000);
  await scroll(4000, { ms: 6000 }); // the admin service's entity sets
  await wait(2000);
  await goto(`${DOCS}?urls.primaryName=Admin%20REST`);
  await wait(4000);
  await hold(2000);
  await end();
};
