import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("authorization state", () => {
  const proof = "A".repeat(43);

  it("atomically consumes a proof-bound state record only once", async () => {
    const stub = env.AUTHORIZATION_STATE.getByName("state-one");
    const nowMs = Date.now();
    expect(await stub.create("payload", proof, nowMs + 600_000, nowMs)).toBe(true);

    const results = await Promise.all([
      stub.consumeIfProof(proof, nowMs + 1),
      stub.consumeIfProof(proof, nowMs + 1),
    ]);
    expect(results.filter((value) => value.status === "consumed")).toEqual([
      { status: "consumed", payload: "payload" },
    ]);
    expect(results.filter((value) => value.status === "missing")).toHaveLength(1);
    expect(await stub.consumeIfProof(proof, nowMs + 1)).toEqual({ status: "missing" });
  });

  it("does not consume state for a missing or incorrect proof", async () => {
    const stub = env.AUTHORIZATION_STATE.getByName("state-two");
    const nowMs = Date.now();
    expect(await stub.create("payload", proof, nowMs + 1_000, nowMs)).toBe(true);
    expect(await stub.consumeIfProof("wrong", nowMs + 1)).toEqual({ status: "proof_mismatch" });
    expect(await stub.consumeIfProof("B".repeat(43), nowMs + 2)).toEqual({ status: "proof_mismatch" });
    expect(await stub.consumeIfProof(proof, nowMs + 3)).toEqual({ status: "consumed", payload: "payload" });
  });

  it("rejects duplicate creation and deletes expired state without returning it", async () => {
    const stub = env.AUTHORIZATION_STATE.getByName("state-three");
    const nowMs = Date.now();
    expect(await stub.create("first", proof, nowMs + 1_000, nowMs)).toBe(true);
    expect(await stub.create("second", proof, nowMs + 1_000, nowMs)).toBe(false);
    expect(await stub.consumeIfProof(proof, nowMs + 1_001)).toEqual({ status: "expired" });
    expect(await stub.consumeIfProof(proof, nowMs + 1_001)).toEqual({ status: "missing" });
  });

  it("rejects invalid proofs, oversized records, and excessive lifetimes", async () => {
    const nowMs = Date.now();
    expect(await env.AUTHORIZATION_STATE.getByName("state-four").create(
      "payload",
      "not-a-sha256-proof",
      nowMs + 600_000,
      nowMs,
    )).toBe(false);
    expect(await env.AUTHORIZATION_STATE.getByName("state-five").create(
      "x".repeat(64 * 1024 + 1),
      proof,
      nowMs + 600_000,
      nowMs,
    )).toBe(false);
    expect(await env.AUTHORIZATION_STATE.getByName("state-six").create(
      "payload",
      proof,
      nowMs + 12 * 60 * 1000,
      nowMs,
    )).toBe(false);
  });
});
