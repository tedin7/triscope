import { describe, expect, it } from 'vitest';
import { knobDefault } from '../src/types.js';

describe('knobDefault', () => {
  it('returns spec.default for number knobs', () => {
    expect(knobDefault({ type: 'number', min: 0, max: 1, default: 0.42 })).toBe(0.42);
  });

  it('returns spec.default for int knobs', () => {
    expect(knobDefault({ type: 'int', min: 0, max: 10, default: 7 })).toBe(7);
  });

  it('returns spec.default for color knobs', () => {
    expect(knobDefault({ type: 'color', default: '#abcdef' })).toBe('#abcdef');
  });

  it('returns spec.default for boolean knobs', () => {
    expect(knobDefault({ type: 'boolean', default: true })).toBe(true);
  });

  it('returns false for trigger knobs (no persistent value)', () => {
    expect(knobDefault({ type: 'trigger' })).toBe(false);
  });
});
