/**
 * D41 canonical form: accents stripped (NFD), uppercase, trimmed, inner whitespace -> `_`.
 * The ONE definition: dictionary codes, facts and the OTRO promotion all use it.
 * Pure: importable by client and server.
 */
export function canonicalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/gu, '_');
}
