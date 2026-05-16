import type { Knob } from './types.js';

type KnobChange = (key: string, value: number | string | boolean) => void;

/**
 * Render a minimal slider/color/checkbox editor for the element's knobs into the given DOM container.
 * Returns a `setValue(key, value)` function so external sources (MCP) can keep the UI in sync.
 *
 * Stays deliberately bare-bones — the styling is the host page's job.
 */
export function mountEditor(
  container: HTMLElement,
  knobs: Record<string, Knob>,
  initial: Record<string, number | string | boolean>,
  onChange: KnobChange,
): { setValue: (key: string, value: number | string | boolean) => void; destroy: () => void } {
  container.replaceChildren();
  container.classList.add('triscope-editor');

  const inputs = new Map<string, HTMLInputElement>();
  const values = new Map<string, HTMLOutputElement>();

  for (const [key, spec] of Object.entries(knobs)) {
    const row = document.createElement('div');
    row.className = 'triscope-editor__row';
    row.dataset.knobKey = key;

    const label = document.createElement('label');
    label.textContent = spec.label ?? key;
    label.title = key;
    row.appendChild(label);

    const input = document.createElement('input');
    input.dataset.knobKey = key;

    const out = document.createElement('output');

    if (spec.type === 'number' || spec.type === 'int') {
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.type === 'int' ? 1 : spec.step ?? (spec.max - spec.min) / 200);
      const v = typeof initial[key] === 'number' ? Number(initial[key]) : spec.default;
      input.value = String(v);
      out.textContent = formatNumber(v, spec.type);
      input.oninput = () => {
        const num = spec.type === 'int' ? parseInt(input.value, 10) : parseFloat(input.value);
        out.textContent = formatNumber(num, spec.type);
        onChange(key, num);
      };
    } else if (spec.type === 'color') {
      input.type = 'color';
      const v = typeof initial[key] === 'string' ? String(initial[key]) : spec.default;
      input.value = v;
      out.textContent = v;
      input.oninput = () => {
        out.textContent = input.value;
        onChange(key, input.value);
      };
    } else if (spec.type === 'boolean') {
      input.type = 'checkbox';
      const v = typeof initial[key] === 'boolean' ? Boolean(initial[key]) : spec.default;
      input.checked = v;
      out.textContent = v ? 'on' : 'off';
      input.onchange = () => {
        out.textContent = input.checked ? 'on' : 'off';
        onChange(key, input.checked);
      };
    }

    row.appendChild(input);
    row.appendChild(out);
    container.appendChild(row);
    inputs.set(key, input);
    values.set(key, out);
  }

  return {
    setValue(key, value) {
      const inp = inputs.get(key);
      const out = values.get(key);
      const spec = knobs[key];
      if (!inp || !out || !spec) return;
      if (spec.type === 'number' || spec.type === 'int') {
        inp.value = String(value);
        out.textContent = formatNumber(Number(value), spec.type);
      } else if (spec.type === 'color') {
        inp.value = String(value);
        out.textContent = String(value);
      } else if (spec.type === 'boolean') {
        inp.checked = Boolean(value);
        out.textContent = inp.checked ? 'on' : 'off';
      }
    },
    destroy() {
      container.replaceChildren();
    },
  };
}

function formatNumber(v: number, type: 'number' | 'int'): string {
  if (type === 'int') return String(Math.round(v));
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
