import { globalIdentityRepo } from './global-identity';
import { globalOrganizationsRepo } from './global-organizations';
import { globalAuditRepo } from './global-audit';
import { platformConfigRepo } from './platform-config';

/** Global repositories expose platform metadata only; tenant content stays in tenant repos. */
export function globalRepos() {
  return {
    identity: globalIdentityRepo(),
    organizations: globalOrganizationsRepo(),
    audit: globalAuditRepo(),
    config: platformConfigRepo(),
  };
}

export type GlobalRepos = ReturnType<typeof globalRepos>;
