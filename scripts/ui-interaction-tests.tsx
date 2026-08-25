/**
 * UI interaction tests (Mission A5) — run via `npm run test:ui` → tsx.
 *
 * The static suite (ui-tests.tsx) covers pure logic + renderToStaticMarkup
 * snapshots. This suite goes one layer deeper: REAL React mounting inside a
 * lightweight happy-dom DOM, driving the same gestures a player makes —
 * tool switching (Inspect / Pipes / Demolish), unit selection, inspector
 * close / demolish / setpoint-slider edits, and port-picker selection /
 * cancellation — asserting on the callbacks the app actually wires up.
 *
 * Recipe proven by the junk/autopilot-20260826 probes:
 *   - happy-dom Window installed onto globalThis BEFORE React touches the DOM,
 *   - IS_REACT_ACT_ENVIRONMENT = true + `act` from react (React 19),
 *   - clicks (tool switching, cards, ports) delegate natively and are
 *     dispatched as bubbling MouseEvents,
 *   - input/change events do NOT reach React's ChangeEventPlugin in this env,
 *     so controlled-input edits assert via the fiber's real onChange prop.
 * SoundManager is neutralised by hiding window.AudioContext (its own guard
 * turns every play* call into a no-op), so clicks never touch Web Audio.
 */
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { BuildToolbar } from '../src/ui/BuildToolbar';
import { UnitInspector } from '../src/ui/UnitInspector';
import { PortSelector } from '../src/ui/PortSelector';
import type { ToolMode } from '../src/types/graphics';
import type {
  PlacedUnit,
  UnitPort,
} from '../src/types/simulation';
import { emptyWater } from '../src/sim/WaterStream';

// ── happy-dom bootstrap ────────────────────────────────────────────────────
const win = new Window({ url: 'https://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
const def = (k: string, v: unknown) => {
  try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); }
  catch { /* keep */ }
};
def('window', win);
def('document', win.document);
def('navigator', win.navigator);
for (const c of ['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'InputEvent']) {
  def(c, (win as unknown as Record<string, unknown>)[c]);
}
// No Web Audio in tests: SoundManager.init() sees AudioContext === undefined
// and every playClick/playDemolish becomes a guarded no-op.
def('AudioContext', undefined);
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!win.document.body) win.document.write('<body></body>');

// ── tiny test kit ──────────────────────────────────────────────────────────
let passes = 0;
let failures = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { passes++; console.log(`  ✅ ${name}`); }
  else { failures++; console.error(`  ❌ ${name}`); }
}

type Spy<A extends unknown[]> = ((...args: A) => void) & { calls: A[] };
function spy<A extends unknown[] = unknown[]>(): Spy<A> {
  const fn = ((...args: A) => { fn.calls.push(args); }) as Spy<A>;
  fn.calls = [];
  return fn;
}

async function mount(node: React.ReactNode): Promise<{ el: HTMLElement; unmount: () => Promise<void> }> {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    el: container,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function buttonWithText(scope: Element | Document, text: string): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').includes(text)) ?? null;
}

// ── shared fixtures ────────────────────────────────────────────────────────
function unitFixture(): PlacedUnit {
  return {
    instanceId: 'u1',
    typeId: 'bar_screen',
    gridX: 3,
    gridY: 2,
    rotation: 0,
    volume: 4,
    customParams: { barSpacingMm: 15, rakeSpeedRpm: 4 },
    active: true,
    efficiencyRating: 12,
    lastInletQuality: emptyWater(),
    lastOutletQuality: emptyWater(),
    lastPowerKwActual: 2.5,
    lastOpexActual: 15,
  };
}

interface ToolbarHarness {
  onSetToolMode: Spy<[ToolMode]>;
  onSelectUnitTypeId: Spy<[string | null]>;
  onRotate: Spy<[]>;
}
async function mountToolbar(toolMode: ToolMode): Promise<{ h: ToolbarHarness } & Awaited<ReturnType<typeof mount>>> {
  const h: ToolbarHarness = {
    onSetToolMode: spy<[ToolMode]>(),
    onSelectUnitTypeId: spy<[string | null]>(),
    onRotate: spy<[]>(),
  };
  const m = await mount(
    <BuildToolbar
      toolMode={toolMode}
      onSetToolMode={h.onSetToolMode}
      selectedUnitTypeId={null}
      onSelectUnitTypeId={h.onSelectUnitTypeId}
      currentRotation={0}
      onRotate={h.onRotate}
      techTree={[]}
      playerCash={50000}
      isSandbox={false}
      availableUnitIds={['bar_screen', 'grit_chamber']}
    />
  );
  return { h, ...m };
}

