import { getLimitsAdminView } from '../../actions/limits';
import LimitsAdmin from '../../../components/LimitsAdmin';

export const dynamic = 'force-dynamic';

export default async function LimitsPage() {
  const view = await getLimitsAdminView();
  if (!view.ok) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Límites de tu organización</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">{view.message}</p>
      </main>
    );
  }
  return <LimitsAdmin view={view} />;
}
