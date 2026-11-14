import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BriefPanel } from '../BriefPanel';
import { BRIEF_CATALOG } from '../../../src/core/brief';
import type { BriefPanelField } from '../../../app/actions/brief';

const onSave = async () => true;

function fields(overrides: Record<string, Partial<BriefPanelField>> = {}): BriefPanelField[] {
  return BRIEF_CATALOG.map((spec) => ({
    name: spec.name,
    label: spec.label,
    maxLength: spec.maxLength,
    status: 'empty',
    value: null,
    source: null,
    origin: 'conversation',
    ...overrides[spec.name],
  }));
}

describe('BriefPanel (KAN-26)', () => {
  it('lists every catalog field with «Sin completar» and an edit button per field', () => {
    const html = renderToStaticMarkup(<BriefPanel fields={fields()} savingField={null} error={null} onSave={onSave} />);
    for (const spec of BRIEF_CATALOG) {
      expect(html).toContain(spec.label);
      expect(html).toContain(`aria-label="Editar ${spec.label}"`);
    }
    expect(html.match(/Sin completar/g)).toHaveLength(BRIEF_CATALOG.length);
    expect(html).not.toContain('Confirmar');
  });

  it('shows the accepted value with its source, and «Por confirmar» plus «Confirmar» for a pending value', () => {
    const html = renderToStaticMarkup(
      <BriefPanel
        fields={fields({
          business_name: { status: 'filled', value: 'Dulce Andino', source: 'panel' },
          style_keywords: { status: 'pending_confirmation', value: 'rústico', source: 'chat' },
        })}
        savingField={null}
        error={null}
        onSave={onSave}
      />,
    );
    expect(html).toContain('Dulce Andino');
    expect(html).toContain('Editado aquí');
    expect(html).toContain('rústico');
    expect(html).toContain('Del chat');
    expect(html.match(/Por confirmar/g)).toHaveLength(1);
    expect(html.match(/> Confirmar</g)).toHaveLength(1);
  });

  it('shows the server error on its field as an alert, and disables edits while saving', () => {
    const html = renderToStaticMarkup(
      <BriefPanel
        fields={fields()}
        savingField="business_name"
        error={{ field: 'product_name', message: '«Producto» puede tener hasta 120 caracteres.' }}
        onSave={onSave}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('«Producto» puede tener hasta 120 caracteres.');
    expect(html.match(/disabled=""/g)).toHaveLength(BRIEF_CATALOG.length);
  });

  it('uses neutral Spanish with tuteo (no voseo)', () => {
    const html = renderToStaticMarkup(
      <BriefPanel fields={fields({ style_keywords: { status: 'pending_confirmation', value: 'x', source: 'chat' } })} savingField={null} error={null} onSave={onSave} />,
    );
    expect(html).not.toMatch(/\b(vos|sos|querés|tenés|podés|editá|confirmá|guardá)\b/i);
  });

  it('shows where each value lives: «De la marca» and «Del producto», nothing for conversation-only fields', () => {
    const html = renderToStaticMarkup(
      <BriefPanel
        fields={fields({ business_name: { origin: 'brand' }, product_name: { origin: 'product' } })}
        savingField={null}
        error={null}
        onSave={onSave}
      />,
    );
    expect(html.match(/De la marca/g)).toHaveLength(1);
    expect(html.match(/Del producto/g)).toHaveLength(1);
  });
});
