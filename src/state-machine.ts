import { Client } from "pg";
import { withDbClient } from "./db.js";

// Valid session statuses
export type SessionStatus =
  | 'pending' | 'active' | 'executing' | 'awaiting_approval'
  | 'planning' | 'pending_review' | 'closed' | 'failed';

// Transition graph: from status → allowed next statuses
export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  pending:            ['active', 'failed'],
  active:             ['executing', 'awaiting_approval', 'planning', 'failed', 'closed'],
  awaiting_approval:  ['active', 'executing', 'failed', 'closed'],
  planning:           ['active', 'awaiting_approval', 'failed'],
  executing:          ['pending_review', 'active', 'failed', 'closed'],
  pending_review:     ['closed', 'active', 'failed'],
  closed:             [],
  failed:             ['active'],
};

// Human-readable labels
export const STATUS_LABELS: Record<SessionStatus, string> = {
  pending:           'Pending',
  active:            'Active',
  executing:         'Executing',
  awaiting_approval: 'Awaiting Approval',
  planning:          'Planning',
  pending_review:    'Pending Review',
  closed:            'Closed',
  failed:            'Failed',
};

// Policy class for tool definitions
export type ToolPolicyClass = 'read_only' | 'mutating' | 'privileged';

/**
 * Atomically update session status with graph validation.
 * Returns { ok: true } on success, { ok: false, error: string } on invalid transition or DB error.
 */
export async function transitionSession(
  dbUrl: string,
  sessionId: string,
  toStatus: SessionStatus,
  metadata?: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await withDbClient(dbUrl, async (client: Client) => {
      // 1. Fetch current status
      const res = await client.query<{ status: string }>(
        `SELECT status FROM sessions WHERE session_id = $1`,
        [sessionId]
      );
      if (res.rows.length === 0) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }
      const currentStatus = res.rows[0].status as SessionStatus;

      // 2. Validate transition
      const allowed = SESSION_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(toStatus)) {
        return {
          ok: false,
          error: `Cannot transition ${currentStatus} → ${toStatus}. Allowed: [${allowed.join(', ')}]`,
        };
      }

      // 3. Optimistic concurrency update
      const updateRes = await client.query(
        `UPDATE sessions SET status = $1, updated_at = now()
         WHERE session_id = $2 AND status = $3`,
        [toStatus, sessionId, currentStatus]
      );

      if (updateRes.rowCount === 0) {
        return { ok: false, error: 'Concurrent update detected, retry' };
      }

      // 4. Emit pg_notify for status change
      const safeId = sessionId.replace(/-/g, '_');
      const notifyPayload = JSON.stringify({
        session_id: sessionId,
        from_status: currentStatus,
        to_status: toStatus,
        metadata: metadata ?? null,
        transitioned_at: new Date().toISOString(),
      });
      await client.query('SELECT pg_notify($1, $2)', [
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
  sessionId: string
): Promise<SessionStatus[]> {
  try {
    return await withDbClient(dbUrl, async (client: Client) => {
      const res = await client.query<{ status: string }>(
        `SELECT status FROM sessions WHERE session_id = $1`,
        [sessionId]
      );
      if (res.rows.length === 0) return [];
      const current = res.rows[0].status as SessionStatus;
      return SESSION_TRANSITIONS[current] ?? [];
    });
  } catch {
    return [];
  }
}
