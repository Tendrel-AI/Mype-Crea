'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setPlatformLimitDefault } from '../app/actions/platform-limits';
import { promoteOtroText } from '../app/actions/platform-dictionaries';

/** F24 / D38: one row per catalog key; the change applies to new organizations only. */
export function LimitDefaultForm({ limitKey, value }: { limitKey: string; value: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  return <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    start(async () => {
      try {
        await setPlatformLimitDefault({ limitKey, value: Number(data.get('value')), reason: String(data.get('reason') ?? '') });
        setMessage('Guardado.');
        router.refresh();
      } catch { setMessage('No pudimos guardar. Escribe un entero entre 0 y 1000 y el motivo.'); }
    });
  }}>
    <input required name="value" type="number" min={0} max={1000} step={1} defaultValue={value} aria-label={`Valor de ${limitKey}`} className="w-24 rounded border p-1" />
    <input required name="reason" maxLength={500} placeholder="Motivo" aria-label={`Motivo para ${limitKey}`} className="rounded border p-1" />
    <button disabled={pending} className="rounded border px-3 py-1">Guardar</button>
    <span role="status" className="text-xs text-neutral-600">{message}</span>
  </form>;
}

/** F24 / D41: map one raw OTRO text to an existing dictionary code. */
export function PromoteOtroForm({ dictionaryKey, text, codes }: { dictionaryKey: string; text: string; codes: readonly { code: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  return <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    start(async () => {
      try {
        const result = await promoteOtroText({ dictionaryKey, text, categoryCode: String(data.get('code') ?? '') });
        setMessage(`Promovido. Filas reasignadas: ${result.rowsRemapped}.`);
        router.refresh();
      } catch { setMessage('No pudimos promover el texto. Revisa la categoría.'); }
    });
  }}>
    <select required name="code" defaultValue="" aria-label={`Categoría para ${text}`} className="rounded border p-1"><option value="" disabled>Elige…</option>{codes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select>
    <button disabled={pending} className="rounded border px-3 py-1">Promover</button>
    <span role="status" className="text-xs text-neutral-600">{message}</span>
  </form>;
}
