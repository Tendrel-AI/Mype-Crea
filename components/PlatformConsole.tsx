'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createPlatformOrganization, grantPlatformOperator, rechargeTenantCredits, renamePlatformOrganization, revokePlatformOperator, setPlatformOrganizationActive } from '../app/actions/platform-admin';
import { applyPlatformModuleRollout, previewPlatformModuleRollout, publishAiModuleVersion, publishPlatformModuleVersion, retryPlatformModuleRollout, rollbackPlatformModule } from '../app/actions/platform-modules';
import type { PlatformModule } from '../src/services/platform/modules/contract';
import type { ModuleVersion, RolloutScope } from '../src/services/platform/rollout/service';

export function OrganizationCreateForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const [operationKey, setOperationKey] = useState(() => crypto.randomUUID());
  return <form className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-3" onSubmit={(event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    start(async () => {
      try {
        await createPlatformOrganization({ operationKey, name: String(data.get('name') ?? ''), reason: String(data.get('reason') ?? '') });
        setMessage('Organización creada.');
        form.reset();
        setOperationKey(crypto.randomUUID());
        router.refresh();
      } catch { setMessage('No pudimos crear la organización. Revisa los datos e inténtalo de nuevo.'); }
    });
  }}>
    <label className="grid gap-1 text-sm">Nombre<input required name="name" className="rounded border p-2" /></label>
    <label className="grid gap-1 text-sm">Motivo<input required name="reason" className="rounded border p-2" /></label>
    <div className="flex items-end gap-3"><button disabled={pending} className="rounded bg-orange-600 px-4 py-2 text-white">Crear organización</button><span role="status" className="text-sm">{message}</span></div>
  </form>;
}

export function OrganizationEditForm({ tenantId, name, active }: { tenantId: string; name: string; active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  return <div className="space-y-4 rounded-xl border bg-white p-5">
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      start(async () => {
        try { await renamePlatformOrganization({ tenantId, name: String(data.get('name') ?? ''), reason: String(data.get('reason') ?? '') }); setMessage('Cambios guardados.'); router.refresh(); }
        catch { setMessage('No pudimos actualizar la organización.'); }
      });
    }}>
      <label className="grid gap-1 text-sm">Nombre<input required name="name" defaultValue={name} className="rounded border p-2" /></label>
      <label className="grid gap-1 text-sm">Motivo<input required name="reason" className="rounded border p-2" /></label>
      <button disabled={pending} className="rounded bg-neutral-900 px-4 py-2 text-white">Guardar</button>
    </form>
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      start(async () => {
        try { await setPlatformOrganizationActive({ tenantId, active: !active, reason: String(data.get('reason') ?? '') }); setMessage(active ? 'Organización desactivada.' : 'Organización reactivada.'); router.refresh(); }
        catch { setMessage('No pudimos cambiar el estado.'); }
      });
    }}>
      <label className="grid gap-1 text-sm">Motivo<input required name="reason" className="rounded border p-2" /></label>
      <button disabled={pending} className="rounded border px-4 py-2">{active ? 'Desactivar' : 'Reactivar'}</button>
      <span role="status" className="text-sm text-neutral-600">{message}</span>
    </form>
  </div>;
}

/** F21/F24: the super admin records a recharge AFTER the tenant paid outside the platform. */
export function CreditRechargeForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const [operationKey, setOperationKey] = useState(() => crypto.randomUUID());
  return <form className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-4" onSubmit={(event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    start(async () => {
      try {
        const result = await rechargeTenantCredits({ tenantId, operationKey, amountUsd: Number(data.get('amount')), reference: String(data.get('reference') ?? ''), reason: String(data.get('reason') ?? '') });
        setMessage(`Recarga registrada. Saldo: USD ${result.balanceUsd.toFixed(2)}.${result.keySynced ? '' : ' La llave de OpenRouter se sincronizará en la próxima operación.'}`);
        form.reset();
        setOperationKey(crypto.randomUUID());
        router.refresh();
      } catch { setMessage('No pudimos registrar la recarga. Revisa los datos e inténtalo de nuevo.'); }
    });
  }}>
    <label className="grid gap-1 text-sm">Monto (USD)<input required name="amount" type="number" min="0.01" step="0.01" className="rounded border p-2" /></label>
    <label className="grid gap-1 text-sm">Referencia del pago<input required name="reference" maxLength={200} className="rounded border p-2" /></label>
    <label className="grid gap-1 text-sm">Motivo<input required name="reason" maxLength={500} className="rounded border p-2" /></label>
    <div className="flex items-end gap-3"><button disabled={pending} className="rounded bg-orange-600 px-4 py-2 text-white">Registrar recarga</button><span role="status" className="text-sm">{message}</span></div>
  </form>;
}

