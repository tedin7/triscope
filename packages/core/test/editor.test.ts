// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mountEditor } from '../src/editor.js';
import type { Knob } from '../src/types.js';

function makeContainer(): HTMLElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

describe('mountEditor', () => {
  it('adds the triscope-editor class and clears prior children', () => {
    const c = makeContainer();
    c.appendChild(document.createElement('span'));
    expect(c.children.length).toBe(1);
    mountEditor(c, {}, {}, () => {});
    expect(c.classList.contains('triscope-editor')).toBe(true);
    expect(c.children.length).toBe(0);
  });

  it('number knob: renders a range input, fires onChange with parsed float', () => {
    const c = makeContainer();
    const onChange = vi.fn();
    const knobs: Record<string, Knob> = {
      gain: { type: 'number', min: 0, max: 1, default: 0.5 },
    };
    mountEditor(c, knobs, {}, onChange);
    const input = c.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('range');
    expect(input.min).toBe('0');
    expect(input.max).toBe('1');
    expect(input.value).toBe('0.5');
    // Simulated drag
    input.value = '0.75';
    input.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('gain', 0.75);
  });

  it('number knob: uses initial value over default when provided', () => {
    const c = makeContainer();
    mountEditor(c, { x: { type: 'number', min: 0, max: 10, default: 5 } }, { x: 2 }, () => {});
    const input = c.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('2');
  });

  it('int knob: enforces step=1 and parses integers', () => {
    const c = makeContainer();
    const onChange = vi.fn();
    mountEditor(c, { n: { type: 'int', min: 0, max: 10, default: 3 } }, {}, onChange);
    const input = c.querySelector('input') as HTMLInputElement;
    expect(input.step).toBe('1');
    input.value = '7';
    input.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('n', 7);
  });

  it('color knob: renders a color input, propagates string value', () => {
    const c = makeContainer();
    const onChange = vi.fn();
    mountEditor(c, { tint: { type: 'color', default: '#ff0000' } }, {}, onChange);
    const input = c.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('color');
    expect(input.value).toBe('#ff0000');
    input.value = '#00ff00';
    input.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('tint', '#00ff00');
  });

  it('boolean knob: renders a checkbox, propagates boolean', () => {
    const c = makeContainer();
    const onChange = vi.fn();
    mountEditor(c, { on: { type: 'boolean', default: false } }, {}, onChange);
    const input = c.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(false);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('on', true);
  });

  it('trigger knob: renders a button, fires onChange(true) on click, flashes output', () => {
    vi.useFakeTimers();
    const c = makeContainer();
    const onChange = vi.fn();
    mountEditor(c, { fire: { type: 'trigger', label: 'Fire!' } }, {}, onChange);
    const btn = c.querySelector('button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('Fire!');
    const out = c.querySelector('output') as HTMLOutputElement;
    expect(out.textContent).toBe('–');
    btn.click();
    expect(onChange).toHaveBeenCalledWith('fire', true);
    expect(out.textContent).toBe('fired');
    vi.advanceTimersByTime(450);
    expect(out.textContent).toBe('–');
    vi.useRealTimers();
  });

  it('uses spec.label when present, falls back to key', () => {
    const c = makeContainer();
    mountEditor(
      c,
      {
        a: { type: 'number', min: 0, max: 1, default: 0, label: 'Alpha' },
        b: { type: 'number', min: 0, max: 1, default: 0 },
      },
      {},
      () => {},
    );
    const labels = c.querySelectorAll('label');
    const texts = Array.from(labels).map((l) => l.textContent);
    expect(texts).toContain('Alpha');
    expect(texts).toContain('b');
  });

  it('setValue updates number input + output without firing onChange', () => {
    const c = makeContainer();
    const onChange = vi.fn();
    const { setValue } = mountEditor(
      c,
      { g: { type: 'number', min: 0, max: 10, default: 0 } },
      {},
      onChange,
    );
    setValue('g', 4.2);
    const input = c.querySelector('input') as HTMLInputElement;
    const out = c.querySelector('output') as HTMLOutputElement;
    expect(input.value).toBe('4.2');
    expect(out.textContent).toBe('4.20');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setValue is a no-op for unknown keys', () => {
    const c = makeContainer();
    const { setValue } = mountEditor(c, {}, {}, () => {});
    expect(() => setValue('nope', 1)).not.toThrow();
  });

  it('setValue updates color, boolean, and flashes trigger', () => {
    vi.useFakeTimers();
    const c = makeContainer();
    const { setValue } = mountEditor(
      c,
      {
        tint: { type: 'color', default: '#000000' },
        on: { type: 'boolean', default: false },
        fire: { type: 'trigger' },
      },
      {},
      () => {},
    );
    setValue('tint', '#abcdef');
    setValue('on', true);
    setValue('fire', true);
    const inputs = c.querySelectorAll('input');
    expect((inputs[0] as HTMLInputElement).value).toBe('#abcdef');
    expect((inputs[1] as HTMLInputElement).checked).toBe(true);
    // The trigger row is selected by its dataset attr on the row div itself;
    // the row's <output> reflects the flash state.
    const triggerRow = c.querySelector('div.triscope-editor__row[data-knob-key="fire"]')!;
    const triggerOut = triggerRow.querySelector('output');
    expect(triggerOut?.textContent).toBe('fired');
    vi.advanceTimersByTime(450);
    expect(triggerOut?.textContent).toBe('–');
    vi.useRealTimers();
  });

  it('destroy removes all rendered knob children', () => {
    const c = makeContainer();
    const { destroy } = mountEditor(
      c,
      {
        a: { type: 'number', min: 0, max: 1, default: 0 },
        b: { type: 'boolean', default: false },
      },
      {},
      () => {},
    );
    expect(c.children.length).toBe(2);
    destroy();
    expect(c.children.length).toBe(0);
  });

  it('formats numbers: int → integer, |v|<1 → 3 decimals, [1,100) → 2, ≥100 → 1', () => {
    const c = makeContainer();
    mountEditor(
      c,
      {
        i: { type: 'int', min: 0, max: 999, default: 5 },
        s: { type: 'number', min: 0, max: 1, default: 0.123456 },
        m: { type: 'number', min: 0, max: 50, default: 12.345 },
        l: { type: 'number', min: 0, max: 1000, default: 250.789 },
      },
      {},
      () => {},
    );
    const outs = Array.from(c.querySelectorAll('output')).map((o) => o.textContent);
    expect(outs[0]).toBe('5');
    expect(outs[1]).toBe('0.123');
    expect(outs[2]).toBe('12.35');
    expect(outs[3]).toBe('250.8');
  });
});
