/** KAN-93: the state-based opening message. Pure: no provider, no DB. */
import { describe, expect, it } from 'vitest';
import { renderWelcome, WELCOME_FALLBACK_TEXT, type ChatContext } from '../chat-welcome';
import { buildSingleAgentFixtureRegistry } from '../../core/__tests__/_fixtures';
import type { PlannerDecision } from '../../core/contracts';
import { buildDefaultRegistry } from '../../core/orchestrator/bootstrap-registry';

const { registry } = buildSingleAgentFixtureRegistry();
const brand: ChatContext = { brandId: 'b', brandName: 'Brisa Ron', productId: null, productName: null };
const product: ChatContext = { ...brand, productId: 'p', productName: 'Ron añejo' };
const legacy: ChatContext = { brandId: null, brandName: null, productId: null, productName: null };
const field = (fieldName: string, promptHint: string) => ({ fieldName, promptHint });
const agentId = 'test-fixture-agent';

const decisions: Record<string, PlannerDecision> = {
  one: { kind: 'request_fields', agentId, fields: [field('a', 'Cuéntame el nombre')] },
  many: { kind: 'request_fields', agentId, fields: [field('a', 'Uno'), field('b', 'Dos'), field('c', 'Tres')] },
  confirm: { kind: 'confirm_fields', entries: [{ agentId, fieldName: 'a', pendingValue: 'Brisa' }], reason: 'low_confidence' },
  confirmMany: { kind: 'confirm_fields', entries: [{ agentId, fieldName: 'a', pendingValue: 'Brisa' }, { agentId, fieldName: 'b', pendingValue: 'Cálido' }], reason: 'low_confidence' },
  offer: { kind: 'offer_generation', agentId, deliverableKind: 'logo' },
  review: { kind: 'report_deliverable_status', agentId, deliverableKind: 'logo', state: 'in_review', allowedCommands: ['approve', 'iterate'] },
  failed: { kind: 'report_deliverable_status', agentId, deliverableKind: 'logo', state: 'failed', allowedCommands: ['retry'] },
  generating: { kind: 'report_deliverable_status', agentId, deliverableKind: 'logo', state: 'generating', allowedCommands: ['cancel'] },
  done: { kind: 'announce_all_complete' },
};

describe('renderWelcome', () => {
  it('starts with the brand or product context line, none for legacy', () => {
    expect(renderWelcome([decisions.done], brand, registry)).toMatch(/^Este es el chat de tu marca «Brisa Ron»\.\n\n/);
    expect(renderWelcome([decisions.done], product, registry)).toMatch(/^Este es el chat de tu producto «Ron añejo» de la marca «Brisa Ron»\.\n\n/);
    expect(renderWelcome([decisions.done], { ...brand, brandName: null }, registry)).toContain('«Marca sin nombre»');
    expect(renderWelcome([decisions.done], legacy, registry)).not.toContain('Este es el chat');
  });

  it('the owner case: brand chat with a logo in review', () => {
    const text = renderWelcome([decisions.review], brand, registry);
    expect(text).toContain('Este es el chat de tu marca «Brisa Ron».');
    expect(text).toMatch(/en el panel para que lo revises: si te gusta, toca Aprobar; si quieres cambios, toca Iterar\./);
  });

  it('writes the real card label in lower case mid-sentence («tu logo», not «Tu Logo»)', () => {
    const real = buildDefaultRegistry();
    const text = renderWelcome([{ ...decisions.review, agentId: 'logo-agent' } as PlannerDecision], brand, real);
    expect(text).toContain('Tu logo está en el panel');
  });

  it('renders one template per decision kind', () => {
    expect(renderWelcome([decisions.one], brand, registry)).toContain('- Cuéntame el nombre');
    const list = renderWelcome([decisions.many], brand, registry);
    expect(list).toContain('qué quieres lograr, qué te inspira');
    expect(list).not.toMatch(/1\. Uno|no aplica|sin preferencia/);
    expect(renderWelcome([decisions.confirm], brand, registry)).toContain('«Brisa». ¿Es correcto?');
    expect(renderWelcome([decisions.confirmMany], brand, registry)).toContain('- «Brisa»\n- «Cálido»\n¿Es todo correcto?');
    expect(renderWelcome([decisions.offer], brand, registry)).toContain('Cuando quieras, toca el botón Generar.');
    expect(renderWelcome([decisions.failed], brand, registry)).toContain('botón Reintentar');
    expect(renderWelcome([decisions.generating], brand, registry)).toContain('se está generando');
    expect(renderWelcome([decisions.done], brand, registry)).toContain('«Nuevo producto»');
    expect(renderWelcome([decisions.done], product, registry)).toContain('Tu etiqueta nutricional está lista.');
    expect(renderWelcome([decisions.done], product, registry)).not.toContain('pronto');
  });

  it('D34: a product chat without the lab report asks for the upload, using the card hint', () => {
    const request: PlannerDecision = { kind: 'request_upload', agentId: 'label-agent', deliverableKind: 'label', uploadKind: 'lab_report', promptHint: buildDefaultRegistry().get('label-agent').card['mypes:requirements'].uploads![0].promptHint };
    const text = renderWelcome([request], product, registry);
    expect(text).toContain('Para tu etiqueta nutricional, sube el análisis de laboratorio de tu producto (PDF) con el botón «Subir análisis de laboratorio».');
    expect(text).toContain('los octógonos.');
  });

  it('ignores announcements and falls back when nothing is plannable', () => {
    const announce = { kind: 'announce_dispatch', agentId, taskId: 't' } as PlannerDecision;
    expect(renderWelcome([announce, decisions.offer], brand, registry)).toContain('botón Generar');
    expect(renderWelcome([announce], legacy, registry)).toBe(WELCOME_FALLBACK_TEXT);
  });

  it('never greets, counts steps or asks to continue', () => {
    for (const d of Object.values(decisions)) {
      for (const c of [brand, product, legacy]) {
        expect(renderWelcome([d], c, registry)).not.toMatch(/¡Hola!|Paso|5 pasos|¿seguimos|estratega/i);
      }
    }
  });
});
