import Link from 'next/link';
import { BRIEF_CATALOG, type BriefFieldSpec } from '../src/core/brief';
import { buildAnalyticsSections } from '../src/core/analytics-sections';
import type { TenantAnalytics } from '../src/repos/tenant-analytics';

const date = (iso: string) => new Date(iso).toLocaleDateString('es-PE');

/** F23: server-rendered tables. Sections come from the catalog, so a new field needs no change here. */
export default function TenantAnalyticsPanel({ analytics, catalog = BRIEF_CATALOG }: { analytics: TenantAnalytics; catalog?: ReadonlyArray<BriefFieldSpec> }) {
  const sections = buildAnalyticsSections(catalog, analytics.fields, analytics.conversations);
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-10">
      <header>
        <Link href="/admin/ai" className="text-sm underline">← Administración</Link>
        <h1 className="mt-3 text-2xl font-semibold">Estadísticas de tu organización</h1>
        <p className="mt-1 text-neutral-600">Datos agregados de toda la cuenta. No se muestra el contenido de ninguna marca.</p>
      </header>

      <section className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b text-neutral-600"><th className="p-3">Conversaciones</th><th className="p-3">Turnos</th><th className="p-3">Alteraciones</th><th className="p-3">Turnos por conversación</th><th className="p-3">Alteraciones por conversación</th></tr></thead>
          <tbody><tr>
            <td className="p-3">{analytics.conversations}</td><td className="p-3">{analytics.turns}</td><td className="p-3">{analytics.alterations}</td>
            <td className="p-3">{analytics.perConversation.avgTurns}</td><td className="p-3">{analytics.perConversation.avgAlterations}</td>
          </tr></tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Entregables</h2>
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-neutral-600"><th className="p-3">Tipo</th><th className="p-3">Generados</th><th className="p-3">Alterados</th><th className="p-3">Aprobados</th></tr></thead>
            <tbody>{analytics.funnel.length === 0
              ? <tr><td className="p-3 text-neutral-600" colSpan={4}>Aún no hay entregables.</td></tr>
              : analytics.funnel.map((row) => (
                <tr key={row.kind} className="border-b last:border-0"><td className="p-3">{row.kind}</td><td className="p-3">{row.generated}</td><td className="p-3">{row.altered}</td><td className="p-3">{row.approved}</td></tr>
              ))}</tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Usuarios</h2>
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-neutral-600"><th className="p-3">Correo</th><th className="p-3">Conversaciones</th><th className="p-3">Turnos</th><th className="p-3">Alteraciones</th></tr></thead>
            <tbody>{analytics.users.map((u) => (
              <tr key={u.userId} className="border-b last:border-0"><td className="p-3">{u.email}</td><td className="p-3">{u.conversations}</td><td className="p-3">{u.turns}</td><td className="p-3">{u.alterations}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      {sections.map((section) => (
        <section key={section.name} className="space-y-2" data-field={section.name}>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {section.label}
            {section.deprecatedSince && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-normal">Retirado desde {section.deprecatedSince}</span>}
          </h2>
          <p className="text-sm text-neutral-600">
            Completado en {section.fillRate} % de las conversaciones ({section.filledConversations} de {analytics.conversations}).
            {section.dictionaryVersion && ` Lista de categorías versión ${section.dictionaryVersion}.`}
          </p>
          {section.values.length > 0 && (
            <div className="overflow-x-auto rounded-xl border bg-white">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b text-neutral-600"><th className="p-3">{section.analytics === 'tags' ? 'Etiqueta' : 'Categoría'}</th><th className="p-3">Conversaciones</th></tr></thead>
                <tbody>{section.values.map((v) => (
                  <tr key={v.value} className="border-b last:border-0"><td className="p-3">{v.label}</td><td className="p-3">{v.count}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      {analytics.dictionaryChanges.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Cambios en las listas de categorías</h2>
          <ol className="space-y-1 text-sm">{analytics.dictionaryChanges.map((c) => (
            <li key={`${c.dictionaryKey}-${c.category}-${c.appliedAt}`} className="border-b pb-1">{date(c.appliedAt)}: nueva categoría «{c.label}» ({c.dictionaryKey}), versión {c.version}.</li>
          ))}</ol>
        </section>
      )}
    </main>
  );
}
