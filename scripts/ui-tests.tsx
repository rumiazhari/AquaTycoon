/**
 * UI regression tests (Prompt 3.4.2) — run via `npm run test:ui` → tsx.
 *
 * Two layers:
 *  1. Pure logic: the tool-state reducer, the authoritative PermitEngine,
 *     TrainTopology resolution, PortSelector clamping, UnitInspector status
 *     derivation, TechTree block reasons.
 *  2. React components rendered with react-dom/server (renderToStaticMarkup):
 *     BuildToolbar, TechTreeModal, OperatorConsole, PlantFlowDiagram,
 *     HeaderHUD, UnitInspector — asserting on real player-facing markup.
 * SoundManager is SSR-safe (guards on typeof window), so no DOM is needed.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GameManager } from '../src/gameplay/GameManager';
import {
  reduceToolSelection,
  ToolInteractionState,
} from '../src/ui/ToolStateLogic';
import type { ToolMode } from '../src/types/graphics';
import { UNIT_DEFINITIONS } from '../src/sim/UnitProcessModels';
import {
  evaluatePermitCriteria,
  permitViolations,
  permitRows,
  isPermitCompliant,
} from '../src/sim/PermitEngine';
import { techBlockReason } from '../src/ui/TechTreeModal';
import { clampPortPanelPosition } from '../src/ui/PortSelector';
import { deriveUnitStatus } from '../src/ui/UnitStatus';
import {
  resolveTrainTopology,
  TrainBranchKind,
} from '../src/ui/TrainTopology';
import { BuildToolbar } from '../src/ui/BuildToolbar';
import { TechTreeModal } from '../src/ui/TechTreeModal';
import { OperatorConsole } from '../src/ui/OperatorConsole';
import { PlantFlowDiagram } from '../src/ui/PlantFlowDiagram';
import { HeaderHUD } from '../src/ui/HeaderHUD';
import { UnitInspector } from '../src/ui/UnitInspector';
import { emptyWater } from '../src/sim/WaterStream';
import type {
  PipeConnection,
  PlacedUnit,
  TreatmentStandard,
  WaterQuality,
} from '../src/types/simulation';

let failures = 0;
let passes = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) { passes++; console.log('PASS  ' + msg); }
  else { failures++; console.error('FAIL  ' + msg); }
};

// ── Shared fixtures ───────────────────────────────────────────────────────────

const mkUnit = (
  id: string,
  typeId: keyof typeof UNIT_DEFINITIONS,
  gridX = 2,
  gridY = 2
): PlacedUnit => {
  const def = UNIT_DEFINITIONS[typeId];
  return {
    instanceId: id,
    typeId: def.id as PlacedUnit['typeId'],
    gridX, gridY, rotation: 0,
    volume: def.footprint[0] * def.footprint[1] * 6 * 4,
    customParams: { ...def.defaultParams },
    active: true,
    efficiencyRating: 90,
    lastInletQuality: emptyWater(),
    lastOutletQuality: emptyWater(),
    lastPowerKwActual: def.powerConsumptionKw,
    lastOpexActual: def.baseOpexPerDay,
  };
};

const mkPipe = (
  id: string,
  fromUnitId: string, fromPortId: string,
  toUnitId: string, toPortId: string
): PipeConnection => ({
  id,
  fromUnitId, fromPortId, toUnitId, toPortId,
  pathPoints: [],
  flowRate: 1000,
  quality: emptyWater(),
  pipeType: 'liquid',
});

const L1 = GameManager.createInitialState(0, false);
const STD: TreatmentStandard = { ...L1.currentLevel.standards };

/** Effluent factory with sane defaults that PASS the level-1 permit. */
const goodEffluent = (): WaterQuality => ({
  ...emptyWater(),
  flowRate: 3500,
  bod: 10, cod: 40, tss: 12, tn: 12, nh4: 4, tp: 1.5,
  pathogens: 500, do: 6, ph: 7.2, turbidity: 5,
});

