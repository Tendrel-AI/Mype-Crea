import { LedgerValidationError } from './errors';

export function str(path: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new LedgerValidationError(path, 'must be a non-empty string');
  return v;
}
export function optStr(path: string, v: unknown) {
  if (v !== undefined) str(path, v);
}
export function nonNeg(path: string, v: unknown) {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new LedgerValidationError(path, 'must be a finite number >= 0');
  }
}
export function finite(path: string, v: unknown) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new LedgerValidationError(path, 'must be a finite number');
}
export function oneOf(path: string, v: unknown, allowed: readonly string[]) {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new LedgerValidationError(path, `must be one of ${allowed.join(', ')}`);
  }
}
export function isoDate(path: string, v: unknown) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
    throw new LedgerValidationError(path, 'must be an ISO date string');
  }
}
