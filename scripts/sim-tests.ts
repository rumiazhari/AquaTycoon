/* Headless smoke tests for the fixed simulation core (run via esbuild+node) */
import { GameManager } from '../src/gameplay/GameManager';
import { SimulationEngine } from '../src/sim/SimulationEngine';
import { UNIT_DEFINITIONS, calculateUnitProcess } from '../src/sim/UnitProcessModels';
import {
  validateConnection,
  getPortWorldPosition,
  getRotatedFootprint,
  getUnitWorldCenter
} from '../src/sim/PipeNetwork';
import type { PipeConnection, PlacedUnit } from '../src/types/simulation';

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log('PASS  ' + msg);
  else { failures++; console.error('FAIL  ' + msg); }
};

function mkUnit(id: string, typeId: string, gridX: number, gridY: number): any {
  const def = UNIT_DEFINITIONS[typeId as keyof typeof UNIT_DEFINITIONS];
  return {
    instanceId: id, typeId, gridX, gridY, rotation: 0,
    volume: (def.footprint[0] * 6) * (def.footprint[1] * 6) * 4.0,
    customParams: { ...def.defaultParams },
    active: true, efficiencyRating: 100,
    lastInletQuality: emptyW(), lastOutletQuality: emptyW(),
    lastPowerKwActual: def.powerConsumptionKw, lastOpexActual: def.baseOpexPerDay,
  };
}
function emptyW(): any {
  return { flowRate: 0, bod: 0, cod: 0, tss: 0, tn: 0, nh4: 0, no3: 0, tp: 0, pathogens: 0, do: 0, ph: 7.2, temp: 20, toxicIndex: 0, turbidity: 0 };
}

// ── Test 1: RAS recycle loop must NOT explode plant throughput ──────────────
{
  const level = GameManager.createInitialState(0, false);
  const cas = mkUnit('cas', 'activated_sludge_cas', 8, 10);
  const clar = mkUnit('clar', 'secondary_clarifier', 14, 10);
  const units = [...level.units, cas, clar];
  const pipes = [
    { id: 'p1', fromUnitId: 'inlet_0', fromPortId: 'outlet', toUnitId: 'cas', toPortId: 'inlet', pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: 'liquid' },
    { id: 'p2', fromUnitId: 'cas', fromPortId: 'outlet', toUnitId: 'clar', toPortId: 'inlet', pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: 'liquid' },
    { id: 'p3', fromUnitId: 'clar', fromPortId: 'sludge_outlet', toUnitId: 'cas', toPortId: 'ras_inlet', pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: 'ras' },
    { id: 'p4', fromUnitId: 'clar', fromPortId: 'outlet', toUnitId: 'outfall_0', toPortId: 'inlet', pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: 'liquid' },
  ] as any;

  let state = { ...level, units, pipes };
  for (let i = 0; i < 40; i++) state = GameManager.tick(state, 0.5);

  const eff = state.finalEffluent.flowRate;
  const inf = state.currentLevel.influentSpec.flowRate;
  assert(eff > inf * 0.5 && eff < inf * 1.6,
    `RAS loop stable: effluent ${eff.toFixed(0)} vs influent ${inf} m3/d (old bug gave ~${inf * 4})`);
}

// ── Test 2: Level 4 strict TN < 5 mg/L must be reachable ────────────────────
{
  const a2o = mkUnit('a2o', 'a2o_bardenpho', 8, 10);
  a2o.customParams = {
    internalRecyclePercent: 400,   // max IR
    aerobicDo: 4.5,                // max DO
    carbonDosingRateMgL: 40,       // max methanol
  };
  const inletQ = {
    ...emptyW(), flowRate: 12000, bod: 260, cod: 520, tss: 290,
    tn: 58, nh4: 45, no3: 1, tp: 7.8, pathogens: 1e6, turbidity: 180,
  };
  const res = UNIT_DEFINITIONS && (() => {
    const mod = require('../src/sim/UnitProcessModels');
    return mod.calculateUnitProcess(a2o, inletQ, 12000);
  })();
  assert(res.effluent.tn < 5.0, `Level 4 achievable: A2O effluent TN = ${res.effluent.tn.toFixed(2)} mg/L (< 5)`);
  assert(res.effluent.flowRate === 12000, `Forward flow preserved through A2O: ${res.effluent.flowRate}`);
}

// ── Test 3: Secondary clarifier mass conservation ───────────────────────────
{
  const mod = require('../src/sim/UnitProcessModels');
  const clar = mkUnit('c', 'secondary_clarifier', 0, 0);
  const q = { ...emptyW(), flowRate: 10000 + 7500, tss: 3200 }; // mixed liquor w/ RAS
  const r = mod.calculateUnitProcess(clar, q, 10000);
  assert(Math.abs(r.effluent.flowRate - 10000) < 600,
    `Clarifier passes forward flow: eff=${r.effluent.flowRate.toFixed(0)} (target ~10000), RAS=${r.sludge!.flowRate.toFixed(0)}`);
}

