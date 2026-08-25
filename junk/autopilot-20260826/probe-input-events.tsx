/** Probe 6: last-mile input strategies — InputEvent, dual-event, execCommand. */
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

function makeComp(initial = '15') {
  const hits: string[] = [];
  function Comp() {
    const [v, setV] = React.useState(initial);
    return <input id="x" type="number" value={v} min={6} max={50}
      onChange={e => { hits.push(`onChange:${e.target.value}`); setV(e.target.value); }} />;
  }
  return { Comp, hits };
}

async function mounted(comp: ReturnType<typeof makeComp>) {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<comp.Comp />); });
  return { container, input: container.querySelector('#x') as HTMLInputElement,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}
const protoSet = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const dirty = (el: Element) =>
  ((el as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker)?.setValue('DIRTY');

// V1: real InputEvent
{
  const c = makeComp();
  const m = await mounted(c);
  await act(async () => {
    protoSet.call(m.input, '30'); dirty(m.input);
    m.input.dispatchEvent(new win.InputEvent('input', { bubbles: true }));
  });
  console.log('V1 InputEvent:', JSON.stringify(c.hits));
  await m.cleanup();
}
// V2: input + change dual dispatch
{
  const c = makeComp();
  const m = await mounted(c);
  await act(async () => {
    protoSet.call(m.input, '30'); dirty(m.input);
    m.input.dispatchEvent(new win.Event('input', { bubbles: true }));
    m.input.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  console.log('V2 dual:', JSON.stringify(c.hits));
  await m.cleanup();
}
// V3: execCommand insertText (select-all first)
{
  const c = makeComp();
  const m = await mounted(c);
  await act(async () => {
    m.input.focus();
    win.document.execCommand('selectAll', false);
    win.document.execCommand('insertText', false, '30');
  });
  console.log('V3 execCommand:', JSON.stringify(c.hits), '| value:', m.input.value);
  await m.cleanup();
}
