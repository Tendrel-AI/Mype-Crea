'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { beginPlatformMfa, verifyPlatformMfa } from '../../actions/auth';

export function PlatformMfaForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'loading' | 'enroll' | 'challenge' | 'error'>('loading');
  const [qrCode, setQrCode] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void beginPlatformMfa().then((result) => {
      if (!result.ok) {
        setMode('error');
        setMessage(result.message);
        return;
      }
      setMode(result.mode);
      if (result.mode === 'enroll') {
        setQrCode(result.qrCode);
        setUri(result.uri);
      }
    }).catch(() => {
      setMode('error');
      setMessage('No pudimos iniciar la verificación. Inténtalo de nuevo.');
    });
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const result = await verifyPlatformMfa(code);
    if (!result.ok) {
      setMessage(result.message ?? 'No pudimos verificar el código. Inténtalo de nuevo.');
      return;
    }
    router.replace('/platform');
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 text-neutral-900">
      <section className="w-full max-w-md space-y-5 rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Verifica tu acceso</h1>
        <p className="text-sm text-neutral-600">Usa una aplicación de autenticación para proteger la consola de la plataforma.</p>
        {mode === 'loading' && <p className="text-sm text-neutral-600">Preparando la verificación…</p>}
        {mode === 'enroll' && (
          <div className="space-y-3 text-sm">
            <p>Escanea este código QR con tu aplicación de autenticación y escribe el código que aparece.</p>
            {qrCode && <Image src={qrCode} alt="Código QR para configurar la autenticación" width={192} height={192} unoptimized className="mx-auto h-48 w-48" />}
            <details>
              <summary className="cursor-pointer">No puedes escanear el código</summary>
              <a className="break-all text-orange-700 underline" href={uri}>{uri}</a>
            </details>
          </div>
        )}
        {mode === 'challenge' && <p className="text-sm">Escribe el código de tu aplicación de autenticación.</p>}
        {mode !== 'loading' && (
          <form onSubmit={submit} className="space-y-4">
            <label className="block space-y-1 text-sm">
              <span>Código de autenticación</span>
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6,8}"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2"
              />
            </label>
            {message && <p role="alert" className="text-sm text-red-700">{message}</p>}
            <button type="submit" className="w-full rounded-lg bg-orange-600 px-4 py-3 font-medium text-white">Verificar</button>
          </form>
        )}
      </section>
    </main>
  );
}
