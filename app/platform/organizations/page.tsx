import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { globalRepos } from '../../../src/repos/global';
import { OrganizationCreateForm } from '../../../components/PlatformConsole';

export default async function PlatformOrganizationsPage() {
  let actorWorkosUserId: string;
  try { actorWorkosUserId = (await requireGlobalMfa()).workosUserId; } catch { redirect('/platform/mfa'); }
  const [organizations, summaries] = await Promise.all([globalRepos().organizations.list(), globalRepos().counters.creditSummaries(actorWorkosUserId)]);
  return <main className="mx-auto max-w-6xl space-y-6 px-5 py-10"><header><Link href="/platform" className="text-sm underline">← Consola</Link><h1 className="mt-3 text-3xl font-semibold">Organizaciones</h1><p className="mt-1 text-neutral-600">Administra el acceso y el estado de cada organización.</p></header>
    <OrganizationCreateForm />
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Nombre</th><th className="p-3">ID</th><th className="p-3">Estado</th><th className="p-3">Saldo (USD)</th><th className="p-3">Consumo 30 días (USD)</th><th className="p-3">Actualizada</th><th className="p-3"> </th></tr></thead><tbody>{organizations.map((organization) => <tr key={organization.tenantId} className="border-b last:border-0"><td className="p-3 font-medium">{organization.name}</td><td className="p-3 font-mono text-xs">{organization.tenantId}</td><td className="p-3">{organization.status === 'active' ? 'Activa' : 'Inactiva'}</td><td className="p-3">{(summaries.get(organization.tenantId)?.balanceUsd ?? 0).toFixed(2)}</td><td className="p-3">{(summaries.get(organization.tenantId)?.consumption30dUsd ?? 0).toFixed(2)}</td><td className="p-3">{new Date(organization.updatedAt).toLocaleDateString('es-PE')}</td><td className="p-3"><Link className="underline" href={`/platform/organizations/${organization.tenantId}`}>Ver detalles</Link></td></tr>)}</tbody></table>{organizations.length === 0 && <p className="p-4 text-sm text-neutral-600">Todavía no hay organizaciones.</p>}</div>
  </main>;
}
