/**
 * Text helpers shared by the eval scorers. Pure, no I/O.
 */

/**
 * Case-, accent- and whitespace-insensitive form used for every value
 * comparison, so "Café  Andino" and "cafe andino" match. `ñ` folds to `n`
 * on both sides, which keeps comparisons symmetric.
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[“”«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function includesNormalized(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

/**
 * Sentence count for short chat replies. A Spanish question opened with `¿`
 * and closed with `?` is one sentence; trailing emoji or whitespace after
 * the last terminator is not a sentence.
 */
export function countSentences(s: string): number {
  return s
    .split(/[.!?…]+(?=\s|$)/u)
    .map((part) => part.replace(/[\s¡¿\p{Extended_Pictographic}]/gu, ''))
    .filter((part) => part.length > 0).length;
}
