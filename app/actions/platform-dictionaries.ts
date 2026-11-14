'use server';

import { requireGlobalMfa } from '../../src/auth/resolve-identity';
import { globalRepos } from '../../src/repos/global';
import { DICTIONARIES, OTHER_CODE } from '../../src/core/dictionaries';

/** D41/F24: top `OTRO` texts per dictionary plus the dated promotion history. Aggregates only. */
export async function getPlatformDictionariesView() {
  const identity = await requireGlobalMfa();
  const repo = globalRepos().dictionaries;
  const keys = Object.keys(DICTIONARIES);
  const [texts, history] = await Promise.all([
    Promise.all(keys.map((key) => repo.otroTexts(identity.workosUserId, key))),
    repo.history(),
  ]);
  return {
    dictionaries: keys.map((key, i) => ({
      key, version: DICTIONARIES[key].version,
      codes: DICTIONARIES[key].entries.filter((e) => e.code !== OTHER_CODE),
      texts: texts[i],
    })),
    history,
  };
}

/** Maps one raw `OTRO` text to an EXISTING dictionary code (new codes ship in code with a version bump). Audited. */
export async function promoteOtroText(input: { dictionaryKey: string; text: string; categoryCode: string }) {
  const identity = await requireGlobalMfa();
  const entry = DICTIONARIES[input.dictionaryKey]?.entries.find((e) => e.code === input.categoryCode && e.code !== OTHER_CODE);
  if (!entry) throw new Error('Elige una categoría existente del diccionario.');
  if (!input.text.trim()) throw new Error('Falta el texto a promover.');
  return globalRepos().dictionaries.promote(
    { dictionaryKey: input.dictionaryKey, label: entry.label, texts: [input.text] }, identity.workosUserId);
}
