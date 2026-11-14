import { describe, expect, it } from 'vitest';
import { canonicalize } from '../canonical';

describe('canonicalize (D41)', () => {
  it.each<[string, string, string]>([
    ['accents', 'Panadería y pastelería', 'PANADERIA_Y_PASTELERIA'],
    ['eñe and diaeresis', 'Pingüinos del Perú ñandú', 'PINGUINOS_DEL_PERU_NANDU'],
    ['mixed case', 'aRteSanÍa', 'ARTESANIA'],
    ['outer and inner whitespace, tabs, newlines', '  alimentos \t y\n bebidas  ', 'ALIMENTOS_Y_BEBIDAS'],
    ['already canonical', 'OTRO', 'OTRO'],
    ['empty', '', ''],
    ['only spaces', '   ', ''],
  ])('%s', (_name, input, expected) => {
    expect(canonicalize(input)).toBe(expected);
  });
});
