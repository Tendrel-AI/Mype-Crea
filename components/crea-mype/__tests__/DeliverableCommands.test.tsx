import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeliverableCommands, NAME_AVAILABILITY_NOTE, iterateSubmission, missingUpstreamMessage } from '../DeliverableCommands';
import { developerFailureChatText, failedCardMessage } from '../failure-copy';
import { usageLimitMessage } from '../../../src/services/usage/policy';
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
  iteration: n,
  stale: false,
  provenance: { promptVersion: null, agentCardVersion: null, provider: null, model: null, inputs: [], upstream: [] },
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

  it('shows the «Potencialmente desactualizado» overlay on an approved deliverable', () => {
    const markup = render(
      view({
        state: 'approved',
        stale: true,
        allowedCommands: ['generate', 'iterate'],
        candidates: [candidate(1)],
        approvedDeliverableId: candidate(1).deliverableId,
      }),
    );
    expect(markup).toContain('Potencialmente desactualizado');
    expect(markup).toContain('o mantener el aprobado');
    expect(buttons(markup)).toEqual(['Generar', 'Iterar']);
  });

  it('shows the overlay on a deliverable still in review (KAN-35), without promising an approved one', () => {
    const markup = render(
      view({
        state: 'in_review',
        stale: true,
        allowedCommands: ['generate', 'iterate', 'approve'],
        candidates: [candidate(1)],
      }),
    );
    expect(markup).toContain('Potencialmente desactualizado');
    expect(markup).toContain('No lo regeneramos solo');
    expect(markup).not.toContain('mantener el aprobado');
  });

  it('name candidates (KAN-31): name and rationale as text, Aprobar each, and the INDECOPI note', () => {
    const nameCandidate = (n: number, name: string) => ({
      ...candidate(n),
      contentUrl: null,
      contentInline: { value: name, kind: 'text', metadata: { rationale: `Por qué ${name} encaja.` } },
    });
    const names = view({
      agentId: 'name-agent',
      deliverableKind: 'business_name',
      state: 'in_review',
      allowedCommands: ['iterate', 'approve'],
      candidates: [nameCandidate(1, 'Dulce Andino'), nameCandidate(2, 'Sabor de Altura')],
    });
    const markup = renderToStaticMarkup(
      <DeliverableCommands view={names} label="nombre" note={NAME_AVAILABILITY_NOTE} busy={false} error="" onCommand={noop} />,
    );
    expect(markup).toContain('Dulce Andino');
    expect(markup).toContain('Por qué Sabor de Altura encaja.');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('<p role="note" class="text-xs text-neutral-600">Verifica la disponibilidad del nombre en INDECOPI antes de usarlo.</p>');
    expect(buttons(markup)).toEqual(['Aprobar', 'Aprobar', 'Iterar']);
    // No note before there is anything to verify.
    const empty = renderToStaticMarkup(
      <DeliverableCommands view={view({ ...names, state: 'enabled', allowedCommands: ['generate'], candidates: [] })} label="nombre" note={NAME_AVAILABILITY_NOTE} busy={false} error="" onCommand={noop} />,
    );
    expect(empty).not.toContain('INDECOPI');
  });

  const failedView = (
    errorCategory: 'transient' | 'content_policy' | 'permanent_bug' | null,
    allowedCommands: DeliverableStateView['allowedCommands'],
    errorKind: string | null = null,
  ) =>
    view({
      state: 'failed',
      allowedCommands,
      lastFailure: { taskId: candidate(1).taskId, iteration: 2, errorCategory, errorKind, retryable: errorCategory === 'transient' },
    });

  it('a worker-side usage denial shows the image-limit copy from the usage policy (KAN-43)', () => {
    const markup = render(failedView('transient', ['retry'], 'usage_limited'));
    expect(markup).toContain(usageLimitMessage('user_image_daily'));
    expect(markup).not.toContain('No pudimos generar tu logo.');
    expect(markup).not.toContain('usage_limited');
  });

  it('«Lema» (KAN-32): blocked until the name is approved, with the server\'s missing precondition named', () => {
    const blocked = view({ agentId: 'tagline-agent', deliverableKind: 'tagline', state: 'blocked', missingUpstream: ['business_name'] });
    const markup = render(blocked);
    expect(markup).toContain('Primero aprueba tu nombre comercial.');
    expect(buttons(markup)).toEqual([]);
    expect(missingUpstreamMessage(['some_future_kind'])).toBe('Primero aprueba los entregables anteriores.');
    const failed = { ...failedView('transient', ['retry'], 'usage_limited'), deliverableKind: 'tagline' };
    expect(failedCardMessage(failed, 'lema')).toBe(usageLimitMessage('user_llm_hourly'));
  });

  it('a worker-side usage denial on names shows the LLM-limit copy (KAN-31)', () => {
    const failed = { ...failedView('transient', ['retry'], 'usage_limited'), deliverableKind: 'business_name' };
    expect(failedCardMessage(failed, 'nombre')).toBe(usageLimitMessage('user_llm_hourly'));
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
      failedCardMessage(failedView('transient', ['retry'], 'usage_limited'), 'logo'),
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
