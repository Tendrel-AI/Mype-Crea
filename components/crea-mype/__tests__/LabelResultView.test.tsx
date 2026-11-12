import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LabelResult, OctagonVerdict } from '../../../src/labeling/types';
import { LabelResultView } from '../LabelResultView';

const verdict = (key: OctagonVerdict['key'], status: OctagonVerdict['status']): OctagonVerdict =>
  ({ key, status, nutrient: 'total_sugars', value: 11, threshold: 6, basis: 'per_100ml', reason: 'measured', explanation: `Explicación ${key}` });
const base: LabelResult = {
  ok: true, rulesVersion: 'map-2018-fase2', productState: 'liquid', basis: 'per_100ml', serving: { amount: 330, unit: 'ml' },
  table: [
    { nutrient: 'total_sugars', label: 'Azúcares totales', unit: 'g', per100: '11,0', perServing: '36,3' },
    { nutrient: 'fiber', label: 'Fibra', unit: 'g', per100: null, perServing: null },
  ],
  octagons: [verdict('alto_en_sodio', 'not_required'), verdict('alto_en_azucar', 'required'), verdict('alto_en_grasas_saturadas', 'not_evaluated'), verdict('contiene_grasas_trans', 'not_required')],
  notices: [{ code: 'i', severity: 'info', message: 'Dato informativo' }, { code: 'w', severity: 'warning', message: 'Densidad estimada' }],
  sources: [{ fileId: 'a', reportNumber: 'INF-1', used: true }, { fileId: 'b', reportNumber: 'INF-2', used: false }],
};

describe('LabelResultView', () => {
  it('renders the required octagon, table, serving column, notices (warnings first) and footer', () => {
    const m = renderToStaticMarkup(<LabelResultView result={base} />);
    expect(m).toContain('data:image/svg+xml;utf8,');
    expect(m).toContain('alt="Octógono: Alto en azúcar');
    expect(m.match(/<img/g)).toHaveLength(1);
    expect(m).toContain('Por 100 ml');
    expect(m).toContain('Por porción (330 ml)');
    expect(m).toContain('No reportado');
    expect(m).toContain('<th scope="col"');
    expect(m.indexOf('Densidad estimada')).toBeLessThan(m.indexOf('Dato informativo'));
    expect(m).toContain('¿Por qué?');
    expect(m).toContain('map-2018-fase2');
    expect(m).toContain('INF-2 (no usado)');
  });

  it('says so when no octagon is required', () => {
    const m = renderToStaticMarkup(<LabelResultView result={{ ...base, serving: null, octagons: base.octagons.map((o) => ({ ...o, status: 'not_required' as const })) }} />);
    expect(m).toContain('Tu producto no lleva octógonos según el análisis.');
    expect(m).not.toContain('<img');
    expect(m).not.toContain('Por porción');
  });
});
