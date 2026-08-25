import { Window } from 'happy-dom';
const win = new Window({ url: 'https://localhost/' });
(globalThis as any).window = win;
(globalAny as any).document = win.document;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (win.document.body) win.document.body.innerHTML = '';
const { createRoot } = require('react-dom/client');
const { Simulate } = require('react-dom/test-utils');
const { act } = require('react');
const { useState } = require('react');

const root = win.document.createElement('div');
const Input = () => {
  const [v, s] = useState('15');
  return <input type='number' value={v} onChange={e => s(e.target.value)} />;
};
const r = createRoot(root);
await act(() => r.render(<Input />));
console.log('Initial value:', (root.querySelector('input') as any).value);
// Try Simulate.change
await act(async () => { Simulate.change(root.querySelector('input') as any); });
console.log('After Simulate.change value:', (root.querySelector('input') as any).value);