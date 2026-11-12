/**
 * label-agent handler (D32): the parser, the engine and the storage are mocked. A success is one `label`
 * artifact whose inline value is the LabelResult, with a deterministic `passed` safety record (approvable) and
 * no brief inputs; a LabelAnalysisFailure or no reports fail with the typed `lab_report_unusable` and the
 * user-facing message; a missing or altered stored file fails `storage_unavailable`.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AMessage } from '../../../src/core/agent-types';
import { isPresentable } from '../../../src/core/deliverable-safety';
import { recordedFieldVersions } from '../../../src/core/deliverable-inputs';

const mocks = vi.hoisted(() => ({
  getObject: vi.fn<(key: string) => Promise<Uint8Array | null>>(),
  parse: vi.fn(),
  analyze: vi.fn(),
}));

vi.mock('../../../src/services/storage/brand-upload', () => ({ brandFileStorage: () => ({ getObject: mocks.getObject }) }));
vi.mock('../../../src/labeling/lab-report-parser', () => ({ parseLabReportPdf: mocks.parse }));
vi.mock('../../../src/labeling/analyze', () => ({ analyzeLabReports: mocks.analyze }));

import { handler } from '../handler';

const PDF = new TextEncoder().encode('%PDF-1.4 informe');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const REF = { fileId: 'f1', storageKey: 'tenants/t/files/f1.pdf', sha256: sha(PDF), originalName: 'informe.pdf' };
const RESULT = { ok: true, rulesVersion: 'rules.v1', productState: 'liquid', basis: 'per_100ml', serving: null, table: [], octagons: [], notices: [], sources: [] };

const message = (requirements: Record<string, unknown>): A2AMessage => ({
  taskId: '11111111-1111-1111-1111-111111111111' as A2AMessage['taskId'],
  tenantId: '22222222-2222-2222-2222-222222222222',
  agentId: 'label-agent',
  agentCardVersion: '0.2.0',
  requirements,
  createdAt: new Date().toISOString(),
});

describe('label-agent handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getObject.mockResolvedValue(PDF);
    mocks.parse.mockResolvedValue({ fileId: 'f1', measurements: [], issues: [] });
    mocks.analyze.mockReturnValue(RESULT);
  });

  it('returns one label artifact with the LabelResult inline, approvable, with no brief inputs', async () => {
    const result = await handler(message({ lab_reports: [REF], lab_serving: { amount: 250, unit: 'ml' } }), undefined);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts).toHaveLength(1);
    const [artifact] = result.artifacts;
    expect(artifact).toMatchObject({ kind: 'label', inline: RESULT });
    expect(artifact.metadata).toMatchObject({ safety: { verdict: 'passed' }, labReports: [{ fileId: 'f1', originalName: 'informe.pdf' }] });
    expect(isPresentable(artifact.metadata)).toBe(true);
    // Staleness compares brief fields; the label records none.
    expect(recordedFieldVersions(artifact.metadata)).toBeNull();
    expect(mocks.parse).toHaveBeenCalledWith(PDF, 'f1');
    expect(mocks.analyze).toHaveBeenCalledWith([expect.objectContaining({ fileId: 'f1' })], { serving: { amount: 250, unit: 'ml' } });
  });

  it('passes no options when there is no serving', async () => {
    await handler(message({ lab_reports: [REF] }), undefined);
    expect(mocks.analyze).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('a LabelAnalysisFailure fails with lab_report_unusable and its own message', async () => {
    mocks.analyze.mockReturnValue({ ok: false, message: 'No encontramos valores nutricionales en tu análisis.', issues: [] });
    const result = await handler(message({ lab_reports: [REF] }), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'lab_report_unusable', message: 'No encontramos valores nutricionales en tu análisis.' } });
  });

  it('without lab reports it fails with the upload message before reading anything', async () => {
    const result = await handler(message({}), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'lab_report_unusable', message: 'Sube primero el análisis de laboratorio de tu producto (PDF).' } });
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing object', null],
    ['an altered object', new TextEncoder().encode('%PDF-1.4 otro')],
  ])('%s fails storage_unavailable (transient) naming the file', async (_name, bytes) => {
    mocks.getObject.mockResolvedValue(bytes);
    const result = await handler(message({ lab_reports: [REF] }), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'storage_unavailable', message: expect.stringContaining('informe.pdf') } });
    expect(mocks.parse).not.toHaveBeenCalled();
  });
});
