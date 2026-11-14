'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  activateAiConfigRelease,
  activateSharedAiRelease,
  createAiConfigDraft,
  createSharedAiBaseline,
  deleteAiTurnTraceContent,
  diffAiConfigDraft,
  exportAiConfigRelease,
  exportAiTurnTrace,
  exportSharedAiConfigRelease,
  freezeAiConfigDraft,
  freezeSharedAiDraft,
  getAiTurnTrace,
  importAiConfigDraft,
  retireAiConfigRelease,
  retireSharedAiRelease,
  setAiProviderAvailability,
  updateAiConfigDraft,
  updateSharedAiDraft,
  validateAiConfigDraft,
  validateSharedAiDraft,
  diffSharedAiDraft,
} from '../app/actions/ai-config';
import { exportConversationTraceAction } from '../app/actions/conversations';

type Release = {
  id: string;
  name: string;
  status: 'draft' | 'frozen' | 'retired';
  draftVersion: number;
  manifest: Record<string, unknown>;
  contentHash: string | null;
  allowedOverridePaths: readonly string[];
  baseSharedReleaseId?: string | null;
};
type AdminData = {
  tenantId: string;
  organizationId: string;
  tenantRole: 'admin' | 'member';
  platformAdmin: boolean;
  releases: Release[];
  sharedReleases: Release[];
  activation: { releaseId: string; version: number } | null;
  providers: Array<{ provider: 'openrouter' | 'anthropic'; enabled: boolean; version: number }>;
  providerStatus: Array<{ provider: string; available: boolean }>;
  syncEvents: Array<Record<string, unknown>>;
  usage: {
    attempts: number;
    inputTokens: number | null;
    outputTokens: number | null;
    unknownInputTokenAttempts: number;
    unknownOutputTokenAttempts: number;
    knownCost: number;
    unknownCostAttempts: number;
    costAccountingStatus: 'no_attempts' | 'complete' | 'partial' | 'unknown';
    budgetStatus: { state: 'within_budget' | 'exhausted'; balanceUsd: number; reservedUsd: number; availableUsd: number };
  } | null;
  turns: Array<{ id: string; conversationId: string; stage: string; failureCategory: string | null; createdAt: string }>;
};

