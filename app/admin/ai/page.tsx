import Link from 'next/link';
import { getAiConfigAdminData } from '../../actions/ai-config';
import AiConfigurationAdmin from '../../../components/AiConfigurationAdmin';

export const dynamic = 'force-dynamic';

export default async function AiConfigurationAdminPage() {
  const result = await getAiConfigAdminData();
  if (result.reason === 'mfa_required') {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Configuración de IA</h1>
        <div className="mt-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p>Como administrador de la plataforma, primero verifica tu código de autenticación para entrar a esta página.</p>
          <Link href="/platform/mfa?next=/admin/ai" className="inline-block rounded-lg bg-orange-600 px-4 py-2 font-medium text-white">Verificar mi acceso</Link>
        </div>
      </main>
    );
  }
  if (!result.ok || !result.data) {
    return <main className="mx-auto max-w-4xl p-8"><h1 className="text-2xl font-semibold">Configuración de IA</h1><p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">No tienes acceso administrativo a esta organización o no se pudo cargar la información.</p></main>;
  }
  return <AiConfigurationAdmin initialData={result.data as Record<string, unknown>} />;
}
