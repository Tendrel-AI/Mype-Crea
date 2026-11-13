/**
 * D41 / F23 tenant-admin analytics. One call to `app.tenant_analytics` (SECURITY DEFINER, current tenant,
 * tenant admin only): aggregates and per-user counters, never a member's brief content. The catalog
 * (name + analytics) is passed in, so a new catalog field is aggregated without touching SQL.
 */
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { NotTenantAdminError } from './tenant-accounts';

const log = loggerFor('repos.tenant-analytics');

export interface AnalyticsFieldInput {
  readonly name: string;
  readonly analytics: 'category' | 'tags' | 'text' | 'none';
}

export interface TenantAnalytics {
  readonly conversations: number;
  readonly turns: number;
  readonly alterations: number;
  readonly perConversation: { readonly avgTurns: number; readonly avgAlterations: number };
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly filledConversations: number;
    readonly values: ReadonlyArray<{ readonly value: string; readonly count: number }>;
  }>;
  readonly funnel: ReadonlyArray<{ readonly kind: string; readonly generated: number; readonly altered: number; readonly approved: number }>;
  readonly users: ReadonlyArray<{ readonly userId: string; readonly email: string; readonly conversations: number; readonly turns: number; readonly alterations: number }>;
  readonly dictionaryChanges: ReadonlyArray<{ readonly dictionaryKey: string; readonly version: string; readonly category: string; readonly label: string; readonly appliedAt: string }>;
}

export function tenantAnalyticsRepo(tenant: Tenant, user: User) {
  return {
    async get(fields: ReadonlyArray<AnalyticsFieldInput>): Promise<TenantAnalytics> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const admin = await tx.query<{ ok: boolean }>('SELECT app.has_tenant_admin() AS ok');
        if (!admin.rows[0]?.ok) throw new NotTenantAdminError();
        const result = await tx.query<{ doc: TenantAnalytics }>(
          'SELECT app.tenant_analytics($1::jsonb) AS doc',
          [JSON.stringify(fields.map(({ name, analytics }) => ({ name, analytics })))],
        );
        log.debug({ tenantId: tenant.id, fields: fields.length }, 'tenant_analytics.read');
        return result.rows[0].doc;
      });
    },
  };
}

export type TenantAnalyticsRepo = ReturnType<typeof tenantAnalyticsRepo>;