export function PlatformOperatorAdmin({ operators }: { operators: readonly { workosUserId: string; grantedAt: Date; revokedAt: Date | null }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  return <div className="space-y-5">
    <form className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-3" onSubmit={(event) => {
      event.preventDefault();
      const workosUserId = target.trim();
      const grantReason = reason.trim();
      start(async () => {
        try { await grantPlatformOperator({ workosUserId, reason: grantReason }); setMessage('Acceso global otorgado.'); setTarget(''); setReason(''); router.refresh(); }
        catch { setMessage('No pudimos otorgar el acceso. Revisa el ID y el motivo.'); }
      });
    }}>
      <label className="grid gap-1 text-sm">ID de usuario de WorkOS<input required value={target} onChange={(event) => setTarget(event.target.value)} className="rounded border p-2 font-mono" /></label>
      <label className="grid gap-1 text-sm">Motivo<input required value={reason} onChange={(event) => setReason(event.target.value)} className="rounded border p-2" /></label>
      <div className="flex items-end gap-3"><button disabled={pending} className="rounded bg-orange-600 px-4 py-2 text-white">Otorgar acceso</button><span role="status" className="text-sm">{message}</span></div>
    </form>
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">ID de usuario de WorkOS</th><th className="p-3">Estado</th><th className="p-3">Otorgado</th><th className="p-3">Revocado</th><th className="p-3"> </th></tr></thead><tbody>{operators.map((operator) => <tr key={operator.workosUserId} className="border-b last:border-0"><td className="p-3 font-mono text-xs">{operator.workosUserId}</td><td className="p-3">{operator.revokedAt ? 'Revocado' : 'Activo'}</td><td className="p-3">{new Date(operator.grantedAt).toLocaleString('es-PE')}</td><td className="p-3">{operator.revokedAt ? new Date(operator.revokedAt).toLocaleString('es-PE') : '—'}</td><td className="p-3">{!operator.revokedAt && <button disabled={pending} onClick={() => { const revokeReason = window.prompt('Indica el motivo de la revocación.')?.trim(); if (!revokeReason) return; start(async () => { try { await revokePlatformOperator({ workosUserId: operator.workosUserId, reason: revokeReason }); setMessage('Acceso global revocado.'); router.refresh(); } catch { setMessage('No pudimos revocar el acceso. Debe quedar al menos un administrador global activo.'); } }); }} className="rounded border px-3 py-1">Revocar</button>}</td></tr>)}</tbody></table>{operators.length === 0 && <p className="p-4 text-sm text-neutral-600">No hay operadores registrados.</p>}</div>
  </div>;
}

