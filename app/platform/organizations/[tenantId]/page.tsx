import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireGlobalMfa } from '../../../../src/auth/resolve-identity';
import { globalRepos } from '../../../../src/repos/global';
import { CreditRechargeForm, OrganizationEditForm } from '../../../../components/PlatformConsole';
import { currentCalendarMonth, getPlatformAuditTrail, getPlatformMonthlyMetrics } from '../../../../src/services/platform/metrics/monthly';
import { getTenantCreditsView, getTenantReconciliation } from '../../../actions/platform-admin';
import { listOrganizationModuleRolloutHistory, getOrganizationEffectiveModuleVersion } from '../../../actions/platform-modules';
import { listPlatformModules } from '../../../../src/services/platform/modules/registry';
import { platformActionLabel, platformReasonLabel } from '../../labels';

export default async function PlatformOrganizationDetailPage({ params }: { params: Promise<{ tenantId: string }> }) {
  let actorWorkosUserId: string;
  try { actorWorkosUserId = (await requireGlobalMfa()).workosUserId; } catch { redirect('/platform/mfa'); }
  const { tenantId } = await params;
  const organization = await globalRepos().organizations.getById(tenantId);
  if (!organization) notFound();
  const moduleDefinitions = listPlatformModules();
  const [counters, credits, reconciliation, metrics, audit, rolloutHistory, effectiveVersions] = await Promise.all([
    globalRepos().counters.forTenant(actorWorkosUserId, tenantId),
    getTenantCreditsView(tenantId), getTenantReconciliation(tenantId).catch(() => null),
    getPlatformMonthlyMetrics(actorWorkosUserId), getPlatformAuditTrail(actorWorkosUserId),
    listOrganizationModuleRolloutHistory(tenantId),
    Promise.all(moduleDefinitions.map((module) => getOrganizationEffectiveModuleVersion({ moduleId: module.id, organizationId: tenantId }))),
  ]);
  const monthly = metrics.find((row) => row.organizationId === tenantId);
  const activity = audit.filter((row) => row.scopeId === tenantId);
  return <main className="mx-auto max-w-4xl space-y-6 px-5 py-10"><header><Link href="/platform/organizations" className="text-sm underline">← Organizaciones</Link><h1 className="mt-3 text-3xl font-semibold">{organization.name}</h1><p className="mt-2 text-sm text-neutral-600">ID de organización: <span className="font-mono">{organization.tenantId}</span></p><p className="text-sm text-neutral-600">Estado: {organization.status === 'active' ? 'Activa' : 'Inactiva'}</p></header><OrganizationEditForm tenantId={organization.tenantId} name={organization.name} active={organization.status === 'active'} />
    <section className="space-y-3"><h2 className="text-xl font-semibold">Contadores</h2><div className="grid gap-3 sm:grid-cols-3">{[
      ['Marcas', counters.brands], ['Productos', counters.products], ['Conversaciones', counters.conversations],
      ['Mensajes (turnos)', counters.turns], ['Retoques', counters.alterations], ['Turnos por conversación (prom.)', counters.avgTurnsPerConversation],
      ['Retoques por entregable (prom.)', counters.avgAlterationsPerDeliverable], ['Saldo (USD)', counters.balanceUsd.toFixed(2)], ['Consumo últimos 30 días (USD)', counters.consumption30dUsd.toFixed(2)],
    ].map(([label, value]) => <article key={String(label)} className="rounded-xl border bg-white p-4"><p className="text-sm text-neutral-600">{label}</p><p className="mt-1 text-xl font-semibold">{typeof value === 'number' ? value.toLocaleString('es-PE') : value}</p></article>)}</div>
      <p className="text-sm text-neutral-600">Entregables generados: {counters.deliverablesByKind.map((item) => `${item.kind} ${item.generated}`).join(' · ') || '—'}</p></section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Créditos</h2><p className="text-sm">Saldo: <span className="font-semibold">USD {credits.balanceUsd.toFixed(2)}</span>{credits.balanceUsd <= 0 && <span className="text-red-700"> · sin créditos: las llamadas se rechazan</span>}</p><CreditRechargeForm tenantId={organization.tenantId} />
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Fecha</th><th className="p-3">Tipo</th><th className="p-3">Monto (USD)</th><th className="p-3">Referencia</th><th className="p-3">Motivo</th></tr></thead><tbody>{credits.ledger.map((entry) => <tr key={entry.id} className="border-b last:border-0"><td className="p-3">{new Date(entry.createdAt).toLocaleString('es-PE')}</td><td className="p-3">{{ recharge: 'Recarga', consumption: 'Consumo', adjustment: 'Ajuste' }[entry.kind]}</td><td className="p-3">{entry.amountUsd.toFixed(6)}</td><td className="p-3">{entry.externalRef ?? '—'}</td><td className="p-3">{entry.reason ?? '—'}</td></tr>)}</tbody></table>{credits.ledger.length === 0 && <p className="p-3 text-sm text-neutral-600">Sin movimientos.</p>}</div>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Conciliación</h2>{reconciliation?.hasKey ? <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Mes (UTC)</th><th className="p-3">Consumo en el libro (USD)</th><th className="p-3">Uso de la llave en OpenRouter (USD)</th><th className="p-3">Diferencia</th></tr></thead><tbody>{reconciliation.months.map((row) => <tr key={row.month} className="border-b"><td className="p-3">{row.month}</td><td className="p-3">{row.ledgerUsd.toFixed(6)}</td><td className="p-3">{row.keyUsageUsd === null ? '—' : row.keyUsageUsd.toFixed(6)}</td><td className="p-3">{row.differenceUsd === null ? '—' : row.differenceUsd.toFixed(6)}</td></tr>)}<tr className="font-medium"><td className="p-3">Total</td><td className="p-3">{reconciliation.totalLedgerUsd.toFixed(6)}</td><td className="p-3">{reconciliation.totalKeyUsageUsd?.toFixed(6) ?? '—'}</td><td className="p-3">{reconciliation.totalDifferenceUsd?.toFixed(6) ?? '—'}</td></tr></tbody></table></div> : <p className="text-sm text-neutral-600">Esta organización aún no tiene una llave de OpenRouter propia; no hay nada que conciliar.</p>}</section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Métricas de {currentCalendarMonth()}</h2><div className="grid gap-3 sm:grid-cols-3">{[['Usuarios activos', monthly?.activeUsers ?? 0], ['Conversaciones nuevas', monthly?.newConversations ?? 0], ['Errores', monthly?.errors ?? 0]].map(([label, value]) => <article key={String(label)} className="rounded-xl border bg-white p-4"><p className="text-sm text-neutral-600">{label}</p><p className="mt-1 text-xl font-semibold">{Number(value).toLocaleString('es-PE')}</p></article>)}</div>
      <div className="rounded-xl border bg-white p-4"><h3 className="font-medium">Uso de modelos</h3>{monthly?.providerModelUsage.length ? <ul className="mt-2 space-y-2 text-sm">{monthly.providerModelUsage.map((item, index) => <li key={`${item.provider}:${item.model}:${index}`}>{item.provider} / {item.model}: {item.calls} llamadas, {item.inputTokens + item.outputTokens} tokens{item.costs.length > 0 && <ul className="ml-3 text-xs text-neutral-600">{item.costs.map((cost, costIndex) => <li key={`${cost.currency}:${cost.source}:${costIndex}`}>{cost.amount.toFixed(4)} {cost.currency ?? ''} · {cost.source ?? 'costo reportado'}</li>)}</ul>}</li>)}</ul> : <p className="mt-2 text-sm text-neutral-600">Sin uso registrado.</p>}<p className="mt-2 text-sm">Costo total estimado: {monthly?.estimatedCost.toFixed(4) ?? '0.0000'} <span className="text-xs text-neutral-500">(estimación)</span></p><p className="mt-1 text-sm">Versiones activas: {monthly?.activeVersions.map((item) => `${item.moduleId} v${item.version}`).join(', ') || '—'}</p></div>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Módulos habilitados y versiones efectivas</h2><div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Módulo</th><th className="p-3">Estado</th><th className="p-3">Origen</th><th className="p-3">Versión</th></tr></thead><tbody>{moduleDefinitions.map((module, index) => { const effective = effectiveVersions[index]; return <tr key={module.id} className="border-b last:border-0"><td className="p-3">{module.name}</td><td className="p-3">{effective.source === 'unconfigured' ? 'No habilitado' : 'Habilitado'}</td><td className="p-3">{{ organization_assignment: 'Excepción de organización', tenant_activation: 'Activación de organización', global_default: 'Predeterminada global', unconfigured: 'Sin configuración' }[effective.source]}</td><td className="p-3">{effective.moduleVersion === null ? effective.releaseId ?? '—' : `v${effective.moduleVersion}`}</td></tr>; })}</tbody></table></div></section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Historial de despliegues</h2><div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-600"><th className="p-3">Fecha</th><th className="p-3">Módulo</th><th className="p-3">Alcance</th><th className="p-3">Cambio de versión</th><th className="p-3">Estado</th><th className="p-3">Resultado en esta organización</th></tr></thead><tbody>{rolloutHistory.map((operation) => { const result = operation.results.find((item) => item.organizationId === tenantId); return <tr key={operation.operationKey} className="border-b last:border-0"><td className="p-3">{new Date(operation.createdAt).toLocaleString('es-PE')}</td><td className="p-3">{moduleDefinitions.find((item) => item.id === operation.moduleId)?.name ?? 'Módulo'}</td><td className="p-3">{rolloutScopeLabel(operation.scope.kind)}</td><td className="p-3">{result?.previousVersion ?? '—'} → v{operation.version}</td><td className="p-3">{rolloutStatusLabel(operation.status)}</td><td className="p-3">{result ? rolloutResultLabel(result.status) : '—'}{result?.status === 'failed' ? ' · Revisa la compatibilidad de la configuración.' : ''}</td></tr>; })}</tbody></table>{rolloutHistory.length === 0 && <p className="p-3 text-sm text-neutral-600">No hay despliegues registrados para esta organización.</p>}</div></section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Actividad reciente</h2><div className="rounded-xl border bg-white divide-y">{activity.map((row) => <div key={row.id} className="p-3 text-sm"><p className="font-medium">{platformActionLabel(row.action)} · {row.outcome === 'success' ? 'Correcto' : 'Fallido'}</p><p className="text-neutral-600">{new Date(row.createdAt).toLocaleString('es-PE')}{row.reason ? ` · ${platformReasonLabel(row.reason)}` : ''}</p></div>)}{activity.length === 0 && <p className="p-3 text-sm text-neutral-600">No hay actividad reciente en el registro consultado.</p>}</div></section>
  </main>;
}

function rolloutScopeLabel(scope: 'default' | 'one' | 'selected' | 'all'): string {
  return { default: 'Predeterminada', one: 'Una organización', selected: 'Organizaciones seleccionadas', all: 'Todas las organizaciones' }[scope];
}

function rolloutStatusLabel(status: 'pending' | 'complete' | 'partial' | 'failed'): string {
  return { pending: 'Pendiente', complete: 'Completado', partial: 'Parcial', failed: 'Fallido' }[status];
}

function rolloutResultLabel(status: 'succeeded' | 'failed' | 'skipped'): string {
  return { succeeded: 'Aplicado', failed: 'Fallido', skipped: 'Omitido' }[status];
}
