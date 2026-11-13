import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { getPlatformLimitDefaults } from '../../actions/platform-limits';
import { LimitDefaultForm } from '../../../components/PlatformCatalogForms';

export default async function PlatformLimitsPage() {
  try { await requireGlobalMfa(); } catch { redirect('/platform/mfa'); }
  const limits = await getPlatformLimitDefaults();
  return <main className="mx-auto max-w-4xl space-y-6 px-5 py-10"><header><Link href="/platform" className="text-sm underline">← Consola</Link><h1 className="mt-3 text-3xl font-semibold">Límites predeterminados</h1><p className="mt-1 text-neutral-600">Los cambios aplican a organizaciones nuevas; los perfiles existentes no cambian.</p></header>
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Límite</th><th className="p-3">Clave</th><th className="p-3">Valor (0–1000)</th></tr></thead><tbody>{limits.map((limit) => <tr key={limit.key} className="border-b last:border-0"><td className="p-3">{limit.label}</td><td className="p-3 font-mono text-xs">{limit.key}</td><td className="p-3"><LimitDefaultForm limitKey={limit.key} value={limit.value} /></td></tr>)}</tbody></table></div>
  </main>;
}
