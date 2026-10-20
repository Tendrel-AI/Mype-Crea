import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../src/auth/resolve-identity';
import { globalRepos } from '../../src/repos/global';
import { listPlatformModules } from '../../src/services/platform/modules/registry';
import { currentCalendarMonth, getPlatformMonthlyMetrics, getPlatformAuditTrail } from '../../src/services/platform/metrics/monthly';
import { platformActionLabel, platformScopeLabel } from './labels';

export default async function PlatformPage() {
  let actorWorkosUserId: string;
  try { actorWorkosUserId = (await requireGlobalMfa()).workosUserId; } catch { redirect('/platform/mfa'); }
  const [organizations, metrics, audit] = await Promise.all([
    globalRepos().organizations.list(), getPlatformMonthlyMetrics(actorWorkosUserId), getPlatformAuditTrail(actorWorkosUserId),
  ]);
  const platform = metrics.find((row) => row.organizationId === null);
  const modules = listPlatformModules();
  return <main className="mx-auto max-w-6xl space-y-8 px-5 py-10 text-neutral-900">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-orange-700">CreaMype · Consola global</p><h1 className="text-3xl font-semibold">Panel de plataforma</h1></div><nav className="flex flex-wrap gap-4 text-sm"><Link href="/platform/organizations" className="underline">Organizaciones</Link><Link href="/platform/metrics" className="underline">Métricas</Link><Link href="/platform/modules" className="underline">Módulos</Link><Link href="/platform/operators" className="underline">Administradores</Link></nav></header>
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Summary label="Organizaciones activas" value={organizations.filter((item) => item.status === 'active').length} />
      <Summary label={`Usuarios activos · ${currentCalendarMonth()}`} value={platform?.activeUsers ?? 0} />
      <Summary label="Conversaciones nuevas" value={platform?.newConversations ?? 0} />
      <Summary label="Errores del mes" value={platform?.errors ?? 0} />
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Catálogo de módulos</h2><div className="grid gap-3 md:grid-cols-2">{modules.map((module) => <Link key={module.id} href={`/platform/modules/${module.id}`} className="rounded-xl border bg-white p-5 hover:border-orange-500"><h3 className="font-semibold">{module.name}</h3><p className="mt-1 text-sm text-neutral-600">{module.description}</p></Link>)}</div></section>
    <section className="space-y-3"><div className="flex justify-between"><h2 className="text-xl font-semibold">Actividad reciente</h2><Link href="/platform/audit" className="text-sm underline">Ver actividad</Link></div><AuditRows rows={audit.slice(0, 8)} /></section>
  </main>;
}

function Summary({ label, value }: { label: string; value: number }) { return <article className="rounded-xl border bg-white p-5"><p className="text-sm text-neutral-600">{label}</p><p className="mt-2 text-2xl font-semibold">{value.toLocaleString('es-PE')}</p></article>; }
function AuditRows({ rows }: { rows: Awaited<ReturnType<typeof getPlatformAuditTrail>> }) { return <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Fecha</th><th className="p-3">Acción</th><th className="p-3">Alcance</th><th className="p-3">Resultado</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="p-3">{new Date(row.createdAt).toLocaleString('es-PE')}</td><td className="p-3">{platformActionLabel(row.action)}</td><td className="p-3">{platformScopeLabel(row.scopeType)}{row.scopeId ? ` · ${row.scopeId}` : ''}</td><td className="p-3">{row.outcome === 'success' ? 'Correcto' : 'Fallido'}</td></tr>)}</tbody></table>{rows.length === 0 && <p className="p-4 text-sm text-neutral-600">No hay actividad registrada.</p>}</div>; }