// ═══ A. BuildToolbar — global tool switching ══════════════════════════════
console.log('\n── A. BuildToolbar: Inspect / Pipes / Demolish tool switching ──');
{
  const t = await mountToolbar('select');
  const inspectBtn = buttonWithText(t.el, 'Inspect');
  assert(inspectBtn !== null, 'Inspect button renders');
  await act(async () => { inspectBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(t.h.onSetToolMode.calls.length === 1 && t.h.onSetToolMode.calls[0][0] === 'select',
    'Clicking Inspect switches to select mode');
  assert(t.h.onSelectUnitTypeId.calls.length === 1 && t.h.onSelectUnitTypeId.calls[0][0] === null,
    'Switching tools clears any pending unit-type selection');
  await t.unmount();
}
{
  const t = await mountToolbar('select');
  const pipesBtn = buttonWithText(t.el, 'Pipes');
  await act(async () => { pipesBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(t.h.onSetToolMode.calls.length === 1 && t.h.onSetToolMode.calls[0][0] === 'connect_pipe',
    'Clicking Pipes enters connect_pipe mode');
  await t.unmount();
}
{
  const t = await mountToolbar('connect_pipe');
  const demolishBtn = buttonWithText(t.el, 'Demolish');
  await act(async () => { demolishBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(t.h.onSetToolMode.calls.length === 1 && t.h.onSetToolMode.calls[0][0] === 'demolish',
    'Clicking Demolish from pipe mode enters demolish mode');
  await t.unmount();
}
{
  // Active-state styling is the player's only "which tool am I in" cue.
  const t = await mountToolbar('demolish');
  const demolishBtn = buttonWithText(t.el, 'Demolish')!;
  const inspectBtn = buttonWithText(t.el, 'Inspect')!;
  assert(demolishBtn.className.includes('bg-rose-500'),
    'Active Demolish tool is highlighted rose');
  assert(!inspectBtn.className.includes('bg-sky-500'),
    'Inactive Inspect tool loses its highlight while another tool is active');
  await t.unmount();
}
{
    // Unit selection: bar_screen sits in the default 'preliminary' category and
    // is unlockedByDefault, so its card must be present and clickable.
    const t = await mountToolbar('select');
    const card = Array.from(t.el.querySelectorAll('button'))
      .find(b => (b.textContent ?? '').includes('Mechanical Bar Screen'));
    assert(card !== undefined, 'Bar Screen build card visible in Preliminary category');
    await act(async () => { card!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
    assert(t.h.onSetToolMode.calls.some(c => c[0] === 'place_unit'),
      'Clicking a unit card arms place_unit mode');
    assert(t.h.onSelectUnitTypeId.calls.some(c => c[0] === 'bar_screen'),
      'Clicking Bar Screen card selects bar_screen as the active unit type');
    await t.unmount();
  }

// ═══ B. UnitInspector — inspect, close, demolish, setpoint sliders ════════
console.log('\n── B. UnitInspector: selection panel interactions ──');
{
  const onClose = spy<[]>();
  const onUpdateParams = spy<[string, string, number]>();
  const onDemolish = spy<[string]>();
  const m = await mount(
    <UnitInspector unit={unitFixture()} onClose={onClose}
      onUpdateParams={onUpdateParams} onDemolish={onDemolish} />
  );
  assert(m.el.textContent?.includes('Mechanical Bar Screen') === true,
    'Inspector shows the selected unit definition name');
  assert(m.el.textContent?.includes('Connect pipes to feed wastewater stream') === true,
    'Zero-flow truthfulness: no-flow units say so instead of fake numbers');

  // The header close X is the first <button> in DOM order.
  const closeBtn = m.el.querySelector('button');
  await act(async () => { closeBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(onClose.calls.length === 1 && onUpdateParams.calls.length === 0 && onDemolish.calls.length === 0,
    'Header X closes only the inspector (no param/demolish side effects)');
  await m.unmount();
}
{
  const onDemolish = spy<[string]>();
  const m = await mount(
    <UnitInspector unit={unitFixture()} onClose={spy()} onUpdateParams={spy()}
      onDemolish={onDemolish} />
  );
  const demolishBtn = buttonWithText(m.el, 'Demolish Unit');
  assert(demolishBtn !== null, 'Demolish action offered for a regular unit');
  await act(async () => { demolishBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(onDemolish.calls.length === 1 && onDemolish.calls[0][0] === 'u1',
    'Demolish click targets the inspected instance id');
  await m.unmount();
}
{
  // UnitInspector slider callback wiring (DOM event bubbling for range inputs is
  // a happy-dom limitation; the component's onChange → onUpdateParams logic is
  // verified here directly. Full browser E2E would require jsdom/playwright.)
  const onUpdateParams = spy<[string, string, number]>();
  const m = await mount(
    <UnitInspector unit={unitFixture()} onClose={spy()} onUpdateParams={onUpdateParams}
      onDemolish={spy()} />
  );
  const sliders = m.el.querySelectorAll<HTMLInputElement>('input[type="range"]');
  assert(sliders.length === 2, 'Both bar_screen setpoint sliders render');
  const barSpacing = Array.from(sliders)
    .find(s => Number(s.getAttribute('min')) === 6)!; // barSpacingMm: min 6, max 50
  // happy-dom limitation (proven by junk probes 7-10): dispatched input/
  // change/click events never reach React's ChangeEventPlugin in this env
  // (plain div onClick delegates fine), so a player-grade synthetic edit
  // cannot be delivered natively. Invoke the component's REAL rendered
  // onChange prop from its fiber instead — the exact callback React would
  // call — and assert what it commits.
  const fiberKey = Object.keys(barSpacing).find(k => k.startsWith('__reactFiber$'));
  const onChange = fiberKey
    ? (barSpacing as unknown as Record<string, { memoizedProps?: { onChange?: (e: unknown) => void } }>[string])?.[fiberKey]?.memoizedProps?.onChange
    : undefined;
  assert(typeof onChange === 'function', 'Bar Spacing slider has a wired onChange handler');
  await act(async () => { onChange!({ target: { value: '25' } }); });
  assert(onUpdateParams.calls.length === 1 &&
    onUpdateParams.calls[0][0] === 'u1' &&
    onUpdateParams.calls[0][1] === 'barSpacingMm' &&
    onUpdateParams.calls[0][2] === 25,
    `Bar Spacing onChange commits ('u1','barSpacingMm',25) — got ${JSON.stringify(onUpdateParams.calls)}`);
  await m.unmount();
}

// ═══ C. PortSelector — pipe-mode port picking & cancellation ══════════════
console.log('\n── C. PortSelector: pipe endpoint picking & cancel ──');
{
  const inletPort: UnitPort = { id: 'inlet', name: 'Raw Influent', type: 'inlet', relativePosition: [-1, 0.5, 0] };
  const outletPort: UnitPort = { id: 'outlet', name: 'Screened Water', type: 'outlet', relativePosition: [1, 0.5, 0] };
  const onSelect = spy<[UnitPort]>();
  const onCancel = spy<[]>();
  const m = await mount(
    <PortSelector title="Vortex Grit Chamber" subtitle="Choose source port"
      choices={[
        { port: inletPort, connected: false },
        { port: outletPort, connected: true },
      ]}
      highlightId={null} onSelect={onSelect} onCancel={onCancel}
      anchor={{ x: 200, y: 200 }} />
  );
  assert(m.el.textContent?.includes('FREE') === true && m.el.textContent?.includes('IN USE') === true,
    'Live connection status shown (FREE vs IN USE)');
  const freeRow = Array.from(m.el.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').includes('Raw Influent'))!;
  await act(async () => { freeRow.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(onSelect.calls.length === 1 && onSelect.calls[0][0].id === 'inlet',
    'Clicking a FREE port selects that exact port');
  const busyRow = Array.from(m.el.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').includes('Screened Water'))! as HTMLButtonElement;
  assert(busyRow.disabled === true,
    'Connected non-highlighted port row is disabled (cannot double-connect)');
  const cancelBtn = m.el.querySelector<HTMLButtonElement>('button[title="Cancel"]')!;
  await act(async () => { cancelBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  assert(onCancel.calls.length === 1 && onSelect.calls.length === 1,
    'Cancel button aborts pipe targeting without selecting anything');
  await m.unmount();
}

// ── summary ────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) console.log(`ALL UI INTERACTION TESTS PASSED (${passes})`);
else { console.error(`${failures} UI INTERACTION TEST(S) FAILED (${passes} passed)`); process.exit(1); }