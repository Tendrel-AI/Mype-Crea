'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deactivateTenantMember, provisionTenantMember, reactivateTenantMember, type TenantAccountsView } from '../app/actions/tenant-accounts';

type Members = NonNullable<TenantAccountsView['members']>;
type Audit = NonNullable<TenantAccountsView['audit']>;

const ACTION_LABEL: Record<Audit[number]['action'], string> = {
  'member.provision': 'Alta',
  'member.deactivate': 'Desactivación',
  'member.reactivate': 'Reactivación',
};
const OUTCOME_LABEL: Record<Audit[number]['outcome'], string> = { success: 'Completada', refused: 'Rechazada', failed: 'Falló' };

export default function TenantAccountsAdmin({ members, audit, currentUserId }: { members: Members; audit: Audit; currentUserId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');

  function run(work: () => Promise<{ ok: boolean; message: string }>, clear = false) {
    start(async () => {
      const result = await work();
      setMessage(result.message);
      if (result.ok && clear) { setEmail(''); setReason(''); }
      router.refresh();
    });
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-10">
      <header>
        <Link href="/admin/ai" className="text-sm underline">← Administración</Link>
        <h1 className="mt-3 text-2xl font-semibold">Cuentas de tu organización</h1>
        <p className="mt-1 text-neutral-600">
          Crea cuentas de emprendedores y desactívalas o reactívalas cuando haga falta. No se envían correos:
          comparte tú el enlace de inicio de sesión <code>/login</code> de CreaMype.
        </p>
      </header>

      <form className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-3" onSubmit={(event) => {
        event.preventDefault();
        run(() => provisionTenantMember({ email, reason }), true);
      }}>
        <label className="grid gap-1 text-sm">Correo electrónico<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="rounded border p-2" /></label>
        <label className="grid gap-1 text-sm">Motivo (opcional)<input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} className="rounded border p-2" /></label>
        <div className="flex items-end"><button disabled={pending} className="rounded bg-orange-600 px-4 py-2 text-white">Crear cuenta</button></div>
      </form>
      <p role="status" className="text-sm">{message}</p>

      <section className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b text-neutral-600"><th className="p-3">Correo</th><th className="p-3">Rol</th><th className="p-3">Estado</th><th className="p-3">Creada</th><th className="p-3"><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>{members.map((member) => (
            <tr key={member.id} className="border-b last:border-0">
              <td className="p-3">{member.email}</td>
              <td className="p-3">{member.role === 'admin' ? 'Administrador' : 'Emprendedor'}</td>
              <td className="p-3">{member.status === 'active' ? 'Activa' : 'Desactivada'}</td>
              <td className="p-3">{new Date(member.createdAt).toLocaleDateString('es-PE')}</td>
              <td className="p-3">
                {member.id !== currentUserId && (member.status === 'active'
                  ? <button disabled={pending} className="rounded border px-3 py-1" onClick={() => {
                    if (!window.confirm(`¿Desactivar la cuenta de ${member.email}? Sus conversaciones se conservan.`)) return;
                    run(() => deactivateTenantMember({ userId: member.id }));
                  }}>Desactivar</button>
                  : <button disabled={pending} className="rounded border px-3 py-1" onClick={() => run(() => reactivateTenantMember({ userId: member.id }))}>Reactivar</button>)}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Historial de cambios</h2>
        {audit.length === 0 ? <p className="text-sm text-neutral-600">Aún no hay cambios registrados.</p> : (
          <ol className="space-y-1 text-sm">{audit.map((row) => (
            <li key={row.id} className="border-b pb-1">
              {new Date(row.createdAt).toLocaleString('es-PE')} · {ACTION_LABEL[row.action]} · {row.targetEmail ?? '—'} · {OUTCOME_LABEL[row.outcome]}
              {row.reason ? ` · ${row.reason}` : ''}
            </li>
          ))}</ol>
        )}
      </section>
    </main>
  );
}
