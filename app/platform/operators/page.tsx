import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { globalRepos } from '../../../src/repos/global';
import { PlatformOperatorAdmin } from '../../../components/PlatformConsole';

export default async function PlatformOperatorsPage() {
  try { await requireGlobalMfa(); } catch { redirect('/platform/mfa'); }
  const operators = await globalRepos().identity.listSuperadmins();
  return <main className="mx-auto max-w-6xl space-y-6 px-5 py-10"><header><Link href="/platform" className="text-sm underline">← Consola</Link><h1 className="mt-3 text-3xl font-semibold">Administradores globales</h1><p className="mt-1 text-neutral-600">Administra quién puede acceder a la consola de la plataforma.</p></header><PlatformOperatorAdmin operators={operators} /></main>;
}