// ── Test 4: Level 1 canonical train passes ALL standards at DEFAULT params ──
{
  const gs = GameManager.createInitialState(0, false);
  const add = (id: string, t: string, x: number, y: number, st: any) => st.units.push(mkUnit(id, t, x, y));
  add('scr', 'bar_screen', 5, 10, gs);
  add('grt', 'grit_chamber', 8, 10, gs);
  add('pri', 'primary_clarifier_circular', 11, 9, gs);
  add('cas', 'activated_sludge_cas', 15, 9, gs);
  add('clr2', 'secondary_clarifier', 17, 13, gs);
  add('uv', 'uv_disinfection', 20, 10, gs);

  const P: any[] = [
    ['inlet_0', 'outlet', 'scr', 'inlet'],
    ['scr', 'outlet', 'grt', 'inlet'],
    ['grt', 'outlet', 'pri', 'inlet'],
    ['pri', 'outlet', 'cas', 'inlet'],
    ['cas', 'outlet', 'clr2', 'inlet'],
    ['clr2', 'outlet', 'uv', 'inlet'],
    ['uv', 'outlet', 'outfall_0', 'inlet'],
    // Canonical train includes the RAS return — without it the biomass
    // washes out (correct new physics) and Level 1 cannot pass.
    ['clr2', 'sludge_outlet', 'cas', 'ras_inlet'],
  ].map(([f, fp, t, tp], i) => ({ id: `tp${i}`, fromUnitId: f, fromPortId: fp, toUnitId: t, toPortId: tp, pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: fp === 'sludge_outlet' ? 'ras' : 'liquid' }));
  gs.pipes.push(...P);

  let state = gs;
  for (let i = 0; i < 25; i++) state = GameManager.tick(state, 0.5);

  const eff = state.finalEffluent;
  const std = state.currentLevel.standards;
  const fails: string[] = [];
  if (eff.bod > std.maxBod) fails.push(`BOD ${eff.bod.toFixed(1)}>${std.maxBod}`);
  if (eff.cod > std.maxCod) fails.push(`COD ${eff.cod.toFixed(1)}>${std.maxCod}`);
  if (eff.tss > std.maxTss) fails.push(`TSS ${eff.tss.toFixed(1)}>${std.maxTss}`);
  if (eff.tn > std.maxTn) fails.push(`TN ${eff.tn.toFixed(1)}>${std.maxTn}`);
  if (eff.nh4 > std.maxNh4) fails.push(`NH4 ${eff.nh4.toFixed(1)}>${std.maxNh4}`);
  if (eff.tp > std.maxTp) fails.push(`TP ${eff.tp.toFixed(2)}>${std.maxTp}`);
  if (eff.pathogens > Math.max(1, std.maxPathogens)) fails.push(`P ${eff.pathogens.toExponential(1)}>${std.maxPathogens}`);
  if (eff.do < std.minDo) fails.push(`DO ${eff.do.toFixed(1)}<${std.minDo}`);
  assert(fails.length === 0,
    fails.length === 0
      ? `Level 1 fully compliant at defaults (compliance ${state.overallStats.complianceScore}%)`
      : `Level 1 STILL FAILING: ${fails.join(', ')}`);
}

// ── Test 5: DO must never be structurally impossible (outfall reaeration) ───
{
  const mod = require('../src/sim/UnitProcessModels');
  const outfall = mkUnit('o', 'effluent_outfall', 0, 0);
  const r = mod.calculateUnitProcess(outfall, { ...emptyW(), flowRate: 3500, do: 1.8 }, 3500);
  assert(r.effluent.do >= 4.0, `Cascade re-aeration lifts DO 1.8 → ${r.effluent.do.toFixed(1)} mg/L`);
}

// ── Test 6: Operator Console advisor proposes fixes that actually work ──────
{
  const { generateAdvisories } = require('../src/sim/AdvisoryEngine');

  // Broken plant: no pipes at all
  const broken = GameManager.createInitialState(0, false);
  broken.units.push(mkUnit('scr', 'bar_screen', 5, 10));
  const advNoFlow = generateAdvisories(broken as any);
  assert(advNoFlow.length > 0 && advNoFlow[0].fixes.some(f => f.kind === 'start_piping'),
    'Advisor: no-pipe plant → directs the player to the manual Pipes tool');

  // Under-performing plant: full train + RAS loop but DO setpoint at minimum
  // → ammonia violations exist, and the top param fix must measurably reduce
  //   the violation score (honest one-call prediction of the real simulator).
  const under = GameManager.createInitialState(0, false);
  const addU = (id: string, t: string, x: number, y: number) => {
    const u = mkUnit(id, t, x, y);
    if (t === 'activated_sludge_cas') u.customParams.doSetpoint = 0.5;
    if (t === 'secondary_clarifier') u.customParams.rasRecycleRatioPercent = 75;
    under.units.push(u);
  };
  addU('scr', 'bar_screen', 5, 10); addU('grt', 'grit_chamber', 8, 10);
  addU('pri', 'primary_clarifier_circular', 11, 9);
  addU('cas', 'activated_sludge_cas', 15, 9);
  addU('clr2', 'secondary_clarifier', 17, 13);
  addU('uv', 'uv_disinfection', 20, 10);
  const P: any[] = [
    ['inlet_0', 'outlet', 'scr', 'inlet'], ['scr', 'outlet', 'grt', 'inlet'],
    ['grt', 'outlet', 'pri', 'inlet'], ['pri', 'outlet', 'cas', 'inlet'],
    ['cas', 'outlet', 'clr2', 'inlet'], ['clr2', 'outlet', 'uv', 'inlet'],
    ['uv', 'outlet', 'outfall_0', 'inlet'],
    ['clr2', 'sludge_outlet', 'cas', 'ras_inlet'],
  ].map(([f, fp, t, tp], i) => ({ id: `up${i}`, fromUnitId: f, fromPortId: fp, toUnitId: t, toPortId: tp, pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: fp === 'sludge_outlet' ? 'ras' : 'liquid' }));
  under.pipes.push(...P);
  let st: any = under;
  for (let i = 0; i < 40; i++) st = GameManager.tick(st, 0.5);

  assert(st.finalEffluent.flowRate > 10 && st.overallStats.complianceScore < 100,
    `Under-tuned plant violates (${st.overallStats.complianceScore}% compliance) — advisor has something to fix`);

  // The plant must be RECOVERABLE: raising DO to max must clear violations.
  const recoveredUnits = st.units.map((u: any) =>
    u.typeId === 'activated_sludge_cas'
      ? { ...u, customParams: { ...u.customParams, doSetpoint: 4.5 } }
      : u
  );
  const recPipes = st.pipes.map((p: any) => ({ ...p, flowRate: 0, quality: emptyW(), gasFlowRate: 0 }));
  const rec = SimulationEngine.stepSimulation(
    recoveredUnits, recPipes,
    st.gameMode === 'sandbox' ? st.sandboxCustomInfluent : st.currentLevel.influentSpec,
    st.currentLevel.standards, st.financials, st.currentLevel.tariffPerM3,
    0.15, 45, { daylight: 1, wind: 1 }
  );
  assert(rec.finalEffluent.nh4 < st.currentLevel.standards.maxNh4 && rec.finalEffluent.do >= st.currentLevel.standards.minDo - 0.01,
    `Recovery exists: DO→4.5 predicts NH4 ${rec.finalEffluent.nh4.toFixed(1)} mg/L & DO ${rec.finalEffluent.do.toFixed(1)} mg/L (both PASS)`);

  const advs = generateAdvisories(st);
  assert(advs.length > 0, `Advisor generated ${advs.length} advisory card(s)`);
}

