import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { listPlatformModules } from '../../../src/services/platform/modules/registry';

export default async function PlatformModulesPage() {
  try { await requireGlobalMfa(); } catch { redirect('/platform/mfa'); }
  const modules = listPlatformModules();
  return <main className="mx-auto max-w-6xl space-y-6 px-5 py-10"><header><Link href="/platform" className="text-sm underline">← Consola</Link><h1 className="mt-3 text-3xl font-semibold">Catálogo de módulos</h1></header><div className="grid gap-4 md:grid-cols-2">{modules.map((module) => <Link key={module.id} href={`/platform/modules/${module.id}`} className="rounded-xl border bg-white p-5 hover:border-orange-500"><h2 className="font-semibold">{module.name}</h2><p className="mt-2 text-sm text-neutral-600">{module.description}</p><p className="mt-3 text-xs text-neutral-500">{module.permissions.join(' · ')}</p></Link>)}</div></main>;
}
