'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { updateLimitValueAction, type LimitsAdminView } from '../app/actions/limits';

const GROUPS: ReadonlyArray<{ group: LimitsAdminView['keys'][number]['group']; title: string; hint: string }> = [
  { group: 'alterations', title: 'Retoques por entregable', hint: 'Cuántas veces puede retocar cada persona un entregable (la primera generación nunca se bloquea).' },
  { group: 'turns', title: 'Mensajes', hint: 'Mensajes al asistente por conversación.' },
  { group: 'brands', title: 'Marcas', hint: 'Marcas activas por usuario.' },
  { group: 'products', title: 'Productos', hint: 'Productos por marca.' },
];

function LimitRow({ profileId, def }: { profileId: string; def: LimitsAdminView['keys'][number] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(String(def.value));
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  return (
    <form className="grid gap-3 border-b p-3 last:border-0 md:grid-cols-4" onSubmit={(event) => {
      event.preventDefault();
      start(async () => {
        const result = await updateLimitValueAction({ profileId, limitKey: def.key, value: Number(value), reason });
        setMessage(result.ok ? 'Guardado.' : result.message);
        if (result.ok) { setReason(''); router.refresh(); }
      });
    }}>
      <label className="grid gap-1 text-sm">{def.label}<input required type="number" min={0} max={1000} step={1} value={value} onChange={(event) => setValue(event.target.value)} className="rounded border p-2" /></label>
      <label className="grid gap-1 text-sm md:col-span-2">Motivo (opcional)<input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} className="rounded border p-2" /></label>
      <div className="flex items-end gap-3"><button disabled={pending} className="rounded bg-orange-600 px-4 py-2 text-white">Guardar</button><span role="status" className="text-sm">{message}</span></div>
    </form>
  );
}

export default function LimitsAdmin({ view }: { view: LimitsAdminView }) {
  const labelOf = (key: string) => view.keys.find((def) => def.key === key)?.label ?? key;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-10">
      <header>
        <Link href="/admin/ai" className="text-sm underline">← Administración</Link>
        <h1 className="mt-3 text-2xl font-semibold">Límites de tu organización</h1>
        <p className="mt-1 text-neutral-600">
          Perfil «{view.profileName}»: aplica a todas las cuentas. Bajar un límite por debajo del uso actual solo impide seguir usando; no se borra nada.
        </p>
      </header>

      {GROUPS.map(({ group, title, hint }) => (
        <section key={group} className="rounded-xl border bg-white">
          <div className="border-b p-3"><h2 className="font-semibold">{title}</h2><p className="text-sm text-neutral-600">{hint}</p></div>
          {view.keys.filter((def) => def.group === group).map((def) => <LimitRow key={`${def.key}:${def.value}`} profileId={view.profileId} def={def} />)}
        </section>
      ))}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Historial de cambios</h2>
        {view.audit.length === 0 ? <p className="text-sm text-neutral-600">Aún no hay cambios registrados.</p> : (
          <ol className="space-y-1 text-sm">{view.audit.map((row) => (
            <li key={row.id} className="border-b pb-1">
              {new Date(row.createdAt).toLocaleString('es-PE')} · {row.actorEmail ?? '—'} · {labelOf(row.limitKey)}: {row.beforeValue ?? '—'} → {row.afterValue}
              {row.reason ? ` · ${row.reason}` : ''}
            </li>
          ))}</ol>
        )}
      </section>
    </main>
  );
}
