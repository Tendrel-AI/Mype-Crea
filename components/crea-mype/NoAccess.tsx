import React from 'react';
import { signOutAction } from '../../app/actions/auth';
import type { AccessRefusalReason } from '../../src/auth/resolve-identity';

const PAUSED_COPY = 'El acceso de tu organización está pausado. Contacta a su administrador.';
const DEFAULT_COPY = 'Pide al administrador de tu organización que registre tu correo. Si ya lo hizo, cierra sesión y vuelve a entrar con ese mismo correo.';

/** D52: shown to a signed-in person who may not use the app (no self sign-up in the pilot). */
export function NoAccess({ email, reason }: { readonly email: string; readonly reason: AccessRefusalReason }) {
  return (
    <main className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <section aria-labelledby="no-access-title" className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl border border-neutral-200 text-center space-y-4">
        <h1 id="no-access-title" className="text-2xl font-bold text-neutral-900">No tienes acceso a ninguna organización</h1>
        <p className="text-sm text-neutral-600 leading-relaxed">{reason === 'organization_paused' ? PAUSED_COPY : DEFAULT_COPY}</p>
        <p className="text-xs text-neutral-500">Sesión iniciada como <span className="font-medium text-neutral-700">{email}</span></p>
        <form action={signOutAction}>
          <button type="submit" className="w-full px-6 py-3 bg-orange-600 hover:bg-orange-500 text-white rounded-xl font-medium transition-colors">
            Cerrar sesión
          </button>
        </form>
      </section>
    </main>
  );
}
