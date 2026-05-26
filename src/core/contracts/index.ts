/**
 * MYPES Platform — Contracts barrel
 * ==================================
 *
 * Re-exports every public symbol from the focused slices. New consumers may
 * import directly from the slice files (`./ids`, `./decisions`, etc.) when
 * they only need a subset; importing from the root barrel (or from the
 * back-compat `../contracts.ts`) remains supported.
 */

export * from './ids';
export * from './conversation';
export * from './decisions';
export * from './deltas';
export * from './core';