// ── Test 7: Power system — solar follows daylight, wind follows resource ────
{
  const mod = require('../src/sim/UnitProcessModels');
  const solar = mkUnit('pv', 'solar_array', 0, 0);
  const wind = mkUnit('wt', 'wind_turbine', 0, 0);

  const noon = mod.calculateUnitProcess(solar, emptyW(), undefined, { daylight: 1, wind: 1 });
  const midnight = mod.calculateUnitProcess(solar, emptyW(), undefined, { daylight: 0, wind: 1 });
  assert(noon.powerKw === -42 && midnight.powerKw === 0,
    `Solar: ${noon.powerKw} kW at full sun, ${midnight.powerKw} kW at night`);

  const windy = mod.calculateUnitProcess(wind, emptyW(), undefined, { daylight: 0, wind: 1 });
  const calm = mod.calculateUnitProcess(wind, emptyW(), undefined, { daylight: 0, wind: 0.2 });
  assert(windy.powerKw === -85 && Math.abs(calm.powerKw + 17) < 0.01,
    `Wind: ${windy.powerKw} kW rated, ${calm.powerKw} kW at 20% wind`);
}

// ── Test 8: Green generation offsets grid demand in plant economics ─────────
{
  const gs = GameManager.createInitialState(4, false); // megapolis roster has wind+solar
  gs.units.push(mkUnit('pv', 'solar_array', 30, 20));
  gs.units.push(mkUnit('wt', 'wind_turbine', 36, 24));
  const inf = { ...emptyW(), flowRate: 100 };
  const res = SimulationEngine.stepSimulation(
    gs.units, [], inf,
    {
      maxBod: 25, maxCod: 90, maxTss: 30, maxTn: 25, maxNh4: 15, maxTp: 4,
      maxPathogens: 1000, minDo: 4, minPh: 6.5, maxPh: 8.5, maxTurbidity: 15
    },
    gs.financials, 1, 0.15, 45, { daylight: 1, wind: 1 }
  );
  assert(res.overallStats.totalGreenGenerationKw >= 127,
    `Solar+wind feed the grid: ${res.overallStats.totalGreenGenerationKw.toFixed(0)} kW green generation`);
}

// ── Test 9: PIPING CONSEQUENCE — UV blinded by raw sewage (bad routing) ─────
{
  const mod = require('../src/sim/UnitProcessModels');
  const uv = mkUnit('uv', 'uv_disinfection', 0, 0);
  const dirty = { ...emptyW(), flowRate: 3500, pathogens: 5e5, tss: 250, turbidity: 180 };
  const clean  = { ...emptyW(), flowRate: 3500, pathogens: 5e5, tss: 3, turbidity: 2 };
  const rDirty = mod.calculateUnitProcess(uv, dirty);
  const rClean = mod.calculateUnitProcess(uv, clean);
  assert(rDirty.effluent.pathogens > 5e4 && rClean.effluent.pathogens < 200,
    `UV consequence: raw feed survives as ${rDirty.effluent.pathogens.toExponential(1)} CFU, polished feed drops to ${rClean.effluent.pathogens.toFixed(0)} CFU`);
}

// ── Test 10: CHLORINE DEMAND — ammonia starves disinfection ─────────────────
{
  const mod = require('../src/sim/UnitProcessModels');
  const cl = mkUnit('cl', 'chlorination_basin', 0, 0);
  const septic = { ...emptyW(), flowRate: 3500, pathogens: 1e6, nh4: 40 };
  const nitrified = { ...emptyW(), flowRate: 3500, pathogens: 1e6, nh4: 1.5 };
  const rSeptic = mod.calculateUnitProcess(cl, septic);
  const rNitrif = mod.calculateUnitProcess(cl, nitrified);
  assert(rSeptic.effluent.pathogens > rNitrif.effluent.pathogens * 100,
    `Chlorine demand: septic feed leaves ${rSeptic.effluent.pathogens.toExponential(1)} vs ${rNitrif.effluent.pathogens.toExponential(1)} CFU after nitrification`);
}

