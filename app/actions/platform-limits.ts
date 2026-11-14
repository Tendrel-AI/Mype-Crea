'use server';

import { requireGlobalMfa } from '../../src/auth/resolve-identity';
import { globalRepos } from '../../src/repos/global';
import { getLimitCatalog } from '../../src/core/limits/runtime';
import { isValidLimitValue, LIMIT_MAX, LIMIT_MIN, withDefaults } from '../../src/core/limits/catalog';

/** D38/F24: every catalog key with its stored platform default (code default when never stored). */
export async function getPlatformLimitDefaults() {
  await requireGlobalMfa();
  const catalog = getLimitCatalog();
  const values = withDefaults(catalog, await globalRepos().limitDefaults.list());
  return catalog.map((def) => ({ key: def.key, label: def.label, value: values[def.key] }));
}

/** Changes a default for NEW organizations only; existing profiles keep their copied values. Audited. */
export async function setPlatformLimitDefault(input: { limitKey: string; value: number; reason: string }) {
  const identity = await requireGlobalMfa();
  const reason = input.reason.trim();
  if (!getLimitCatalog().some((def) => def.key === input.limitKey)) throw new Error('Límite desconocido.');
  if (!isValidLimitValue(input.value)) throw new Error(`Escribe un entero entre ${LIMIT_MIN} y ${LIMIT_MAX}.`);
  if (!reason) throw new Error('Escribe el motivo.');
  await globalRepos().limitDefaults.set({ limitKey: input.limitKey, value: input.value, reason, actorWorkosUserId: identity.workosUserId });
}
