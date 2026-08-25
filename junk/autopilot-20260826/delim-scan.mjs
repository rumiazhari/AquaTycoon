// Probe: string/comment-aware delimiter balance scanner for UnitDesigner.tsx
import { readFileSync } from 'node:fs';
const p = process.argv[2];
const src = readFileSync(p, 'utf8');
const stack = [];
let state = 'code'; // code, sq, dq, tpl, lc, bc
let line = 1;
const pairs = { '(': ')', '{': '}', '[': ']' };
let i = 0;
while (i < src.length) {
  const c = src[i];
  const nxt = src[i + 1] ?? '';
  if (c === '\n') { line++; i++; continue; }
  if (state === 'code') {
    if (c === '/' && nxt === '/') { state = 'lc'; i += 2; continue; }
    if (c === '/' && nxt === '*') { state = 'bc'; i += 2; continue; }
    if (c === "'") { state = 'sq'; i += 1; continue; }
    if (c === '"') { state = 'dq'; i += 1; continue; }
    if (c === '`') { state = 'tpl'; i += 1; continue; }
    if (c in pairs) stack.push([c, line]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.length && pairs[stack[stack.length - 1][0]] === c) stack.pop();
      else {
        console.log(`MISMATCH closer ${c} at line ${line}; top of stack:`, JSON.stringify(stack.slice(-4)));
        process.exit(0);
      }
    }
    i++; continue;
  }
  if (state === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'" || c === '\n') state = 'code'; i++; continue; }
  if (state === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"' || c === '\n') state = 'code'; i++; continue; }
  if (state === 'tpl') { if (c === '\\') { i += 2; continue; } if (c === '`') state = 'code'; i++; continue; }
  if (state === 'lc') { state = 'code'; continue; }
  if (state === 'bc') { if (c === '*' && nxt === '/') { state = 'code'; i += 2; continue; } i++; continue; }
}
console.log('final state:', state);
console.log('unclosed (top 10):', JSON.stringify(stack.slice(-10)));
