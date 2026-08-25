import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const win = new Window({ url: 'https://localhost/' });
const g = globalThis as any;
const def = (k: string, v: unknown) => {
  try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); }
  catch { /* keep */ }
};
def('window', win);
def('document', win.document);
def('navigator', win.navigator);
for (const c of ['HTMLElement','HTMLInputElement','HTMLSelectElement','Element','Node','Text','Event','MouseEvent','InputEvent']) {
  def(c, (win as any)[c]);
}
g.AudioContext = undefined;
g.IS_REACT_ACT_ENVIRONMENT = true;
if (!win.document.body) win.document.write('<body></body>');

function SliderComp({ onChange }) {
  return <input type="range" min="6" max="50" step="1" value="15" onChange={onChange} />;
}

const container = win.document.createElement('div');
win.document.body.appendChild(container);
const root = createRoot(container);
const calls = [];
await act(async () => {
  root.render(<SliderComp onChange={e => calls.push(e.target.value)} />);
});
const input = container.querySelector('input')!;
console.log('Initial DOM value:', input.value);

const protoSet = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
await act(async () => {
  protoSet.call(input, '25');
  (input as any)._valueTracker?.setValue('-1');
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
});
console.log('After DOM value:', input.value);
console.log('Calls:', calls);

// try dispatching on container (root) instead
const container2 = win.document.createElement('div');
win.document.body.appendChild(container2);
const root2 = createRoot(container2);
const calls2 = [];
await act(async () => {
  root2.render(<SliderComp onChange={e => calls2.push(e.target.value)} />);
});
const input2 = container2.querySelector('input')!;
await act(async () => {
  protoSet.call(input2, '30');
  (input2 as any)._valueTracker?.setValue('-1');
  container2.dispatchEvent(new win.Event('input', { bubbles: true }));
});
console.log('Container-dispatch calls:', calls2);

await act(async () => { root.unmount(); root2.unmount(); });
container.remove(); container2.remove();