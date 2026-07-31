import { DurableObject } from "cloudflare:workers";

export class ConfirmationLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS confirmation_claims (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        claimed_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )
    `);
  }

  async claim(expiresAtMs: number, nowMs = Date.now()): Promise<boolean> {
    if (
      !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= nowMs
      || expiresAtMs > nowMs + 4 * 60 * 1000
    ) return false;

    const cursor = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO confirmation_claims (id, claimed_at_ms, expires_at_ms) VALUES (1, ?, ?)",
      nowMs,
      expiresAtMs,
    );
    const claimed = cursor.rowsWritten === 1;
    if (claimed) await this.ctx.storage.setAlarm(expiresAtMs + 60_000);
    return claimed;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
