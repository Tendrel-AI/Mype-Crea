'use server';

/**
 * D32: the ids and names of the lab reports uploaded for the product of a conversation, shown next to the label
 * result. Owner-scoped like the other panel controllers; a conversation without a product has none.
 */

import { authorizeConversation as authorize, isUuid } from './conversation-access';
import type { ConversationId } from '../../src/core/contracts';
import { labReportsOfConversation } from '../../src/labeling/lab-task-inputs';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.lab-reports');

export type LabReportNamesResult =
  | { readonly ok: true; readonly reports: ReadonlyArray<{ readonly id: string; readonly name: string }> }
  | { readonly ok: false };

export async function listLabReportNamesAction(input: { readonly conversationId: string }): Promise<LabReportNamesResult> {
  if (!isUuid(input?.conversationId)) return { ok: false };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorize(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return { ok: false };
  try {
    const found = await labReportsOfConversation(authorized.identity.tenant, authorized.identity.user, conversationId);
    return { ok: true, reports: (found?.reports ?? []).map((report) => ({ id: report.fileId, name: report.originalName })) };
  } catch (error) {
    log.error({ conversationId, err: error }, 'labReports.list_failed');
    return { ok: false };
  }
}
