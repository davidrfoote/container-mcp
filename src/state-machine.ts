/**
 * src/state-machine.ts — Session status transition graph.
 *
 * Formalizes the allowed session status transitions with:
 *   - Graph validation (rejects invalid transitions)
 *   - Optimistic concurrency (WHERE status = $current prevents races)
 *   - pg_notify on transition for real-time UI updates
 *
 * Statuses match the SessionStatus type in dev-session-app/types/index.ts.
 */

import { Client } from "pg";
import { withDbClient } from "./db.js";

export type SessionStatus =
  | "pending"
  | "active"
  | "executing"
  | "awaiting_approval"
  | "planning"
  | "paused"
  | "completed"
  | "failed";

/** Transition graph: from status → allowed next statuses */
export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  pending:            ["active", "failed"],
  active:             ["executing", "awaiting_approval", "planning", "paused", "completed", "failed"],
  executing:          ["active", "awaiting_approval", "completed", "failed"],
  awaiting_approval:  ["active", "executing", "completed", "failed"],
  planning:           ["active", "awaiting_approval", "failed"],
  paused:             ["active", "failed"],
  completed:          [],  // terminal
  failed:             ["active"],  // allow retry
};

/** Tool policy classification for authorization/audit */
export type ToolPolicyClass = "read_only" | "mutating" | "privileged";

/**
 * Atomically update session status with graph validation.
 * Uses optimistic concurrency: UPDATE ... WHERE status = $current
 * to prevent races when multiple agents touch the same session.
 */
export async function transitionSession(
  dbUrl: string,
  sessionId: string,
  toStatus: SessionStatus,
  metadata?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await withDbClient(dbUrl, async (client: Client) => {
      const res = await client.query<{ status: string }>(
        "SELECT status FROM sessions WHERE session_id = $1",
        [sessionId],
      );
      if (res.rows.length === 0) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }
      const currentStatus = res.rows[0].status as SessionStatus;

      const allowed = SESSION_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(toStatus)) {
        return {
          ok: false,
          error: `Cannot transition ${currentStatus} → ${toStatus}. Allowed: [${allowed.join(", ")}]`,
        };
      }

      // Optimistic concurrency — fails if another process changed status first
      const updateRes = await client.query(
        `UPDATE sessions SET status = $1, updated_at = now()
         WHERE session_id = $2 AND status = $3`,
        [toStatus, sessionId, currentStatus],
      );

      if (updateRes.rowCount === 0) {
        return { ok: false, error: "Concurrent update detected, retry" };
      }

      // Notify listeners
      const safeId = sessionId.replace(/-/g, "_");
      const notifyPayload = JSON.stringify({
        session_id: sessionId,
        from_status: currentStatus,
        to_status: toStatus,
        metadata: metadata ?? null,
        transitioned_at: new Date().toISOString(),
      });
      await client.query("SELECT pg_notify($1, $2)", [
        `session_status_${safeId}`,
        notifyPayload,
      ]);

      return { ok: true };
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `DB error: ${message}` };
  }
}

/**
 * Return the list of next valid statuses for a session.
 */
export async function nextAllowedActions(
  dbUrl: string,
  sessionId: string,
): Promise<SessionStatus[]> {
  try {
    return await withDbClient(dbUrl, async (client: Client) => {
      const res = await client.query<{ status: string }>(
        "SELECT status FROM sessions WHERE session_id = $1",
        [sessionId],
      );
      if (res.rows.length === 0) return [];
      const current = res.rows[0].status as SessionStatus;
      return SESSION_TRANSITIONS[current] ?? [];
    });
  } catch {
    return [];
  }
}
