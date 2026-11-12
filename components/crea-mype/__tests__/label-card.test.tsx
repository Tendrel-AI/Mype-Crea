import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../LabelResultView', () => ({
  LabelResultView: ({ result }: { result: { rulesVersion: string } }) => <div data-testid="label-result">{result.rulesVersion}</div>,
}));

import { LabelCard, labelCommandAfterUpload, labelResultOf } from '../label-card';
import { failedCardMessage } from '../failure-copy';
import { ChatPanel } from '../ChatPanel';
import { Dashboard } from '../Dashboard';
import { LAB_UPLOAD_LABEL, LAB_UPLOAD_OBSERVATION } from '../lab-upload-copy';
import type { DeliverableStateView } from '../../../src/core/contracts';
import type { BrandAssets, Message } from '../types';

const noop = () => {};

function view(partial: Partial<DeliverableStateView>): DeliverableStateView {
  return {
    agentId: 'label-agent', deliverableKind: 'label', state: 'enabled', stale: false, allowedCommands: [],
    missingFields: [], missingUpstream: [], activeTask: null, lastFailure: null, candidates: [],
    approvedDeliverableId: null, stateToken: 'ds1-00000000', ...partial,
  };
}

const candidate = (inline: unknown) => ({
  deliverableId: 'd1', taskId: 't1', contentUrl: null, contentInline: inline, createdAt: '2026-11-11T00:00:00.000Z',
  approvable: true, iteration: 1, stale: false,
  provenance: { promptVersion: null, agentCardVersion: null, provider: null, model: null, inputs: [], origin: 'generated', upstream: [] },
}) as unknown as DeliverableStateView['candidates'][number];

describe('labelCommandAfterUpload (the upload is the user\'s command, D30)', () => {
  it('generate when allowed', () => {
    expect(labelCommandAfterUpload(view({ allowedCommands: ['generate', 'iterate'] }))).toEqual({ kind: 'generate' });
  });

  it('iterate with the upload observation, anchored to the newest candidate, when generate is not allowed', () => {
    const c = candidate({ kind: 'label', value: { ok: true } });
    expect(labelCommandAfterUpload(view({ state: 'in_review', allowedCommands: ['iterate', 'approve'], candidates: [c] })))
      .toEqual({ kind: 'iterate', deliverableId: 'd1', observation: LAB_UPLOAD_OBSERVATION });
  });

  it('on a failed deliverable with iterate allowed, iterate carries no anchor', () => {
    expect(labelCommandAfterUpload(view({ state: 'failed', allowedCommands: ['retry', 'iterate'] })))
      .toEqual({ kind: 'iterate', deliverableId: null, observation: LAB_UPLOAD_OBSERVATION });
  });

  it('retry when only retry is allowed', () => {
    expect(labelCommandAfterUpload(view({ state: 'failed', allowedCommands: ['retry'] }))).toEqual({ kind: 'retry' });
  });

  it('null when nothing is allowed (generating)', () => {
    expect(labelCommandAfterUpload(view({ state: 'generating', allowedCommands: ['cancel'] }))).toBeNull();
  });
});

describe('label preview and card', () => {
  it('renders LabelResultView from a label candidate\'s inline LabelResult, and nothing for other kinds', () => {
    const result = { ok: true, rulesVersion: 'rules.v9' };
    expect(labelResultOf(candidate({ kind: 'label', value: result }))).toEqual(result);
    expect(labelResultOf(candidate({ kind: 'text', value: 'hola' }))).toBeNull();
    const markup = renderToStaticMarkup(
      <LabelCard
        view={view({ state: 'in_review', allowedCommands: ['iterate'], candidates: [candidate({ kind: 'label', value: result })] })}
        reportNames={['informe.pdf', 'otro.pdf']} uploading={false} busy={false} error="" onCommand={noop}
      />,
    );
    expect(markup).toContain('rules.v9');
    expect(markup).toContain('informe.pdf');
    expect(markup).toContain('otro.pdf');
  });

  it('a failed label shows the failure\'s own message, never a generic one', () => {
    const lastFailure = { taskId: 't', iteration: 1, errorCategory: 'permanent_bug', errorKind: 'lab_report_unusable', retryable: false, errorMessage: 'No encontramos valores nutricionales en tu análisis.' } as const;
    expect(failedCardMessage({ lastFailure, allowedCommands: ['retry'] }, 'etiqueta')).toBe('No encontramos valores nutricionales en tu análisis.');
  });
});

describe('product-only visibility', () => {
  const assets: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };
  const chat = {
    assets, processingAgents: new Set<string>(), conversationId: 'c1', handleExportConversation: noop, onCreateBrand: noop, onImportBrand: noop,
    messages: [] as Message[], isLoading: false, messagesEndRef: React.createRef<HTMLDivElement>(), conversationError: '', retryTurn: null,
    submitTurn: noop, inputText: '', setInputText: noop, handleKeyDown: noop, handleSend: noop, needsNewConversation: false,
  };

  it('the attach button exists only when the chat is given an upload (product conversations)', () => {
    expect(renderToStaticMarkup(<ChatPanel {...chat} />)).not.toContain(LAB_UPLOAD_LABEL);
    const product = renderToStaticMarkup(<ChatPanel {...chat} labUpload={{ busy: false, onFiles: noop }} />);
    expect(product).toContain(`aria-label="${LAB_UPLOAD_LABEL}"`);
    expect(product).toContain('accept="application/pdf,.pdf"');
    expect(product).toContain('multiple');
  });

  it('the dashboard shows the label card only when given label controls', () => {
    const props = { assets, processingAgents: new Set<string>(), step: 1, setActiveTab: noop };
    expect(renderToStaticMarkup(<Dashboard {...props} />)).not.toContain('brand-step-3"');
    expect(renderToStaticMarkup(<Dashboard {...props} labelControls={<p>tarjeta</p>} />)).toContain('tarjeta');
  });
});
