/** Probe 9: recipe × input-type matrix. */
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
const def = (k: string, v: unknown) => {
  try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } catch { /* keep */ }
};
def('window', win); def('document', win.document); def('navigator', win.navigator);
for (const c of ['HTMLElement','HTMLInputElement','HTMLSelectElement','Element','Node','Text','Event','MouseEvent','InputEvent']) def(c, (win as unknown as Record<string, unknown>)[c]);
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!win.document.body) win.document.write('<body></body>');

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

async function trial(type: string): Promise<string[]> {
  const hits: string[] = [];
  function Comp() {
    const [v, setV] = React.useState('15');
    return <input id="x" type={type} min={6} max={50} step={1} value={v}
      onChange={e => { hits.push(`onChange:${e.target.value}`); setV(e.target.value); }} />;
  }
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Comp />); });
  const inp = container.querySelector('#x') as HTMLInputElement;
  const protoSet = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    protoSet.call(inp, '25');
    ((inp as unknown as { _valueTracker?: { setValue: (x: string) => void } })._valueTracker)?.setValue('-1');
    inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    inp.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  await act(async () => { root.unmount(); });
  container.remove();
  return hits;
}

for (const t of ['text', 'number', 'range', 'email', 'search']) {
  const h = await trial(t);
  console.log(`${t.padEnd(7)} → ${JSON.stringify(h)}`);
}