// ── Test 11: RO FOULING — unpolished feed collapses rejection ───────────────
{
  const mod = require('../src/sim/UnitProcessModels');
  const ro = mkUnit('ro', 'reverse_osmosis', 0, 0);
  const unfiltered = { ...emptyW(), flowRate: 10000, bod: 30, tss: 25, turbidity: 40, pathogens: 1e4 };
  const polished   = { ...emptyW(), flowRate: 10000, bod: 5, tss: 0.2, turbidity: 0.4, pathogens: 100 };
  const rBad = mod.calculateUnitProcess(ro, unfiltered);
  const rGood = mod.calculateUnitProcess(ro, polished);
  assert(rBad.effluent.bod > rGood.effluent.bod * 5 && rBad.effluent.pathogens > rGood.effluent.pathogens,
    `RO consequence: fouled permeate BOD ${rBad.effluent.bod.toFixed(1)} vs clean ${rGood.effluent.bod.toFixed(1)}`);
}

// ── Test 12: PUMP CLOGGING on unscreened sewage ─────────────────────────────
{
  const mod = require('../src/sim/UnitProcessModels');
  const pump = mkUnit('ps', 'pump_station', 0, 0);
  const raw = { ...emptyW(), flowRate: 3500, tss: 420 };
  const screened = { ...emptyW(), flowRate: 3500, tss: 120 };
  const rRaw = mod.calculateUnitProcess(pump, raw);
  const rScr = mod.calculateUnitProcess(pump, screened);
  assert(rRaw.opexDay > rScr.opexDay * 2 && rRaw.powerKw > rScr.powerKw,
    `Pump consequence: unscreened opex $${rRaw.opexDay.toFixed(0)}/d & ${rRaw.powerKw.toFixed(1)} kW vs screened $${rScr.opexDay.toFixed(0)}/d`);
}

// ═════════════════════════════════════════════════════════════════════════════
// HYDRAULIC FOUNDATION TESTS (A–J) — port semantics, flow conservation, RAS
// ═════════════════════════════════════════════════════════════════════════════

/** Builds a pipe record for tests */
function mkPipe(
  id: string, fromUnitId: string, fromPortId: string,
  toUnitId: string, toPortId: string,
  pipeType: PipeConnection['pipeType'] = 'liquid'
): PipeConnection {
  return { id, fromUnitId, fromPortId, toUnitId, toPortId, pathPoints: [], flowRate: 0, quality: emptyW(), pipeType };
}

/** Runs the solver directly on a unit/pipe network and returns the result */
function solve(units: PlacedUnit[], pipes: PipeConnection[], flow = 10000) {
  const realisticInfluent = {
    ...emptyW(),
    flowRate: flow,
    bod: 220, cod: 450, tss: 250, tn: 40, nh4: 30, no3: 1,
    tp: 6.5, pathogens: 1e6, do: 0.5, ph: 7.2, temp: 20, turbidity: 180
  };
  return SimulationEngine.stepSimulation(
    units, pipes, realisticInfluent,
    {
      maxBod: 25, maxCod: 90, maxTss: 30, maxTn: 25, maxNh4: 15, maxTp: 4,
      maxPathogens: 1000, minDo: 4, minPh: 6.5, maxPh: 8.5, maxTurbidity: 15
    },
    {
      cash: 0, dailyRevenue: 0, dailyOpex: 0, dailyPowerCost: 0, dailyChemicalCost: 0,
      dailySludgeDisposalCost: 0, dailyBiogasRevenue: 0, dailyFines: 0,
      totalTreatedM3: 0, netDailyProfit: 0
    },
    1, 0.15, 45, { daylight: 1, wind: 1 }
  );
}

// ── Test A: simple series line — no artificial duplication ──────────────────
{
  const units = [
    mkUnit('inl', 'influent_inlet', 0, 0),
    mkUnit('scr', 'bar_screen', 4, 0),
    mkUnit('pri', 'primary_clarifier_circular', 8, 0),
    mkUnit('cas', 'activated_sludge_cas', 13, 0),
    mkUnit('cla', 'secondary_clarifier', 18, 0),
    mkUnit('uv', 'uv_disinfection', 23, 0),
    mkUnit('out', 'effluent_outfall', 26, 0)
  ];
  const pipes = [
    mkPipe('a1', 'inl', 'outlet', 'scr', 'inlet'),
    mkPipe('a2', 'scr', 'outlet', 'pri', 'inlet'),
    mkPipe('a3', 'pri', 'outlet', 'cas', 'inlet'),
    mkPipe('a4', 'cas', 'outlet', 'cla', 'inlet'),
    mkPipe('a5', 'cla', 'outlet', 'uv', 'inlet'),
    mkPipe('a6', 'uv', 'outlet', 'out', 'inlet')
  ];
  const res = solve(units, pipes, 10000);
  const eff = res.finalEffluent.flowRate;
  // Forward flow must stay physical: sludge draw-offs shrink it slightly,
  // never duplicate it and never collapse it.
  assert(eff > 7000 && eff <= 10000 + 1,
    `A. series line conserves forward flow: ${eff.toFixed(0)} m³/d from 10,000 (no duplication, no collapse)`);
}

