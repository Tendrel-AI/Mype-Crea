import { globalIdentityRepo } from './global-identity';
import { globalOrganizationsRepo } from './global-organizations';
import { globalAuditRepo } from './global-audit';
import { globalCreditsRepo } from './global-credits';
import { globalLimitsRepo } from './global-limits';
import { globalCountersRepo } from './global-counters';
import { dictionaryChangesRepo } from './dictionary-changes';
import { platformConfigRepo } from './platform-config';
import { platformTraceRepo } from './platform-trace';

/** Global repositories expose platform metadata only; tenant content stays in tenant repos. */
export function globalRepos() {
  return {
    identity: globalIdentityRepo(),
    organizations: globalOrganizationsRepo(),
    audit: globalAuditRepo(),
    config: platformConfigRepo(),
    trace: platformTraceRepo(),
    credits: globalCreditsRepo(),
    limitDefaults: globalLimitsRepo(),
    counters: globalCountersRepo(),
    dictionaries: dictionaryChangesRepo(),
  };
}

export type GlobalRepos = ReturnType<typeof globalRepos>;