export function PlatformModuleAdmin({ module, versions, organizations }: { module: Omit<PlatformModule, 'validateConfig'>; versions: readonly ModuleVersion[]; organizations: readonly { tenantId: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [config, setConfig] = useState('');
  const [version, setVersion] = useState(versions[0]?.version ?? 1);
  const [scopeKind, setScopeKind] = useState<'default' | 'all' | 'one' | 'selected'>('default');
  const [organizationId, setOrganizationId] = useState(organizations[0]?.tenantId ?? '');
  const [organizationIds, setOrganizationIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [operationKey, setOperationKey] = useState('');
  const [result, setResult] = useState('');
  const [releaseName, setReleaseName] = useState('');
  const [manifest, setManifest] = useState('');
  const [overridePaths, setOverridePaths] = useState('');
  const [releaseOperationKey, setReleaseOperationKey] = useState('');
  const scope: RolloutScope = scopeKind === 'default' ? { kind: 'default' } : scopeKind === 'all' ? { kind: 'all' } : scopeKind === 'selected' ? { kind: 'selected', organizationIds } : { kind: 'one', organizationId };
  function parseConfig() { return JSON.parse(config) as unknown; }
  function run(action: () => Promise<unknown>) {
    start(async () => {
      try { setResult(JSON.stringify(translateConsoleResult(await action()), null, 2)); router.refresh(); }
      catch { setResult('No se pudo completar la operación. Revisa la configuración y el motivo.'); }
    });
  }
  return <div className="space-y-6">
    {module.id === 'ai' && <section className="space-y-3 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">Crear versión compartida de IA</h2><p className="text-sm text-neutral-600">La configuración se valida y se congela como una versión inmutable.</p>
      <label className="grid max-w-xl gap-1 text-sm">Nombre<input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} className="rounded border p-2" /></label>
      <label className="grid gap-1 text-sm">Manifiesto JSON<textarea value={manifest} onChange={(event) => setManifest(event.target.value)} rows={6} className="rounded border p-2 font-mono" /></label>
      <label className="grid max-w-xl gap-1 text-sm">Rutas permitidas para excepciones (una por línea)<textarea value={overridePaths} onChange={(event) => setOverridePaths(event.target.value)} rows={3} className="rounded border p-2 font-mono" /></label>
      <label className="grid max-w-xl gap-1 text-sm">Motivo<input value={reason} onChange={(event) => setReason(event.target.value)} className="rounded border p-2" /></label>
      <button disabled={pending || !releaseName.trim() || !manifest.trim() || !reason.trim()} onClick={() => { const key = releaseOperationKey || crypto.randomUUID(); setReleaseOperationKey(key); run(async () => { const created = await publishAiModuleVersion({ name: releaseName, manifest: JSON.parse(manifest), allowedOverridePaths: overridePaths.split('\n').map((path) => path.trim()).filter(Boolean), operationKey: key, reason }); setVersion(created.moduleVersion.version); return created; }); }} className="rounded bg-orange-600 px-4 py-2 text-white">Crear y publicar versión</button>
      {releaseOperationKey && <span className="ml-3 text-xs text-neutral-500">Clave de operación: <code>{releaseOperationKey}</code></span>}
    </section>}
    <section className="space-y-3 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">Versiones publicadas</h2>
      {versions.length ? <ol className="space-y-2">{versions.map((item) => <li key={item.version} className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm"><span><strong>Versión {item.version}</strong> · {new Date(item.createdAt).toLocaleString('es-PE')}</span><code>{JSON.stringify(item.config)}</code></li>)}</ol> : <p className="text-sm text-neutral-600">Aún no hay versiones.</p>}
      <label className="grid gap-1 text-sm">Configuración JSON<textarea value={config} onChange={(event) => setConfig(event.target.value)} rows={4} placeholder={'{"sharedReleaseId":"…"}'} className="rounded border p-2 font-mono" /></label>
      <button disabled={pending || !config} onClick={() => run(async () => { const created = await publishPlatformModuleVersion({ moduleId: module.id, config: parseConfig() }); setVersion(created.version); return created; })} className="rounded bg-neutral-900 px-4 py-2 text-white">Publicar versión</button>
    </section>
    <section className="space-y-4 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">Vista previa y activación</h2>
      <div className="flex flex-wrap gap-3"><label className="grid gap-1 text-sm">Versión<select value={version} onChange={(event) => setVersion(Number(event.target.value))} className="rounded border p-2">{versions.map((item) => <option key={item.version} value={item.version}>Versión {item.version}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Alcance<select value={scopeKind} onChange={(event) => setScopeKind(event.target.value as typeof scopeKind)} className="rounded border p-2"><option value="default">Predeterminada para nuevas organizaciones</option><option value="all">Todas las organizaciones activas</option><option value="selected">Organizaciones seleccionadas</option><option value="one">Una organización</option></select></label>
        {scopeKind === 'one' && <label className="grid gap-1 text-sm">Organización<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} className="rounded border p-2">{organizations.map((item) => <option key={item.tenantId} value={item.tenantId}>{item.name}</option>)}</select></label>}
      </div>
      {scopeKind === 'selected' && <fieldset className="flex flex-wrap gap-3 text-sm"><legend className="mb-2">Selecciona las organizaciones</legend>{organizations.map((item) => <label key={item.tenantId} className="flex items-center gap-2"><input type="checkbox" checked={organizationIds.includes(item.tenantId)} onChange={(event) => setOrganizationIds((current) => event.target.checked ? [...current, item.tenantId] : current.filter((id) => id !== item.tenantId))} />{item.name}</label>)}</fieldset>}
      <label className="grid max-w-xl gap-1 text-sm">Motivo<input value={reason} onChange={(event) => setReason(event.target.value)} className="rounded border p-2" /></label>
      <div className="flex flex-wrap gap-2"><button disabled={pending || !version || (scopeKind === 'selected' && organizationIds.length === 0)} onClick={() => run(() => previewPlatformModuleRollout({ moduleId: module.id, version, scope }))} className="rounded border px-4 py-2">Vista previa</button><button disabled={pending || !version || !reason.trim() || (scopeKind === 'selected' && organizationIds.length === 0)} onClick={() => { const key = crypto.randomUUID(); setOperationKey(key); run(() => applyPlatformModuleRollout({ moduleId: module.id, version, scope, operationKey: key, reason })); }} className="rounded bg-orange-600 px-4 py-2 text-white">Aplicar</button><button disabled={pending || !operationKey} onClick={() => run(() => retryPlatformModuleRollout({ operationKey, reason }))} className="rounded border px-4 py-2">Reintentar última operación</button></div>
      <div className="flex flex-wrap items-end gap-2 border-t pt-4"><label className="grid gap-1 text-sm">Versión de destino<select value={version} onChange={(event) => setVersion(Number(event.target.value))} className="rounded border p-2">{versions.map((item) => <option key={item.version} value={item.version}>Versión {item.version}</option>)}</select></label><button disabled={pending || !reason.trim() || (scopeKind === 'selected' && organizationIds.length === 0)} onClick={() => { const key = crypto.randomUUID(); setOperationKey(key); run(() => rollbackPlatformModule({ moduleId: module.id, targetVersion: version, scope, operationKey: key, reason })); }} className="rounded border px-4 py-2">Revertir al destino</button></div>
      {operationKey && <p className="text-xs text-neutral-500">Clave de operación: <code>{operationKey}</code></p>}
      {result && <pre className="max-h-72 overflow-auto rounded bg-neutral-50 p-3 text-xs">{result}</pre>}
    </section>
  </div>;
}

const consoleFieldLabels: Readonly<Record<string, string>> = {
  operationKey: 'Clave de operación', moduleId: 'Módulo', version: 'Versión', config: 'Configuración',
  createdAt: 'Fecha de creación', createdByWorkosUserId: 'ID de quien publicó', sharedReleaseId: 'ID de versión compartida',
  organizations: 'Organizaciones', organizationId: 'ID de organización', currentVersion: 'Versión actual',
  effectiveVersion: 'Versión efectiva', source: 'Origen', moduleVersion: 'Versión del módulo', releaseId: 'ID de versión',
  compatible: 'Compatible', error: 'Detalle', defaultVersion: 'Versión predeterminada', scope: 'Alcance',
  kind: 'Tipo', status: 'Estado', results: 'Resultados', previousVersion: 'Versión anterior',
};

const consoleEnumLabels: Readonly<Record<string, string>> = {
  pending: 'Pendiente', complete: 'Completado', partial: 'Parcial', failed: 'Fallido',
  succeeded: 'Aplicado', skipped: 'Omitido', default: 'Predeterminada', one: 'Una organización',
  selected: 'Organizaciones seleccionadas', all: 'Todas las organizaciones',
  organization_assignment: 'Excepción de organización', tenant_activation: 'Activación de organización',
  global_default: 'Predeterminada global', unconfigured: 'Sin configuración', ai: 'Inteligencia artificial',
};

function translateConsoleResult(value: unknown, field?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => translateConsoleResult(entry));
  if (typeof value === 'string') {
    if (field === 'error') return 'Revisa la compatibilidad de la configuración.';
    return (field === 'status' || field === 'kind' || field === 'source' || field === 'moduleId')
      ? consoleEnumLabels[value] ?? value
      : value;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      consoleFieldLabels[key] ?? key,
      translateConsoleResult(entry, key),
    ]));
  }
  return value;
}
