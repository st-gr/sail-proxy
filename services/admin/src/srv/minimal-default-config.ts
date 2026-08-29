/**
 * Last-resort configuration seeded when api_config.json cannot be read at
 * bootstrap. This object is written straight into the database and activated,
 * so a fallback that fails its own schema produces an active configuration the
 * admin UI then refuses to save.
 *
 * It lives in its own module because config-service.ts ends with
 * `module.exports = (srv) => ...`, which clobbers any ES named export it
 * declares — there is no way to reach this constant from a test while it sits
 * in that file. test/unit/services/fallback-config-schema.test.ts validates it
 * against src/schemas/api-config-schema.json.
 */
export const MINIMAL_DEFAULT_CONFIG = {
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
    },
    platform: {
      timeouts: {
        default: 120000,
        streaming: 240000
      },
      logging: {
        // Uppercase: platform.logging.defaultLevel is an enum of
        // TRACE/DEBUG/INFO/WARN/ERROR/FATAL.
        defaultLevel: "INFO"
      }
    }
  }
};