export default function AiConfigurationAdmin({ initialData }: { initialData: Record<string, unknown> }) {
  const data = initialData as unknown as AdminData;
  const allReleases = useMemo(() => [...data.releases, ...data.sharedReleases.map((release) => ({ ...release, name: `Compartida · ${release.name}` }))], [data.releases, data.sharedReleases]);
  const initialSelected = allReleases[0];
  const [selectedId, setSelectedId] = useState(initialSelected?.id ?? '');
  const [manifestText, setManifestText] = useState(initialSelected ? JSON.stringify(initialSelected.manifest, null, 2) : '');
  const [releaseName, setReleaseName] = useState(initialSelected?.name.replace(/^Compartida · /, '') ?? '');
  const [overridePaths, setOverridePaths] = useState(initialSelected?.allowedOverridePaths.join('\n') ?? '');
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState('');
  const [importText, setImportText] = useState('');
  const [importBaseId, setImportBaseId] = useState(data.sharedReleases.find((release) => release.status === 'frozen')?.id ?? '');
  const [traceId, setTraceId] = useState('');
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(data.providers.map((item) => [item.provider, item.enabled])));
  const selected = allReleases.find((release) => release.id === selectedId);
  const selectedIsShared = data.sharedReleases.some((release) => release.id === selectedId);
  const isAdmin = data.tenantRole === 'admin';
  const canManageSelected = selectedIsShared ? data.platformAdmin : isAdmin;

  async function run<T>(work: () => Promise<{ ok: boolean; data?: T; error?: string }>, success: string, show?: (value: T) => string) {
    setNotice('Procesando…');
    const result = await work();
    if (!result.ok) {
      setNotice(result.error ?? 'No se pudo completar la acción.');
      return undefined;
    }
    setNotice(success);
    if (result.data !== undefined && show) setDetails(show(result.data));
    if (!show) window.location.reload();
    return result.data;
  }

  function editedManifest(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(manifestText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('El contenido debe ser un objeto JSON.');
    return parsed as Record<string, unknown>;
  }

  async function saveDraft() {
    try {
      const manifest = editedManifest();
      if (!selected) return;
      if (selectedIsShared) {
        await run(() => updateSharedAiDraft({ releaseId: selected.id, expectedVersion: selected.draftVersion, name: releaseName, manifest, allowedOverridePaths: overridePaths.split('\n').map((path) => path.trim()).filter(Boolean) }), 'Borrador compartido actualizado.');
      } else {
        await run(() => updateAiConfigDraft({ releaseId: selected.id, expectedVersion: selected.draftVersion, name: releaseName, manifest }), 'Borrador actualizado.');
      }
    } catch {
      setNotice('Revisa el JSON y los campos obligatorios antes de guardar.');
    }
  }

  function downloadJson(name: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name.replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 text-slate-900 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-sm text-slate-500">Administración · Organización {data.organizationId}</p><h1 className="mt-1 text-3xl font-semibold">Configuración de IA</h1><p className="mt-2 text-sm text-slate-600">Tenant {data.tenantId} · {isAdmin ? 'Administradora de la organización' : 'Miembro'} · {data.platformAdmin ? 'Administradora de plataforma' : 'Acceso de tenant'}</p></div>
        <div className="flex gap-2">{isAdmin && <Link className="rounded-md border px-3 py-2 text-sm hover:bg-slate-50" href="/admin/accounts">Cuentas</Link>}<Link className="rounded-md border px-3 py-2 text-sm hover:bg-slate-50" href="/">Volver al asistente</Link></div>
      </header>

      {notice && <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">{notice}</p>}
      {details && <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100">{details}</pre>}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="space-y-4 rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-64 flex-1 text-sm font-medium">Release
              <select className="mt-1 block w-full rounded-md border p-2" value={selectedId} onChange={(event) => { const id = event.target.value; const release = allReleases.find((candidate) => candidate.id === id); setSelectedId(id); if (release) { setManifestText(JSON.stringify(release.manifest, null, 2)); setReleaseName(release.name.replace(/^Compartida · /, '')); setOverridePaths(release.allowedOverridePaths.join('\n')); } }}>
                {data.releases.map((release) => <option key={release.id} value={release.id}>Tenant · {release.name} · {release.status}</option>)}
                {data.sharedReleases.map((release) => <option key={release.id} value={release.id}>Plataforma compartida · {release.name} · {release.status}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">Nombre<input className="mt-1 block rounded-md border p-2" value={releaseName} disabled={!selected || selected.status !== 'draft' || !canManageSelected} onChange={(event) => setReleaseName(event.target.value)} /></label>
          </div>
          {selected && <p className="text-xs text-slate-500">Estado: {selected.status} · Versión: {selected.draftVersion} · Hash: {selected.contentHash ?? 'pendiente'}</p>}
          <label className="block text-sm font-medium">Contenido JSON validado
            <textarea spellCheck={false} readOnly={!selected || selected.status !== 'draft' || !canManageSelected} className="mt-1 min-h-[28rem] w-full rounded-md border p-3 font-mono text-xs read-only:bg-slate-50" value={manifestText} onChange={(event) => setManifestText(event.target.value)} />
          </label>
          {selectedIsShared && data.platformAdmin && selected?.status === 'draft' && <label className="block text-sm font-medium">Paths exactos que puede editar un tenant (uno por línea)
            <textarea className="mt-1 min-h-20 w-full rounded-md border p-3 font-mono text-xs" value={overridePaths} onChange={(event) => setOverridePaths(event.target.value)} />
          </label>}
          <div className="flex flex-wrap gap-2">
            {selected?.status === 'draft' && canManageSelected && <button className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white dark:bg-slate-600" onClick={saveDraft}>Guardar borrador</button>}
            {selected?.status === 'draft' && canManageSelected && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => selectedIsShared ? validateSharedAiDraft(selected.id) : validateAiConfigDraft(selected.id), 'Validación completada.', (value) => JSON.stringify({ contentHash: (value as { contentHash?: string }).contentHash }, null, 2))}>Validar</button>}
            {selected?.status === 'draft' && selectedIsShared && data.platformAdmin && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => { try { const manifest = editedManifest(); void run(() => diffSharedAiDraft({ releaseId: selected.id, manifest }), 'Diferencias calculadas.', (value) => JSON.stringify(value, null, 2)); } catch { setNotice('Revisa el JSON antes de comparar.'); } }}>Ver diferencias del borrador</button>}
            {selected?.status === 'draft' && !selectedIsShared && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => diffAiConfigDraft(selected.id), 'Diferencias calculadas.', (value) => JSON.stringify(value, null, 2))}>Ver diferencias con la base compartida</button>}
            {selected?.status === 'draft' && canManageSelected && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => selectedIsShared ? freezeSharedAiDraft({ releaseId: selected.id, expectedVersion: selected.draftVersion }) : freezeAiConfigDraft({ releaseId: selected.id, expectedVersion: selected.draftVersion }), 'Release congelado.')}>Congelar</button>}
            {selected?.status === 'frozen' && !selectedIsShared && isAdmin && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => activateAiConfigRelease({ releaseId: selected.id, expectedActivationVersion: data.activation?.version ?? 0 }), 'Release activado para conversaciones nuevas.')}>Activar</button>}
            {selected?.status === 'frozen' && selectedIsShared && isAdmin && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => activateSharedAiRelease({ sharedReleaseId: selected.id, expectedSharedVersion: selected.draftVersion, expectedActivationVersion: data.activation?.version ?? 0 }), 'Release compartido copiado y activado para este tenant.')}>Activar copia para tenant</button>}
            {selected?.status === 'frozen' && selected && canManageSelected && <button className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700" onClick={() => void run(() => selectedIsShared ? retireSharedAiRelease({ releaseId: selected.id, expectedVersion: selected.draftVersion }) : retireAiConfigRelease({ releaseId: selected.id, expectedVersion: selected.draftVersion }), 'Release retirado.')}>Retirar</button>}
            {selected && !selectedIsShared && <button className="rounded-md border px-3 py-2 text-sm" onClick={async () => { const result = await exportAiConfigRelease(selected.id); if (result.ok && typeof result.data === 'string') downloadJson(selected.name, result.data); else setNotice(result.error ?? 'No se pudo exportar.'); }}>Descargar JSON</button>}
            {selectedIsShared && selected && data.platformAdmin && isAdmin && <button className="rounded-md border px-3 py-2 text-sm" onClick={async () => { const result = await exportSharedAiConfigRelease(selected.id); if (result.ok && typeof result.data === 'string') downloadJson(selected.name, result.data); else setNotice(result.error ?? 'No se pudo exportar.'); }}>Exportar compartido</button>}
          </div>
          {isAdmin && selected?.status === 'frozen' && selectedIsShared && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => createAiConfigDraft({ name: `${selected.name} · personalización`, manifest: selected.manifest, baseSharedReleaseId: selected.id }), 'Borrador derivado creado.')}>Crear personalización permitida</button>}
        </div>

        <aside className="space-y-5">
          {(isAdmin || data.platformAdmin) && <section className="space-y-3 rounded-xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">Catálogo y activación</h2>
            <p className="text-xs text-slate-500">Los prompts los gestiona el equipo de desarrollo; aquí solo se configuran modelos y respaldos.</p>
            <p className="text-sm text-slate-600">Release activo para conversaciones nuevas: {data.activation?.releaseId ?? 'ninguno'}.</p>
            <p className="text-xs text-slate-500">Cambiar la activación no modifica conversaciones que ya tienen una versión fijada.</p>
            {data.platformAdmin && <button className="w-full rounded-md border px-3 py-2 text-sm" onClick={() => void run(() => createSharedAiBaseline(`Baseline ${new Date().toISOString().slice(0, 10)}`), 'Borrador base compartido creado.')}>Capturar borrador base de plataforma</button>}
            {data.platformAdmin && <p className="text-xs text-slate-500">La captura es local y no publica ni activa contenido automáticamente.</p>}
          </section>}

          {isAdmin && <section className="space-y-3 rounded-xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">Importar JSON</h2>
            <input className="w-full rounded-md border p-2 text-sm" value={releaseName} onChange={(event) => setReleaseName(event.target.value)} aria-label="Nombre del release importado" />
            <textarea className="min-h-28 w-full rounded-md border p-2 font-mono text-xs" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Pega aquí el manifiesto JSON" />
            <label className="block text-sm">Release compartido de origen<select className="mt-1 w-full rounded-md border p-2" value={importBaseId} onChange={(event) => setImportBaseId(event.target.value)}>{data.sharedReleases.filter((release) => release.status === 'frozen').map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</select></label>
            <button disabled={!importBaseId} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(() => importAiConfigDraft({ name: releaseName || 'Importación', serialized: importText, baseSharedReleaseId: importBaseId }), 'Importación validada como borrador.')}>Importar sobre release compartido congelado</button>
            <p className="text-xs text-slate-500">La importación queda como datos inertes en un borrador. No ejecuta código ni selecciona credenciales.</p>
          </section>}

          {isAdmin && <section className="space-y-3 rounded-xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">Proveedores y credenciales</h2>
            {(['openrouter', 'anthropic'] as const).map((provider) => {
              const row = data.providers.find((item) => item.provider === provider);
              const status = data.providerStatus.find((item) => item.provider === provider);
              return <label key={provider} className="flex items-center justify-between gap-3 text-sm"><span>{provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'}<span className="block text-xs text-slate-500">Credencial de plataforma: {status?.available ? 'configurada' : 'no disponible'}</span></span><input type="checkbox" checked={providerEnabled[provider] ?? true} onChange={(event) => { const enabled = event.target.checked; setProviderEnabled((current) => ({ ...current, [provider]: enabled })); void run(() => setAiProviderAvailability({ provider, enabled, expectedVersion: row?.version ?? 0 }), 'Disponibilidad actualizada.'); }} /></label>;
            })}
          </section>}
        </aside>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Uso y presupuesto</h2>
          {data.usage ? <>
            <p className="text-sm text-slate-600">
              Créditos de la organización: USD {data.usage.budgetStatus.balanceUsd.toFixed(2)} de saldo, USD {data.usage.budgetStatus.reservedUsd.toFixed(2)} reservados; disponibles USD {data.usage.budgetStatus.availableUsd.toFixed(2)}
              {data.usage.budgetStatus.state === 'exhausted' ? ' (agotado: se rechazan nuevas llamadas a modelos e imágenes)' : ''}.
              {' '}Estado del costo: {data.usage.costAccountingStatus === 'complete' ? 'completo' : data.usage.costAccountingStatus === 'partial' ? 'parcial' : data.usage.costAccountingStatus === 'unknown' ? 'desconocido' : 'sin intentos'}.
            </p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt>Intentos registrados</dt><dd>{String(data.usage.attempts)}</dd>
              <dt>Tokens de entrada</dt><dd>{data.usage.inputTokens === null ? `Desconocidos en ${data.usage.unknownInputTokenAttempts} intentos` : String(data.usage.inputTokens)}</dd>
              <dt>Tokens de salida</dt><dd>{data.usage.outputTokens === null ? `Desconocidos en ${data.usage.unknownOutputTokenAttempts} intentos` : String(data.usage.outputTokens)}</dd>
              <dt>Costos no disponibles</dt><dd>{String(data.usage.unknownCostAttempts)}</dd>
              <dt>Costo conocido acumulado</dt><dd>{data.usage.costAccountingStatus === 'no_attempts' ? 'Sin intentos registrados' : data.usage.costAccountingStatus === 'unknown' ? 'Desconocido' : String(data.usage.knownCost)}</dd>
            </dl>
            <p className="text-xs text-slate-500">El presupuesto se cuenta por mes calendario (hora de Lima) y se verifica antes de cada llamada a modelos e imágenes. Los costos desconocidos no se estiman ni se convierten en cero.</p>
          </> : <p className="text-sm">Sin resumen de uso disponible.</p>}
        </div>
        <div className="space-y-3 rounded-xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Auditoría y sincronización</h2><p className="text-sm text-slate-600">La exportación local prepara un JSON descargable. Se muestra el historial existente de solo lectura.</p><div className="space-y-2">{data.syncEvents.map((event, index) => <div key={`${String(event.operationId)}-${String(event.status)}-${index}`} className="rounded bg-slate-50 p-2 text-xs"><p>{String(event.destination)} · {String(event.action)} · {String(event.status)} · {event.pinnedCommit ? `commit ${String(event.pinnedCommit)}` : 'sin commit fijado'}</p></div>)}</div></div>
      </section>

      {isAdmin && <section className="space-y-3 rounded-xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Trazas de esta organización</h2><div className="flex gap-2"><select className="min-w-0 flex-1 rounded-md border p-2 text-sm" value={traceId} onChange={(event) => setTraceId(event.target.value)}><option value="">Selecciona un turno</option>{data.turns.map((turn) => <option key={turn.id} value={turn.id}>{turn.createdAt} · {turn.stage}{turn.failureCategory ? ` · ${turn.failureCategory}` : ''}</option>)}</select><button disabled={!traceId} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(() => getAiTurnTrace(traceId), 'Traza cargada.', (value) => JSON.stringify(value, null, 2))}>Ver</button><button disabled={!traceId} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => { const result = await exportAiTurnTrace(traceId); if (result.ok && result.data) downloadJson(`traza-${traceId}`, result.data); else setNotice(result.error ?? 'No se pudo exportar.'); }}>Exportar</button><button disabled={!traceId} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" title="Descargar la conversación completa de este turno y sus registros" onClick={async () => { const conversationId = data.turns.find((turn) => turn.id === traceId)?.conversationId; if (!conversationId) return; const result = await exportConversationTraceAction({ conversationId }); if (result.ok) downloadJson(`conversacion-${conversationId}`, result.content); else setNotice(result.message); }}>Exportar conversación</button><button disabled={!traceId} className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-50" onClick={() => { if (window.confirm('Se borrará el contenido de entrada, respuesta y solicitudes de proveedor. Los datos de uso y auditoría permanecerán. Esta acción no se puede deshacer.')) void run(() => deleteAiTurnTraceContent(traceId), 'Se eliminó el contenido de la traza. Los metadatos y el registro de uso permanecen.'); }}>Eliminar contenido</button></div></section>}
    </main>
  );
}