const baseToolState = (toolMode: ToolMode = 'select', selectedUnitTypeId: any = null): ToolInteractionState =>
  ({ toolMode, selectedUnitTypeId });

// ══════════════════════════════════════════════════════════════════════════════
// T1 — Tool-mode reducer: the P0 Inspect/Pipes/Demolish bug can never recur.
{
  // The exact old bug sequence: tool button then onSelectUnitTypeId(null).
  const s1 = reduceToolSelection(
    reduceToolSelection(baseToolState('place_unit', 'bar_screen'), { type: 'set_tool_mode', mode: 'connect_pipe' }),
    { type: 'select_unit_type', typeId: null }
  );
  assert(s1.toolMode === 'connect_pipe' && s1.selectedUnitTypeId === null,
    'T1a. Pipes click followed by null unit selection stays in connect_pipe (old bug sequence)');

  const s2 = reduceToolSelection(
    baseToolState('place_unit', 'bar_screen'), { type: 'set_tool_mode', mode: 'demolish' });
  assert(s2.toolMode === 'demolish' && s2.selectedUnitTypeId === null,
    'T1b. Switching tools atomically clears the stale placement unit');

  const s3 = reduceToolSelection(baseToolState(), { type: 'select_unit_type', typeId: null });
  assert(s3.toolMode === 'select' && s3.selectedUnitTypeId === null,
    'T1c. onSelectUnitTypeId(null) NEVER enters place_unit');

  const s4 = reduceToolSelection(baseToolState(), { type: 'select_unit_type', typeId: 'bar_screen' });
  assert(s4.toolMode === 'place_unit' && s4.selectedUnitTypeId === 'bar_screen',
    'T1d. Selecting a build unit enters place_unit WITH that unit in one transition');

  const s5 = reduceToolSelection(baseToolState('connect_pipe'), { type: 'select_unit_type', typeId: null });
  assert(s5.toolMode === 'connect_pipe',
    'T1e. Null selection in Pipes mode does not kick the player out of Pipes');

  const s6 = reduceToolSelection(baseToolState('place_unit', 'grit_chamber'), { type: 'cancel_placement' });
  assert(s6.toolMode === 'select' && s6.selectedUnitTypeId === null,
    'T1f. cancel_placement resets to select cleanly');
}

// ══════════════════════════════════════════════════════════════════════════════
// T2 — PermitEngine: authoritative, true-zero pathogens, full criteria set.
{
  const eff = goodEffluent();
  assert(isPermitCompliant(eff, STD), 'T2a. Good effluent passes every criterion');
  assert(permitViolations(eff, STD).length === 0, 'T2b. No violations for good effluent');

  const rows = permitRows(eff, STD);
  assert(rows.length === 10,
    'T2c. Permit table covers ALL parameters incl. pH band and turbidity (10 rows)');
  assert(permitRows(goodEffluent(), { ...STD, maxPathogens: 0 }).find(r => r.key === 'pathogens')!.limitText.includes('≤ 0'),
    'T2d. Zero-pathogen limit displayed literally as "≤ 0" (never clamped to 1)');

  const zeroStd: TreatmentStandard = { ...STD, maxPathogens: 0 };
  assert(!isPermitCompliant({ ...eff, pathogens: 500 }, zeroStd),
    'T2e. Pathogens 500 vs limit 0 FAILS a true-zero permit');
  assert(isPermitCompliant({ ...eff, pathogens: 0 }, zeroStd),
    'T2f. Pathogens exactly 0 PASSES a true-zero permit');
  assert(permitViolations(eff, zeroStd)[0].key === 'pathogens',
    'T2g. True-zero pathogen violation detected and ranked');

  const critKeys = evaluatePermitCriteria(goodEffluent(), STD).map(c => c.key);
  assert(critKeys.filter(k => k.startsWith('ph')).length === 2,
    'T2h. Both pH bounds evaluated as separate criteria (matches SimulationEngine)');

  const turbViol = permitViolations({ ...eff, turbidity: 99 }, STD);
  assert(turbViol.some(v => v.key === 'turbidity'),
    'T2i. Turbidity violation detected (was invisible in the old UI checks)');
  const phHiViol = permitViolations({ ...eff, ph: 10.5 }, STD);
  assert(phHiViol.some(v => v.key === 'ph_high'),
    'T2j. High-pH violation detected (was invisible in the old UI checks)');
  const phLoViol = permitViolations({ ...eff, ph: 4.0 }, STD);
  assert(phLoViol.some(v => v.key === 'ph_low'),
    'T2k. Low-pH violation detected');

  // Engine-message parity with SimulationEngine's historical strings.
  const msg = evaluatePermitCriteria({ ...eff, bod: 999 }, STD).find(c => c.key === 'bod')!.engineMessage;
  assert(msg === 'BOD (999.0 > 25 mg/L)', 'T2l. Criterion message byte-identical to engine format');
}

