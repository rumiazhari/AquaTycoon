/** Probe 7: range-input strategies against the REAL UnitInspector slider. */
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
const def = (k: string, v: unknown) => {
  try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } catch { /* keep */ }
};
def('window', win); def('document', win.document); def('navigator', win.navigator);
for (const c of ['HTMLElement','HTMLInputElement','HTMLSelectElement','Element','Node','Text','Event','MouseEvent','InputEvent','KeyboardEvent']) def(c, (win as unknown as Record<string, unknown>)[c]);
def('AudioContext', undefined);
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!win.document.body) win.document.write('<body></body>');

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UnitInspector } from '../../src/ui/UnitInspector';
import { emptyWater } from '../../src/sim/WaterStream';

const unitFixture = {
  instanceId: 'u1', typeId: 'bar_screen', gridX: 3, gridY: 2, rotation: 0,
  volume: 4, customParams: { barSpacingMm: 15, rakeSpeedRpm: 4 },
  active: true, efficiencyRating: 12,
  lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(),
  lastPowerKwActual: 2.5, lastOpexActual: 15,
} as any;

async function mounted(hits: string[]) {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const onUpdateParams = (id: string, key: string, v: number) => hits.push(`${key}=${v}`);
  await act(async () => {
    root.render(<UnitInspector unit={unitFixture} onClose={() => {}} onUpdateParams={onUpdateParams} onDemolish={() => {}} />);
  });
  return {
    el: container,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}
const protoSet = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const dirty = (el: Element, v: string) =>
  ((el as unknown as { _valueTracker?: { setValue: (x: string) => void } })._valueTracker)?.setValue(v);
const slider = (el: Element) =>
  Array.from(el.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(s => s.getAttribute('min') === '6')!;

// V1: dual Event (current failing recipe)
{
  const hits: string[] = [];
  const m = await mounted(hits);
  const inp = slider(m.el);
  console.log('V1 pre:', JSON.stringify({ value: inp.value, hasTracker: !!(inp as any)._valueTracker, onchange: typeof inp.onchange }));
  await act(async () => {
    protoSet.call(inp, '25'); dirty(inp, '-1');
    inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    inp.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  console.log('V1 dual-Event:', JSON.stringify(hits));
  await m.cleanup();
}
// V2: InputEvent only
{
  const hits: string[] = [];
  const m = await mounted(hits);
  const inp = slider(m.el);
  await act(async () => {
    protoSet.call(inp, '25'); dirty(inp, '-1');
    inp.dispatchEvent(new win.InputEvent('input', { bubbles: true }));
  });
  console.log('V2 InputEvent:', JSON.stringify(hits));
  await m.cleanup();
}
// V3: direct instance-level set (bypasses protoSet entirely)
{
  const hits: string[] = [];
  const m = await mounted(hits);
  const inp = slider(m.el);
  await act(async () => {
    inp.value = '25'; dirty(inp, '-1');
    inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    inp.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  console.log('V3 plain set:', JSON.stringify(hits));
  await m.cleanup();
}
// V4: keyboard arrow on focused range
{
  const hits: string[] = [];
  const m = await mounted(hits);
  const inp = slider(m.el);
  await act(async () => {
    inp.focus();
    inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    inp.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    inp.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  console.log('V4 keyboard:', JSON.stringify(hits), '| value now:', inp.value);
  await m.cleanup();
}
