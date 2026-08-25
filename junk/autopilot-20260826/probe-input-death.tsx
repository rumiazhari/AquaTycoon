/** Probe 8: where does the input event die? Propagation + React listener registry. */
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
const def = (k: string, v: unknown) => {
  try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } catch { /* keep */ }
};
def('window', win); def('document', win.document); def('navigator', win.navigator);
for (const c of ['HTMLElement','HTMLInputElement','HTMLSelectElement','Element','Node','Text','Event','MouseEvent','InputEvent']) def(c, (win as unknown as Record<string, unknown>)[c]);
def('AudioContext', undefined);
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!win.document.body) win.document.write('<body></body>');

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Minimal controlled range component (no app imports)
function Comp({ hits }: { hits: string[] }) {
  const [v, setV] = React.useState(15);
  return <input id="r" type="range" min={6} max={50} step={1} value={v}
    onChange={e => { hits.push(`onChange:${e.target.value}`); setV(Number(e.target.value)); }} />;
}

const hits: string[] = [];
const container = win.document.createElement('div');
win.document.body.appendChild(container);

// Spy listeners at every hop
container.addEventListener('input', () => console.log('  [prop] input reached CONTAINER'));
win.document.addEventListener('input', () => console.log('  [prop] input reached DOCUMENT'));
container.addEventListener('click', () => console.log('  [prop] click reached CONTAINER'));

const root = createRoot(container);
await act(async () => { root.render(<Comp hits={hits} />); });

const inp = container.querySelector('#r') as HTMLInputElement;
console.log('initial value:', inp.value, '| tracker:', !!(inp as any)._valueTracker);
console.log('container own keys w/ react fiber:', Object.keys(container).filter(k => k.startsWith('_') || k.includes('react')));

const protoSet = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
await act(async () => {
  protoSet.call(inp, '25');
  ((inp as any)._valueTracker)?.setValue('-1');
  console.log('post-set value read:', inp.value);
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
});
await act(async () => {
  inp.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
});
console.log('hits:', JSON.stringify(hits));

// Inspect React's listener map on the container (randomKeyPrefix)
const keys = Object.getOwnPropertyNames(container);
console.log('container prop names:', keys.slice(0, 10));
