import { beforeEach, describe, expect, it, vi } from 'vitest';

// No jsdom/RTL in this repo: hooks are stubbed and the button's onClick is called directly.
const state = { value: false };
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: (init: boolean) => [state.value, (v: boolean) => { state.value = v; }],
  useEffect: () => {},
}));

import { ThemeToggle } from '../../ThemeToggle';

describe('ThemeToggle', () => {
  const classes = new Set<string>();
  const store: Record<string, string> = {};

  beforeEach(() => {
    classes.clear();
    for (const k of Object.keys(store)) delete store[k];
    state.value = false;
    vi.stubGlobal('document', {
      documentElement: { classList: {
        contains: (c: string) => classes.has(c),
        toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
      } },
    });
    vi.stubGlobal('localStorage', { setItem: (k: string, v: string) => { store[k] = v; } });
  });

  it('adds `dark` and saves "dark", then removes it and saves "light"', () => {
    const click = () => (ThemeToggle({}) as { props: { onClick: () => void } }).props.onClick();
    click();
    expect(classes.has('dark')).toBe(true);
    expect(store.theme).toBe('dark');
    click();
    expect(classes.has('dark')).toBe(false);
    expect(store.theme).toBe('light');
  });
});
