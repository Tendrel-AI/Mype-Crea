/**
 * KAN-89 (F12): «Usar mi nombre / logo / lema». Stores what the user brought as a version (task marked
 * `origin: 'user'` + deliverable, `src/repos/own-candidates.ts`) and approves it through the normal
 * approval (`approvals.approve`, brand-level), so the brand's result, the stale marks and the brand
 * record follow the same code path as a generated version. No LLM, no image call, no cost.
 *
 * The logo is COPIED to the deliverable's own bucket key: replacing the brand upload later deletes the
 * old object, and an approved version must not lose its image. Without a configured bucket the copy
 * lands in the dev in-memory store and `/api/assets/<id>` cannot serve it (local only).
 */
import { randomUUID } from 'node:crypto';
import type { ApproveOwnInput, ApproveOwnResult } from '../core/approvals';
import type { ConversationId, UUID } from '../core/contracts';
import type { Tenant, User } from '../db/with-transaction';
import { approvalsRepo } from '../repos/approvals';
import { toApproveResult } from '../repos/approval-store';
import { ownCandidatesRepo, type OwnCandidateInput } from '../repos/own-candidates';
import { loggerFor } from './logger';
import { brandFileStorage } from './storage/brand-upload';
import type { IObjectStorage } from './storage/types';

const log = loggerFor('services.own-approval');

export function createOwnApproval(
  tenant: Tenant,
  user: User,
  storage: () => IObjectStorage = brandFileStorage,
): (input: ApproveOwnInput) => Promise<ApproveOwnResult> {
  const candidates = ownCandidatesRepo(tenant, user);
  const approvals = approvalsRepo(tenant, user);

  return async (input) => {
    const conversationId = input.conversationId as ConversationId;
    const deliverableId = randomUUID() as UUID;
    const child = log.child({ tenantId: tenant.id, userId: user.id, conversationId, kind: input.deliverableKind, deliverableId });
    let copiedKey: string | null = null;
    let source: OwnCandidateInput['source'];
    if (input.source.kind === 'text') {
      source = { text: input.source.value };
    } else {
      const logo = await candidates.findBrandLogo(conversationId);
      const bytes = logo ? await storage().getObject(logo.storageKey) : null;
      if (!logo || !bytes) {
        child.info('own_approval.missing_logo');
        return { ok: false, reason: 'missing_source' };
      }
      copiedKey = `tenants/${tenant.id}/conversations/${conversationId}/own/${deliverableId}.${logo.storageKey.split('.').pop()}`;
      await storage().putObject(copiedKey, bytes, logo.contentType);
      source = { file: logo, storageKey: copiedKey };
    }
    try {
      const inserted = await candidates.insert({
        deliverableId, conversationId, agentId: input.agentId, agentCardVersion: input.agentCardVersion,
        deliverableKind: input.deliverableKind, source,
      });
      if (!inserted) {
        if (copiedKey) await storage().deleteObject(copiedKey);
        return { ok: false, reason: 'not_found' };
      }
    } catch (err) {
      if (copiedKey) await storage().deleteObject(copiedKey).catch(() => undefined);
      throw err;
    }
    // A refused approval (stale view) leaves the version as an ordinary unapproved candidate.
    const outcome = await approvals.approve({
      conversationId, deliverableKind: input.deliverableKind, deliverableId,
      expectedApprovedId: input.expectedApprovedId, dependentKinds: input.dependentKinds, brandLevel: true,
    });
    child.info({ outcome: outcome.kind }, 'own_approval.done');
    return toApproveResult(outcome);
  };
}
