import { describe, expect, it } from 'vitest';
import { isDevelopmentMode } from '../development-mode';

describe('isDevelopmentMode', () => {
  it.each(['TRUE', 'true', ' True '])('is on for %j', (value) => {
    expect(isDevelopmentMode({ DEVELOPMENT: value })).toBe(true);
  });

  it.each([undefined, '', 'false', '1', 'yes', 'TRUE1'])('is off for %j', (value) => {
    expect(isDevelopmentMode({ DEVELOPMENT: value })).toBe(false);
  });
});
