import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeliverableCommands, iterateSubmission } from '../DeliverableCommands';
import { developerFailureChatText, failedCardMessage } from '../failure-copy';
import { Dashboard } from '../Dashboard';
import type { DeliverableStateView } from '../../../src/core/contracts';
import type { BrandAssets } from '../types';

const noop = () => {};

function view(partial: Partial<DeliverableStateView>): DeliverableStateView {
  return {
    agentId: 'logo-agent',
    deliverableKind: 'logo',
    state: 'enabled',
    stale: false,
    allowedCommands: [],
    missingFields: [],
    missingUpstream: [],
    activeTask: null,
    lastFailure: null,
    candidates: [],
    approvedDeliverableId: null,
    stateToken: 'ds1-00000000',
    ...partial,
  };
}

const candidate = (n: number) => ({
  deliverableId: `00000000-0000-4000-8000-00000000000${n}`,
  taskId: `10000000-0000-4000-8000-00000000000${n}`,
  contentUrl: `https://cdn.test/logo-${n}.png`,
  contentInline: null,
  createdAt: `2026-10-25T00:00:0${n}.000Z`,
});

const render = (v: DeliverableStateView | undefined, extra: { onAdvance?: () => void; error?: string } = {}) =>
  renderToStaticMarkup(
    <DeliverableCommands view={v} label="logo" busy={false} error={extra.error ?? ''} onCommand={noop} onAdvance={extra.onAdvance} />,
  );