// ══════════════════════════════════════════════════════════════════════════════
// T3 — TrainTopology: real connectivity, not units.map().
{
  const inlet = mkUnit('inlet', 'influent_inlet', 0, 2);
  const screen = mkUnit('scr', 'bar_screen', 4, 2);
  const digester = mkUnit('dig', 'anaerobic_digester', 8, 8); // sludge branch only
  const loner = mkUnit('lone', 'pump_station', 12, 12);       // fully disconnected

  const pipes = [
    mkPipe('p1', 'inlet', 'outlet', 'scr', 'inlet'),
    mkPipe('p2', 'scr', 'sludge_outlet', 'dig', 'inlet'),
  ];
  const topo = resolveTrainTopology([inlet, screen, digester, loner], pipes);

  assert(topo.byUnit.get('inlet')!.onActiveTrain, 'T3a. Influent inlet is on the active train');
  assert(topo.byUnit.get('scr')!.onActiveTrain, 'T3b. Screen fed by the inlet is on the active train');
  assert(!topo.byUnit.get('dig')!.onActiveTrain,
    'T3c. Sludge-fed unit is NOT claimed as part of the main liquid train');
  assert(topo.byUnit.get('dig')!.fullyDisconnected === false,
    'T3d. Sludge-fed unit is connected but off-train (not "no pipes attached")');
  assert(topo.byUnit.get('lone')!.fullyDisconnected,
    'T3e. Zero-pipe unit flagged fully disconnected');
  assert(topo.mainTrainOrder[0] === 'inlet' && topo.mainTrainOrder[1] === 'scr',
    'T3f. Main-train order follows real liquid edges from the inlet');
  assert(topo.offTrainIds.sort().join(',') === 'dig,lone',
    'T3g. Off-train list contains exactly the non-main-line units');
}

// ══════════════════════════════════════════════════════════════════════════════
// T4 — PortSelector clamp across required viewport sizes.
{
  const sizes: Array<[number, number, string]> = [
    [1920, 1080, '1920×1080'], [1366, 768, '1366×768'], [1280, 720, '1280×720'],
    [1024, 768, '1024×768'], [800, 600, '~800px width'],
  ];
  let allOk = true;
  for (const [w, h, name] of sizes) {
    // Extreme anchors: far corners and beyond.
    for (const [ax, ay] of [[-5000, -5000], [w + 5000, h + 5000], [w / 2, h / 2]]) {
      const { left, top } = clampPortPanelPosition(ax, ay, w, h);
      if (left < 8 || left + 272 > w || top < 64 || top + 296 > h) allOk = false;
    }
    assert(allOk, `T4-${name}: card always inside viewport at ${name}`);
  }
  const neg = clampPortPanelPosition(0, 0, 400, 300);
  assert(neg.left >= 8 && neg.top >= 64,
    'T4z. Tiny viewport never produces negative placement coordinates');
}

