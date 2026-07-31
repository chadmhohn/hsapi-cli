import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("mutation confirmation ledger", () => {
  it("atomically claims each confirmation nonce only once", async () => {
    const stub = env.CONFIRMATION_LEDGER.getByName("confirmation-one");
    const expiresAtMs = Date.now() + 180_000;

    expect(await stub.claim(expiresAtMs)).toBe(true);
    expect(await stub.claim(expiresAtMs)).toBe(false);
  });

  it("isolates independent confirmation nonces and rejects expired claims", async () => {
    expect(await env.CONFIRMATION_LEDGER.getByName("confirmation-two").claim(Date.now() + 180_000)).toBe(true);
    expect(await env.CONFIRMATION_LEDGER.getByName("confirmation-three").claim(Date.now() - 1)).toBe(false);
  });
});
