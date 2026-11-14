/**
 * KAN-44 rejected-write log, shared by the chat, brief panel and deliverable
 * command controllers. Not a server action module: only server actions import
 * it, so it is never callable directly.
 *
 * Merge and the planner only REPORT rejections; this is where they become
 * `write_rejections` rows. The offending payload or value is hashed here
 * (SHA-256 hex) before it reaches the repository, so the raw value never
 * leaves the process. Recording never throws: a failure to log must not
 * change the answer the user gets, and the write stays refused either way.
 */

import { createHash } from 'node:crypto';
import { resolveIdentity, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import type { WriteChannel } from '../../src/repos/models';
import type { UUID } from '../../src/core/contracts';
import { loggerFor } from '../../src/services/logger';
import { isUuid } from './conversation-access';

const log = loggerFor('controller.write-rejections');

export interface RejectedWrite {
  readonly channel: WriteChannel;
  readonly reason: string;
  /** The payload or value that was refused. Only its hash is stored. */
  readonly offending: unknown;
  readonly conversationId?: unknown;
  readonly agentId?: unknown;
  readonly fieldName?: unknown;
}

/** SHA-256 hex of the JSON form of a value (its string form when it has none). */
export function payloadHash(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Record refused writes for the server identity (resolved here when not given). */
export async function recordRejectedWrites(
  identity: ResolvedIdentity | undefined,
  writes: ReadonlyArray<RejectedWrite>,
): Promise<void> {
  if (writes.length === 0) return;
  const rows = writes.map((write) => ({
    channel: write.channel,
    conversationId: isUuid(write.conversationId) ? (write.conversationId.toLowerCase() as UUID) : null,
    agentId: safeName(write.agentId),
    fieldName: safeName(write.fieldName),
    reason: write.reason,
    payloadHash: payloadHash(write.offending),
  }));
  const summary = rows.map(({ channel, reason, agentId, fieldName }) => ({ channel, reason, agentId, fieldName }));
  try {
    const actor = identity ?? (await resolveIdentity());
    await repos(actor.tenant, actor.user).writeRejections.record(rows);
    log.warn({ rejections: summary }, 'writeRejection.recorded');
  } catch (error) {
    log.error({ rejections: summary, err: error }, 'writeRejection.record_failed');
  }
}

/** True when `input` is a plain object whose keys are all in `allowed`. */
export function hasOnlyKeys(input: unknown, allowed: ReadonlyArray<string>): input is Record<string, unknown> {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).every((key) => allowed.includes(key))
  );
}

/** An agent id or field name only when it is a safe identifier; anything else is covered by the hash. */
function safeName(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : null;
}
