import { getTenantAccounts } from '../../actions/tenant-accounts';
import { getBrandLimitsAction } from '../../actions/brands';
import TenantAccountsAdmin from '../../../components/TenantAccountsAdmin';

export const dynamic = 'force-dynamic';

export default async function TenantAccountsPage() {
  const [view, limits] = await Promise.all([getTenantAccounts(), getBrandLimitsAction()]);
  if (!view.ok || !view.members || !view.audit || !view.currentUserId) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Cuentas de tu organización</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">{view.error}</p>
      </main>
    );
  }
  return <TenantAccountsAdmin members={view.members} audit={view.audit} currentUserId={view.currentUserId} limits={limits.ok ? { maxBrandsPerUser: limits.maxBrandsPerUser, maxConversationsPerBrand: limits.maxConversationsPerBrand } : undefined} />;
}
