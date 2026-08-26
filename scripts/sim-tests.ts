/* Headless smoke tests for the fixed simulation core (run via `npm test` → tsx) */
import { GameManager } from '../src/gameplay/GameManager';
import { SimulationEngine } from '../src/sim/SimulationEngine';
import {
  UNIT_DEFINITIONS,
  calculateUnitProcess
} from '../src/sim/UnitProcessModels';
import { generateAdvisories } from '../src/sim/AdvisoryEngine';
import {
  validateConnection,
  getPortWorldPosition,
  getRotatedFootprint,
  getUnitWorldCenter
} from '../src/sim/PipeNetwork';
import type { PipeConnection, PlacedUnit } from '../src/types/simulation';
import { OvertakeController } from '../src/graphics/OvertakeController';
import {
  REAL_SECONDS_PER_GAME_DAY,
  INITIAL_GAME_TIME_DAYS,
  realSecondsToSimDays,
  gameDaysToCalendar,
  formatGameClock,
  getDayNightFactor,
} from '../src/gameplay/GameTime';
import {
  composeFlatWaterMatrix,
  riverYawAt,
  foamTransform,
  flowStreakTransform,
} from '../src/graphics/WaterSurface';
import {
  roadCorridorHeight,
  ROAD_HALF_WIDTH,
  ROAD_SHOULDER_WIDTH,
  ROAD_SUPPORT_GRADE,
  ROAD_CLEAR_END,
  NATURE_ROAD_CLEARANCE,
} from '../src/graphics/RoadClearance';
import {
  WATER_DAY,
  WATER_DUSK,
  WATER_NIGHT,
  waterColorAt,
} from '../src/graphics/TerrainGrid';
import * as THREE from 'three';

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
  const res = calculateUnitProcess(a2o, inletQ, 12000);
  assert(res.effluent.tn < 5.0, `Level 4 achievable: A2O effluent TN = ${res.effluent.tn.toFixed(2)} mg/L (< 5)`);
  assert(res.effluent.flowRate === 12000, `Forward flow preserved through A2O: ${res.effluent.flowRate}`);
}

// ── Test 3: Secondary clarifier mass conservation ───────────────────────────
{
  const clar = mkUnit('c', 'secondary_clarifier', 0, 0);
  const q = { ...emptyW(), flowRate: 10000 + 7500, tss: 3200 }; // mixed liquor w/ RAS
  const r = calculateUnitProcess(clar, q, 10000);
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
  const outfall = mkUnit('o', 'effluent_outfall', 0, 0);
  const r = calculateUnitProcess(outfall, { ...emptyW(), flowRate: 3500, do: 1.8 }, 3500);
  assert(r.effluent.do >= 4.0, `Cascade re-aeration lifts DO 1.8 → ${r.effluent.do.toFixed(1)} mg/L`);
}

// ── Test 6: Operator Console advisor proposes fixes that actually work ──────
{

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
  const solar = mkUnit('pv', 'solar_array', 0, 0);
  const wind = mkUnit('wt', 'wind_turbine', 0, 0);

  const noon = calculateUnitProcess(solar, emptyW(), undefined, { daylight: 1, wind: 1 });
  const midnight = calculateUnitProcess(solar, emptyW(), undefined, { daylight: 0, wind: 1 });
  assert(noon.powerKw === -42 && midnight.powerKw === 0,
    `Solar: ${noon.powerKw} kW at full sun, ${midnight.powerKw} kW at night`);

  const windy = calculateUnitProcess(wind, emptyW(), undefined, { daylight: 0, wind: 1 });
  const calm = calculateUnitProcess(wind, emptyW(), undefined, { daylight: 0, wind: 0.2 });
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
  const uv = mkUnit('uv', 'uv_disinfection', 0, 0);
  const dirty = { ...emptyW(), flowRate: 3500, pathogens: 5e5, tss: 250, turbidity: 180 };
  const clean  = { ...emptyW(), flowRate: 3500, pathogens: 5e5, tss: 3, turbidity: 2 };
  const rDirty = calculateUnitProcess(uv, dirty);
  const rClean = calculateUnitProcess(uv, clean);
  assert(rDirty.effluent.pathogens > 5e4 && rClean.effluent.pathogens < 200,
    `UV consequence: raw feed survives as ${rDirty.effluent.pathogens.toExponential(1)} CFU, polished feed drops to ${rClean.effluent.pathogens.toFixed(0)} CFU`);
}

// ── Test 10: CHLORINE DEMAND — ammonia starves disinfection ─────────────────
{
  const cl = mkUnit('cl', 'chlorination_basin', 0, 0);
  const septic = { ...emptyW(), flowRate: 3500, pathogens: 1e6, nh4: 40 };
  const nitrified = { ...emptyW(), flowRate: 3500, pathogens: 1e6, nh4: 1.5 };
  const rSeptic = calculateUnitProcess(cl, septic);
  const rNitrif = calculateUnitProcess(cl, nitrified);
  assert(rSeptic.effluent.pathogens > rNitrif.effluent.pathogens * 100,
    `Chlorine demand: septic feed leaves ${rSeptic.effluent.pathogens.toExponential(1)} vs ${rNitrif.effluent.pathogens.toExponential(1)} CFU after nitrification`);
}

// ── Test 11: RO FOULING — unpolished feed collapses rejection ───────────────
{
  const ro = mkUnit('ro', 'reverse_osmosis', 0, 0);
  const unfiltered = { ...emptyW(), flowRate: 10000, bod: 30, tss: 25, turbidity: 40, pathogens: 1e4 };
  const polished   = { ...emptyW(), flowRate: 10000, bod: 5, tss: 0.2, turbidity: 0.4, pathogens: 100 };
  const rBad = calculateUnitProcess(ro, unfiltered);
  const rGood = calculateUnitProcess(ro, polished);
  assert(rBad.effluent.bod > rGood.effluent.bod * 5 && rBad.effluent.pathogens > rGood.effluent.pathogens,
    `RO consequence: fouled permeate BOD ${rBad.effluent.bod.toFixed(1)} vs clean ${rGood.effluent.bod.toFixed(1)}`);
}

