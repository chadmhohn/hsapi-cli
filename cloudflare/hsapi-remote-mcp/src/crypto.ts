const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function opaqueUserId(secret: string, hubId: number, userId: number): Promise<string> {
  const digest = await hmacBase64Url(secret, `hubspot-user:${hubId}:${userId}`);
  return `hs_${digest.slice(0, 40)}`;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeForStableJson(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

export interface ConfirmationPayload {
  version: 1;
  expiresAtMs: number;
  nonce: string;
  requestDigest: string;
}

export async function createConfirmationToken(
  secret: string,
  requestBinding: unknown,
  nowMs = Date.now(),
): Promise<string> {
  const payload: ConfirmationPayload = {
    version: 1,
    expiresAtMs: nowMs + 3 * 60 * 1000,
    nonce: randomToken(),
    requestDigest: await sha256Base64Url(stableJson(requestBinding)),
  };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmacBase64Url(secret, encoded)}`;
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url encoding.");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error("Non-canonical base64url encoding.");
  return bytes;
}

export async function verifyConfirmationToken(
  token: string,
  secret: string,
  requestBinding: unknown,
  nowMs = Date.now(),
): Promise<boolean> {
  return Boolean(await readConfirmationToken(token, secret, requestBinding, nowMs));
}

export async function readConfirmationToken(
  token: string,
  secret: string,
  requestBinding: unknown,
  nowMs = Date.now(),
): Promise<ConfirmationPayload | undefined> {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return undefined;
  const key = await hmacKey(secret);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return undefined;
  }
  const signatureBuffer = new Uint8Array(signatureBytes).buffer;
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBuffer,
    encoder.encode(encoded),
  );
  if (!signatureValid) return undefined;
  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as ConfirmationPayload;
  } catch {
    return undefined;
  }
  if (
    payload.version !== 1
    || !Number.isSafeInteger(payload.expiresAtMs)
    || payload.expiresAtMs <= nowMs
    || typeof payload.nonce !== "string"
    || !/^[A-Za-z0-9_-]{32,128}$/.test(payload.nonce)
  ) return undefined;
  return payload.requestDigest === await sha256Base64Url(stableJson(requestBinding)) ? payload : undefined;
}
