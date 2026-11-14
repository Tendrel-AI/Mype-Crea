import type { ForecastView } from '../src/repos/forecast';

const usd = (n: number) => `US$ ${n.toFixed(2)}`;
const monthLabel = (m: string) => new Date(`${m}T12:00:00Z`).toLocaleDateString('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** F22: presentational. Shows the stored current-month snapshot and the last snapshots. */
export default function ForecastPanel({ view }: { view: ForecastView }) {
  const { current, recent } = view;
  const f = current.forecast;
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-10">
      <header>
        <h1 className="text-2xl font-semibold">Proyección de consumo</h1>
        <p className="mt-1 text-neutral-600">Estimación para {monthLabel(current.month)}, según tu uso real y valores de referencia de la plataforma.</p>
        {f.pocosDatos && (
          <span className="mt-2 inline-block rounded-full bg-amber-100 px-3 py-1 text-sm text-amber-800">Pocos datos</span>
        )}
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border bg-white p-4"><p className="text-sm text-neutral-600">Gasto esperado del mes</p><p className="text-2xl font-semibold">{usd(f.expectedSpendUsd)}</p></div>
        <div className="rounded-xl border bg-white p-4"><p className="text-sm text-neutral-600">Recarga sugerida</p><p className="text-2xl font-semibold">{usd(f.suggestedRechargeUsd)}</p></div>
        <div className="rounded-xl border bg-white p-4"><p className="text-sm text-neutral-600">Por cada marca nueva</p><p className="text-xl">{usd(f.perNewBrandUsd)}</p></div>
        <div className="rounded-xl border bg-white p-4"><p className="text-sm text-neutral-600">Por cada producto nuevo</p><p className="text-xl">{usd(f.perNewProductUsd)}</p></div>
      </section>

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Últimos meses</h2>
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b text-neutral-600"><th className="p-3">Mes</th><th className="p-3">Gasto esperado</th><th className="p-3">Recarga sugerida</th><th className="p-3">Confianza</th></tr></thead>
              <tbody>{recent.map((s) => (
                <tr key={s.month} className="border-b last:border-0">
                  <td className="p-3">{monthLabel(s.month)}</td><td className="p-3">{usd(s.forecast.expectedSpendUsd)}</td>
                  <td className="p-3">{usd(s.forecast.suggestedRechargeUsd)}</td>
                  <td className="p-3">{s.forecast.pocosDatos ? 'Pocos datos' : s.forecast.confidence === 'high' ? 'Alta' : 'Media'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