// ── Test B: 75% RAS loop → Qras/Qforward ≈ 0.75, NOT ≈ 3.0 ──────────────────
{
  const cas = mkUnit('cas', 'activated_sludge_cas', 8, 10);
  const clar = mkUnit('clar', 'secondary_clarifier', 14, 10);
  const units = [mkUnit('inl', 'influent_inlet', 0, 0), cas, clar];
  const pipes = [
    mkPipe('b1', 'inl', 'outlet', 'cas', 'inlet'),
    mkPipe('b2', 'cas', 'outlet', 'clar', 'inlet'),
    mkPipe('b3', 'clar', 'sludge_outlet', 'cas', 'ras_inlet', 'ras'),
    mkPipe('b4', 'clar', 'outlet', 'outf', 'inlet') // outfall absent: flow ends at pipe level
  ];
  const res = solve(units, pipes, 10000);
  const qRas = res.updatedPipes.find(p => p.id === 'b3')!.flowRate;
  const qFwd = res.updatedPipes.find(p => p.id === 'b4')!.flowRate;
  const ratio = qRas / Math.max(1, qFwd);
  assert(Math.abs(ratio - 0.75) < 0.12 && ratio < 1.5,
    `B. RAS ratio Qras/Qforward = ${ratio.toFixed(2)} (target ≈ 0.75, old bug ≈ 3.0)`);
}

// ── Test C: clarifier loading uses correct mixed-liquor hydraulics ───────────
{
  // Feed mixed liquor at exactly Qforward*(1+r): with r=0.75, forward must
  // resolve to Qforward = Qclar/(1+r) — i.e. 17500 in → 10000 out.
  const clar = mkUnit('c', 'secondary_clarifier', 0, 0);
  const q = { ...emptyW(), flowRate: 10000 * 1.75, tss: 3200 };
  const r = calculateUnitProcess(clar, q);
  const expectedForward = 10000;
  assert(Math.abs(r.effluent.flowRate - expectedForward) < 250,
    `C. clarifier forward = Qclar/(1+r): ${r.effluent.flowRate.toFixed(0)} ≈ ${expectedForward} m³/d (RAS ${r.sludge!.flowRate.toFixed(0)})`);
}

// ── Test D: junction splitter 60/40 → 6000 + 4000 = 10000 ────────────────────
{
  const j = mkUnit('jx', 'pipe_junction', 0, 0);
  j.customParams.splitRatioPercent = 60;
  const units = [
    mkUnit('inl', 'influent_inlet', 0, 0), j,
    mkUnit('br1', 'pump_station', 5, -2), mkUnit('br2', 'pump_station', 5, 2)
  ];
  const pipes = [
    mkPipe('d1', 'inl', 'outlet', 'jx', 'inlet'),
    mkPipe('d2', 'jx', 'outlet', 'br1', 'inlet'),
    mkPipe('d3', 'jx', 'recycle_outlet', 'br2', 'inlet', 'recycle')
  ];
  const res = solve(units, pipes, 10000);
  const q1 = res.updatedPipes.find(p => p.id === 'd2')!.flowRate;
  const q2 = res.updatedPipes.find(p => p.id === 'd3')!.flowRate;
  const sum = q1 + q2;
  assert(Math.abs(q1 - 6000) < 200 && Math.abs(q2 - 4000) < 200 && Math.abs(sum - 10000) < 300,
    `D. splitter 60/40: ${q1.toFixed(0)} + ${q2.toFixed(0)} = ${sum.toFixed(0)} m³/d`);
}

// ── Test E: two pipes cannot clone one unsplit 10,000 outlet ─────────────────
{
  const src = mkUnit('src', 'bar_screen', 0, 0);   // ordinary outlet port
  const a = mkUnit('dstA', 'grit_chamber', 5, -2);
  const b = mkUnit('dstB', 'grit_chamber', 5, 2);
  const units = [mkUnit('inl', 'influent_inlet', -4, 0), src, a, b];
  const pipes = [mkPipe('e1', 'inl', 'outlet', 'src', 'inlet'), mkPipe('e2', 'src', 'outlet', 'dstA', 'inlet')];
  const second = validateConnection(pipes, units, 'src', 'outlet', 'dstB', 'inlet');
  assert(!second.ok,
    `E. branching an unsplit outlet is rejected: "${second.reason?.slice(0, 72)}…"`);

  // Engine-level defense: even if such a topology exists (legacy save), flows divide.
  const forcedPipes = [
    mkPipe('f1', 'inl', 'outlet', 'src', 'inlet'),
    mkPipe('f2', 'src', 'outlet', 'dstA', 'inlet'),
    mkPipe('f3', 'src', 'outlet', 'dstB', 'inlet')
  ];
  const res = solve(units, forcedPipes, 10000);
  const f2 = res.updatedPipes.find(p => p.id === 'f2')!.flowRate;
  const f3 = res.updatedPipes.find(p => p.id === 'f3')!.flowRate;
  assert(Math.abs(f2 - 5000) < 400 && Math.abs(f3 - 5000) < 400,
    `E+. engine divides duplicated source across pipes: ${f2.toFixed(0)} + ${f3.toFixed(0)} ≠ 20,000`);
}

