import { getTenantAnalytics } from '../../actions/tenant-analytics';
import TenantAnalyticsPanel from '../../../components/TenantAnalyticsPanel';

export const dynamic = 'force-dynamic';

export default async function TenantAnalyticsPage() {
  const view = await getTenantAnalytics();
  if (!view.ok) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Estadísticas de tu organización</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">{view.error}</p>
      </main>
    );
  }
  return <TenantAnalyticsPanel analytics={view.analytics} />;
}
