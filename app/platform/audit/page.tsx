import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { getPlatformAuditTrail } from '../../../src/services/platform/metrics/monthly';
import { platformActionLabel, platformScopeLabel } from '../labels';

export default async function PlatformAuditPage() {
  let actorWorkosUserId: string;
  try { actorWorkosUserId = (await requireGlobalMfa()).workosUserId; } catch { redirect('/platform/mfa'); }
  const rows = await getPlatformAuditTrail(actorWorkosUserId);
  return <main className="mx-auto max-w-6xl space-y-6 px-5 py-10"><header><Link href="/platform" className="text-sm underline">← Consola</Link><h1 className="mt-3 text-3xl font-semibold">Registro de actividad</h1></header><div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Fecha</th><th className="p-3">Actor</th><th className="p-3">Acción</th><th className="p-3">Alcance</th><th className="p-3">Versiones</th><th className="p-3">Resultado</th><th className="p-3">Motivo</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="p-3">{new Date(row.createdAt).toLocaleString('es-PE')}</td><td className="p-3 font-mono text-xs">{row.actorWorkosUserId ?? '—'}</td><td className="p-3">{platformActionLabel(row.action)}</td><td className="p-3">{platformScopeLabel(row.scopeType)}{row.scopeId ? ` · ${row.scopeId}` : ''}</td><td className="p-3">{row.priorVersion ?? '—'} → {row.newVersion ?? '—'}</td><td className="p-3">{row.outcome === 'success' ? 'Correcto' : 'Fallido'}</td><td className="p-3">{row.reason ?? '—'}</td></tr>)}</tbody></table>{rows.length === 0 && <p className="p-4 text-sm text-neutral-600">No hay actividad registrada.</p>}</div></main>;
}
