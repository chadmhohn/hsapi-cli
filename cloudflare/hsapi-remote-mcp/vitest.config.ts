import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Wrangler resolves required secret bindings while loading the test project.
// Force a known non-secret fixture so tests never consume operator credentials.
process.env.STATE_ENCRYPTION_KEY = "vitest-only-state-encryption-key-0000000000000000";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          STATE_ENCRYPTION_KEY: "test-only-state-encryption-key-0000000000000000",
        },
      },
    }),
  ],
});