const buttons = (markup: string) =>
  [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

describe('DeliverableCommands (KAN-28)', () => {
  it('renders nothing before the server state arrives', () => {
    expect(render(undefined)).toBe('');
  });

  it('renders buttons only from allowedCommands', () => {
    expect(buttons(render(view({ state: 'enabled', allowedCommands: ['generate'] })))).toEqual(['Generar']);
    expect(buttons(render(view({ state: 'generating', allowedCommands: ['cancel'] })))).toEqual(['Cancelar']);
    expect(buttons(render(view({ state: 'generating', allowedCommands: [] })))).toEqual([]);
    expect(buttons(render(view({ state: 'blocked', allowedCommands: [] })))).toEqual([]);
  });

  it('shows Spanish state badges and guidance with tú', () => {
    expect(render(view({ state: 'blocked', missingFields: ['style'] }))).toContain('Bloqueado');
    expect(render(view({ state: 'blocked', missingFields: ['business_name', 'style_keywords'] }))).toContain(
      'Para habilitar tu logo falta: Nombre del negocio, Estilo. Complétalo en el chat o en los datos de tu marca.',
    );
    expect(render(view({ state: 'enabled', allowedCommands: ['generate'] }))).toContain('Listo para generar');
    expect(render(view({ state: 'generating', allowedCommands: ['cancel'] }))).toContain('Generando');
  });

  it('in review: candidates with Aprobar each, plus Iterar', () => {
    const markup = render(
      view({ state: 'in_review', allowedCommands: ['iterate', 'approve'], candidates: [candidate(1), candidate(2)] }),
    );
    expect(markup).toContain('En revisión');
    expect(markup).toContain('src="https://cdn.test/logo-1.png"');
    expect(markup).toContain('src="https://cdn.test/logo-2.png"');
    expect(buttons(markup)).toEqual(['Aprobar', 'Aprobar', 'Iterar']);
  });

  it('approved (e.g. after reload): marks the approved candidate, offers Aprobar for the others, and «Avanzar» is UI-only', () => {
    const approved = view({
      state: 'approved',
      allowedCommands: ['iterate', 'approve'],
      candidates: [candidate(1), candidate(2)],
      approvedDeliverableId: candidate(1).deliverableId,
    });
    const markup = render(approved, { onAdvance: noop });
    expect(markup).toContain('Aprobado');
    expect(markup).toContain('Aprobada');
    expect(buttons(markup)).toEqual(['Aprobar', 'Iterar', 'Avanzar']);
    // Without a navigation target there is no «Avanzar» at all.
    expect(buttons(render(approved))).toEqual(['Aprobar', 'Iterar']);
  });

  it('shows the obsoleto overlay on an approved deliverable', () => {
    const markup = render(
      view({
        state: 'approved',
        stale: true,
        allowedCommands: ['generate', 'iterate'],
        candidates: [candidate(1)],
        approvedDeliverableId: candidate(1).deliverableId,
      }),
    );
    expect(markup).toContain('Obsoleto');
    expect(buttons(markup)).toEqual(['Generar', 'Iterar']);
  });

  const failedView = (errorCategory: 'transient' | 'content_policy' | 'permanent_bug' | null, allowedCommands: DeliverableStateView['allowedCommands']) =>
    view({
      state: 'failed',
      allowedCommands,
      lastFailure: { taskId: candidate(1).taskId, errorCategory, retryable: errorCategory === 'transient' },
    });

  it.each([
    ['transient', ['retry'], ['Reintentar'], 'Fue un problema temporal: toca Reintentar.'],
    ['content_policy', ['iterate', 'retry'], ['Iterar', 'Reintentar'], 'Toca Iterar para cambiar lo que pediste'],
    ['permanent_bug', ['retry'], ['Reintentar'], 'Toca Reintentar para probar otra vez.'],
    [null, ['retry'], ['Reintentar'], 'Toca Reintentar para probar otra vez.'],
  ] as const)('failed (%s): «Falló», plain copy and a recovery button (KAN-58)', (category, allowed, expectedButtons, copy) => {
    const markup = render(failedView(category, [...allowed]));
    expect(markup).toContain('Falló');
    expect(markup).toContain('No pudimos generar tu logo.');
    expect(markup).toContain(copy);
    expect(buttons(markup)).toEqual(expectedButtons);
    // No technical detail on the card, ever.
    expect(markup).not.toMatch(/transient|content_policy|permanent_bug|error|Categoría|Modo desarrollo/i);
  });

  it('failed with the brief incomplete: no button, and the copy says how to unblock it', () => {
    const markup = render(failedView('permanent_bug', []));
    expect(buttons(markup)).toEqual([]);
    expect(markup).toContain('Completa la información en el chat para volver a intentarlo.');
  });

  it('Iterar after a failure: no anchor, and an empty change cannot be sent', () => {
    const failed = failedView('content_policy', ['iterate', 'retry']);
    expect(iterateSubmission(failed, '   ')).toBeNull();
    expect(iterateSubmission(failed, '  Sin la mascota  ')).toEqual({
      kind: 'iterate',
      deliverableId: null,
      observation: 'Sin la mascota',
    });
    expect(iterateSubmission(failed, 'é'.repeat(501))).toBeNull();
    // In review, the anchor is the newest candidate and a blank observation is allowed.
    const review = view({ state: 'in_review', allowedCommands: ['iterate', 'approve'], candidates: [candidate(1), candidate(2)] });
    expect(iterateSubmission(review, ' ')).toEqual({ kind: 'iterate', deliverableId: candidate(2).deliverableId, observation: '' });
  });

  it('shows the server rejection message', () => {
    expect(render(view({ allowedCommands: ['generate'] }), { error: 'Esta acción no está disponible en este momento.' })).toContain(
      'role="alert"',
    );
  });

  it('never uses voseo in its copy', () => {
    const all = [
      render(view({ state: 'blocked' })),
      render(view({ state: 'blocked', missingUpstream: ['logo'] })),
      render(view({ state: 'enabled', allowedCommands: ['generate'] })),
      render(failedView('transient', ['retry'])),
      render(failedView('content_policy', ['iterate', 'retry'])),
      render(failedView('permanent_bug', ['retry'])),
      render(failedView('permanent_bug', [])),
      failedCardMessage(failedView(null, ['retry']), 'logo'),
      developerFailureChatText('logo-agent', { errorCategory: 'transient', errorKind: 'timeout', message: 'x' }),
      render(view({ state: 'approved', stale: true, candidates: [candidate(1)], approvedDeliverableId: candidate(1).deliverableId })),
    ].join(' ');
    expect(all).not.toMatch(/\b(vos|sos|tenés|querés|podés|tocá|revisá|completá|aprobá)\b/i);
  });

  it('developer failure chat text carries the category, kind and message', () => {
    expect(
      developerFailureChatText('logo-agent', { errorCategory: 'content_policy', errorKind: 'content_policy', message: 'blocked' }),
    ).toBe('[Modo desarrollo] Falló la tarea de logo-agent. Categoría: content_policy. Tipo: content_policy. Detalle: blocked');
  });

  it('Dashboard renders the logo controls slot inside the logo card', () => {
    const assets: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };
    const markup = renderToStaticMarkup(
      <Dashboard
        assets={assets}
        processingAgents={new Set()}
        step={1}
        setActiveTab={noop}
        logoControls={<DeliverableCommands view={view({ allowedCommands: ['generate'] })} label="logo" busy={false} error="" onCommand={noop} />}
      />,
    );
    expect(markup).toContain('data-testid="deliverable-commands-logo-agent"');
    expect(markup.indexOf('deliverable-commands-logo-agent')).toBeLessThan(markup.indexOf('id="brand-step-3"'));
  });
});
