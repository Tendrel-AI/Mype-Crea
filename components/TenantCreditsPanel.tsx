import type { TenantCreditSummary } from '../src/repos/credits';
import { USAGE_POLICY } from '../src/services/usage/policy';

const usd = (n: number) => `US$ ${n.toFixed(2)}`;

/** F21: read-only credit view. Every number comes from `credits.summary()`; nothing is re-aggregated here. */
export default function TenantCreditsPanel({ summary }: { summary: TenantCreditSummary }) {
  const rows: Array<[string, number]> = [
    ['Saldo actual', summary.balanceUsd],
    ['Total recargado', summary.grantedUsd],
    ['Consumo en texto (LLM)', summary.consumptionByKind.llm],
    ['Consumo en imágenes', summary.consumptionByKind.image],
    ['Consumo de este mes', summary.consumptionByMonth.current],
    ['Consumo del mes anterior', summary.consumptionByMonth.previous],
  ];
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-10">
      <header>
        <h1 className="text-2xl font-semibold">Créditos de tu organización</h1>
        <p className="mt-1 text-neutral-600">Montos en dólares (USD). Solo lectura.</p>
      </header>
      {summary.balanceUsd <= USAGE_POLICY.lowBalanceUsd && (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4">Pide una recarga al administrador de la plataforma</p>
      )}
      <section className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-left text-sm">
          <tbody>{rows.map(([label, value]) => (
            <tr key={label} className="border-b last:border-0"><th className="p-3 font-normal text-neutral-600">{label}</th><td className="p-3">{usd(value)}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </main>
  );
}
