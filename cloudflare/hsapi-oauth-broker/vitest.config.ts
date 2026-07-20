import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          BROKER_SIGNING_KEY:
            "test-only-signing-key-with-at-least-thirty-two-characters",
          ENVIRONMENT: "test",
          HUBSPOT_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
          HUBSPOT_CLIENT_SECRET: "test-only-client-secret",
          HUBSPOT_REDIRECT_URI:
            "https://broker.test/v1/oauth/callback",
          HUBSPOT_REQUIRED_SCOPES: "oauth",
        },
      },
    }),
  ],
  test: {
    globals: false,
  },
});
