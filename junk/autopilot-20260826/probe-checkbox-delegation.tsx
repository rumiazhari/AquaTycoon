/** Probe 10: checkbox+click through ChangeEventPlugin vs div onClick (delegation sanity). */
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

const hits: string[] = [];
function Comp() {
  const [c, setC] = React.useState(false);
  return <>
    <input id="cb" type="checkbox" checked={c}
      onChange={e => { hits.push(`cb:${e.target.checked}`); setC(e.target.checked); }} />
    <div id="dv" onClick={() => hits.push('div:click')}>zone</div>
  </>;
}
const container = win.document.createElement('div');
win.document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(<Comp />); });

const cb = container.querySelector('#cb') as HTMLInputElement;
const dv = container.querySelector('#dv') as HTMLDivElement;
console.log('checkbox tracker present:', !!(cb as any)._valueTracker);

await act(async () => { dv.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
// React checkbox onChange rides native 'click' for checkables; must flip .checked first
await act(async () => {
  (cb as HTMLInputElement).checked = true;
  ((cb as unknown as { _valueTracker?: { setValue: (x: string) => void } })._valueTracker)?.setValue('false');
  cb.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
});
console.log('hits after div-click + checkbox-click:', JSON.stringify(hits));

// Fiber-prop direct invocation sanity
const fiberKey = Object.keys(cb).find(k => k.startsWith('__reactFiber$'));
console.log('fiber key found:', Boolean(fiberKey));
const onChange = (cb as any)[fiberKey!]?.memoizedProps?.onChange;
console.log('memoizedProps.onChange is function:', typeof onChange === 'function');
await act(async () => { onChange({ target: { value: '25' } }); });
console.log('hits after direct fiber-prop invoke:', JSON.stringify(hits));