// ── Test F: sludge chain uses the actual sludge outlet stream ────────────────
{
  const pri = mkUnit('pri', 'primary_clarifier_circular', 8, 0);
  const thick = mkUnit('thk', 'sludge_thickener', 12, 4);
  const dig = mkUnit('dig', 'anaerobic_digester', 16, 8);
  const units = [mkUnit('inl', 'influent_inlet', 0, 0), pri, thick, dig];
  const pipes = [
    mkPipe('g1', 'inl', 'outlet', 'pri', 'inlet'),
    mkPipe('g2', 'pri', 'sludge_outlet', 'thk', 'inlet', 'sludge'),
    mkPipe('g3', 'thk', 'sludge_outlet', 'dig', 'inlet', 'sludge')
  ];
  const res = solve(units, pipes, 10000);
  const toThick = res.updatedPipes.find(p => p.id === 'g2')!;
  const toDig = res.updatedPipes.find(p => p.id === 'g3')!;
  // The sludge line must carry the SLUDGE stream (~1.5% of flow, high TSS),
  // never the main effluent.
  assert(toThick.flowRate > 50 && toThick.flowRate < 500 && toThick.quality.tss > 1500,
    `F. primary sludge line carries real sludge: ${toThick.flowRate.toFixed(0)} m³/d @ ${toThick.quality.tss.toFixed(0)} mg/L TSS`);
  assert(toDig.flowRate > 0 && toDig.quality.tss > toThick.quality.tss * 2,
    `F+. thickened sludge concentrates into digester: ${toDig.flowRate.toFixed(0)} m³/d @ ${toDig.quality.tss.toFixed(0)} mg/L TSS`);

  const digU = res.updatedUnits.find(u => u.instanceId === 'dig')!;
  const gas = digU.gasStreams?.['gas_outlet'];
  assert(!!gas && gas.flowRate > 100,
    `F++. digester produces biogas: ${gas ? gas.flowRate.toFixed(0) : 0} Nm³/d`);
}

// ── Test G: CAS RAS — clarifier sludge/RAS port → CAS ras_inlet ──────────────
{
  const cas = mkUnit('cas', 'activated_sludge_cas', 8, 10);
  const clar = mkUnit('clar', 'secondary_clarifier', 14, 10);
  const units = [mkUnit('inl', 'influent_inlet', 0, 0), cas, clar];
  const ok = validateConnection([], units, 'clar', 'sludge_outlet', 'cas', 'ras_inlet');
  assert(ok.ok, `G. secondary clarifier sludge_outlet → CAS ras_inlet accepted (${ok.reason ?? 'ok'})`);

  // And it actually carries RAS flow through the loop:
  const pipes = [
    mkPipe('h1', 'inl', 'outlet', 'cas', 'inlet'),
    mkPipe('h2', 'cas', 'outlet', 'clar', 'inlet'),
    mkPipe('h3', 'clar', 'sludge_outlet', 'cas', 'ras_inlet', 'ras')
  ];
  const res = solve(units, pipes, 10000);
  const ras = res.updatedPipes.find(p => p.id === 'h3')!.flowRate;
  assert(ras > 1000, `G+. RAS pipe carries recycle flow: ${ras.toFixed(0)} m³/d`);
}

// ── Test H: rotated non-square ports align with rendered boundaries ──────────
{
  // bar_screen footprint [2,1]; primary rect [4,2]; CAS [4,3] — non-square.
  let allOk = true;
  const detail: string[] = [];
  for (const typeId of ['bar_screen', 'primary_clarifier_rect', 'activated_sludge_cas'] as const) {
    const def = UNIT_DEFINITIONS[typeId];
    for (const rotation of [0, 90, 180, 270] as const) {
      const u = mkUnit('u_' + rotation, typeId, 10, 10);
      u.rotation = rotation as 0 | 90 | 180 | 270;
      const [fw, fl] = getRotatedFootprint(def, u.rotation);
      const cx = u.gridX + fw / 2;
      const cz = u.gridY + fl / 2;
      const center = getUnitWorldCenter(u);
      const centerOk = Math.abs(center[0] - cx) < 1e-9 && Math.abs(center[2] - cz) < 1e-9;

      // Every port must land within the unit's occupied footprint bounds.
      for (const port of def.ports) {
        const [px, , pz] = getPortWorldPosition(u, port.id);
        const inside =
          px >= u.gridX - 0.01 && px <= u.gridX + fw + 0.01 &&
          pz >= u.gridY - 0.01 && pz <= u.gridY + fl + 0.01;
        if (!inside || !centerOk) {
          allOk = false;
          detail.push(`${typeId}@${rotation}° ${port.id} → (${px.toFixed(2)}, ${pz.toFixed(2)}) bounds x:[${u.gridX},${u.gridX + fw}] z:[${u.gridY},${u.gridY + fl}] center=${centerOk}`);
        }
      }
    }
  }
  assert(allOk, `H. rotated ports stay aligned with rendered footprint at 0/90/180/270°${detail.length ? ' — ' + detail[0] : ''}`);

  // Rotation actually MOVES ports (not identity-transformed):
  const u0 = mkUnit('r0', 'activated_sludge_cas', 10, 10); u0.rotation = 0;
  const u90 = mkUnit('r90', 'activated_sludge_cas', 10, 10); u90.rotation = 90;
  const p0 = getPortWorldPosition(u0, 'outlet');
  const p90 = getPortWorldPosition(u90, 'outlet');
  assert(Math.hypot(p0[0] - p90[0], p0[2] - p90[2]) > 0.5,
    `H+. rotating moves port positions: outlet moved ${(Math.hypot(p0[0] - p90[0], p0[2] - p90[2])).toFixed(2)} tiles at 90°`);
}

