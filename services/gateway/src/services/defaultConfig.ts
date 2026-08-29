/**
 * The gateway's built-in fallback configuration, used when api_config.json is
 * missing or unreadable.
 *
 * It lives in its own module, with no imports, so that the admin service's test
 * suite — which owns the api_config JSON Schema and the only Ajv dependency in
 * the repo — can load it and validate it against that schema without pulling in
 * configService's runtime (Valkey, axios, the plugin loader). A fallback that
 * fails its own schema is a config the gateway cannot be reconfigured out of,
 * so the schema check has to be mechanical.
 *
 * configService.ts annotates this object as `Config` on import, which is where
 * its shape is type-checked.
 */
export const DEFAULT_CONFIG = {
  api_config: {
    providers: {
      openai: {
        substitute_models: [
          { from: "GPT-4", to: "o1" },
          { from: "GPT-3.5", to: "GPT-4" }
        ],
        emulate_streaming_for_models: []
      },
      anthropic: {
        substitute_models: [
          { from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" },
          { from: "claude-3-7-sonnet-20250219", to: "anthropic--claude-3.7-sonnet" }
        ],
        emulate_streaming_for_models: ["anthropic--claude-3.7-sonnet"]
      }
    }
  }
};
