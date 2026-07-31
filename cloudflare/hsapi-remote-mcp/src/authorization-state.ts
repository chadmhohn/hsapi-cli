import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

const MAX_AUTHORIZATION_STATE_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_STATE_TTL_MS = 11 * 60 * 1000;
const PROOF_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

interface AuthorizationStateRow {
  [key: string]: string | number | null;
  payload: string;
  proof_hash: string | null;
  expires_at_ms: number;
}

export type AuthorizationStateConsumeResult =
  | { status: "consumed"; payload: string }
  | { status: "missing" | "expired" | "proof_mismatch" | "invalid" };

function proofHashesEqual(left: string, right: string): boolean {
  if (!PROOF_HASH_PATTERN.test(left) || !PROOF_HASH_PATTERN.test(right)) return false;
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export class AuthorizationState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS authorization_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        proof_hash TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )
    `);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(authorization_state)")
      .toArray();
    if (!columns.some((column) => column.name === "proof_hash")) {
      this.ctx.storage.sql.exec("ALTER TABLE authorization_state ADD COLUMN proof_hash TEXT");
    }
  }

  async create(
    payload: string,
    proofHash: string,
    expiresAtMs: number,
    nowMs = Date.now(),
  ): Promise<boolean> {
    if (
      encoder.encode(payload).byteLength > MAX_AUTHORIZATION_STATE_BYTES
      || !PROOF_HASH_PATTERN.test(proofHash)
      || !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= nowMs
      || expiresAtMs > nowMs + MAX_AUTHORIZATION_STATE_TTL_MS
    ) return false;

    const cursor = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO authorization_state (id, payload, proof_hash, expires_at_ms) VALUES (1, ?, ?, ?)",
      payload,
      proofHash,
      expiresAtMs,
    );
    if (cursor.rowsWritten !== 1) return false;

    try {
      await this.ctx.storage.setAlarm(expiresAtMs + 60_000);
      return true;
    } catch (error) {
      this.ctx.storage.sql.exec("DELETE FROM authorization_state");
      throw error;
    }
  }

  consumeIfProof(proofHash: string, nowMs = Date.now()): AuthorizationStateConsumeResult {
    const row = this.ctx.storage.sql
      .exec<AuthorizationStateRow>(
        "SELECT payload, proof_hash, expires_at_ms FROM authorization_state WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return { status: "missing" };

    if (!Number.isSafeInteger(row.expires_at_ms) || row.expires_at_ms <= nowMs) {
      this.ctx.storage.sql.exec("DELETE FROM authorization_state WHERE id = 1");
      return { status: "expired" };
    }
    if (typeof row.proof_hash !== "string" || !PROOF_HASH_PATTERN.test(row.proof_hash)) {
      this.ctx.storage.sql.exec("DELETE FROM authorization_state WHERE id = 1");
      return { status: "invalid" };
    }
    if (!proofHashesEqual(proofHash, row.proof_hash)) return { status: "proof_mismatch" };

    // Proof validation and deletion stay in the same input gate with no await.
    // Invalid callers cannot burn valid state, while the first valid caller
    // atomically prevents every replay from observing the payload.
    this.ctx.storage.sql.exec("DELETE FROM authorization_state WHERE id = 1");
    return { status: "consumed", payload: row.payload };
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM authorization_state");
    await this.ctx.storage.deleteAlarm();
  }
}