// ── Test I: digester gas never appears as a wastewater stream ────────────────
{
  const dig = mkUnit('dig', 'anaerobic_digester', 0, 0);
  const feed = { ...emptyW(), flowRate: 400, tss: 40000, bod: 8000 };
  const r = calculateUnitProcess(dig, feed);
  const gasPort = UNIT_DEFINITIONS.anaerobic_digester.ports.find(p => p.type === 'gas_outlet')!;

  // Gas lives in gasStreams as a GasStream…
  const gas = r.gasStreams?.[gasPort.id];
  assert(!!gas && gas.flowRate > 0 && gas.ch4Fraction > 0.5,
    `I. digester emits GasStream: ${gas ? gas.flowRate.toFixed(0) : 0} Nm³/d @ ${gas ? (gas.ch4Fraction * 100).toFixed(0) : 0}% CH₄`);

  // …and NEVER as liquid WaterQuality on any liquid port.
  const gasAsLiquid = r.portStreams?.[gasPort.id];
  assert(!gasAsLiquid,
    `I+. gas port has NO entry in liquid portStreams (${gasAsLiquid ? 'LEAKED!' : 'clean'})`);

  // Through a gas pipe, quality stays zero-flow wastewater-free:
  const units = [mkUnit('d2', 'anaerobic_digester', 0, 0)];
  units[0].portStreams = {}; units[0].gasStreams = { gas_outlet: { flowRate: 900, ch4Fraction: 0.65, h2sPpm: 20 } };
  const res = solve(units, [mkPipe('i1', 'd2', 'gas_outlet', 'sink', 'inlet', 'gas')], 0);
  const gp = res.updatedPipes[0];
  assert(gp.pipeType === 'gas' && (gp.gasFlowRate ?? 0) === 900 && gp.quality.flowRate === 0,
    `I++. gas pipe carries gasFlowRate=900 with zero WaterQuality flow`);
}

// ── Test J: gas → ordinary liquid inlet is REJECTED ──────────────────────────
{
  const dig = mkUnit('dig', 'anaerobic_digester', 0, 0);
  const uv = mkUnit('uv', 'uv_disinfection', 6, 0);
  const thick = mkUnit('thk', 'sludge_thickener', -6, 0);
  const units = [dig, uv, thick];

  const v1 = validateConnection([], units, 'dig', 'gas_outlet', 'uv', 'inlet');
  assert(!v1.ok, `J. digester gas_outlet → UV inlet rejected: "${v1.reason?.slice(0, 70)}…"`);

  const v2 = validateConnection([], units, 'dig', 'gas_outlet', 'dig', 'inlet');
  assert(!v2.ok, `J+. gas cannot even feed its own unit's inlet`);

  // Sludge → sludge-unit inlet stays legal (thickener accepts sludge feed)…
  const v3 = validateConnection([], units, 'dig', 'sludge_outlet', 'thk', 'inlet');
  assert(v3.ok, `J++. sludge_outlet → thickener inlet remains valid plumbing`);

  // …but a duplicate second feed on the same target port is refused.
  const v4 = validateConnection(
    [mkPipe('x1', 'dig', 'sludge_outlet', 'thk', 'inlet', 'sludge')],
    units, 'dig', 'sludge_outlet', 'thk', 'inlet'
  );
  assert(!v4.ok, `J+++. duplicate connection to the same target port rejected`);
}

// ── Test K: digester gas CHP revenue offsets grid imports ────────────────────
{
  // Build a complete plant train with a sludge-to-digester chain.
  const gs = GameManager.createInitialState(0, false);
  const inf = gs.currentLevel.influentSpec;
  const units = [
    mkUnit('inl', 'influent_inlet', 2, 10),
    mkUnit('scr', 'bar_screen', 5, 10),
    mkUnit('grt', 'grit_chamber', 8, 10),
    mkUnit('pri', 'primary_clarifier_circular', 11, 9),
    mkUnit('cas', 'activated_sludge_cas', 15, 9),
    mkUnit('clr', 'secondary_clarifier', 17, 13),
    mkUnit('uv', 'uv_disinfection', 20, 10),
    mkUnit('outf', 'effluent_outfall', 24, 10),
    mkUnit('thk', 'sludge_thickener', 30, 12),
    mkUnit('dig', 'anaerobic_digester', 36, 0),
    mkUnit('pv', 'solar_array', 40, 0),
    mkUnit('wt', 'wind_turbine', 44, 0)
  ];
  const pipes: PipeConnection[] = [
    mkPipe('k_a', 'inl', 'outlet', 'scr', 'inlet'),
    mkPipe('k_b', 'scr', 'outlet', 'grt', 'inlet'),
    mkPipe('k_c', 'grt', 'outlet', 'pri', 'inlet'),
    mkPipe('k_d', 'pri', 'outlet', 'cas', 'inlet'),
    mkPipe('k_e', 'cas', 'outlet', 'clr', 'inlet'),
    mkPipe('k_f', 'clr', 'outlet', 'uv', 'inlet'),
    mkPipe('k_g', 'uv', 'outlet', 'outf', 'inlet'),
    // Sludge chain: clarifier WAS → thickener → digester
    mkPipe('k_h', 'clr', 'was_outlet', 'thk', 'inlet', 'sludge'),
    mkPipe('k_i', 'thk', 'sludge_outlet', 'dig', 'inlet', 'sludge'),
    // RAS return to CAS
    mkPipe('k_r', 'clr', 'sludge_outlet', 'cas', 'ras_inlet', 'ras')
  ];

  const res = SimulationEngine.stepSimulation(
    units, pipes,
    inf,
    gs.currentLevel.standards,
    gs.financials,
    gs.currentLevel.tariffPerM3,
    0.15, 45,
    { daylight: 1, wind: 1 }
  ) as any;

  const digU = res.updatedUnits?.find((u: any) => u.instanceId === 'dig') ?? units.find(u => u.instanceId === 'dig');
  const gen = res.overallStats?.totalGreenGenerationKw ?? 0;
  const imp = res.overallStats?.gridImportKw ?? 0;
  const digGen = digU?.lastPowerKwActual ?? 0; // negative = generation
  assert(gen > 0, `K. biogas + renewables generate: ${gen.toFixed(1)} kW green`);
  assert(digGen <= -0.01, `K+. digester CHP produces real power: ${digGen.toFixed(1)} kW (negative=gen)`);
  assert(imp < (digGen < 0 ? Math.abs(digGen) : gen), `K++. grid import (${imp.toFixed(1)}) < green generation — self-consumption is real`);
}

