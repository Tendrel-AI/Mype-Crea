import { unstable_rethrow } from 'next/navigation';
import { getTenantCreditSummary } from '../../actions/credits';
import { TenantAdminRequiredError } from '../../../src/auth/resolve-identity';
import TenantCreditsPanel from '../../../components/TenantCreditsPanel';

export const dynamic = 'force-dynamic';

export default async function TenantCreditsPage() {
  try {
    return <TenantCreditsPanel summary={await getTenantCreditSummary()} />;
  } catch (error) {
    unstable_rethrow(error);
    const message = error instanceof TenantAdminRequiredError
      ? 'No tienes permiso para ver los créditos de esta organización.'
      : 'No pudimos cargar los créditos. Vuelve a intentarlo.';
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Créditos de tu organización</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">{message}</p>
      </main>
    );
  }
}
