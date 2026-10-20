import { withGlobalTransaction } from '../../../db/global-transaction';
import { assertActivePlatformActor } from '../../../repos/global-audit';
import { platformConfigRepo } from '../../../repos/platform-config';
import { listPlatformModules, getPlatformModule } from '../modules/registry';
import { ModuleRolloutService } from './service';

export function platformModuleRolloutService(actorWorkosUserId: string): ModuleRolloutService {
  return new ModuleRolloutService(
    getPlatformModule,
    platformConfigRepo(),
    async (actor) => {
      if (actor !== actorWorkosUserId) throw new Error('No tienes permiso para administrar la plataforma.');
    },
    async ({ moduleId, config, organizationId }) => {
      if (moduleId !== 'ai') return;
      if (organizationId) {
        const organization = await withGlobalTransaction((tx) => tx.query<{ readonly status: string }>(
          `SELECT status FROM tenants WHERE id=$1`, [organizationId],
        ));
        if (organization.rows[0]?.status !== 'active') throw new Error('Organization is not active.');
      }
      const sharedReleaseId = (config as { readonly sharedReleaseId: string }).sharedReleaseId;
      const result = await withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        return tx.query<{ readonly id: string }>(
          `SELECT id FROM ai_shared_releases WHERE id=$1 AND status='frozen'`, [sharedReleaseId],
        );
      });
      if (!result.rows[0]) throw new Error('The selected shared AI release is not frozen or available.');
    },
  );
}

export { listPlatformModules, getPlatformModule };
export type { ModuleVersion, ModuleRolloutRepository, RolloutOperation, RolloutPreview, RolloutScope } from './service';
