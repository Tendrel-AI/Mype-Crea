/**
 * Label agent handler (D32): deterministic, no LLM, no usage reservation.
 *
 * Reads the product's lab-report PDFs through the storage service (read only), from the references the
 * command recorded in `requirements_snapshot.lab_reports` (`{fileId, storageKey, sha256, originalName}`), parses
 * each with `parseLabReportPdf` and merges them with `analyzeLabReports` (the product's principal
 * presentation is the serving when it is in ml/g, `requirements.lab_serving`). One artifact `label` whose inline
 * value is the `LabelResult`.
 *
 * Traceability: `metadata.inputs` is empty on purpose (staleness compares brief fields; the label uses none),
 * the lab reports used are listed in `metadata.labReports`. `metadata.safety` is the deterministic `passed`
 * verdict (KAN-33 shape) so the candidate is approvable. A report whose bytes are missing or whose hash differs is skipped
 * with a warning notice; when none is readable the task fails `lab_report_missing` (permanent). A `LabelAnalysisFailure` fails the task with the typed
 * kind `lab_report_unusable` and its user-facing message. The handler never writes to the database.
 */
import { createHash } from 'node:crypto';
import type { A2AArtifact, A2AMessage, AgentHandler } from '../../src/core/agent-types';
import type { SafetyRecord } from '../../src/core/deliverable-safety';
import { TaskError, taskErrorFromThrown } from '../../src/core/task-errors';
import { LAB_REPORTS_KEY, LAB_SERVING_KEY, NO_LAB_REPORTS_MESSAGE, type LabReportRef } from '../../src/labeling/lab-report-refs';
import { analyzeLabReports } from '../../src/labeling/analyze';
import { parseLabReportPdf } from '../../src/labeling/lab-report-parser';
import type { AnalyzeOptions, LabelNotice, ParsedLabReport } from '../../src/labeling/types';
import { loggerFor } from '../../src/services/logger';
import { brandFileStorage } from '../../src/services/storage/brand-upload';

const log = loggerFor('agent.label-agent');

/** Deterministic stand-in for the classifier record: nothing here can be unsafe content. */
const DETERMINISTIC_SAFETY = (checkedAt: string): SafetyRecord => ({
  verdict: 'passed',
  category: null,
  classifier: 'deterministic',
  model: 'none',
  policyVersion: 'label-deterministic.v1',
  checkedAt,
});

const isRef = (value: unknown): value is LabReportRef => {
  const ref = value as Partial<Record<keyof LabReportRef, unknown>> | null;
  return typeof ref?.fileId === 'string' && typeof ref.storageKey === 'string'
    && typeof ref.sha256 === 'string' && typeof ref.originalName === 'string';
};

function servingOf(value: unknown): AnalyzeOptions['serving'] | undefined {
  const serving = value as { amount?: unknown; unit?: unknown } | null | undefined;
  return typeof serving?.amount === 'number' && serving.amount > 0 && (serving.unit === 'ml' || serving.unit === 'g')
    ? { amount: serving.amount, unit: serving.unit }
    : undefined;
}

export const handler: AgentHandler<undefined> = async (message: A2AMessage) => {
  const child = log.child({ op: 'handle', taskId: message.taskId, tenantId: message.tenantId, agentId: message.agentId });
  try {
    const raw = message.requirements[LAB_REPORTS_KEY];
    const refs = Array.isArray(raw) ? raw.filter(isRef) : [];
    if (refs.length === 0) throw new TaskError('lab_report_unusable', NO_LAB_REPORTS_MESSAGE);
    const serving = servingOf(message.requirements[LAB_SERVING_KEY]);
    child.info({ reportCount: refs.length, serving }, 'agent.label.start');

    const storage = brandFileStorage();
    const reports: ParsedLabReport[] = [];
    const skipped: LabelNotice[] = [];
    for (const ref of refs) {
      const bytes = await storage.getObject(ref.storageKey);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
        child.warn({ fileId: ref.fileId }, 'agent.label.report_unreadable');
        skipped.push({ code: 'lab_report_missing', severity: 'warning', message: `No encontramos el archivo «${ref.originalName}»; súbelo de nuevo.` });
        continue;
      }
      reports.push(await parseLabReportPdf(bytes, ref.fileId));
    }
    if (reports.length === 0) throw new TaskError('lab_report_missing', 'No encontramos tus análisis guardados. Súbelos de nuevo.');

    const analyzed = analyzeLabReports(reports, serving ? { serving } : undefined);
    if (!analyzed.ok) {
      child.debug({ issueCodes: analyzed.issues.map((issue) => issue.code) }, 'agent.label.unusable');
      throw new TaskError('lab_report_unusable', analyzed.message);
    }
    const result = { ...analyzed, notices: [...analyzed.notices, ...skipped] };

    const completedAt = new Date().toISOString();
    const artifact: A2AArtifact = {
      kind: 'label',
      inline: result,
      metadata: {
        purpose: 'nutrition_label',
        inputs: {},
        labReports: refs.map(({ fileId, sha256, originalName }) => ({ fileId, sha256, originalName })),
        rulesVersion: result.rulesVersion,
        agentCardVersion: message.agentCardVersion,
        safety: DETERMINISTIC_SAFETY(completedAt),
        generatedAt: completedAt,
      },
    };
    child.info({ rulesVersion: result.rulesVersion, octagons: result.octagons.filter((o) => o.status === 'required').length }, 'agent.label.completed');
    return { status: 'completed', taskId: message.taskId, artifacts: [artifact], completedAt };
  } catch (err) {
    const error = taskErrorFromThrown(err);
    // An unusable report is the user's to fix, not a system error.
    child[error.kind === 'lab_report_unusable' || error.kind === 'lab_report_missing' ? 'warn' : 'error']({ err, errorKind: error.kind }, 'agent.label.failed');
    return { status: 'failed', taskId: message.taskId, error, completedAt: new Date().toISOString() };
  }
};
