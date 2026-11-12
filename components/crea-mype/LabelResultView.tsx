import React from 'react';
import { octagonSvg } from '../../src/labeling/octagon-svg';
import type { LabelNotice, LabelResult, OctagonKey } from '../../src/labeling/types';

const ALT: Record<OctagonKey, string> = {
  alto_en_sodio: 'Octógono: Alto en sodio, evitar su consumo excesivo',
  alto_en_azucar: 'Octógono: Alto en azúcar, evitar su consumo excesivo',
  alto_en_grasas_saturadas: 'Octógono: Alto en grasas saturadas, evitar su consumo excesivo',
  contiene_grasas_trans: 'Octógono: Contiene grasas trans, evitar su consumo',
};

const dataUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function Notice({ n }: { n: LabelNotice }) {
  const warn = n.severity === 'warning';
  return (
    <li className={warn ? 'rounded-lg border border-amber-400 bg-amber-50 p-3 text-amber-950' : 'rounded-lg border border-sky-300 bg-sky-50 p-3 text-sky-950'}>
      <strong>{warn ? 'Advertencia: ' : 'Información: '}</strong>{n.message}
    </li>
  );
}

export function LabelResultView({ result }: { result: LabelResult }) {
  const required = result.octagons.filter((o) => o.status === 'required');
  const notices = [...result.notices.filter((n) => n.severity === 'warning'), ...result.notices.filter((n) => n.severity === 'info')];
  const unit = result.basis === 'per_100ml' ? 'ml' : 'g';
  const cell = (v: string | null) => v ?? 'No reportado';
  return (
    <div className="space-y-6 text-slate-900">
      <section aria-label="Octógonos">
        {required.length === 0 ? <p>Tu producto no lleva octógonos según el análisis.</p> : (
          <ul className="flex flex-wrap gap-4">
            {required.map((o) => (
              <li key={o.key}><img src={dataUri(octagonSvg(o.key))} alt={ALT[o.key]} className="h-40 w-auto" /></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Tabla nutricional">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Información nutricional</caption>
          <thead>
            <tr className="border-b border-slate-400 text-left">
              <th scope="col" className="py-2">Nutriente</th>
              <th scope="col" className="py-2">Por 100 {unit}</th>
              {result.serving && <th scope="col" className="py-2">Por porción ({result.serving.amount} {result.serving.unit})</th>}
            </tr>
          </thead>
          <tbody>
            {result.table.map((r) => (
              <tr key={r.nutrient} className="border-b border-slate-200">
                <th scope="row" className="py-1 text-left font-medium">{r.label} ({r.unit})</th>
                <td>{cell(r.per100)}</td>
                {result.serving && <td>{cell(r.perServing)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {notices.length > 0 && <ul className="space-y-2" aria-label="Avisos">{notices.map((n) => <Notice key={n.code} n={n} />)}</ul>}

      <section aria-label="Detalle de octógonos" className="space-y-2">
        {result.octagons.map((o) => (
          <details key={o.key} className="rounded-lg border border-slate-300 p-2 text-sm">
            <summary className="cursor-pointer font-medium">{ALT[o.key].replace('Octógono: ', '')}: ¿Por qué?</summary>
            <p className="mt-1">{o.explanation}</p>
          </details>
        ))}
      </section>

      <footer className="text-xs text-slate-700">
        <p>Versión de reglas: {result.rulesVersion}</p>
        <ul>
          {result.sources.map((s) => (
            <li key={s.fileId}>Informe {s.reportNumber ?? 's/n'}{s.used ? '' : ' (no usado)'}</li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
