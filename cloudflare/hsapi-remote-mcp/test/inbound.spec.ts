import { describe, expect, it } from "vitest";
import { boundIncomingRequest, inboundBodyLimit } from "../src/inbound";

describe("bounded incoming requests", () => {
  it("uses route-specific limits", () => {
    expect(inboundBodyLimit(new Request("https://example.com/authorize", { method: "POST" }))).toBe(16 * 1024);
    expect(inboundBodyLimit(new Request("https://example.com/oauth/token", { method: "POST" }))).toBe(64 * 1024);
    expect(inboundBodyLimit(new Request("https://example.com/oauth/register", { method: "POST" }))).toBe(1024 * 1024);
    expect(inboundBodyLimit(new Request("https://example.com/mcp", { method: "POST" }))).toBe(1024 * 1024);
    expect(inboundBodyLimit(new Request("https://example.com/mcp", { method: "GET" }))).toBeUndefined();
  });

  it("rejects an oversized declared content length before parsing", async () => {
    const result = await boundIncomingRequest(new Request("https://example.com/oauth/token", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 + 1) },
      body: "x",
    }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect((result as Response).headers.get("cache-control")).toBe("no-store");
  });

  it("enforces the streamed size when content length is absent", async () => {
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    });
    request.headers.delete("content-length");
    const result = await boundIncomingRequest(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("does not trust a forged smaller content length", async () => {
    const request = new Request("https://example.com/authorize", {
      method: "POST",
      headers: { "content-length": "1" },
      body: "x".repeat(16 * 1024 + 1),
    });
    const result = await boundIncomingRequest(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("reconstructs an allowed request without a stale content length", async () => {
    const result = await boundIncomingRequest(new Request("https://example.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "7" },
      body: "a=b&c=d",
    }));
    expect(result).toBeInstanceOf(Request);
    expect((result as Request).headers.get("content-length")).toBeNull();
    expect(await (result as Request).text()).toBe("a=b&c=d");
  });
});
