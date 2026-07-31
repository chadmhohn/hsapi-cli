const AUTHORIZATION_BODY_LIMIT_BYTES = 16 * 1024;
const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const LARGE_BODY_LIMIT_BYTES = 1024 * 1024;

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function declaredContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function inboundBodyLimit(request: Request): number | undefined {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return undefined;
  const pathname = new URL(request.url).pathname;
  if (pathname === "/authorize") return AUTHORIZATION_BODY_LIMIT_BYTES;
  if (pathname === "/mcp" || pathname === "/oauth/register" || pathname.startsWith("/oauth/register/")) {
    return LARGE_BODY_LIMIT_BYTES;
  }
  return DEFAULT_BODY_LIMIT_BYTES;
}

export async function boundIncomingRequest(request: Request): Promise<Request | Response> {
  const limit = inboundBodyLimit(request);
  if (limit === undefined) return request;
  const declared = declaredContentLength(request);
  if (declared !== undefined && declared > limit) return errorResponse(413, "Request body too large.");
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return errorResponse(413, "Request body too large.");
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The stream is already unusable; return a generic client error.
    }
    return errorResponse(400, "Invalid request body.");
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body });
}