// ══════════════════════════════════════════════════════════════════════════════
// T5 — UnitInspector status derivation & null-safe metrics.
{
  const u = mkUnit('u1', 'activated_sludge_cas');
  const noFlow = deriveUnitStatus({ ...u, active: true });
  assert(noFlow.key === 'no_flow' && noFlow.label === 'No Flow',
    'T5a. Dry unit reports "No Flow" (not Active & Steady)');
  const inactive = deriveUnitStatus({ ...u, active: false });
  assert(inactive.key === 'inactive' && inactive.label === 'Inactive',
    'T5b. Disabled unit reports "Inactive"');
  const flowing = deriveUnitStatus({
    ...u,
    lastInletQuality: { ...emptyWater(), flowRate: 900 },
  });
  assert(flowing.key === 'steady' && flowing.label === 'Active & Steady',
    'T5c. Flowing healthy unit reports Active & Steady');
  const toxic = deriveUnitStatus({
    ...u,
    lastInletQuality: { ...emptyWater(), flowRate: 900, toxicIndex: 80 },
  });
  assert(toxic.key === 'stressed',
    'T5d. Toxic load surfaces as a warning status, not fake health');

  // fmtMetric semantics pinned through real component markup: valid numeric 0
  // stays 0, undefined renders "—", and the old magic defaults are gone from
  // the METRIC CELLS (the tuning slider may legitimately show its own default).
  const insp = renderToStaticMarkup(
    React.createElement(UnitInspector, {
      unit: {
        ...u,
        dissolvedOxygenActual: 5.1, // gate for the Biological State Metrics card
        mlssActual: 0,              // valid zero must stay zero
        // sviActual deliberately undefined → must render "—"
      },
      onClose: () => {}, onUpdateParams: () => {}, onDemolish: () => {},
    })
  );
  assert(insp.includes('>0 mg/L<'),
    'T5e. Valid numeric 0 renders as 0 (never swapped for a default)');
  // Scope to the METRIC CELLS — tuning sliders legitimately show their own
  // defaults elsewhere in the panel.
  assert(!insp.includes('text-amber-300">3200') && !insp.includes('text-emerald-300">105'),
    'T5f. Old magic fallbacks gone from MLSS/SVI cells');
  const flat = insp.replace(/\r?\n\s*/g, '');
  assert(/>SVI<\/div><div[^>]*>—</.test(flat),
    'T5g. Undefined SVI renders as an explicit em-dash placeholder');
}

// ══════════════════════════════════════════════════════════════════════════════
// T6 — TechTree truthful disabled reasons (synthetic tree = fully deterministic).
{
  const mkNode = (id: string, unlocked: boolean, prerequisites: string[], cost: number) =>
    ({ id, title: id.replace(/_/g, ' '), unlocked, prerequisites, cost });

  const tree: any[] = [
    mkNode('base_tech', true, [], 0),
    mkNode('child_tech', false, ['base_tech'], 50000),
    mkNode('grandchild', false, ['child_tech'], 1000),
  ];

  // Prereq path: grandchild needs child_tech which is locked.
  assert(techBlockReason(tree[2], tree, 1_000_000, false).startsWith('Requires: child tech'),
    'T6a. Missing prerequisite names the actual requirement (not "Prerequisites Locked")');
  // Cash path: prereqs met but wallet empty (locale-safe: don't pin separators).
  const cashReason = techBlockReason(tree[1], tree, 0, false);
  assert(cashReason.startsWith('Need $') && cashReason.endsWith(' more'),
    `T6b. Insufficient cash says exactly how much is missing ("${cashReason}")`);
  assert(techBlockReason(tree[1], tree, 0, true) === '',
    'T6c. Sandbox ignores cash requirements');
  assert(techBlockReason(tree[1], tree, 50_000, false) === '',
    'T6d. Exactly-enough cash unlocks (>= comparison)');
  assert(techBlockReason(tree[0], tree, 0, false) === 'Already unlocked',
    'T6e. Unlocked node reports its own state');
}

