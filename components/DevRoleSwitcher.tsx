'use client';

/**
 * Developer role switcher panel (KAN-79). Rendered only when the server passes a state,
 * which happens only with DEVELOPMENT=TRUE. Never reads env itself. The server action is
 * the authority: this panel only offers reductions the real roles allow.
 */
import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resetDevRoleOverrideAction, setDevRoleOverrideAction } from '../app/actions/dev-roles';
import type { RoleSwitcherState } from '../src/auth/resolve-identity';
import type { TenantRole } from '../src/auth/role-override';

export function describeRoles(roles: RoleSwitcherState['effective']): string {
  const parts: string[] = [];
  if (roles.tenantRole) parts.push(roles.tenantRole === 'admin' ? 'Administración de la organización' : 'Miembro de la organización');
  parts.push(roles.platformAdmin ? 'administración de plataforma' : 'sin administración de plataforma');
  return parts.join(' · ');
}

export function DevRoleSwitcher({ state }: { readonly state: RoleSwitcherState }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tenantRole, setTenantRole] = useState<TenantRole | null>(state.effective.tenantRole);
  const [platformAdmin, setPlatformAdmin] = useState(state.effective.platformAdmin);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (work: () => Promise<{ ok: boolean; message?: string }>) => startTransition(async () => {
    setMessage(null);
    const result = await work();
    if (!result.ok) {
      setMessage(result.message ?? 'No pudimos cambiar tus roles. Inténtalo de nuevo.');
      return;
    }
    setOpen(false);
    router.refresh();
  });

  const apply = () => run(() => setDevRoleOverrideAction({
    ...(state.real.tenantRole !== null && tenantRole !== null ? { tenantRole } : {}),
    ...(state.real.platformAdmin ? { platformAdmin } : {}),
  }));
  const reset = () => run(() => resetDevRoleOverrideAction());

  return (
    <>
      {state.reduced && (
        <div role="status" className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 bg-amber-100 px-4 py-1.5 text-xs text-amber-950 shadow-sm">
          <span>Modo desarrollo: estás actuando con roles reducidos ({describeRoles(state.effective)}).</span>
          <button type="button" disabled={pending} onClick={reset} className="rounded border border-amber-400 bg-white px-2 py-0.5 font-medium hover:bg-amber-50 disabled:opacity-60">
            Volver a mis roles
          </button>
        </div>
      )}
      <div className="fixed bottom-3 left-3 z-[60] text-xs">
        {open ? (
          <section aria-label="Cambiar roles de prueba" className="w-72 space-y-3 rounded-lg border border-neutral-300 bg-white p-3 text-neutral-900 shadow-lg">
            <header className="flex items-center justify-between">
              <h2 className="font-semibold">Roles de prueba</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-neutral-500 hover:text-neutral-800" aria-label="Cerrar">✕</button>
            </header>
            <p className="text-neutral-600">Tus roles reales: {describeRoles(state.real)}. Solo puedes reducirlos.</p>
            {state.real.tenantRole === 'admin' && (
              <label className="block space-y-1">
                <span className="font-medium">Rol en la organización</span>
                <select value={tenantRole ?? 'admin'} onChange={(event) => setTenantRole(event.target.value as TenantRole)} className="w-full rounded border px-2 py-1">
                  <option value="admin">Administración</option>
                  <option value="member">Miembro</option>
                </select>
              </label>
            )}
            {state.real.platformAdmin && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={platformAdmin} onChange={(event) => setPlatformAdmin(event.target.checked)} />
                <span>Actuar con administración de plataforma</span>
              </label>
            )}
            {message && <p role="alert" className="text-red-700">{message}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={pending} onClick={apply} className="flex-1 rounded bg-neutral-900 px-2 py-1 font-medium text-white hover:bg-neutral-700 disabled:opacity-60">Aplicar</button>
              {state.reduced && <button type="button" disabled={pending} onClick={reset} className="flex-1 rounded border px-2 py-1 hover:bg-neutral-50 disabled:opacity-60">Volver a mis roles</button>}
            </div>
          </section>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="rounded-full border border-neutral-300 bg-white/90 px-3 py-1 text-neutral-700 shadow hover:bg-white">
            Roles de prueba
          </button>
        )}
      </div>
    </>
  );
}