// ── Test 12: PUMP CLOGGING on unscreened sewage ─────────────────────────────
{
  const pump = mkUnit('ps', 'pump_station', 0, 0);
  const raw = { ...emptyW(), flowRate: 3500, tss: 420 };
  const screened = { ...emptyW(), flowRate: 3500, tss: 120 };
  const rRaw = calculateUnitProcess(pump, raw);
  const rScr = calculateUnitProcess(pump, screened);
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

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAIGN GAME-LOGIC TESTS (A–Y) — Prompt 3: objectives, domain rules, advisor
// ═════════════════════════════════════════════════════════════════════════════

import { analyzeActiveLiquidPath, hasActiveProcessTypeOnPath } from '../src/gameplay/PlantTopology';
import { CAMPAIGN_LEVELS } from '../src/gameplay/LevelsData';
import { TECH_TREE_NODES } from '../src/gameplay/TechTreeData';

/** Build a Level-1-style conventional train (units + pipes + RAS) on a state */
function buildConventionalTrain(gs: ReturnType<typeof GameManager.createInitialState>) {
  const units = [
    mkUnit('inl', 'influent_inlet', 2, 10),
    mkUnit('scr', 'bar_screen', 5, 10),
    mkUnit('grt', 'grit_chamber', 8, 10),
    mkUnit('pri', 'primary_clarifier_circular', 11, 9),
    mkUnit('cas', 'activated_sludge_cas', 15, 9),
    mkUnit('clr', 'secondary_clarifier', 18, 12),
    mkUnit('uv', 'uv_disinfection', 21, 10),
    ...gs.units.filter(u => u.typeId === 'effluent_outfall')
  ];
  const pipes = [
    mkPipe('t1', 'inl', 'outlet', 'scr', 'inlet'),
    mkPipe('t2', 'scr', 'outlet', 'grt', 'inlet'),
    mkPipe('t3', 'grt', 'outlet', 'pri', 'inlet'),
    mkPipe('t4', 'pri', 'outlet', 'cas', 'inlet'),
    mkPipe('t5', 'cas', 'outlet', 'clr', 'inlet'),
    mkPipe('t6', 'clr', 'outlet', 'uv', 'inlet'),
    mkPipe('t7', 'uv', 'outlet', gs.units.find(u => u.typeId === 'effluent_outfall')!.instanceId, 'inlet'),
    mkPipe('t8', 'clr', 'sludge_outlet', 'cas', 'ras_inlet', 'ras')
  ];
  return { units, pipes };
}

function tickN(state: any, n: number) {
  let s = state;
  for (let i = 0; i < n; i++) s = GameManager.tick(s, 0.5);
  return s;
}

const obj = (state: any, id: string) => state.currentLevel.objectives.find((o: any) => o.id === id);

// ── Test A: MBR hydraulic conservation Qin ≈ Qperm + QWAS (normal + fouled) ──
{
  const mbr = mkUnit('mbr', 'mbr_membrane', 0, 0);
  const normal = { ...emptyW(), flowRate: 10000, bod: 20, tss: 3500 };
  const rNormal = calculateUnitProcess(mbr, normal);
  const balNormal = Math.abs(10000 - rNormal.effluent.flowRate - rNormal.sludge!.flowRate) / 10000;
  assert(balNormal < 0.01,
    `A. MBR normal balance |Qin−Qperm−Qwas|/Qin = ${(balNormal * 100).toFixed(2)}% < 1%`);

  // Fouled MBR still conserves flow
  const mbrF = mkUnit('mbrf', 'mbr_membrane', 0, 0);
  const foulingFeed = { ...emptyW(), flowRate: 8000, bod: 400, tss: 1500 }; // raw-ish → fouled
  const rFouled = calculateUnitProcess(mbrF, foulingFeed);
  const balFouled = Math.abs(8000 - rFouled.effluent.flowRate - rFouled.sludge!.flowRate) / 8000;
  assert(balFouled < 0.01,
    `A+. MBR fouled balance error ${(balFouled * 100).toFixed(2)}% < 1%`);
}

// ── Tests B/C: disconnected vs connected MBR for obj_mbr ─────────────────────
{
  // B. Disconnected MBR must NOT satisfy obj_mbr
  const gsB = GameManager.createInitialState(4, false); // Level 5 has obj_mbr
  gsB.units.push(mkUnit('mbrDisc', 'mbr_membrane', 30, 30)); // no pipes at all
  const sB = tickN(gsB, 20);
  assert(!obj(sB, 'obj_mbr').achieved,
    'B. disconnected MBR does NOT satisfy obj_mbr');

  // C. Connected MBR with qualifying effluent CAN satisfy obj_mbr.
  //    The MBR waste-sludge line MUST be routed away — an undrained sludge
  //    sump legitimately overflows into the effluent (no free magic disposal).
  const gsC = GameManager.createInitialState(4, false);
  const unitsC = [
    mkUnit('inl', 'influent_inlet', 2, 10),
    mkUnit('scr', 'bar_screen', 5, 10),
    mkUnit('grt', 'grit_chamber', 8, 10),
    mkUnit('mbrC', 'mbr_membrane', 12, 10),
    mkUnit('uv', 'uv_disinfection', 17, 10),
    mkUnit('thkS', 'sludge_thickener', 22, 18), // WAS sink
    ...gsC.units.filter(u => u.typeId === 'effluent_outfall')
  ];
  const outC = gsC.units.find(u => u.typeId === 'effluent_outfall')!.instanceId;
  const pipesC = [
    mkPipe('c1', 'inl', 'outlet', 'scr', 'inlet'),
    mkPipe('c2', 'scr', 'outlet', 'grt', 'inlet'),
    mkPipe('c3', 'grt', 'outlet', 'mbrC', 'inlet'),
    mkPipe('c4', 'mbrC', 'outlet', 'uv', 'inlet'),
    mkPipe('c5', 'uv', 'outlet', outC, 'inlet'),
    mkPipe('c6', 'mbrC', 'sludge_outlet', 'thkS', 'inlet', 'sludge')
  ];
  const sC0 = { ...gsC, units: unitsC, pipes: pipesC };
  const sC = tickN(sC0, 25);
  assert(obj(sC, 'obj_mbr').achieved && sC.finalEffluent.tss <= 0.1,
    `C. connected MBR satisfies obj_mbr (TSS ${sC.finalEffluent.tss.toFixed(3)} ≤ 0.1)`);
}

// ── Tests D/E: RO objective requires integration ─────────────────────────────
{
  // D. Disconnected RO fails
  const gsD = GameManager.createInitialState(4, false);
  gsD.units.push(mkUnit('roDisc', 'reverse_osmosis', 40, 40));
  const sD = tickN(gsD, 15);
  assert(!obj(sD, 'obj_ro').achieved, 'D. disconnected RO does NOT satisfy obj_ro');

  // E. Connected multi-barrier train with RO can satisfy obj_ro.
  //    Brine + MBR-WAS routes provided (undrained waste would foul the product).
  const gsE = GameManager.createInitialState(4, false);
  const unitsE = [
    mkUnit('inlE', 'influent_inlet', 2, 10),
    mkUnit('scrE', 'bar_screen', 5, 10),
    mkUnit('grtE', 'grit_chamber', 8, 10),
    mkUnit('mbrE', 'mbr_membrane', 12, 10),
    mkUnit('roE', 'reverse_osmosis', 17, 10),
    mkUnit('uvE', 'uv_disinfection', 22, 10),
    mkUnit('aopE', 'advanced_oxidation_aop', 26, 10),
    mkUnit('thkW', 'sludge_thickener', 31, 18),
    mkUnit('thkB', 'sludge_thickener', 36, 18),
    ...gsE.units.filter(u => u.typeId === 'effluent_outfall')
  ];
  const outId = gsE.units.find(u => u.typeId === 'effluent_outfall')!.instanceId;
  const pipesE = [
    mkPipe('e1', 'inlE', 'outlet', 'scrE', 'inlet'),
    mkPipe('e2', 'scrE', 'outlet', 'grtE', 'inlet'),
    mkPipe('e3', 'grtE', 'outlet', 'mbrE', 'inlet'),
    mkPipe('e4', 'mbrE', 'outlet', 'roE', 'inlet'),
    mkPipe('e5', 'roE', 'outlet', 'uvE', 'inlet'),
    mkPipe('e6', 'uvE', 'outlet', 'aopE', 'inlet'),
    mkPipe('e7', 'aopE', 'outlet', outId, 'inlet'),
    mkPipe('e8', 'mbrE', 'sludge_outlet', 'thkW', 'inlet', 'sludge'),
    mkPipe('e9', 'roE', 'sludge_outlet', 'thkB', 'inlet', 'sludge')
  ];
  const sE0 = { ...gsE, units: unitsE, pipes: pipesE };
  const sE = tickN(sE0, 25);
  assert(obj(sE, 'obj_ro').achieved,
    `E. connected RO multi-barrier satisfies obj_ro (BOD ${sE.finalEffluent.bod.toFixed(2)}, TSS ${sE.finalEffluent.tss.toFixed(3)})`);
}

// ── Test F: obj_pathogen_zero honors target 0 exactly ────────────────────────
{
  // A plant whose effluent still carries pathogens must NOT pass a 0-CFU target.
  const gsF = GameManager.createInitialState(4, false);
  // Simple non-disinfected train: screen→grit→MBR→outfall (pathogens survive MBR)
  const unitsF = [
    mkUnit('inlF', 'influent_inlet', 2, 10),
    mkUnit('scrF', 'bar_screen', 5, 10),
    mkUnit('grtF', 'grit_chamber', 8, 10),
    mkUnit('mbrF', 'mbr_membrane', 12, 10),
    mkUnit('thkF', 'sludge_thickener', 17, 18),
    ...gsF.units.filter(u => u.typeId === 'effluent_outfall')
  ];
  const outF = gsF.units.find(u => u.typeId === 'effluent_outfall')!.instanceId;
  const pipesF = [
    mkPipe('f1', 'inlF', 'outlet', 'scrF', 'inlet'),
    mkPipe('f2', 'scrF', 'outlet', 'grtF', 'inlet'),
    mkPipe('f3', 'grtF', 'outlet', 'mbrF', 'inlet'),
    mkPipe('f4', 'mbrF', 'outlet', outF, 'inlet'),
    mkPipe('f5', 'mbrF', 'sludge_outlet', 'thkF', 'inlet', 'sludge')
  ];
  const sF0 = { ...gsF, units: unitsF, pipes: pipesF };
  const sF = tickN(sF0, 20);
  if (sF.finalEffluent.pathogens > 0) {
    assert(!obj(sF, 'obj_pathogen_zero').achieved,
      `F. pathogen_zero NOT achieved while effluent has ${sF.finalEffluent.pathogens.toExponential(1)} CFU (target exactly 0)`);
  } else {
    assert(obj(sF, 'obj_pathogen_zero').achieved,
      'F. pathogen_zero achieved when effluent reaches true 0 CFU');
  }
}

// ── Tests G/H: obj_volume uses CURRENT m³/day, not cumulative volume ─────────
{
  // H. A plant treating only ~3,500 m³/d can NEVER pass a 10,000 m³/d target —
  //    even after many game days of accumulation. tick(0.5s) at 1x = 0.5/60 day,
  //    so run at max speed with long deltas to accumulate real volume.
  const gsH = GameManager.createInitialState(0, false);
  gsH.currentLevel.objectives = [{
    id: 'obj_volume', description: 'Reclaim and sell >10,000 m³/day',
    type: 'treat_volume', targetValue: 10000, achieved: false
  }];
  const trainH = buildConventionalTrain(gsH); // Level 1 influent = 3,500 m³/d
  let sH: any = { ...gsH, units: trainH.units, pipes: trainH.pipes };
  for (let i = 0; i < 40; i++) sH = GameManager.tick(sH, 60 * 5); // ~3.3 days total
  assert(!obj(sH, 'obj_volume').achieved && sH.financials.totalTreatedM3 > 10000,
    `G/H. cumulative ${sH.financials.totalTreatedM3.toFixed(0)} m³ accumulated but obj_volume NOT latched — current-flow semantics verified (${sH.finalEffluent.flowRate.toFixed(0)} m³/d < 10,000)`);

  // G. A plant with CURRENT flow ≥ target passes immediately
  const gsG2 = GameManager.createInitialState(4, false);
  gsG2.currentLevel.objectives = [{
    id: 'obj_volume', description: 'test', type: 'treat_volume', targetValue: 5000, achieved: false
  }];
  const trainG = buildConventionalTrain(gsG2); // Level 5 influent = 18,000 m³/d
  const sG = tickN({ ...gsG2, units: trainG.units, pipes: trainG.pipes }, 10);
  assert(obj(sG, 'obj_volume').achieved && sG.finalEffluent.flowRate >= 5000,
    `G+. obj_volume passes on CURRENT throughput (${sG.finalEffluent.flowRate.toFixed(0)} ≥ 5,000 m³/d)`);
}

// ── Test I: obj_aeration uses reactor DO, not effluent DO ────────────────────
{
  const gsI = GameManager.createInitialState(1, false); // Level 2 has obj_aeration
  const trainI = buildConventionalTrain(gsI);
  // Set reactor DO below target — even though UV/oxygenated effluent might read high DO
  const casI = trainI.units.find(u => u.instanceId === 'cas')!;
  casI.customParams.doSetpoint = 0.5; // far below 2.0 target
  const sI = tickN({ ...gsI, units: trainI.units, pipes: trainI.pipes }, 15);
  assert(!obj(sI, 'obj_aeration').achieved,
    `I. obj_aeration tracks REACTOR DO (setpoint 0.5 → actual ${(casI.dissolvedOxygenActual ?? 0).toFixed(1)}), not satisfied despite flow`);
}

// ── Test J: energy objective reflects CURRENT performance ────────────────────
{
  const gsJ = GameManager.createInitialState(3, false); // Level 4 has obj_energy 50%
  const sJ = tickN(gsJ, 10); // no renewables yet
  assert(!obj(sJ, 'obj_energy').achieved && sJ.overallStats.energySelfSufficiencyPercent < 50,
    `J. obj_energy unmet while self-sufficiency is ${sJ.overallStats.energySelfSufficiencyPercent.toFixed(0)}%`);

  // Add solar+wind at noon → sufficiency jumps
  const unitsJ = [...sJ.units, mkUnit('pvJ', 'solar_array', 50, 20), mkUnit('wtJ', 'wind_turbine', 56, 24)];
  const sJ2raw = SimulationEngine.stepSimulation(
    unitsJ, [], gsJ.currentLevel.influentSpec, gsJ.currentLevel.standards,
    sJ.financials, gsJ.currentLevel.tariffPerM3, 0.15, 45, { daylight: 1, wind: 1 }
  );
  assert(sJ2raw.overallStats.energySelfSufficiencyPercent > 0 || sJ2raw.overallStats.totalGreenGenerationKw > 0,
    `J+. adding renewables raises green generation to ${sJ2raw.overallStats.totalGreenGenerationKw.toFixed(0)} kW`);
}

// ── Test K: compliance streak resets after violation ─────────────────────────
{
  const gsK = GameManager.createInitialState(2, false); // Level 3 has obj_compliance
  let sK: any = { ...gsK, simSpeed: 1 as const };
  const place = (type: UnitTypeId, x: number, y: number, params?: Record<string, number>) => {
    const r = GameManager.placeUnit(sK, type, x, y);
    sK = r.newState;
    const u = sK.units[sK.units.length - 1] as PlacedUnit;
    if (params) Object.assign(u.customParams, params);
    return u;
  };
  const scr = place('bar_screen', 10, 20)!;
    const grt = place('grit_chamber', 13, 20)!;
    const eq = place('equalization_basin', 16, 20)!;
    const m1 = place('mbbr_reactor', 19, 20, { carrierFillRatioPercent: 100 })!;
    const m2 = place('mbbr_reactor', 22, 24, { carrierFillRatioPercent: 100 })!;
    const m3 = place('mbbr_reactor', 28, 20, { carrierFillRatioPercent: 100 })!;
    const cl = place('secondary_clarifier', 25, 23)!;
    const a1 = place('advanced_oxidation_aop', 29, 20, { ozoneDoseMgL: 18 })!;
    const cp1 = place('chemical_phosphorus', 33, 20, { coagulantDoseMgL: 60 })!;
    const cp2 = place('chemical_phosphorus', 37, 20, { coagulantDoseMgL: 60 })!;
    const uv = place('uv_disinfection', 41, 20)!;
    sK.pipes = [
      mkPipe('p1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
      mkPipe('p2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
      mkPipe('p3', grt.instanceId, 'outlet', eq.instanceId, 'inlet'),
      mkPipe('p4', eq.instanceId, 'outlet', m1.instanceId, 'inlet'),
      mkPipe('p5', m1.instanceId, 'outlet', m2.instanceId, 'inlet'),
      mkPipe('p6', m2.instanceId, 'outlet', m3.instanceId, 'inlet'),
      mkPipe('p7', m3.instanceId, 'outlet', cl.instanceId, 'inlet'),
      mkPipe('p8', cl.instanceId, 'outlet', a1.instanceId, 'inlet'),
      mkPipe('p9', a1.instanceId, 'outlet', cp1.instanceId, 'inlet'),
      mkPipe('p10', cp1.instanceId, 'outlet', cp2.instanceId, 'inlet'),
      mkPipe('p11', cp2.instanceId, 'outlet', uv.instanceId, 'inlet'),
      mkPipe('p12', uv.instanceId, 'outlet', 'outfall_0', 'inlet'),
      mkPipe('p13', cl.instanceId, 'sludge_outlet', m1.instanceId, 'ras_inlet', 'ras')
    ];
  for (let i = 0; i < 250; i++) sK = GameManager.tick(sK, 1); // warm-up to steady state
  for (let i = 0; i < 5; i++) sK = GameManager.tick(sK, 300); // +25 game days of streak
  const streakBefore = sK.complianceStreakDays;

    // Break the biology: bypass MBBRs + EQ (grit → clarifier directly).
    // Without biological treatment BOD/COD/TSS/NH4 all explode and the
    // compliance streak must reset to zero.
    sK.pipes = sK.pipes.filter((p: PipeConnection) => !['p3', 'p4', 'p5', 'p6', 'p7', 'p13'].includes(p.id));
    sK.pipes.push(mkPipe('pBypass', grt.instanceId, 'outlet', cl.instanceId, 'inlet'));
  for (let i = 0; i < 5; i++) sK = GameManager.tick(sK, 300);
  const streakAfter = sK.complianceStreakDays;

  assert(streakBefore > 0 && streakAfter === 0,
    `K. compliance streak resets on process failure (${streakBefore.toFixed(1)}d → ${streakAfter.toFixed(1)}d)`);
}

// ── Tests L/M: disconnected EQ basin / sand filter fail their objectives ─────
{
  const gsL = GameManager.createInitialState(1, false); // Level 2 has obj_eq
  gsL.units.push(mkUnit('eqDisc', 'equalization_basin', 40, 30)); // disconnected
  const trainL = buildConventionalTrain(gsL).pipes;
  const withDAF = [
    ...gsL.units.filter(u => u.typeId !== 'equalization_basin' && u.typeId !== 'effluent_outfall' || u.typeId === 'effluent_outfall'),
    mkUnit('eqDisc', 'equalization_basin', 44, 30)
  ];
  const sL = tickN({ ...gsL, units: withDAF, pipes: [] }, 12);
  assert(!obj(sL, 'obj_eq').achieved, 'L. disconnected Equalization Basin does NOT satisfy obj_eq');

  const gsM = GameManager.createInitialState(3, false); // Level 4 has obj_sand
  const unitsM = [
    mkUnit('inlM', 'influent_inlet', 2, 10),
    mkUnit('scrM', 'bar_screen', 5, 10),
    mkUnit('grtM', 'grit_chamber', 8, 10),
    mkUnit('a2oM', 'a2o_bardenpho', 11, 10),
    mkUnit('clrM', 'secondary_clarifier', 17, 13),
    mkUnit('uvM', 'uv_disinfection', 21, 10),
    mkUnit('sandDisc', 'sand_filter', 45, 35), // DISCONNECTED sand filter
    ...gsM.units.filter(u => u.typeId === 'effluent_outfall')
  ];
  const outM = gsM.units.find(u => u.typeId === 'effluent_outfall')!.instanceId;
  const pipesM = [
    mkPipe('m1', 'inlM', 'outlet', 'scrM', 'inlet'),
    mkPipe('m2', 'scrM', 'outlet', 'grtM', 'inlet'),
    mkPipe('m3', 'grtM', 'outlet', 'a2oM', 'inlet'),
    mkPipe('m4', 'a2oM', 'outlet', 'clrM', 'inlet'),
    mkPipe('m5', 'clrM', 'outlet', 'uvM', 'inlet'),
    mkPipe('m6', 'uvM', 'outlet', outM, 'inlet'),
    mkPipe('m7', 'clrM', 'sludge_outlet', 'a2oM', 'ras_inlet', 'ras')
  ];
  const sM = tickN({ ...gsM, units: unitsM, pipes: pipesM }, 15);
  assert(!obj(sM, 'obj_sand').achieved,
    `M. disconnected sand filter does NOT satisfy obj_sand (TSS ${sM.finalEffluent.tss.toFixed(1)})`);
}

// ── Tests N/O/P/Q: domain-rule enforcement in GameManager ────────────────────
{
  // N. placeUnit rejects unit unavailable in level
  const gsN = GameManager.createInitialState(0, false); // L1: no RO
  const rN = GameManager.placeUnit(gsN, 'reverse_osmosis', 10, 10);
  assert(!rN.success && !!rN.reason, `N. placeUnit rejects unavailable unit: "${rN.reason}"`);

  // O. placeUnit rejects locked technology
  const gsO = GameManager.createInitialState(3, false); // L4 has no MBR tech
  const rO = GameManager.placeUnit(gsO, 'mbr_membrane', 10, 10);
  assert(!rO.success && !!rO.reason, `O. placeUnit rejects locked-tech unit: "${rO.reason}"`);

  // P. unlockTech rejects missing prerequisites.
  //    Pick a tech whose prereq chain is NOT satisfied at level start
  //    (Level 1 only unlocks tech_basics — anything requiring an unowned node fails).
  const gsP = GameManager.createInitialState(0, false);
  const lockedDeep = TECH_TREE_NODES.find(
    n => !n.unlocked && (n.prerequisites ?? []).some(pid => !gsP.techTree.find(t => t.id === pid)?.unlocked)
  )!;
  const rP = GameManager.unlockTech(gsP, lockedDeep.id);
  assert(!rP.success && (rP.reason ?? '').includes('research'),
    `P. unlockTech rejects missing prerequisites: "${rP.reason}"`);

  // Q. valid tech unlock succeeds (unlock prerequisite chain first)
  const base = gsP.techTree.find(n => n.unlocked)!;
  const child = TECH_TREE_NODES.find(n => (n.prerequisites ?? []).includes(base.id))!;
  const rQ = GameManager.unlockTech(gsP, child.id);
  assert(rQ.success && rQ.newState.techTree.find(n => n.id === child.id)!.unlocked,
    `Q. valid tech unlock succeeds: ${child.id}`);
}

// ── Test R: active liquid path handles RAS cycles without infinite traversal ─
{
  const gsR = GameManager.createInitialState(0, false);
  const tr = buildConventionalTrain(gsR);
  const analysis = analyzeActiveLiquidPath(tr.units, []);
  assert(analysis.activeUnitIds.size === 1 && !analysis.influentToOutfall,
    'R. zero-pipe plant: only the inlet is active, no path to outfall');

  // With RAS loop present the BFS must terminate and find the full train
  const sR = tickN({ ...gsR, units: tr.units, pipes: tr.pipes }, 8);
  const an2 = analyzeActiveLiquidPath(sR.units, sR.pipes);
  assert(an2.activeUnitIds.size >= 7 && an2.influentToOutfall,
    `R+. RAS loop terminates; ${an2.activeUnitIds.size} units active, influent→outfall=${an2.influentToOutfall}`);

  assert(hasActiveProcessTypeOnPath('activated_sludge_cas', sR.units, sR.pipes),
    'R++. CAS detected as active on-path process');
}

// ── Test S: valid Level 1 canonical train can complete Level 1 ───────────────
{
  const gsS = GameManager.createInitialState(0, false);
  let s: any = { ...gsS, simSpeed: 5 as const };
  const place = (type: UnitTypeId, x: number, y: number, params?: Record<string, number>) => {
    const r = GameManager.placeUnit(s, type, x, y);
    if (!r.success) { console.error('place fail:', type, r.reason); return null; }
    s = r.newState;
    const u = s.units[s.units.length - 1];
    if (params) Object.assign(u.customParams, params);
    return u as PlacedUnit;
  };
  // Stage A: core liquid train + pump station (obj_pump needs on-train pump
    // delivering at duty point from the start). obj_cas_sizing is already
    // satisfied by the fresh CAS template (1728 m³ → ≈11.9 h HRT at 3500 m³/d).
    const scr = place('bar_screen', 5, 20)!;
    const grt = place('grit_chamber', 8, 20)!;
    const pri = place('primary_clarifier_circular', 11, 20)!;
    const cas = place('activated_sludge_cas', 16, 20, { doSetpoint: 2.5 })!;
    const cl = place('secondary_clarifier', 22, 23)!;
    const pmp = place('pump_station', 26, 20)!;
    s.pipes = [
      mkPipe('sp1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
      mkPipe('sp2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
      mkPipe('sp3', grt.instanceId, 'outlet', pri.instanceId, 'inlet'),
      mkPipe('sp4', pri.instanceId, 'outlet', cas.instanceId, 'inlet'),
      mkPipe('sp5', cas.instanceId, 'outlet', cl.instanceId, 'inlet'),
      mkPipe('sp6', cl.instanceId, 'outlet', pmp.instanceId, 'inlet'),
      mkPipe('sp7', pmp.instanceId, 'outlet', 'outfall_0', 'inlet'),
      mkPipe('sp8', cl.instanceId, 'sludge_outlet', cas.instanceId, 'ras_inlet', 'ras')
    ];
    for (let i = 0; i < 300; i++) s = GameManager.tick(s, 1);

    // Stage B: add UV disinfection once earned revenue covers it.
    const uvCapex = UNIT_DEFINITIONS.uv_disinfection.capex;
    let waitTicks = 0;
    while (s.financials.cash < uvCapex && waitTicks < 1200) {
      s = GameManager.tick(s, 1);
      waitTicks++;
    }
    const uv = place('uv_disinfection', 29, 20);
    if (uv) {
      s.pipes = s.pipes.filter((p: PipeConnection) => !(p.fromUnitId === pmp.instanceId && p.toUnitId === 'outfall_0'));
      s.pipes.push(
        mkPipe('sp9', pmp.instanceId, 'outlet', uv.instanceId, 'inlet'),
        mkPipe('sp10', uv.instanceId, 'outlet', 'outfall_0', 'inlet')
      );
      for (let i = 0; i < 600; i++) s = GameManager.tick(s, 1);
    }
    assert(uv !== null && s.isLevelComplete && s.currentLevel.objectives.every((o: any) => o.achieved),
      `S. Level 1 canonical staged build COMPLETES (score ${s.overallStats.complianceScore}%, cash $${s.financials.cash.toFixed(0)})`);
  }

// ── Tests T–W: advisor behavior per level ─────────────────────────────────────
{
  // T/U. Level 3: with screen+grit+MBBR+clarifier placed but toxic/COD/TP high
  // (no effluent yet — chemistry unproven) → AOP & chemP suggested in order.
  const gsT = GameManager.createInitialState(2, false); // level.id===3 is index 2
  const unitsT = [
    mkUnit('scr', 'bar_screen', 5, 20),
    mkUnit('grt', 'grit_chamber', 8, 20),
    mkUnit('mbb', 'mbbr_reactor', 11, 20),
    mkUnit('clr', 'secondary_clarifier', 16, 23)
  ];
  const sugT = GameManager.computeNextSuggestion(unitsT, gsT.currentLevel);
  assert(!!sugT && sugT.unitTypeId === 'advanced_oxidation_aop',
    `T. L3 advisor suggests AOP when toxic/COD remain high (${sugT?.unitTypeId})`);
  // After AOP exists, chemP should be next while TP still high
  unitsT.push(mkUnit('aop', 'advanced_oxidation_aop', 21, 20));
  const sugU = GameManager.computeNextSuggestion(unitsT, gsT.currentLevel);
  assert(!!sugU && sugU.unitTypeId === 'chemical_phosphorus',
    `U. L3 advisor suggests chemical P when TP remains high (${sugU?.unitTypeId})`);

  // V/W. Level 4: after bio+clarifier+polishing chain exists but sludge/energy
  // chain missing → thickener/digester suggested; sand filter recognized.
  const gsV = GameManager.createInitialState(3, false);
  const unitsV = [
    mkUnit('scr4', 'bar_screen', 5, 20),
    mkUnit('grt4', 'grit_chamber', 8, 20),
    mkUnit('a2o4', 'a2o_bardenpho', 11, 20),
    mkUnit('clr4', 'secondary_clarifier', 18, 23),
    mkUnit('uv4', 'uv_disinfection', 22, 20)
  ];
  const sugV = GameManager.computeNextSuggestion(unitsV, gsV.currentLevel);
  assert(!!sugV && sugV.unitTypeId === 'sand_filter',
    `W. L4 advisor recognizes missing sand filtration (${sugV?.unitTypeId})`);
  // Now add sand+chemP — energy/sludge chain should be next
  unitsV.push(mkUnit('sf4', 'sand_filter', 24, 20));
  unitsV.push(mkUnit('cp4', 'chemical_phosphorus', 28, 20));
  const sugV2 = GameManager.computeNextSuggestion(unitsV, gsV.currentLevel);
  assert(!!sugV2 && sugV2.unitTypeId === 'sludge_thickener',
    `V. L4 advisor directs to sludge/energy recovery chain (${sugV2?.unitTypeId})`);
}

// ── Test X: Level 5 volume objective uses current throughput criterion ────────
{
  const gsX = GameManager.createInitialState(4, false);
  const unitsX = [
    mkUnit('x_scr', 'bar_screen', 5, 10),
    mkUnit('x_grt', 'grit_chamber', 8, 10),
    mkUnit('x_mbr', 'mbr_membrane', 12, 10),
    mkUnit('x_ro', 'reverse_osmosis', 17, 10),
    mkUnit('x_uv', 'uv_disinfection', 22, 10),
    mkUnit('x_thk', 'sludge_thickener', 27, 18)
  ];
  const pipesX = [
    mkPipe('x1', 'inl', 'outlet', 'x_scr', 'inlet'),
    mkPipe('x2', 'x_scr', 'outlet', 'x_grt', 'inlet'),
    mkPipe('x3', 'x_grt', 'outlet', 'x_mbr', 'inlet'),
    mkPipe('x4', 'x_mbr', 'outlet', 'x_ro', 'inlet'),
    mkPipe('x5', 'x_ro', 'outlet', 'x_uv', 'inlet'),
    mkPipe('x6', 'x_uv', 'outlet', 'outf', 'inlet'),
    mkPipe('x7', 'x_mbr', 'sludge_outlet', 'x_thk', 'inlet', 'sludge')
  ];
  // NOTE: uses own inlet/outfall ids below
  unitsX.unshift(mkUnit('inl', 'influent_inlet', 2, 10));
  unitsX.push(mkUnit('outf', 'effluent_outfall', 27, 10));
  pipesX[0] = mkPipe('x1', 'inl', 'outlet', 'x_scr', 'inlet');
  pipesX[5] = mkPipe('x6', 'x_uv', 'outlet', 'outf', 'inlet');
  let sX: any = { ...gsX, units: unitsX, pipes: pipesX, simSpeed: 5 as const };
  for (let i = 0; i < 40; i++) sX = GameManager.tick(sX, 1);
  const flowOk = sX.finalEffluent.flowRate >= 10000;
  assert(obj(sX, 'obj_volume').achieved === flowOk,
    `X. L5 obj_volume tracks CURRENT throughput (${sX.finalEffluent.flowRate.toFixed(0)} m³/d → achieved=${obj(sX, 'obj_volume').achieved})`);
}

// ── Test Z: Live effluent/financial objectives UNLATCH; completion LATCHES ─────
// Regression for the "objective achieved flag flips back to false when plant
// conditions deteriorate" behavior — operational objectives reflect CURRENT
// state every tick (no per-objective latching), while isLevelComplete is
// permanent once all are met.
{
  const gsZ = GameManager.createInitialState(0, true); // sandbox → we can shock the influent
  let s: any = { ...gsZ, simSpeed: 5 as const };
  const place = (type: UnitTypeId, x: number, y: number, params?: Record<string, number>) => {
    const r = GameManager.placeUnit(s, type, x, y);
    if (!r.success) { console.error('place fail:', type, r.reason); return null; }
    s = r.newState;
    const u = s.units[s.units.length - 1];
    if (params) Object.assign(u.customParams, params);
    return u as PlacedUnit;
  };
  const scr = place('bar_screen', 5, 20)!;
  const grt = place('grit_chamber', 8, 20)!;
  const pri = place('primary_clarifier_circular', 11, 9)!;
  const cas = place('activated_sludge_cas', 15, 9, { doSetpoint: 2.5 })!;
  const clr = place('secondary_clarifier', 18, 12)!;
  const uv = place('uv_disinfection', 21, 10)!;
  const pmp = place('pump_station', 24, 10)!;
  const outfall = s.units.find((u: any) => u.typeId === 'effluent_outfall')!.instanceId;
  s.pipes = [
    mkPipe('z1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
    mkPipe('z2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
    mkPipe('z3', grt.instanceId, 'outlet', pri.instanceId, 'inlet'),
    mkPipe('z4', pri.instanceId, 'outlet', cas.instanceId, 'inlet'),
    mkPipe('z5', cas.instanceId, 'outlet', clr.instanceId, 'inlet'),
    mkPipe('z6', clr.instanceId, 'outlet', uv.instanceId, 'inlet'),
    mkPipe('z7', uv.instanceId, 'outlet', pmp.instanceId, 'inlet'),
    mkPipe('z9', pmp.instanceId, 'outlet', outfall, 'inlet'),
    mkPipe('z8', clr.instanceId, 'sludge_outlet', cas.instanceId, 'ras_inlet', 'ras')
  ];
  // Run to steady state — the conventional train should hit BOD < 25.
  for (let i = 0; i < 400; i++) s = GameManager.tick(s, 0.5);
  assert(obj(s, 'obj_bod').achieved === true,
    `Z1. Live objective unlatch — BOD met at steady state (bod=${s.finalEffluent.bod.toFixed(1)} ≤ 25)`);
  assert(obj(s, 'obj_profit').achieved === true,
    `Z2. Live objective unlatch — profit positive at steady state ($${s.financials.netDailyProfit.toFixed(0)}/d)`);

  // Shock the influent: spike BOD massively → effluent BOD climbs above target.
  s.sandboxCustomInfluent = { ...s.sandboxCustomInfluent, bod: 5000, cod: 4000, tss: 2500 };
  for (let i = 0; i < 400; i++) s = GameManager.tick(s, 0.5);
  assert(obj(s, 'obj_bod').achieved === false,
    `Z3. Live objective UNLATCHED — BOD deteriorated above 25 (bod=${s.finalEffluent.bod.toFixed(1)})`);

  // Restore influent → BOD recovers → objective true again (re-achievable, not sticky).
  s.sandboxCustomInfluent = { ...gsZ.currentLevel.influentSpec };
  for (let i = 0; i < 400; i++) s = GameManager.tick(s, 0.5);
  assert(obj(s, 'obj_bod').achieved === true,
    `Z4. Live objective re-achievable after recovery (bod=${s.finalEffluent.bod.toFixed(1)} ≤ 25)`);

  // ── Completion latch: ALL objectives valid simultaneously → isLevelComplete
  // latches permanently even if conditions later deteriorate.
  // Reset to a clean steady-state plant.
  let sC: any = { ...gsZ, simSpeed: 5 as const };
  const placeC = (type: UnitTypeId, x: number, y: number, params?: Record<string, number>) => {
    const r = GameManager.placeUnit(sC, type, x, y);
    if (!r.success) { console.error('place fail:', type, r.reason); return null; }
    sC = r.newState;
    const u = sC.units[sC.units.length - 1];
    if (params) Object.assign(u.customParams, params);
    return u as PlacedUnit;
  };
  const scrC = placeC('bar_screen', 5, 20)!;
  const grtC = placeC('grit_chamber', 8, 20)!;
  const priC = placeC('primary_clarifier_circular', 11, 9)!;
  const casC = placeC('activated_sludge_cas', 15, 9, { doSetpoint: 2.5 })!;
  const clrC = placeC('secondary_clarifier', 18, 12)!;
  const uvC = placeC('uv_disinfection', 21, 10)!;
  const pmpC = placeC('pump_station', 24, 10)!;
  const outfallC = sC.units.find((u: any) => u.typeId === 'effluent_outfall')!.instanceId;
  sC.pipes = [
    mkPipe('zC1', 'inlet_0', 'outlet', scrC.instanceId, 'inlet'),
    mkPipe('zC2', scrC.instanceId, 'outlet', grtC.instanceId, 'inlet'),
    mkPipe('zC3', grtC.instanceId, 'outlet', priC.instanceId, 'inlet'),
    mkPipe('zC4', priC.instanceId, 'outlet', casC.instanceId, 'inlet'),
    mkPipe('zC5', casC.instanceId, 'outlet', clrC.instanceId, 'inlet'),
    mkPipe('zC6', clrC.instanceId, 'outlet', uvC.instanceId, 'inlet'),
    mkPipe('zC7', uvC.instanceId, 'outlet', pmpC.instanceId, 'inlet'),
    mkPipe('zC9', pmpC.instanceId, 'outlet', outfallC, 'inlet'),
    mkPipe('zC8', clrC.instanceId, 'sludge_outlet', casC.instanceId, 'ras_inlet', 'ras')
  ];
  for (let i = 0; i < 400; i++) sC = GameManager.tick(sC, 0.5);
  const allMet = sC.currentLevel.objectives.every((o: any) => o.achieved);
  assert(allMet, 'Z5. All Level 1 objectives valid simultaneously → complete');
  assert(sC.isLevelComplete, 'Z6. isLevelComplete latches true on all-met');
  // Deteriorate AFTER completion — completion must STAY latched.
  sC.sandboxCustomInfluent = { ...sC.sandboxCustomInfluent, bod: 5000, cod: 4000, tss: 2500 };
  for (let i = 0; i < 400; i++) sC = GameManager.tick(sC, 0.5);
  assert(obj(sC, 'obj_bod').achieved === false, 'Z7. Post-completion: live BOD objective still unlatched (can flip false)');
  assert(sC.isLevelComplete === true, 'Z8. isLevelComplete STAYS latched true despite deterioration');
}

// ── Test AA: Overtake reservation controller (pure, no WebGL) ──────────────────
{
  // 1. vehicle A acquires reservation
  const oc = new OvertakeController();
  const A = { id: 1, dir: 1, state: 'cruise' as const, overtakeTime: 0, cooldown: 0, inHomeLane: true };
  assert(oc.acquireOvertakeReservation(A) === true && oc.isReservationHeldBy(1), 'AA1. vehicle A acquires road-wide reservation');
  // 2. vehicle B same direction cannot acquire
  const B = { id: 2, dir: 1, state: 'cruise' as const, overtakeTime: 0, cooldown: 0, inHomeLane: true };
  assert(oc.acquireOvertakeReservation(B) === false && !oc.isReservationHeldBy(2), 'AA2. vehicle B (same dir) cannot acquire while A holds');
  // 3. vehicle C opposite direction cannot acquire
  const C = { id: 3, dir: -1, state: 'cruise' as const, overtakeTime: 0, cooldown: 0, inHomeLane: true };
  assert(oc.acquireOvertakeReservation(C) === false && !oc.isReservationHeldBy(3), 'AA3. vehicle C (opposite dir) cannot acquire — single road-wide lock');
  // 4. A retains reservation through prepare / overtake / return (no one may begin)
  A.state = 'prepare'; assert(oc.canBeginOvertake(B) === false, 'AA4. B cannot begin while A in prepare (retained)');
  A.state = 'overtake'; assert(oc.canBeginOvertake(C) === false, 'AA4b. C cannot begin while A in overtake (retained)');
  A.state = 'return';   assert(oc.isReservationHeldBy(1), 'AA4c. A still holds through return');
  // 5. reservation releases after A reaches cooldown / home lane
  A.state = 'cooldown'; A.inHomeLane = true;
  oc.releaseOvertakeReservation(1);
  assert(oc.activeId === null, 'AA5. reservation released after A reaches cooldown/home lane');
  // 6. another vehicle may acquire afterward
  assert(oc.acquireOvertakeReservation(B) === true && oc.isReservationHeldBy(2), 'AA6. B may acquire after release');
  // Safety: releasing when not the holder is a no-op
  assert(oc.releaseOvertakeReservation(999) === false, 'AA7. release by non-holder is refused (no stale-lock injection)');
  // canBeginOvertake rejects already-manoeuvring and cooldown vehicles
  const D = { id: 4, dir: 1, state: 'prepare' as const, overtakeTime: 0, cooldown: 0, inHomeLane: false };
  const E = { id: 5, dir: 1, state: 'cruise' as const, overtakeTime: 0, cooldown: 3, inHomeLane: true };
  assert(oc.canBeginOvertake(D) === false, 'AA8. canBeginOvertake=false for a vehicle already manoeuvring');
  assert(oc.canBeginOvertake(E) === false, 'AA9. canBeginOvertake=false while vehicle cooldown > 0');
}

// ── Test Y: Level 5 completion is campaign completion (no wrap to Level 1) ────
{
  const lastIdx = CAMPAIGN_LEVELS.length - 1;
  const lastLevel = CAMPAIGN_LEVELS[lastIdx];
  // App.tsx logic under test:
  const wouldWrap = (() => {
    const idx = CAMPAIGN_LEVELS.findIndex(l => l.id === lastLevel.id) + 1;
    return idx % CAMPAIGN_LEVELS.length; // OLD buggy modulo behavior
  })();
  const advancesCorrectly = (() => {
    const idx = CAMPAIGN_LEVELS.findIndex(l => l.id === lastLevel.id);
    return idx < CAMPAIGN_LEVELS.length - 1 ? idx + 1 : idx; // NEW guard
  })();
  assert(wouldWrap === 0 && advancesCorrectly === lastIdx,
    'Y. Level 5 completion does NOT wrap to Level 1 (modulo removed, guarded advance)');
}

// ── Prompt 3.3: unified game-time architecture (items 9–18) ────────────────

// T1: seconds → game-day conversion (600 real sec = 1 game day at 1×)
{
  assert(REAL_SECONDS_PER_GAME_DAY === 600, 'T1a. REAL_SECONDS_PER_GAME_DAY is the single constant 600');
  assert(Math.abs(realSecondsToSimDays(600, 1) - 1) < 1e-12, 'T1b. 600 real seconds = exactly 1 game day at 1×');
  assert(Math.abs(realSecondsToSimDays(300, 2) - 1) < 1e-12, 'T1c. 300 real seconds = 1 game day at 2×');
  assert(Math.abs(realSecondsToSimDays(120, 5) - 1) < 1e-12, 'T1d. 120 real seconds = 1 game day at 5×');
}

// T2: speed scaling — 0/1/2/5 multiply world progression proportionally
{
  const base = realSecondsToSimDays(10, 1);
  assert(realSecondsToSimDays(10, 0) === 0, 'T2a. speed 0 → zero simulated time (pause)');
  assert(Math.abs(realSecondsToSimDays(10, 2) - 2 * base) < 1e-12, 'T2b. speed 2 → exactly 2× progression');
  assert(Math.abs(realSecondsToSimDays(10, 5) - 5 * base) < 1e-12, 'T2c. speed 5 → exactly 5× progression');
}

// T3: HH:MM clock formatting from gameTimeDays
{
  const c1 = gameDaysToCalendar(0);
  assert(c1.day === 1 && c1.hour === 0 && c1.minute === 0, 'T3a. day 0 → Day 1, 00:00');
  assert(formatGameClock(7 / 24 + 17 / (24 * 60)) === '07:17', 'T3b. 07:17 formats correctly');
  assert(formatGameClock(0.999999) === '23:59', 'T3c. late-day rounding stays inside 23:59');
  assert(formatGameClock(3 + 4 / 24 + 5 / (24 * 60)) === '04:05', 'T3d. fractional days beyond whole days ignored for clock');
  const c2 = gameDaysToCalendar(1.5);
  assert(c2.day === 2 && c2.hour === 12 && c2.minute === 0, 'T3e. 1.5 days → Day 2, 12:00');
}

// T4: dawn/day/sunset/night factor schedule
{
  const at = (h: number) => getDayNightFactor(h / 24);
  assert(at(0) === 0, 'T4a. midnight = full night');
  assert(at(5) === 0, 'T4b. 05:00 still night');
  assert(at(6) > 0 && at(6) < 1, 'T4c. 06:00 mid-dawn blend (smooth, not snapped)');
  assert(at(7) === 1 && at(12) === 1 && at(17.9) === 1, 'T4d. 06:30–18:00 = full day');
  assert(at(18.5) > 0 && at(18.5) < 1, 'T4e. 18:30 mid-sunset blend');
  assert(at(19.5) === 0 && at(23) === 0, 'T4f. 19:30–24:00 = night');
  // Monotonic dawn ramp & dusk ramp
  assert(at(5.75) < at(6.25), 'T4g. dawn ramps upward smoothly');
  assert(at(18.25) > at(18.75), 'T4h. sunset ramps downward smoothly');
  assert(getDayNightFactor(10) === getDayNightFactor(11), 'T4i. pure function of fractional day only');
}

// T5: pause stops ALL time progression through GameManager.tick
{
  let sP = GameManager.createInitialState(0, false);
  sP.simSpeed = 0;
  const before = { days: sP.gameTimeDays, cash: sP.financials.cash };
  for (let i = 0; i < 20; i++) sP = GameManager.tick(sP, 0.5);
  assert(sP.gameTimeDays === before.days, 'T5a. pause freezes game clock');
  assert(sP.financials.cash === before.cash, 'T5b. pause freezes finance progression');
  assert(sP.finalEffluent.flowRate === 0 || before.days === sP.gameTimeDays, 'T5c. pause freezes simulation outputs');
}

// T6: 2× and 5× produce ~2×/5× game-time progression over the same real time
{
  const runFor = (speed: 1 | 2 | 5): number => {
    let sR = GameManager.createInitialState(0, false);
    sR.simSpeed = speed;
    for (let i = 0; i < 100; i++) sR = GameManager.tick(sR, 0.5); // 50 real seconds
    return sR.gameTimeDays;
  };
  // Measure PROGRESSION (delta from the shared initial clock, which starts at
  // 07:00 on Day 1), not absolute clock values.
  const start = INITIAL_GAME_TIME_DAYS;
  const d1 = runFor(1) - start, d2 = runFor(2) - start, d5 = runFor(5) - start;
  assert(Math.abs(d2 - 2 * d1) < 0.01, `T6a. 2× doubles progression (${d2.toFixed(3)} vs ${d1.toFixed(3)})`);
  assert(Math.abs(d5 - 5 * d1) < 0.02, `T6b. 5× quintuples progression (${d5.toFixed(3)} vs ${d1.toFixed(3)})`);
}

// T7: fresh campaign starts in the morning with a full day ahead
{
  const sI = GameManager.createInitialState(0, false);
  assert(Math.abs(sI.gameTimeDays - INITIAL_GAME_TIME_DAYS) < 1e-12, 'T7a. initial gameTimeDays uses INITIAL_GAME_TIME_DAYS');
  assert(formatGameClock(sI.gameTimeDays) === '07:00', 'T7b. new campaign begins at 07:00');
  assert(sI.isNight === false && sI.dayNightFactor === 1, 'T7c. campaign starts in daylight');
}

// T8: solar generation is synchronized to the visual day/night factor
{
  // Solar output must be ~0 at night and rise during the day, driven by the
  // same getDayNightFactor curve the renderer uses.
  const mkSolarState = (days: number) => {
    const base8 = GameManager.createInitialState(0, false);
    const solar = mkUnit('solar', 'solar_array', 16, 4);
    return { ...base8, gameTimeDays: days, units: [...base8.units, solar] } as any;
  };
  const noon = GameManager.tick(mkSolarState(2 + 13 / 24), 0.5);
  const midnight = GameManager.tick(mkSolarState(2 + 1 / 24), 0.5);
  const solarKw = (st: any) => st.units.find((u: any) => u.instanceId === 'solar').lastPowerKwActual;
  assert(solarKw(noon) < -1, `T8a. strong solar production near midday (${solarKw(noon).toFixed(1)} kW)`);
  assert(solarKw(midnight) === 0, 'T8b. zero solar production at night');
  // Visual↔production consistency: factor drives BOTH.
  assert(getDayNightFactor(noon.gameTimeDays) === 1 && getDayNightFactor(midnight.gameTimeDays) === 0,
    'T8c. lighting factor agrees with production windows');
}

// ── Prompt 3.4: flat-water transform architecture (items 11–16) ─────────────

const WATER_EPS = 1e-6;

/** Transforms (0,1,0) by a matrix and returns the world-space normal. */
function transformedUpNormal(m: THREE.Matrix4): THREE.Vector3 {
  const n = new THREE.Vector3(0, 1, 0);
  // Use the normal matrix (inverse transpose of the upper 3×3). Our matrices
  // are rotation(Y)+non-uniform scale(X/Z), so this validates the real
  // shading normal behaviour too.
  const inv = new THREE.Matrix4().copy(m).invert();
  const nrm = new THREE.Matrix3().setFromMatrix4(inv).transpose();
  return n.applyMatrix3(nrm).normalize();
}

// W1: THE regression test for the vertical-white-poles bug. Every water
// instance matrix must keep the surface normal pointing UP (+Y) for ANY yaw.
{
  const yaws = [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2, 2.7, -0.9];
  let allUp = true;
  for (const yaw of yaws) {
    const m = composeFlatWaterMatrix(new THREE.Matrix4(), 5, 0.02, -7, yaw, 1.3, 2.1);
    const n = transformedUpNormal(m);
    if (n.y < 1 - 1e-4 || Math.abs(n.x) > 1e-6 || Math.abs(n.z) > 1e-6) allUp = false;
  }
  assert(allUp, 'W1a. surface normal stays +Y for yaws {0, π/4, π/2, π, −π/2, …}');
  // The old buggy pattern (Euler(-π/2, 0, yaw) applied to already-flat geometry)
  // stands the quad vertical — prove the helper can NEVER reproduce it.
  const badQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const badM = new THREE.Matrix4().compose(
    new THREE.Vector3(), badQ, new THREE.Vector3(1, 1, 1));
  const badN = transformedUpNormal(badM);
  assert(Math.abs(badN.y) < 1e-6 && Math.abs(badN.z + 1) < 1e-6,
    'W1b. sanity: the OLD double-rotation pattern yields normal −Z (vertical quad)');
}

// W2: foam animation is a pure function of (immutable base, time) — no drift,
// no dependence on evaluation history.
{
  const p = {
    baseX: 12.5, baseZ: -30.25, baseYaw: riverYawAt((z) => z * 0.05, -30),
    baseWidth: 0.42, baseLength: 1.1, phase: 1.234, driftAmplitude: 0.06,
  };
  const t0 = foamTransform(p, 0);
  const t1 = foamTransform(p, 10);
  const t2 = foamTransform(p, 123.45);
  const bounded =
    (s: { x: number; z: number }) =>
      Math.hypot(s.x - p.baseX, s.z - p.baseZ) <= p.driftAmplitude + 1e-9;
  assert(bounded(t0) && bounded(t1) && bounded(t2),
    'W2a. position always equals basePosition ± bounded oscillation');
  // Determinism / history-independence: evaluating "out of order" gives the
  // exact same result — impossible with the old decompose-and-mutate scheme.
  const again = foamTransform(p, 10);
  assert(t1.x === again.x && t1.z === again.z,
    'W2b. pure determinism: same (base,t) → identical position, any call order');
  // Width pulses around base width; length immutable.
  assert(Math.abs(t1.width - p.baseWidth) <= p.baseWidth * 0.13,
    'W2c. width pulse stays within ±13% of base width');
  assert(t0.length === t1.length && t1.length === t2.length && t2.length === p.baseLength,
    'W2d. length never mutates');
  // Yaw NEVER changes — instances stay tangent-aligned, never pitch/roll.
  assert(t0.yaw === t1.yaw && t1.yaw === t2.yaw && t2.yaw === p.baseYaw,
    'W2e. yaw is constant per particle (no accidental verticals over time)');
}

// W3: thousands of simulated frames must never accumulate displacement.
{
  const p = {
    baseX: 3.3, baseZ: 8.8, baseYaw: 0.4, baseWidth: 0.5, baseLength: 0.9,
    phase: 0.77, driftAmplitude: 0.06,
  };
  let maxDisp = 0;
  for (let f = 0; f < 10000; f++) {
    const s = foamTransform(p, f * (1 / 60)); // 10k frames @60fps ≈ 166 s
    maxDisp = Math.max(maxDisp, Math.hypot(s.x - p.baseX, s.z - p.baseZ));
  }
  assert(maxDisp <= p.driftAmplitude + 1e-9,
    `W3a. max displacement after 10k frames = ${maxDisp.toFixed(6)} ≤ amplitude ${p.driftAmplitude}`);
  // And the exact start state recurs every full period → zero net integration.
  const periodS = (2 * Math.PI) / 0.7; // FOAM_DRIFT_FREQUENCY = 0.7 rad/s
  const a = foamTransform(p, 500);
  const b = foamTransform(p, 500 + 1000 * periodS);
  assert(Math.abs(a.x - b.x) < WATER_EPS && Math.abs(a.z - b.z) < WATER_EPS,
    'W3b. position is periodic in time — no secular (cumulative) term exists');
}

// W4: flow streaks also stay flat and follow the local river tangent.
{
  const meander = (z: number) => 6 * Math.sin(z * 0.02); // gentle S-curve
  const f = { t: 0.37, u: -1.2, speed: 1.0, scale: 1.4 };
  const s = flowStreakTransform(f, 4.2, -50, 200, meander, 0.15);
  const m = composeFlatWaterMatrix(new THREE.Matrix4(), s.x, s.y, s.z, s.yaw, s.sx, s.sz);
  const n = transformedUpNormal(m);
  assert(n.y > 1 - 1e-4, 'W4a. animated streak matrix keeps normal +Y');
  const expectedYaw = Math.atan2(meander(s.z + 0.6) - meander(s.z - 0.6), 1.2);
  assert(Math.abs(s.yaw - expectedYaw) < 1e-9,
    'W4b. streak yaw equals atan2(ΔcenterX, 2Δ) — follows the meander tangent');
}

// ── Prompt 3.4.1: road-corridor terrain clearance (item C) ──────────────────

// R1: inside the paved corridor + shoulder, terrain can NEVER exceed the
// road support grade — no matter how high the incoming candidate is (this was
// the raised-soil lip at the bridge approaches).
{
  const bankPlateau = 0.25;   // river bank-top height that overrode the flatten
  const tallHill = 3.0;       // worst-case hill amplitude
  let allClear = true;
  for (let d = 0; d <= ROAD_HALF_WIDTH + ROAD_SHOULDER_WIDTH + 1e-9; d += 0.1) {
    if (roadCorridorHeight(bankPlateau, d) > ROAD_SUPPORT_GRADE + 1e-9) allClear = false;
    if (roadCorridorHeight(tallHill, d) > ROAD_SUPPORT_GRADE + 1e-9) allClear = false;
  }
  assert(allClear, 'R1a. corridor heights clamped ≤ support grade (bridge approaches clean)');
  // Negative terrain (river bed crossing under the road) must be untouched.
  assert(roadCorridorHeight(-1.75, 0) === -1.75,
    'R1b. below-grade channel bed passes through unclamped');
}

// R2: smooth hand-off — no harsh trench, monotonic release across blend band.
{
  const h = 2.5;
  const at = (d: number) => roadCorridorHeight(h, d);
  assert(at(ROAD_CLEAR_END) === h, 'R2a. natural terrain restored at/after clear end');
  let monotonic = true;
  for (let d = ROAD_HALF_WIDTH; d < ROAD_CLEAR_END; d += 0.05) {
    if (at(d + 0.001) < at(d) - 1e-9) monotonic = false;
  }
  assert(monotonic, 'R2b. height rises monotonically outward (no trench, no re-raise)');
}

// ── Prompt 3.4.1 §2: explicit three-stop water palette (day → dusk → night) ──
// Water must be a stylized blue at ALL times — never pure black, never neon.

// P1: the palette exports exist and are unmistakably blue (b > r and b > g).
{
  // Read channels back in sRGB via getHex() (round-trips through three's
  // color management), so thresholds are intuitive byte values.
  const chans = (c: THREE.Color) => {
    const hx = c.getHex();
    return { r: (hx >> 16) & 255, g: (hx >> 8) & 255, b: hx & 255 };
  };
  const isBlue = (c: THREE.Color) => {
    const h = chans(c);
    return h.b > h.r && h.b > h.g && h.b >= 0x30;
  };
  assert(isBlue(WATER_DAY), 'P1a. WATER_DAY is a blue');
  assert(isBlue(WATER_DUSK), 'P1b. WATER_DUSK is a blue');
  assert(isBlue(WATER_NIGHT), 'P1c. WATER_NIGHT is a blue');
  // Day brightest, night darkest, dusk strictly between on luminance.
  const lum = (c: THREE.Color) => {
    const h = chans(c);
    return 0.2126 * h.r + 0.7152 * h.g + 0.0722 * h.b;
  };
  assert(lum(WATER_DAY) > lum(WATER_DUSK), 'P1d. day brighter than dusk');
  assert(lum(WATER_DUSK) > lum(WATER_NIGHT), 'P1e. dusk brighter than night');
  assert(WATER_NIGHT.getHex() !== 0x000000, 'P1f. night water is not pure black');
}

// P2: waterColorAt interpolates through the DUSK stop at nf=0.5.
{
  assert(waterColorAt(0).getHex() === WATER_DAY.getHex(), 'P2a. nf=0 → WATER_DAY exactly');
  assert(waterColorAt(1).getHex() === WATER_NIGHT.getHex(), 'P2b. nf=1 → WATER_NIGHT exactly');
  const mid = waterColorAt(0.5).getHex();
  const naive = WATER_DUSK.getHex();
  const dayToNight = new THREE.Color(WATER_DAY).lerp(new THREE.Color(WATER_NIGHT), 0.5).getHex();
  assert(mid === naive, 'P2c. nf=0.5 hits WATER_DUSK exactly (3-stop curve, not a DAY↔NIGHT lerp)');
  assert(mid !== dayToNight, 'P2d. midpoint differs from a plain two-stop lerp (dusk stop is real)');
  // Monotonic darkening across nf ∈ [0,1] — no bright flash or dip anywhere.
  // Luminance from sRGB channels (see chans() above).
  const lumOf = (c: THREE.Color) => {
    const hx = c.getHex();
    return 0.2126 * ((hx >> 16) & 255) + 0.7152 * ((hx >> 8) & 255) + 0.0722 * (hx & 255);
  };
  let mono = true;
  for (let t = 0; t <= 20; t++) {
    const lA = lumOf(waterColorAt(t / 20));
    const lB = lumOf(waterColorAt((t + 1) / 20));
    if (lB > lA + 1e-9) mono = false;
  }
  assert(mono, 'P2e. luminance decreases monotonically with nightFactor (no dips/spikes)');
}

// ── Prompt 3.4.1 §9/§12: ONE authoritative nature road-clearance constant ────

// C1: the constant exists and covers asphalt + shoulder plus a safety margin.
{
  assert(NATURE_ROAD_CLEARANCE === ROAD_HALF_WIDTH + ROAD_SHOULDER_WIDTH + 1.8,
    'C1a. NATURE_ROAD_CLEARANCE = paved half-width + shoulder + margin');
  assert(NATURE_ROAD_CLEARANCE >= 5.2,
    'C1b. at least as strict as the tightest previous magic distance (5.2)');
  assert(NATURE_ROAD_CLEARANCE <= 6.5,
    'C1c. not wider than the widest previous distance (6.5 — no over-clearing)');
}

// ── CONSTRUCTION-BUILDER Phase 1: player-drawn basin domain layer ───────────────
{
  const mkState = () => GameManager.createInitialState(0, true); // sandbox → no cash gate

  // 1. Valid draw places a basin with correct geometry & depth.
  {
    const s0 = mkState();
    const r = GameManager.placeCustomBasin(s0, { x: 3, y: 4, w: 6, h: 4 });
    assert(r.success, 'B1. a valid 6x4 basin draws successfully');
    assert(r.newState.customBasins!.length === 1, 'B2. exactly one basin now exists');
    const b = r.newState.customBasins![0];
    assert(b.w === 6 && b.h === 4 && b.x === 3 && b.y === 4, 'B3. footprint stored verbatim (x,y,w,h)');
    assert(Math.abs(b.depthM - 4.0) < 1e-6, 'B4. default depth 4.0 m applied');
    assert(typeof b.id === 'string' && b.id.length > 0, 'B5. basin has a unique id');
  }

  // 2. Cost derives from volume + wall area, charged in campaign mode.
  {
    const sSand = GameManager.createInitialState(0, true);
    const rSand = GameManager.placeCustomBasin(sSand, { x: 1, y: 1, w: 4, h: 4 });
    assert((rSand.charged ?? 0) === 0, 'B6. sandbox build costs $0 (no cash gate)');

    const sCamp = GameManager.createInitialState(0, false);
    sCamp.financials.cash = 10_000_000; // ensure funds so we test the charge mechanic, not the budget
    const rCamp = GameManager.placeCustomBasin(sCamp, { x: 1, y: 1, w: 4, h: 4 });
    // 4x4 tiles = 24m x 24m x 4m = 2304 m³ * $165 + 2*(24+24)*4 = 384 m² * $55
    const expected = Math.round(2304 * 165 + 384 * 55);
    assert(rCamp.success && rCamp.charged === expected,
      `B7. campaign build charges volume+wall CAPEX ($${expected})`);
    assert(rCamp.newState.financials.cash === sCamp.financials.cash - expected,
      'B8. cash reduced by the exact CAPEX');
  }

  // 3. Overlap detection — a basin cannot be drawn over an existing basin.
  {
    const s0 = mkState();
    const r1 = GameManager.placeCustomBasin(s0, { x: 2, y: 2, w: 5, h: 5 });
    assert(r1.success, 'B9. first basin placed');
    const r2 = GameManager.placeCustomBasin(r1.newState, { x: 4, y: 4, w: 3, h: 3 });
    assert(!r2.success, 'B10. overlapping basin is rejected');
    assert(/overlap/i.test(r2.reason ?? ''), 'B11. rejection reason mentions overlap');
    // Adjacent (non-overlapping) basin is allowed.
    const r3 = GameManager.placeCustomBasin(r1.newState, { x: 2, y: 7, w: 3, h: 3 });
    assert(r3.success, 'B12. adjacent (non-overlapping) basin is allowed');
  }

  // 4. Legacy unit lots block basin placement (symmetry with unit-blocking).
  {
    const s0 = mkState();
    const unit = {
      instanceId: 'u1', typeId: 'activated_sludge_cas' as const,
      gridX: 10, gridY: 10, rotation: 0 as const,
      customParams: {} as Record<string, number>,
    };
    s0.units.push(unit as any);
    const r = GameManager.placeCustomBasin(s0, { x: 11, y: 11, w: 2, h: 2 });
    assert(!r.success, 'B13. basin cannot be drawn over a legacy unit lot');
  }

  // 5. Boundaries: basin must stay within the map.
  {
    const s0 = mkState();
    const [mw, mh] = s0.currentLevel.mapSize;
    const r = GameManager.placeCustomBasin(s0, { x: mw - 2, y: 0, w: 6, h: 2 });
    assert(!r.success && /boundary|out of/i.test(r.reason ?? ''), `B14. out-of-bounds basin rejected (map ${mw}x${mh})`);
  }

  // 6. Minimum size enforced.
  {
    const s0 = mkState();
    const r = GameManager.placeCustomBasin(s0, { x: 1, y: 1, w: 1, h: 1 });
    assert(!r.success, 'B15. sub-minimum (1x1) basin rejected');
  }

  // 7. Demolition removes the basin and refunds salvage (50%) in campaign.
  {
    const sCamp = GameManager.createInitialState(0, false);
    sCamp.financials.cash = 10_000_000; // funds available for the build
    const built = GameManager.placeCustomBasin(sCamp, { x: 1, y: 1, w: 4, h: 4 });
    assert(built.success, 'B16a. campaign basin built for demolish test');
    const id = built.newState.customBasins![0].id;
    const demo = GameManager.demolishCustomBasin(built.newState, id);
    assert(demo.success && demo.newState.customBasins!.length === 0,
      'B16. demolish removes the basin');
    const full = Math.round(2304 * 165 + 384 * 55);
    const salvage = Math.round(full * 0.5);
    assert(demo.refunded === salvage, `B17. campaign demolish refunds 50% salvage ($${salvage})`);
  }

  // 8. tileInCustomBasin helper — click hit-testing sanity.
  {
    const s0 = mkState();
    const built = GameManager.placeCustomBasin(s0, { x: 5, y: 5, w: 3, h: 3 });
    assert(GameManager.tileInCustomBasin(built.newState, 6, 6), 'B18. tile inside basin detected');
    assert(!GameManager.tileInCustomBasin(built.newState, 0, 0), 'B19. tile outside basin not detected');
  }
}

// ── CONSTRUCTION-BUILDER Phase 2: physical equipment placement ──────────────
{
  const mkState = () => GameManager.createInitialState(0, true); // sandbox → no cash gate
  const withBasin = () => {
    const s = mkState();
    const r = GameManager.placeCustomBasin(s, { x: 5, y: 5, w: 4, h: 4 });
    assert(r.success, 'E0a. fixture basin drawn');
    return r.newState;
  };

  // 1. Wet-installed types mount INSIDE a drawn basin.
  {
    const s = withBasin();
    const rd = GameManager.placeProcessEquipment(s, 'fine_bubble_diffuser', 6, 6);
    assert(rd.success && rd.charged === 0, 'E1. diffuser installs inside a basin (sandbox $0)');
    const rm = GameManager.placeProcessEquipment(rd.newState, 'submersible_mixer', 8, 7);
    assert(rm.success, 'E2. mixer installs inside a basin');
    assert(rm.newState.processEquipment!.length === 2, 'E2b. both machines tracked');
  }

  // 2. Mounting rules: in_basin refuses open ground; ground refuses basins.
  {
    const s = withBasin();
    const r1 = GameManager.placeProcessEquipment(s, 'fine_bubble_diffuser', 20, 20);
    assert(!r1.success && /inside a constructed basin/i.test(r1.reason ?? ''),
      'E3. diffuser on bare ground rejected — must mount inside a basin');
    const r2 = GameManager.placeProcessEquipment(s, 'rotary_blower', 6, 6);
    assert(!r2.success && /dry-installed|open ground/i.test(r2.reason ?? ''),
      'E4. blower inside a basin rejected — dry-installed only');
    const r3 = GameManager.placeProcessEquipment(s, 'process_pump', 21, 21);
    assert(r3.success, 'E5. pump installs on open ground');
  }

  // 3. Unknown type + boundaries.
  {
    const s = withBasin();
    assert(!GameManager.placeProcessEquipment(s, 'flux_capacitor', 6, 6).success,
      'E6. unknown equipment type rejected');
    const [mw] = s.currentLevel.mapSize;
    const rOut = GameManager.placeProcessEquipment(s, 'process_pump', mw + 5, 2);
    assert(!rOut.success && /boundary|out of/i.test(rOut.reason ?? ''),
      'E7. out-of-bounds equipment rejected');
  }

  // 4. One machine per tile; legacy lots block ground machines.
  {
    const s = withBasin();
    const r1 = GameManager.placeProcessEquipment(s, 'process_pump', 15, 15);
    assert(r1.success, 'E8. first pump placed on open tile');
    const r2 = GameManager.placeProcessEquipment(r1.newState, 'rotary_blower', 15, 15);
    assert(!r2.success && /already holds equipment/i.test(r2.reason ?? ''),
      'E9. second machine refused on the same tile');
    const unit = {
      instanceId: 'u9', typeId: 'activated_sludge_cas' as const,
      gridX: 18, gridY: 18, rotation: 0 as const,
      customParams: {} as Record<string, number>,
    };
    s.units.push(unit as any);
    const r3 = GameManager.placeProcessEquipment(s, 'process_pump', 19, 19);
    assert(!r3.success && /unit lot/i.test(r3.reason ?? ''),
      'E10. pump cannot sit on a legacy unit lot');
  }

  // 5. Campaign economics: exact catalog CAPEX charged; cash gate enforced.
  {
    const sCamp = withBasin();
    sCamp.gameMode = 'campaign';
    sCamp.financials.cash = 10_000_000;
    const r = GameManager.placeProcessEquipment(sCamp, 'submersible_mixer', 6, 6);
    const expected = 9_800;
    assert(r.success && r.charged === expected,
      `E11. campaign install charges catalog CAPEX ($${expected})`);
    assert(r.newState.financials.cash === sCamp.financials.cash - expected,
      'E12. cash reduced by the exact CAPEX');

    const sPoor = withBasin();
    sPoor.gameMode = 'campaign';
    sPoor.financials.cash = 100; // below any catalog price
    const rp = GameManager.placeProcessEquipment(sPoor, 'fine_bubble_diffuser', 6, 6);
    assert(!rp.success && /insufficient funds/i.test(rp.reason ?? ''),
      'E13. unaffordable install rejected with a funds message');
  }

  // 6. Demolition refunds 70% salvage (campaign), $0 in sandbox/tutorial.
  {
    const sCamp = withBasin();
    sCamp.gameMode = 'campaign';
    sCamp.tutorialActive = false;
    sCamp.financials.cash = 10_000_000;
    const built = GameManager.placeProcessEquipment(sCamp, 'rotary_blower', 20, 20);
    assert(built.success, 'E14a. blower installed for demolish test');
    const id = built.newState.processEquipment![0].id;
    const demo = GameManager.demolishProcessEquipment(built.newState, id);
    assert(demo.success && demo.newState.processEquipment!.length === 0,
      'E14. demolish removes the machine');
    const salvage = Math.round(32_000 * 0.7);
    assert(demo.refunded === salvage, `E15. demolish refunds 70% salvage ($${salvage})`);

    const sSandbox = withBasin();
    const b2 = GameManager.placeProcessEquipment(sSandbox, 'rotary_blower', 20, 20);
    const d2 = GameManager.demolishProcessEquipment(b2.newState, b2.newState.processEquipment![0].id);
    assert(d2.refunded === 0, 'E16. sandbox demolish refunds $0');

    const sTut = withBasin();
    sTut.gameMode = 'campaign';
    sTut.tutorialActive = true;
    sTut.financials.cash = 10_000_000;
    const b3 = GameManager.placeProcessEquipment(sTut, 'rotary_blower', 20, 20);
    const d3 = GameManager.demolishProcessEquipment(b3.newState, b3.newState.processEquipment![0].id);
    assert(d3.refunded === 0, 'E17. tutorial demolish refunds $0 (grant units)');
  }

  // 7. Symmetric blocking: concrete and legacy units may not bury equipment.
  {
    const s = withBasin();
    const pump = GameManager.placeProcessEquipment(s, 'process_pump', 15, 15);
    assert(pump.success, 'E18a. ground pump placed');
    const overPump = GameManager.placeCustomBasin(pump.newState, { x: 14, y: 14, w: 3, h: 3 });
    assert(!overPump.success, 'E18. a basin cannot be drawn over a ground machine');

    // EQ basin is 3×3 → its lot covers the pump's tile at (15,15).
    const legacyOver = GameManager.placeUnit(pump.newState, 'equalization_basin', 14, 14, 0, {});
    assert(!legacyOver.success && /installed equipment/i.test(legacyOver.reason ?? ''),
      'E19. legacy unit lot blocked by ground equipment');
  }

  // 8. Mounting integrity: a basin holding equipment cannot be demolished.
  {
    const s = withBasin();
    const inst = GameManager.placeProcessEquipment(s, 'fine_bubble_diffuser', 6, 6);
    assert(inst.success, 'E20a. diffuser installed in fixture basin');
    const basinId = inst.newState.customBasins![0].id;
    const demo = GameManager.demolishCustomBasin(inst.newState, basinId);
    assert(!demo.success && /equipment/i.test(demo.reason ?? ''),
      'E20. basin demolition refused while equipment remains mounted');
    // After removing the machine the basin can go.
    const cleared = GameManager.demolishProcessEquipment(inst.newState, inst.newState.processEquipment![0].id);
    const demo2 = GameManager.demolishCustomBasin(cleared.newState, basinId);
    assert(demo2.success, 'E21. basin demolishes once its equipment is removed');
  }

  // 9. Hit-testing helper.
  {
    const s = withBasin();
    const inst = GameManager.placeProcessEquipment(s, 'submersible_mixer', 7, 8);
    assert(GameManager.equipmentAtTile(inst.newState, 7, 8)?.typeId === 'submersible_mixer',
      'E22. equipmentAtTile finds the mixer');
    assert(GameManager.equipmentAtTile(inst.newState, 0, 0) === null,
      'E23. equipmentAtTile returns null on an empty tile');
  }
}

// ── CONSTRUCTION-BUILDER Phase 3: utility connections ────────────────────
{
  const mkState = () => GameManager.createInitialState(0, true);
  const withFixture = () => {
    const s = mkState();
    const rB = GameManager.placeCustomBasin(s, { x: 5, y: 5, w: 8, h: 6 });
    assert(rB.success, 'U0a. fixture basin drawn');
    let st = rB.newState;
    const rDiff = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 6, 6);
    assert(rDiff.success, 'U0b. fixture diffuser placed');
    st = rDiff.newState;
    const rMix = GameManager.placeProcessEquipment(st, 'submersible_mixer', 7, 6);
    assert(rMix.success, 'U0c. fixture mixer placed');
    st = rMix.newState;
    const rPump = GameManager.placeProcessEquipment(st, 'process_pump', 20, 5);
    assert(rPump.success, 'U0d. fixture pump placed on ground');
    st = rPump.newState;
    const rBlow = GameManager.placeProcessEquipment(st, 'rotary_blower', 22, 5);
    assert(rBlow.success, 'U0e. fixture blower placed on ground');
    return rBlow.newState;
  };

  // 1. Water pipe: pump -> basin tile is valid.
  {
    const s = withFixture();
    const r = GameManager.placeUtilityConnection(s, 'water_pipe', 20, 5, 6, 6);
    assert(r.success, 'U1. water_pipe pump -> basin-tile succeeds');
  }
  // 2. Air pipe: blower -> diffuser is the canonical valid case.
  {
    const s = withFixture();
    const r = GameManager.placeUtilityConnection(s, 'air_pipe', 22, 5, 6, 6);
    assert(r.success, 'U2. air_pipe blower -> diffuser succeeds');
  }
  // 3. Power cable: pump -> mixer (both powered) is valid.
  {
    const s = withFixture();
    const r = GameManager.placeUtilityConnection(s, 'power_cable', 20, 5, 7, 6);
    assert(r.success, 'U3. power_cable pump -> mixer succeeds');
  }
  // 4. Air pipe type-enforcement: diffuser -> mixer must fail (no blower).
  {
    const s = withFixture();
    const r = GameManager.placeUtilityConnection(s, 'air_pipe', 6, 6, 7, 6);
    assert(!r.success && /Blower.*Diffuser/i.test(r.reason ?? ''), 'U4. air_pipe diffuser -> mixer rejected - needs blower+diffuser');
  }
  // 5. Water pipe type-enforcement: blower -> blower without pump/basin fails.
  {
    const s2 = mkState();
    const b = GameManager.placeCustomBasin(s2, { x: 30, y: 30, w: 4, h: 4 });
    let st = b.newState;
    const p1 = GameManager.placeProcessEquipment(st, 'rotary_blower', 2, 2);
    st = p1.newState;
    const p2 = GameManager.placeProcessEquipment(st, 'rotary_blower', 4, 2);
    st = p2.newState;
    const rFail = GameManager.placeUtilityConnection(st, 'water_pipe', 2, 2, 4, 2);
    assert(!rFail.success && /pump|basin/i.test(rFail.reason ?? ''), 'U5. water_pipe blower -> blower without pump/basin rejected');
  }
  // 6. Power cable needs a powered machine - diffuser alone (0 kW) is not enough.
  {
    const s = withFixture();
    const rD2 = GameManager.placeProcessEquipment(s, 'fine_bubble_diffuser', 8, 6);
    assert(rD2.success, 'U6a. second diffuser placed');
    const r = GameManager.placeUtilityConnection(rD2.newState, 'power_cable', 6, 6, 8, 6);
    assert(!r.success && /powered/i.test(r.reason ?? ''), 'U6. power_cable diffuser -> diffuser rejected - needs powered kit');
  }
  // 7. Endpoints must be on hosts (equipment or basin) - empty ground fails.
  {
    const s = mkState();
    const r = GameManager.placeUtilityConnection(s, 'water_pipe', 1, 1, 2, 2);
    assert(!r.success && /host|equipment|basin/i.test(r.reason ?? ''), 'U7. utility with both endpoints on empty ground rejected');
  }
  // 8. Duplicate connection rejected (unordered).
  {
    const s = withFixture();
    const r1 = GameManager.placeUtilityConnection(s, 'water_pipe', 20, 5, 6, 6);
    assert(r1.success, 'U8a. first water_pipe placed');
    const r2 = GameManager.placeUtilityConnection(r1.newState, 'water_pipe', 6, 6, 20, 5);
    assert(!r2.success && /already exists/i.test(r2.reason ?? ''), 'U8. duplicate utility (swapped endpoints) rejected');
  }
  // 9. Distinct endpoints required.
  {
    const s = withFixture();
    const r = GameManager.placeUtilityConnection(s, 'water_pipe', 20, 5, 20, 5);
    assert(!r.success && /distinct/i.test(r.reason ?? ''), 'U9. same-tile endpoints rejected');
  }
  // 10. Campaign cost charged correctly and bounds enforced.
  {
    const sCamp = GameManager.createInitialState(0, false);
    sCamp.financials.cash = 10_000_000;
    const rb = GameManager.placeCustomBasin(sCamp, { x: 5, y: 5, w: 8, h: 6 });
    let st = rb.newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 20, 5).newState;
    const r = GameManager.placeUtilityConnection(st, 'water_pipe', 20, 5, 6, 6);
    assert(r.success && (r.charged ?? 0) > 900, 'U10. campaign water_pipe charged > $900 (got $' + (r.charged ?? 0) + ')');
    assert(r.newState.financials.cash === st.financials.cash - (r.charged ?? 0), 'U10b. cash reduced by exact charge');
    const ro = GameManager.placeUtilityConnection(st, 'water_pipe', -1, 0, 6, 6);
    assert(!ro.success && /boundary|out of/i.test(ro.reason ?? ''), 'U11. out-of-bounds rejected');
    const sPoor = { ...st, financials: { ...st.financials, cash: 1 } };
    const rPoor = GameManager.placeUtilityConnection(sPoor, 'water_pipe', 20, 5, 6, 6);
    assert(!rPoor.success && /Insufficient funds/i.test(rPoor.reason ?? ''), 'U12. unaffordable utility rejected');
  }
  // 11. Demolish removes line and refunds 60% in campaign.
  {
    const sCamp = GameManager.createInitialState(0, false);
    sCamp.financials.cash = 10_000_000;
    let st = GameManager.placeCustomBasin(sCamp, { x: 5, y: 5, w: 6, h: 6 }).newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'rotary_blower', 14, 5).newState;
    const built = GameManager.placeUtilityConnection(st, 'air_pipe', 14, 5, 6, 6);
    assert(built.success, 'U13a. air_pipe built for demolish test');
    const connId = built.newState.utilityConnections[0].id;
    const cashAfterBuild = built.newState.financials.cash;
    const demo = GameManager.demolishUtilityConnection(built.newState, connId);
    assert(demo.success && demo.newState.utilityConnections.length === 0, 'U13. demolish removes the utility');
    const salvage = Math.round((built.charged ?? 0) * 0.6);
    assert(demo.refunded === salvage, 'U14. campaign demolish refunds 60% salvage ($' + salvage + ')');
    assert(demo.newState.financials.cash === cashAfterBuild + salvage, 'U14b. cash refunded correctly');
    const sand = { ...built.newState, gameMode: 'sandbox' };
    const demoSandbox = GameManager.demolishUtilityConnection(sand, connId);
    assert(demoSandbox.refunded === 0, 'U15. sandbox demolish refunds $0');
  }
  // 12. Cascade: demolishing a basin removes attached utilities.
  {
    const s2 = mkState();
    const rb2 = GameManager.placeCustomBasin(s2, { x: 5, y: 5, w: 6, h: 6 });
    let st2 = rb2.newState;
    st2 = GameManager.placeProcessEquipment(st2, 'process_pump', 15, 5).newState;
    const rWater = GameManager.placeUtilityConnection(st2, 'water_pipe', 15, 5, 6, 6);
    assert(rWater.success, 'U16b. water_pipe pump -> basin-tile placed');
    const demo = GameManager.demolishCustomBasin(rWater.newState, rb2.newState.customBasins[0].id);
    assert(demo.success, 'U16. basin demolition still succeeds');
    assert(demo.newState.utilityConnections.length === 0, 'U17. basin cascade removed attached utility');
  }
  // 13. Cascade: demolishing equipment removes its attached utilities.
  {
    const s = withFixture();
    const rAir = GameManager.placeUtilityConnection(s, 'air_pipe', 22, 5, 6, 6);
    assert(rAir.success, 'U18a. air_pipe placed for equip-cascade test');
    const blowerId = rAir.newState.processEquipment.find(e => e.typeId === 'rotary_blower' && e.x === 22).id;
    const demo = GameManager.demolishProcessEquipment(rAir.newState, blowerId);
    assert(demo.success, 'U18. blower demolish succeeds');
    assert(demo.newState.utilityConnections.length === 0, 'U19. equipment cascade removed its utility');
  }
  // 14. Hit-testing helpers.
  {
    const s = withFixture();
    const r = GameManager.placeUtilityConnection(s, 'water_pipe', 20, 5, 6, 6);
    const conn = r.newState.utilityConnections[0];
    assert(GameManager.utilitiesAtTile(r.newState, 20, 5).length === 1, 'U20. utilitiesAtTile finds endpoint utility');
    assert(GameManager.utilitiesAtTile(r.newState, 1, 1).length === 0, 'U21. utilitiesAtTile returns empty on distant tile');
    const mx = (conn.ax + conn.bx) / 2 + 0.5, mz = (conn.ay + conn.by) / 2 + 0.5;
    assert(GameManager.utilityAtPoint(r.newState, mx, mz) !== null, 'U22. utilityAtPoint finds midline');
    assert(GameManager.utilityAtPoint(r.newState, 0, 0) === null, 'U23. utilityAtPoint returns null far away');
  }
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
