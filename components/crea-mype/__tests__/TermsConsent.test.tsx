import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../../../app/actions/terms', () => ({ acceptTermsAction: vi.fn() }));

import { TermsConsent } from '../TermsConsent';
import { CURRENT_TERMS, TERMS_REQUIRED_MESSAGE, TERMS_UNAVAILABLE_MESSAGE } from '../../../src/consent/terms';

describe('TermsConsent (KAN-27)', () => {
  const html = renderToStaticMarkup(<TermsConsent terms={CURRENT_TERMS} />);

  it('shows every section of the current version and a disabled button until the box is checked', () => {
    expect(html).toContain(CURRENT_TERMS.title);
    for (const section of CURRENT_TERMS.sections) {
      expect(html).toContain(section.heading);
      expect(html).toContain(section.body);
    }
    expect(html).toContain(`Versión: ${CURRENT_TERMS.version}`);
    expect(html).toMatch(/<input type="checkbox"[^>]*\/>/);
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Aceptar y continuar<\/button>/);
  });

  it('states the owner-required points: purpose, storage, processors, minimization, Ley N.º 29733, contact', () => {
    const headings = CURRENT_TERMS.sections.map((section) => section.heading);
    expect(headings).toEqual(expect.arrayContaining([
      'Para qué usamos tus datos', 'Qué guardamos y dónde', 'Con quién compartimos tus datos',
      'Solo lo necesario', 'Marco legal', 'Contacto',
    ]));
    expect(html).toContain('Ley N.º 29733');
  });

  it('uses neutral Spanish with tuteo (no voseo, no Spain-only forms)', () => {
    const all = [html, TERMS_REQUIRED_MESSAGE, TERMS_UNAVAILABLE_MESSAGE].join(' ');
    expect(all).not.toMatch(/\b(vos|sos|tenés|querés|podés|aceptá|revisá|leé|vosotros|vale|ordenador|coger)\b/i);
  });
});
