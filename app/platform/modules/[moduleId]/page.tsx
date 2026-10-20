import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../../src/auth/resolve-identity';
import { globalRepos } from '../../../../src/repos/global';
import { getPlatformModule } from '../../../../src/services/platform/modules/registry';
import { PlatformModuleAdmin } from '../../../../components/PlatformConsole';

export default async function PlatformModulePage({ params }: { params: Promise<{ moduleId: string }> }) {
  try { await requireGlobalMfa(); } catch { redirect('/platform/mfa'); }
  const { moduleId } = await params;
  const platformModule = getPlatformModule(moduleId);
  if (!platformModule) notFound();
  const [versions, organizations] = await Promise.all([
    globalRepos().config.listVersions(moduleId), globalRepos().organizations.list(),
  ]);
  const { validateConfig: _validateConfig, ...publicModule } = platformModule;
  return <main className="mx-auto max-w-6xl space-y-6 px-5 py-10"><header><Link href="/platform/modules" className="text-sm underline">← Módulos</Link><h1 className="mt-3 text-3xl font-semibold">{platformModule.name}</h1><p className="mt-1 text-neutral-600">{platformModule.description}</p></header>
    <section className="grid gap-4 md:grid-cols-3">{[['Configuración global', platformModule.globalSettings], ['Configuración por organización', platformModule.tenantSettings], ['Métricas', platformModule.metrics]].map(([label, entries]) => <article key={String(label)} className="rounded-xl border bg-white p-4"><h2 className="font-semibold">{String(label)}</h2><ul className="mt-2 space-y-2 text-sm">{(entries as readonly { key: string; label: string }[]).map((entry) => <li key={entry.key}>{entry.label}</li>)}</ul></article>)}</section>
    <p className="text-xs text-neutral-500">Permisos: {publicModule.permissions.join(' · ')}. Acciones: {platformModule.activationActions.map((action) => action.label).join(', ')}.</p>
    <PlatformModuleAdmin module={publicModule} versions={versions} organizations={organizations.map(({ tenantId, name }) => ({ tenantId, name }))} />
  </main>;
}
