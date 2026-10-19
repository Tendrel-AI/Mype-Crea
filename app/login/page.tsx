import { getSignInUrl, getSignUpUrl, withAuth } from '@workos-inc/authkit-nextjs';
import { Sparkles } from 'lucide-react';

function singleConfiguredOrganization(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(process.env.WORKOS_ORGANIZATION_TENANTS ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    if (entries.some(([id, tenantId]) =>
      !/^org_[A-Za-z0-9]+$/.test(id) ||
      typeof tenantId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId),
    )) return undefined;
    const organizations = entries.map(([id]) => id);
    return organizations.length === 1 ? organizations[0] : undefined;
  } catch {
    return undefined;
  }
}

export default async function LoginPage() {
  const { user } = await withAuth();
  const organizationId = singleConfiguredOrganization();
  const signInUrl = await getSignInUrl(organizationId ? { organizationId } : undefined);
  const signUpUrl = await getSignUpUrl(organizationId ? { organizationId } : undefined);

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50 text-neutral-900 font-sans">
      <div className="text-center space-y-6 p-10 max-w-md bg-white rounded-3xl border border-neutral-200 shadow-xl">
        <div className="bg-orange-500/10 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Sparkles className="w-10 h-10 text-orange-500" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">CreaMype</h1>
        <p className="text-neutral-600 text-sm leading-relaxed">
          Inicia sesión para crear tu marca, generar logos, etiquetas y páginas web con Inteligencia Artificial.
        </p>
        <div className="flex flex-col gap-3">
          {user ? (
            <>
              <p>holas</p>
            </>
          ) : (<></>)};
          <a
            href={signInUrl}
            className="w-full px-6 py-4 bg-orange-600 hover:bg-orange-500 text-white rounded-xl font-medium transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-orange-500/25"
          >
            Iniciar sesión
          </a>
          <a
            href={signUpUrl}
            className="w-full px-6 py-4 bg-white hover:bg-neutral-50 text-neutral-900 border border-neutral-200 rounded-xl font-medium transition-colors"
          >
            Crear cuenta
          </a>
        </div>
      </div>
    </div>
  );
}