// ══════════════════════════════════════════════════════════════════════════════
// T7/T8/T9 — Component markup assertions.
const noop = () => {};

{
  // ── T7: BuildToolbar mode wiring ──
  const tb = (mode: ToolMode, sel: any) => renderToStaticMarkup(
    React.createElement(BuildToolbar, {
      toolMode: mode,
      onSetToolMode: noop,
      selectedUnitTypeId: sel,
      onSelectUnitTypeId: noop,
      currentRotation: 0,
      onRotate: noop,
      techTree: L1.techTree,
      playerCash: L1.financials.cash,
      isSandbox: true,
      availableUnitIds: ['bar_screen'],
    })
  );

  assert(tb('connect_pipe', null).includes('bg-cyan-400 text-slate-950'),
    'T7a. Pipes button visually active in connect_pipe mode');
  assert(!tb('connect_pipe', null).includes('bg-sky-500 text-slate-950 shadow-md font-bold">\n              <MousePointer'),
    'T7b. Inspect button not styled active while Pipes is active');
  assert(tb('demolish', null).includes('bg-rose-500 text-slate-950'),
    'T7c. Demolish button visually active in demolish mode');
  assert(tb('select', null).includes('bg-sky-500 text-slate-950'),
    'T7d. Inspect button visually active in select mode');
  // place_unit with a cleared unit must NOT highlight any palette card.
  const ghost = tb('place_unit', null);
  assert(!ghost.includes('ring-2 ring-cyan-400/50'),
    'T7e. place_unit with null unit highlights no card (dead-state made visible-safe)');

  // Backlog #1: the seed/no-seed placement toggle only exists while actually
  // placing a CAS basin, and its OFF state advertises the haul-in savings.
  assert(!ghost.includes('Seed sludge'),
    'T7f. No seed toggle when no build unit is selected');
  const tbCas = (seeded: boolean) => renderToStaticMarkup(
    React.createElement(BuildToolbar, {
      toolMode: 'place_unit' as ToolMode,
      onSetToolMode: noop,
      selectedUnitTypeId: 'activated_sludge_cas',
      onSelectUnitTypeId: noop,
      currentRotation: 0,
      onRotate: noop,
      techTree: L1.techTree,
      playerCash: L1.financials.cash,
      isSandbox: true,
      availableUnitIds: ['activated_sludge_cas'],
      placeSeeded: seeded,
      onTogglePlaceSeeded: noop,
    })
  );
  assert(tbCas(true).includes('Seed sludge: On'),
    'T7g. CAS placement shows the seed toggle ON by default');
  assert(tbCas(false).includes('Unseeded') && tbCas(false).includes('$'),
    'T7h. Seed OFF advertises the unseeded discount');

  // ── T8: OperatorConsole + PFD compliance truthfulness ──
  const gs = structuredClone(L1) as typeof L1;
  gs.finalEffluent = { ...goodEffluent(), pathogens: 12000 };
  gs.overallStats.complianceScore = 55;
  const oc = renderToStaticMarkup(
    React.createElement(OperatorConsole, { gameState: gs, onClose: noop, onApplyFix: noop })
  );
  assert(oc.includes('Turbidity'), 'T8a. Operator Console lists Turbidity row');
  assert(oc.includes('pH'), 'T8b. Operator Console lists pH row');
  assert(oc.includes('FAIL'), 'T8c. Failing pathogen sample shows FAIL in the report');
  assert(!oc.includes('/ 1 CFU'), 'T8d. Pathogen limit never faked up to 1 CFU');
  assert(oc.split('FAIL').length >= 2, 'T8e. At least one explicit FAIL badge rendered');

  const pfd = renderToStaticMarkup(
    React.createElement(PlantFlowDiagram, { gameState: gs, onClose: noop })
  );
  assert(pfd.includes('Turbidity') && pfd.includes('pH'),
    'T8f. PFD regulatory table includes Turbidity and pH rows');
  assert(pfd.includes('FAIL'), 'T8g. PFD shows FAIL for actual violations (no all-PASS lie)');
  assert(pfd.includes('parameters passing'), 'T8h. PFD shows pass-count summary');

  // ── T9: PFD no-flow/disconnected rendering ──
  const gsDry = structuredClone(L1) as typeof L1;
  gsDry.pipes = [];
  const pfdDry = renderToStaticMarkup(
    React.createElement(PlantFlowDiagram, { gameState: gsDry, onClose: noop })
  );
  assert(pfdDry.includes('No active treatment train yet'),
    'T9a. Empty topology explains there is no active train');
  assert(pfdDry.includes('Unconnected / Auxiliary Units'),
    'T9b. Disconnected units get their own section');
  assert(pfdDry.includes('No treated outfall flow'),
    'T9c. Zero outfall flow is disclosed next to the standards table');
  assert(pfdDry.includes('—'),
    'T9d. Missing outlet data renders as "—", never a fabricated 0 mg/L');
  assert(!pfdDry.includes('.toFixed(1) || 0'), 'T9e. Old fake-zero expression pattern absent');

  // ── T10: UnitInspector component status + HUD chip ──
  const dryUnit = mkUnit('dry', 'pump_station');
  const inspDry = renderToStaticMarkup(
    React.createElement(UnitInspector, {
      unit: dryUnit, onClose: noop, onUpdateParams: noop, onDemolish: noop,
    })
  );
  assert(inspDry.includes('No Flow'), 'T10a. Inspector shows No Flow for a dry unit');
  const hudDry = renderToStaticMarkup(
    React.createElement(HeaderHUD, {
      gameState: (() => { const g = structuredClone(L1) as typeof L1; g.finalEffluent = emptyWater(); return g; })(),
      onSetSpeed: noop, onOpenLevelModal: noop, onOpenTechTree: noop,
      onOpenPFD: noop, onOpenSandboxControls: noop, onOpenOperator: noop,
      onToggleTopDown: noop, isTopDown: false,
    })
  );
  assert(hudDry.includes('NO OUTFALL FLOW'),
    'T10b. HUD chip refuses "WATER CLEAN" when nothing reaches the outfall');

  // ── T11: TechTree insufficient-cash wording in markup ──
  const tree = JSON.parse(JSON.stringify(L1.techTree));
  const firstLocked = tree.find((n: any) => !n.unlocked);
  if (firstLocked) {
    const tt = renderToStaticMarkup(
      React.createElement(TechTreeModal, {
        techTree: tree, playerCash: 0, isSandbox: false,
        onUnlockTech: (_id: string) => {}, onClose: noop,
      })
    );
    assert(!tt.includes('Prerequisites Locked'),
      'T11a. Blanket "Prerequisites Locked" wording removed');
    const reason = techBlockReason(firstLocked, tree, 0, false);
    assert(reason.length > 0 && tt.includes(reason.replace('$', '\\$') ? reason : reason),
      `T11b. Rendered modal shows the concrete blocker ("${reason}")`);
  }

  // ── T12: zero-pathogen display end-to-end ──
  const gsZero = structuredClone(L1) as typeof L1;
  gsZero.currentLevel.standards.maxPathogens = 0;
  gsZero.finalEffluent = { ...goodEffluent(), pathogens: 30 };
  const pfdZero = renderToStaticMarkup(
    React.createElement(PlantFlowDiagram, { gameState: gsZero, onClose: noop })
  );
  assert(pfdZero.includes('≤ 0'), 'T12a. PFD renders the true-zero limit as ≤ 0');
  assert(pfdZero.includes('FAIL'), 'T12b. 30 CFU against a 0 limit shows FAIL');
}

console.log('');
if (failures === 0) console.log(`ALL UI TESTS PASSED (${passes})`);
else { console.error(`${failures} UI TEST(S) FAILED (${passes} passed)`); process.exit(1); }
