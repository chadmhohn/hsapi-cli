import { describe, expect, it } from "vitest";
import {
  createConfirmationToken,
  opaqueUserId,
  stableJson,
  verifyConfirmationToken,
} from "../src/crypto";

describe("confirmation tokens", () => {
  const secret = "test-only-confirmation-secret-that-is-long-enough";
  const now = 1_800_000_000_000;

  it("binds a short-lived token to the exact normalized request", async () => {
    const first = { hubId: 123, request: { b: 2, a: 1 } };
    const reordered = { request: { a: 1, b: 2 }, hubId: 123 };
    const token = await createConfirmationToken(secret, first, now);

    expect(await verifyConfirmationToken(token, secret, reordered, now + 179_999)).toBe(true);
    expect(await verifyConfirmationToken(token, secret, { ...reordered, hubId: 124 }, now + 1)).toBe(false);
    expect(await verifyConfirmationToken(token, secret, reordered, now + 180_001)).toBe(false);
  });

  it("rejects a tampered signature or payload", async () => {
    const token = await createConfirmationToken(secret, { endpointId: "objects.create" }, now);
    const [payload, signature] = token.split(".");
    const replacement = signature.endsWith("A") ? "B" : "A";
    expect(await verifyConfirmationToken(`${payload}.${signature.slice(0, -1)}${replacement}`, secret, { endpointId: "objects.create" }, now)).toBe(false);
    expect(await verifyConfirmationToken(`A${payload.slice(1)}.${signature}`, secret, { endpointId: "objects.create" }, now)).toBe(false);
  });

  it("uses stable object ordering and opaque per-account user identifiers", async () => {
    expect(stableJson({ z: 1, nested: { b: 2, a: 1 } })).toBe('{"nested":{"a":1,"b":2},"z":1}');
    const first = await opaqueUserId(secret, 123, 456);
    expect(first).toBe(await opaqueUserId(secret, 123, 456));
    expect(first).not.toBe(await opaqueUserId(secret, 124, 456));
    expect(first).toMatch(/^hs_[A-Za-z0-9_-]{40}$/);
  });
});
