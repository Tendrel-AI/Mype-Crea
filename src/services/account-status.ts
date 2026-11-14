/**
 * D43: a deactivated account makes no NEW provider call. Callers run `assertOwnerActive`
 * immediately before each provider call (the usage-gateway reservation is the DB-level backstop).
 * A call already sent is never interrupted.
 */
import type { UUID } from '../core/contracts';
import { TaskError } from '../core/task-errors';
import { identityRepo } from '../repos/identity';
import { loggerFor } from './logger';

const log = loggerFor('service.account-status');

export type OwnerActiveCheck = (tenantId: string, userId: string) => Promise<void>;

export const isUserActive = (tenantId: string, userId: string): Promise<boolean> =>
  identityRepo({ id: tenantId as UUID }).isUserActive(userId);

/** Throws the typed, non-retryable `account_inactive` when the user is blocked; a failed read propagates (fail closed). */
export const assertOwnerActive: OwnerActiveCheck = async (tenantId, userId) => {
  if (await isUserActive(tenantId, userId)) return;
  log.warn({ tenantId, userId }, 'account.inactive_provider_call_refused');
  throw new TaskError('account_inactive', 'The account is deactivated; no provider call was made.');
};