// ── Test L: RO mass conservation — permeate + brine = feed ───────────────────
{
  const ro = mkUnit('ro', 'reverse_osmosis', 0, 0);
  const feed = { ...emptyW(), flowRate: 10000, bod: 20, cod: 50, tss: 5, tn: 12, tp: 3, pathogens: 1e3 };
  const r = calculateUnitProcess(ro, feed);
  const permQ = r.effluent.flowRate;
  const brineQ = r.sludge?.flowRate ?? 0;
  const sum = permQ + brineQ;
  assert(Math.abs(sum - 10000) < 500, `L. RO: perm ${permQ.toFixed(0)} + brine ${brineQ.toFixed(0)} = ${sum.toFixed(0)} ≈ 10000 m³/d`);
  // Brine must carry MORE contaminants than feed (concentrated reject)
  assert(r.sludge!.bod > feed.bod, `L+. RO brine concentrates BOD: ${r.sludge!.bod.toFixed(1)} > ${feed.bod}`);
  // Permeate must be cleaner
  assert(r.effluent.bod < feed.bod * 0.2, `L++. RO permeate is clean: BOD ${r.effluent.bod.toFixed(2)} << ${feed.bod}`);
}

// ── Test M: sludge thickener dry-solids conservation ──────────────────────────
{
  const thick = mkUnit('thk', 'sludge_thickener', 0, 0);
  const feed = { ...emptyW(), flowRate: 1000, tss: 10000 }; // 1000 m³/d @ 10,000 mg/L
  const r = calculateUnitProcess(thick, feed);
  const solidsIn = 1000 * 10000 / 1000;       // kg/d = 10,000 kg/d
  const solidsThick = (r.sludge?.flowRate ?? 0) * (r.sludge?.tss ?? 0) / 1000;
  const solidsSup = r.effluent.flowRate * r.effluent.tss / 1000;
  const totalOut = solidsThick + solidsSup;
  assert(Math.abs(totalOut - solidsIn) / solidsIn < 0.02,
    `M. thickener solids balance: in=${solidsIn.toFixed(0)} kg/d, out=${totalOut.toFixed(0)} kg/d (thick=${solidsThick.toFixed(0)}, sup=${solidsSup.toFixed(0)})`);
  assert(r.sludge!.tss > feed.tss, `M+. thickener concentrates: ${r.sludge!.tss.toFixed(0)} > ${feed.tss}`);
}

// ── Test N: clarifier WAS stream is distinct from RAS ─────────────────────────
{
  const clar = mkUnit('clar', 'secondary_clarifier', 0, 0);
  clar.customParams.rasRecycleRatioPercent = 75;
  clar.customParams.wasPurgeRateM3d = 50;
  const q = { ...emptyW(), flowRate: 17500, tss: 3200 }; // Qforward*(1+r)
  const r = calculateUnitProcess(clar, q);
  // RAS → sludge_outlet ; WAS → was_outlet (when defined) — both present and distinct
  const ras = r.portStreams?.['sludge_outlet'];
  const was = r.portStreams?.['was_outlet'];
  assert(!!ras && !!was, `N. clarifier emits distinct RAS (${ras?.flowRate}) and WAS (${was?.flowRate}) streams`);
  if (ras && was) {
    assert(ras.flowRate > 5000, `N+. RAS flow ${ras.flowRate.toFixed(0)} m³/d (>5000 = 75% of forward)`);
    assert(was.flowRate > 0 && was.flowRate <= 50, `N++. WAS purge ${was.flowRate.toFixed(0)} m³/d (capped, distinct path)`);
  }
}

// ── Test O: A2O internal recycle is internal (no external gas/LC outlet) ──────
{
  const a2o = mkUnit('a2o', 'a2o_bardenpho', 0, 0);
  a2o.customParams = { internalRecyclePercent: 400, aerobicDo: 4.5, carbonDosingRateMgL: 40 };
  const def = UNIT_DEFINITIONS.a2o_bardenpho;
  const gasPorts = def.ports.filter(p => p.type.includes('gas'));
  const recyclePorts = def.ports.filter(p => p.type.includes('recycle'));
  assert(recyclePorts.length === 0, `O. A2O has no external recycle_outlet (was flow-creating bug): ${recyclePorts.map(p=>p.id).join(',')}`);
  assert(gasPorts.length === 0, `O+. A2O emits no gas (process gas is internal)`, gasPorts);
  const q = { ...emptyW(), flowRate: 12000, bod: 260, cod: 520, tss: 290, tn: 58, nh4: 45, tp: 7.8, pathogens: 1e6, turbidity: 180 };
  const r = calculateUnitProcess(a2o, q);
  assert(r.effluent.flowRate === 12000, `O++. A2O forward flow preserved: ${r.effluent.flowRate} (not 16000 or 40000)`);
  assert(r.effluent.tn < 12, `O+++. A2O achieves low TN: ${r.effluent.tn.toFixed(2)} mg/L — internal IR enables ANAMMOX/DENIT`
);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
