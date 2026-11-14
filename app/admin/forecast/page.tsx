import { getTenantForecast } from '../../actions/forecast';
import ForecastPanel from '../../../components/ForecastPanel';

export const dynamic = 'force-dynamic';

export default async function TenantForecastPage() {
  const result = await getTenantForecast();
  if (!result.ok) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Proyección de consumo</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">{result.error}</p>
      </main>
    );
  }
  return <ForecastPanel view={result.view} />;
}
