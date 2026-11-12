/**
 * D32 (nutrition label), server side: how a product's lab reports reach the label-agent.
 *
 * At command time the core asks `labelTaskInputs` (wired in runtime.ts as `taskInputsFor`) for the extra inputs of a
 * task. For the label-agent it reads the product's lab-report PDFs (`brand_files`, kind `lab_report`) and the
 * principal presentation as a serving, and they are recorded in `requirements_snapshot` (`lab_reports`, `lab_serving`).
 * The handler reads only what the snapshot says, so a retry or replay sees the same files. Server-only.
 */
import type { ConversationId, UUID } from '../core/contracts';
import { repos } from '../repos';
import type { Tenant, User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { LABEL_AGENT_ID, LAB_REPORTS_KEY, LAB_SERVING_KEY, servingFromPresentation, type LabReportRef } from './lab-report-refs';

const log = loggerFor('labeling.lab-reports');

/** The task inputs of one owner's conversations (a `DeliverableCommandContext.taskInputs`). */
export function labelTaskInputs(tenant: Tenant, user: User) {
  return async (conversationId: ConversationId, agentId: string): Promise<Record<string, unknown>> => {
    if (agentId !== LABEL_AGENT_ID) return {};
    const owned = repos(tenant, user);
    const context = await owned.conversations.context(conversationId);
    if (!context?.productId) return {};
    const [reports, product] = await Promise.all([
      owned.brandFiles.listLabReports(context.productId),
      owned.products.get(context.productId),
    ]);
    const presentations = product?.attributes.product_presentations;
    const principal = Array.isArray(presentations)
      ? (presentations.find((p) => p?.principal === true) as { label?: string } | undefined)?.label
      : undefined;
    const serving = servingFromPresentation(principal);
    log.debug({ conversationId, reportCount: reports.length, serving }, 'label.task_inputs');
    return { [LAB_REPORTS_KEY]: reports satisfies LabReportRef[], ...(serving ? { [LAB_SERVING_KEY]: serving } : {}) };
  };
}

/** The product's lab-report count of a conversation, or null when it is not a product conversation. */
export async function labReportsOfConversation(
  tenant: Tenant,
  user: User,
  conversationId: ConversationId,
): Promise<{ readonly productId: UUID; readonly brandId: UUID; readonly reports: ReadonlyArray<LabReportRef> } | null> {
  const owned = repos(tenant, user);
  const context = await owned.conversations.context(conversationId);
  if (!context?.productId || !context.brandId) return null;
  return { productId: context.productId, brandId: context.brandId, reports: await owned.brandFiles.listLabReports(context.productId) };
}
