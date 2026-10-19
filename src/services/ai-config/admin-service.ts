import type { ResolvedIdentity } from '../../auth/resolve-identity';
import type { AiTurnAttempt, AiTurnNotice, AiTurnRow, UsageSummary } from '../../repos/models';

export interface AiTurnAdminRepository {
  adminGetTurn(turnId: string): Promise<AiTurnRow | undefined>;
  adminListTurns(input?: { conversationId?: string; limit?: number }): Promise<readonly AiTurnRow[]>;
  adminListAttempts(turnId: string): Promise<readonly AiTurnAttempt[]>;
  adminListNotices(turnId: string): Promise<readonly AiTurnNotice[]>;
  adminGetUsage(input?: { from?: string; to?: string }): Promise<UsageSummary>;
  adminDeleteTraceContent(turnId: string): Promise<boolean>;
}

export type AiTurnAdminRepositoryFactory = (identity: ResolvedIdentity) => AiTurnAdminRepository;

/** Tenant-admin trace boundary; repositories repeat the role check in their transaction. */
export class AiAdminService {
  constructor(private readonly repositoryFor: AiTurnAdminRepositoryFactory) {}

  async listTurns(identity: ResolvedIdentity, input: { conversationId?: string; limit?: number } = {}): Promise<readonly AiTurnRow[]> {
    requireTenantAdmin(identity);
    return this.repositoryFor(identity).adminListTurns(input);
  }

  async getTurnTrace(identity: ResolvedIdentity, turnId: string): Promise<{
    readonly turn: AiTurnRow;
    readonly attempts: readonly AiTurnAttempt[];
    readonly notices: readonly AiTurnNotice[];
  } | undefined> {
    requireTenantAdmin(identity);
    const repository = this.repositoryFor(identity);
    const turn = await repository.adminGetTurn(turnId);
    if (!turn) return undefined;
    const [attempts, notices] = await Promise.all([
      repository.adminListAttempts(turnId),
      repository.adminListNotices(turnId),
    ]);
    return Object.freeze({ turn, attempts, notices });
  }

  async exportTurnTrace(identity: ResolvedIdentity, turnId: string): Promise<string> {
    const trace = await this.getTurnTrace(identity, turnId);
    if (!trace) throw new Error('No se encontró el registro de esta conversación.');
    return JSON.stringify(trace);
  }

  async getUsage(identity: ResolvedIdentity, input: { from?: string; to?: string } = {}): Promise<UsageSummary> {
    requireTenantAdmin(identity);
    return this.repositoryFor(identity).adminGetUsage(input);
  }

  async deleteTraceContent(identity: ResolvedIdentity, turnId: string): Promise<boolean> {
    requireTenantAdmin(identity);
    return this.repositoryFor(identity).adminDeleteTraceContent(turnId);
  }
}

function requireTenantAdmin(identity: ResolvedIdentity): void {
  if (identity.tenantRole !== 'admin') throw new Error('No tienes permiso para consultar los registros de esta organización.');
}
