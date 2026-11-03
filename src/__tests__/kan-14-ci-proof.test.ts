import { describe, expect, it } from 'vitest';

// Throwaway: proves CI reports a failing unit test (KAN-14). Never merged.
describe('KAN-14 CI failure proof', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
