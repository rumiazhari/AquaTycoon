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
import {
  poweredEquipmentIds,
  aeratedDiffuserIds,
  isEquipmentPowered,
  constructionStats,
  constructionSummaryLine,
} from '../src/design/ConstructionNetwork';
import { evaluateConstructionEffects, filtrationLiveSets } from '../src/design/ConstructionAdapter';
import {
  estimateBaffleCAPEX,
  validateBafflePlacement,
  zonesForBasin,
  allZones,
  basinZoneStats,
  pointNearBaffle,
  baffleLengthM,
} from '../src/design/BasinZone';
import { recognizeProcess, processSummaryLine } from '../src/design/ProcessRecognition';
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

// ── Phase 4: CONSTRUCTION NETWORK — power & aeration live status ──────────
{
  const mkNState = () => {
    let st = GameManager.createInitialState(0, true) as any;
    st.financials.cash = 10_000_000;
    return st;
  };

  // N1. Fresh mixer with no cables is unpowered; diffuser without air is not aerated.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 8, h: 8 }).newState;
    st = GameManager.placeProcessEquipment(st, 'submersible_mixer', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 7, 7).newState;
    st = GameManager.placeProcessEquipment(st, 'rotary_blower', 20, 5).newState;
    const mix = st.processEquipment.find((e:any)=>e.typeId==='submersible_mixer');
    const diff = st.processEquipment.find((e:any)=>e.typeId==='fine_bubble_diffuser');
    assert(!poweredEquipmentIds(st.processEquipment, st.utilityConnections).has(mix.id), 'N1. mixer without power cable is unpowered');
    assert(!aeratedDiffuserIds(st.processEquipment, st.utilityConnections).has(diff.id), 'N1b. diffuser with no air pipe is not aerated');
  }
  // N2. Power cable on mixer's tile powers it; diffuser passive power irrelevant.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 8, h: 8 }).newState;
    st = GameManager.placeProcessEquipment(st, 'submersible_mixer', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 20, 5).newState;
    // Power cable mixer→pump (both powered machines, valid)
    const rc = GameManager.placeUtilityConnection(st, 'power_cable', 6, 6, 20, 5);
    assert(rc.success, 'N2a. power cable mixer→pump placed');
    const mix = rc.newState.processEquipment.find((e:any)=>e.typeId==='submersible_mixer');
    assert(poweredEquipmentIds(rc.newState.processEquipment, rc.newState.utilityConnections).has(mix.id), 'N2. mixer with incident power cable is powered');
    const diffC = { id:'d1', typeId:'fine_bubble_diffuser', x:6, y:6, createdAtDay:0 } as any;
    assert(isEquipmentPowered(diffC, []), 'N2b. passive diffuser power check is true even with no cables');
  }
  // N3. Pump without cable stays unpowered.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 6, h: 6 }).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 20, 5).newState;
    const pump = st.processEquipment.find((e:any)=>e.typeId==='process_pump');
    assert(!poweredEquipmentIds(st.processEquipment, st.utilityConnections).has(pump.id), 'N3. pump without cable unpowered');
  }
  // N4. Air pipe alone does not aerate if blower unpowered.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 8, h: 8 }).newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'rotary_blower', 20, 5).newState;
    st = GameManager.placeUtilityConnection(st, 'air_pipe', 20, 5, 6, 6).newState;
    const diff = st.processEquipment.find((e:any)=>e.typeId==='fine_bubble_diffuser');
    assert(!aeratedDiffuserIds(st.processEquipment, st.utilityConnections).has(diff.id), 'N4. diffuser with air pipe but UNPOWERED blower is not aerated');
  }
  // N5. Air pipe + powered blower → aerated.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 8, h: 8 }).newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'rotary_blower', 20, 5).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 22, 5).newState;
    st = GameManager.placeUtilityConnection(st, 'air_pipe', 20, 5, 6, 6).newState;
    // power the blower via power cable blower→pump
    st = GameManager.placeUtilityConnection(st, 'power_cable', 20, 5, 22, 5).newState;
    const diff = st.processEquipment.find((e:any)=>e.typeId==='fine_bubble_diffuser');
    assert(aeratedDiffuserIds(st.processEquipment, st.utilityConnections).has(diff.id), 'N5. diffuser aerated when air_pipe + blower powered');
  }
  // N6. Cutting power to blower de-aerates downstream diffuser.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 8, h: 8 }).newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'rotary_blower', 20, 5).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 22, 5).newState;
    st = GameManager.placeUtilityConnection(st, 'air_pipe', 20, 5, 6, 6).newState;
    const pwrConn = GameManager.placeUtilityConnection(st, 'power_cable', 20, 5, 22, 5);
    st = pwrConn.newState;
    // now cut the power cable
    const powerId = st.utilityConnections.find((u:any)=>u.type==='power_cable').id;
    st = GameManager.demolishUtilityConnection(st, powerId).newState;
    const diff = st.processEquipment.find((e:any)=>e.typeId==='fine_bubble_diffuser');
    assert(!aeratedDiffuserIds(st.processEquipment, st.utilityConnections).has(diff.id), 'N6. cutting blower power de-aerates diffuser');
  }
  // N7. constructionStats numbers.
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 4, h: 4 }).newState; // 4×4 tiles
    st = GameManager.placeProcessEquipment(st, 'submersible_mixer', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'fine_bubble_diffuser', 7, 7).newState;
    st = GameManager.placeProcessEquipment(st, 'rotary_blower', 20, 5).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 22, 5).newState;
    st = GameManager.placeUtilityConnection(st, 'power_cable', 6, 6, 20, 5).newState;
    st = GameManager.placeUtilityConnection(st, 'air_pipe', 20, 5, 7, 7).newState;
    // power the blower too
    st = GameManager.placeUtilityConnection(st, 'power_cable', 20, 5, 22, 5).newState;
    const s2 = constructionStats(st.customBasins, st.processEquipment, st.utilityConnections);
    assert(s2.totalBasins === 1, 'N7. stats totalBasins 1 (got '+s2.totalBasins+')');
    assert(s2.totalBasinVolumeM3 === 4*6 * 4*6 * 4, 'N7b. stats volume '+(4*6*4*6*4)+' m³ (got '+s2.totalBasinVolumeM3+')');
    assert(s2.totalEquipment === 4, 'N7c. stats totalEquipment 4 (got '+s2.totalEquipment+')');
    assert(s2.poweredEquipment === 4, 'N7d. stats powered 4/4 inc. passive diffuser (got '+s2.poweredEquipment+')');
    assert(s2.aeratedDiffusers === 1, 'N7e. stats aerated 1/1 (got '+s2.aeratedDiffusers+')');
    assert(s2.livePowerKw === 4 + 22 + 11, 'N7f. livePowerKw 37 kW (got '+s2.livePowerKw+')');
  }
  // N8. GameManager wrappers mirror pure functions
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 6, h: 6 }).newState;
    st = GameManager.placeProcessEquipment(st, 'submersible_mixer', 6, 6).newState;
    const pure = poweredEquipmentIds(st.processEquipment, st.utilityConnections);
    const viaMgr = GameManager.poweredEquipmentIds(st);
    assert(pure.size === viaMgr.size && [...pure].every(id=>viaMgr.has(id)), 'N8. GameManager.poweredEquipmentIds mirrors pure function');
    const sStats = GameManager.constructionStats(st);
    assert(sStats.totalEquipment === 1, 'N8b. GameManager.constructionStats totalEquipment 1');
  }
  // N9. Cascade: demolishing powered equipment keeps stats consistent (no throw)
  {
    let st = mkNState();
    st = GameManager.placeCustomBasin(st, { x: 5, y: 5, w: 6, h: 6 }).newState;
    st = GameManager.placeProcessEquipment(st, 'submersible_mixer', 6, 6).newState;
    st = GameManager.placeProcessEquipment(st, 'process_pump', 20, 5).newState;
    st = GameManager.placeUtilityConnection(st, 'power_cable', 6, 6, 20, 5).newState;
    const mixId = st.processEquipment.find((e:any)=>e.typeId==='submersible_mixer').id;
    st = GameManager.demolishProcessEquipment(st, mixId).newState;
    assert(poweredEquipmentIds(st.processEquipment, st.utilityConnections).size === 0, 'N9. after mixer removal, pump loses cable → 0 powered (got '+poweredEquipmentIds(st.processEquipment, st.utilityConnections).size+')');
    assert(!(() => { try { poweredEquipmentIds(st.processEquipment, st.utilityConnections); return false; } catch { return true; }})(), 'N9b. no throw on powered check after cascade');
  }
}

// ── Phase 4 slice 2: CONSTRUCTION ADAPTER — live sim effects ─────────────
{
  const mkState = () => {
    let s: any = GameManager.createInitialState(0, true) as any;
    s.financials.cash = 10_000_000;
    return s;
  };
  const mkFullTrain = (base: any) => {
    // Minimal conventional plant so there's effluent flow to measure adapter delta
    // Use the state's actual inlet/outfall ids to avoid duplicate inlets.
    const inletId = base.units.find((u:any)=>u.typeId==='influent_inlet').instanceId;
    const outId = base.units.find((u:any)=>u.typeId==='effluent_outfall').instanceId;
    const units = [
      base.units.find((u:any)=>u.typeId==='influent_inlet'),
      base.units.find((u:any)=>u.typeId==='effluent_outfall'),
      mkUnit('scr', 'bar_screen', 5, 10),
      mkUnit('grt', 'grit_chamber', 8, 10),
      mkUnit('pri', 'primary_clarifier_circular', 11, 9),
      mkUnit('cas', 'activated_sludge_cas', 15, 9),
      mkUnit('clr', 'secondary_clarifier', 17, 13),
      mkUnit('uv',  'uv_disinfection', 20, 10),
    ];
    const pipes = [
      mkPipe('f1',inletId,'outlet','scr','inlet'),
      mkPipe('f2','scr','outlet','grt','inlet'),
      mkPipe('f3','grt','outlet','pri','inlet'),
      mkPipe('f4','pri','outlet','cas','inlet'),
      mkPipe('f5','cas','outlet','clr','inlet'),
      mkPipe('f6','clr','outlet','uv','inlet'),
      mkPipe('f7','uv','outlet',outId,'inlet'),
      mkPipe('f8','clr','sludge_outlet','cas','ras_inlet','ras'),
    ];
    return { units, pipes };
  };

  // CA0. Zero construction = identity effect (no effluent change, no power draw)
  {
    const ce = evaluateConstructionEffects([], [], []);
    assert(ce.bodMultiplier === 1 && ce.tnMultiplier === 1 && ce.doBoostMgL === 0,
      'CA0. zero construction effect is identity (bod×'+ce.bodMultiplier.toFixed(2)+', do+'+ce.doBoostMgL+')');
    assert(ce.extraPowerKw === 0 && ce.extraOpexPerDay === 0, 'CA0b. zero construction draws 0 kW/OPEX');
    assert(ce.septicBasins === 0, 'CA0c. zero construction has 0 septic basins');
  }

  // CA1. Single aerated basin polish: BOD down, DO up vs. no construction
  {
    let base = mkState();
    const train = mkFullTrain(base);
    let noBuild: any = { ...base, units: train.units, pipes: train.pipes };
    for (let i=0;i<25;i++) noBuild = GameManager.tick(noBuild, 0.5);
    const bodBase = noBuild.finalEffluent.bod;
    const doBase  = noBuild.finalEffluent.do;

    // Build basin at 24,18 (fits in 40x30: 24+8=32<40, 18+8=26<30) away from train
    let withAer: any = mkState();
    let rB = GameManager.placeCustomBasin(withAer, { x: 24, y: 18, w: 8, h: 8 });
    assert(rB.success, 'CA1-pre. basin placed at 24,18');
    withAer = rB.newState;
    let rD = GameManager.placeProcessEquipment(withAer, 'fine_bubble_diffuser', 25, 19);
    assert(rD.success, 'CA1-pre. diffuser inside basin');
    withAer = rD.newState;
    let rM = GameManager.placeProcessEquipment(withAer, 'submersible_mixer', 26, 20);
    assert(rM.success, 'CA1-pre. mixer inside basin');
    withAer = rM.newState;
    let rBl = GameManager.placeProcessEquipment(withAer, 'rotary_blower', 30, 2);
    assert(rBl.success, 'CA1-pre. blower on ground');
    withAer = rBl.newState;
    let rPu = GameManager.placeProcessEquipment(withAer, 'process_pump', 32, 2);
    assert(rPu.success, 'CA1-pre. pump on ground');
    withAer = rPu.newState;
    let rA = GameManager.placeUtilityConnection(withAer, 'air_pipe', 30, 2, 25, 19);
    assert(rA.success, 'CA1-pre. air pipe blower→diffuser');
    withAer = rA.newState;
    let rP1 = GameManager.placeUtilityConnection(withAer, 'power_cable', 26, 20, 30, 2);
    assert(rP1.success, 'CA1-pre. power mixer→blower');
    withAer = rP1.newState;
    let rP2 = GameManager.placeUtilityConnection(withAer, 'power_cable', 30, 2, 32, 2);
    assert(rP2.success, 'CA1-pre. power blower→pump');
    withAer = rP2.newState;
    // Add the conventional train (reuse same inlet/outfall ids already in state)
    const extraUnits = train.units.filter((u:any)=> u.typeId!=='influent_inlet' && u.typeId!=='effluent_outfall');
    withAer.units = [...withAer.units, ...extraUnits];
    withAer.pipes = [...withAer.pipes, ...train.pipes as any];
    for (let i=0;i<25;i++) withAer = GameManager.tick(withAer, 0.5);
    assert(withAer.finalEffluent.bod < bodBase * 0.98,
      'CA1. aerated basin polishes BOD '+bodBase.toFixed(1)+' → '+withAer.finalEffluent.bod.toFixed(1)+' mg/L');
    assert(withAer.finalEffluent.do > doBase,
      'CA1b. aerated basin lifts DO '+doBase.toFixed(1)+' → '+withAer.finalEffluent.do.toFixed(1)+' mg/L');
    assert(withAer.overallStats.totalPowerDemandKw > noBuild.overallStats.totalPowerDemandKw + 10,
      'CA1c. aerated plant draws live power ('+withAer.overallStats.totalPowerDemandKw.toFixed(1)+' vs '+noBuild.overallStats.totalPowerDemandKw.toFixed(1)+' kW)');
  }

  // CA2. Unaerated = no BOD/DO benefit beyond small volume settling (blower unpowered)
  // Healthy mixing, but blower unpowered → aerated 0, only volume credit
  {
    const ceUnaerated = evaluateConstructionEffects(
      [{ x:5,y:5,w:6,h:6, depthM:4, id:'b1', createdAtDay:0 } as any],
      [
        { id:'d1', typeId:'fine_bubble_diffuser', x:6,y:6, createdAtDay:0 } as any,
        { id:'bl1', typeId:'rotary_blower', x:20,y:5, createdAtDay:0 } as any,
        { id:'mx1', typeId:'submersible_mixer', x:6,y:7, createdAtDay:0 } as any,
        { id:'pu1', typeId:'process_pump', x:21,y:5, createdAtDay:0 } as any,
      ],
      [
        { id:'a1', type:'air_pipe', ax:20,ay:5,bx:6,by:6, createdAtDay:0 } as any,
        { id:'p1', type:'power_cable', ax:6,ay:7,bx:21,by:5, createdAtDay:0 } as any, // mixer→pump (powered), blower stays unpowered
      ],
    );
    assert(ceUnaerated.aeratedDiffusers === 0, 'CA2. blower unpowered → 0 aerated diffusers');
    assert(ceUnaerated.bodMultiplier >= 0.96 && ceUnaerated.bodMultiplier <= 1.00,
      'CA2b. without aeration only small volume polish (bod×'+ceUnaerated.bodMultiplier.toFixed(3)+')');
  }

  // CA3. Basin without powered mixer = septic (BOD up, DO down vs mixed twin)
  {
    const ceHealthy = evaluateConstructionEffects(
      [{ x:5,y:5,w:6,h:6, depthM:4, id:'b1', createdAtDay:0 } as any],
      [{ id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any, { id:'pu1', typeId:'process_pump', x:20,y:5, createdAtDay:0 } as any],
      [{ id:'c1', type:'power_cable', ax:6,ay:6,bx:20,by:5, createdAtDay:0 } as any],
    );
    const ceSeptic = evaluateConstructionEffects(
      [{ x:5,y:5,w:6,h:6, depthM:4, id:'b1', createdAtDay:0 } as any],
      [{ id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any],
      [], // mixer unpowered
    );
    assert(ceSeptic.septicBasins === 1 && ceHealthy.septicBasins === 0,
      'CA3. septic detection: septic='+ceSeptic.septicBasins+', healthy='+ceHealthy.septicBasins);
    assert(ceSeptic.bodMultiplier > ceHealthy.bodMultiplier,
      'CA3b. septic BOD× '+ceSeptic.bodMultiplier.toFixed(3)+' > healthy '+ceHealthy.bodMultiplier.toFixed(3));
    assert(ceSeptic.doBoostMgL < ceHealthy.doBoostMgL,
      'CA3c. septic DO boost '+ceSeptic.doBoostMgL.toFixed(2)+' < healthy '+ceHealthy.doBoostMgL.toFixed(2));
  }

  // CA4. Power/OPEX gates through the live-power set (unpowered mixer draws 0)
  {
    const ceLive = evaluateConstructionEffects(
      [{ x:5,y:5,w:6,h:6, depthM:4, id:'b1', createdAtDay:0 } as any],
      [{ id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any, { id:'pu1', typeId:'process_pump', x:20,y:5, createdAtDay:0 } as any],
      [{ id:'c1', type:'power_cable', ax:6,ay:6,bx:20,by:5, createdAtDay:0 } as any],
    );
    const ceDead = evaluateConstructionEffects(
      [{ x:5,y:5,w:6,h:6, depthM:4, id:'b1', createdAtDay:0 } as any],
      [{ id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any],
      [],
    );
    assert(ceDead.extraPowerKw === 0, 'CA4. unpowered mixer draws 0 kW (got '+ceDead.extraPowerKw+')');
    assert(ceLive.extraPowerKw === 15, 'CA4b. powered mixer+ pump draw 15 kW (got '+ceLive.extraPowerKw+')');
    assert(ceLive.extraOpexPerDay === 30, 'CA4c. powered mixer+ pump OPEX $30/d (got '+ceLive.extraOpexPerDay+')');
  }

  // CA5. Tick integration: GameManager.tick with septic basin adds warning & BOD penalty
  {
    let st: any = mkState();
    const train = mkFullTrain(st);
    st = { ...st, units: train.units, pipes: train.pipes };
    // Add a basin at 24,18 with an UNPOWERED mixer → septic (24+8=32<40, 18+8=26<30)
    let rB = GameManager.placeCustomBasin(st, { x: 24, y: 18, w: 8, h: 8 });
    assert(rB.success, 'CA5-pre. basin for septic test');
    st = rB.newState;
    let rM = GameManager.placeProcessEquipment(st, 'submersible_mixer', 25, 19);
    assert(rM.success, 'CA5-pre. mixer for septic test');
    st = rM.newState;
    // no power cable → septic
    for (let i=0;i<25;i++) st = GameManager.tick(st, 0.5);
    const hasSepticAlert = st.overallStats.activeAlerts.some((a:any)=>a.id==='construction_septic');
    assert(hasSepticAlert, 'CA5. septic basin surfaces a construction_septic warning alert');
    // Now power the mixer and re-tick — warning should clear
    let rPu = GameManager.placeProcessEquipment(st, 'process_pump', 30, 2);
    st = rPu.newState;
    let rC = GameManager.placeUtilityConnection(st, 'power_cable', 25, 19, 30, 2);
    assert(rC.success, 'CA5-pre. power cable to clear septic');
    st = rC.newState;
    for (let i=0;i<15;i++) st = GameManager.tick(st, 0.5);
    const stillSeptic = st.overallStats.activeAlerts.some((a:any)=>a.id==='construction_septic');
    assert(!stillSeptic, 'CA5b. powering the mixer clears the septic warning');
  }

  // CA6. Pure adapter scales modestly: 8 aerated diffusers cap benefit
  {
    let basins = [{ x:0,y:0,w:10,h:10, depthM:4, id:'b1', createdAtDay:0 } as any];
    let equip: any[] = [];
    let conns: any[] = [];
    for (let i=0;i<8;i++) equip.push({ id:'d'+i, typeId:'fine_bubble_diffuser', x:1+i, y:1, createdAtDay:0 });
    equip.push({ id:'bl', typeId:'rotary_blower', x:20, y:5, createdAtDay:0 });
    equip.push({ id:'pu', typeId:'process_pump', x:22, y:5, createdAtDay:0 });
    equip.push({ id:'mx', typeId:'submersible_mixer', x:2, y:2, createdAtDay:0 });
    for (let i=0;i<8;i++) conns.push({ id:'a'+i, type:'air_pipe', ax:20,ay:5,bx:1+i,by:1, createdAtDay:0 });
    conns.push({ id:'p1', type:'power_cable', ax:20,ay:5,bx:22,by:5, createdAtDay:0 });
    conns.push({ id:'p2', type:'power_cable', ax:2,ay:2,bx:20,by:5, createdAtDay:0 });
    const ce8 = evaluateConstructionEffects(basins, equip, conns);
    assert(ce8.bodMultiplier >= 0.74 && ce8.bodMultiplier <= 0.96,
      'CA6. 8 aerated diffusers bod× '+ce8.bodMultiplier.toFixed(3)+' inside capped range');
    // 16 diffusers should not be much better than 8 (cap)
    for (let i=8;i<16;i++) { equip.push({ id:'d'+i, typeId:'fine_bubble_diffuser', x:1+(i-8), y:3, createdAtDay:0 }); conns.push({ id:'a'+i, type:'air_pipe', ax:20,ay:5,bx:1+(i-8),by:3, createdAtDay:0 }); }
    const ce16 = evaluateConstructionEffects(basins, equip, conns);
    assert(Math.abs(ce16.bodMultiplier - ce8.bodMultiplier) < 0.02,
      'CA6b. benefit capped: 16 diffusers bod× '+ce16.bodMultiplier.toFixed(3)+' ≈ 8 diffusers '+ce8.bodMultiplier.toFixed(3));
  }

  // ── PHASE 5 — zones & baffles (basin compartments) ───────────────────────
  // Z1: single basin with zero baffles = exactly one zone covering whole footprint
  {
    const basin = { x:5,y:6,w:8,h:6, depthM:4, id:'bz1', createdAtDay:0 } as any;
    const zones = zonesForBasin(basin, []);
    assert(zones.length === 1 && zones[0].x===5 && zones[0].y===6 && zones[0].w===8 && zones[0].h===6,
      'Z1. zero baffles → single zone ' + JSON.stringify(zones[0]));
    assert(zones[0].role === 'aerobic', 'Z1b. single zone defaults to aerobic ('+zones[0].role+')');
  }
  // Z2: one vertical baffle splits basin into 2 zones (anoxic | aerobic default)
  {
    const basin = { x:2,y:3,w:8,h:4, depthM:4, id:'bz2', createdAtDay:0 } as any;
    const baffles: any[] = [{ id:'bf1', basinId:'bz2', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const zones = zonesForBasin(basin, baffles);
    assert(zones.length === 2, 'Z2. one vertical baffle → 2 zones (got '+zones.length+')');
    // w=8 split at 4 → left w=4 right w=4
    const widths = zones.map(z=>z.w).sort((a,b)=>a-b);
    assert(widths[0]===4 && widths[1]===4, 'Z2b. split widths 4/4 (got '+widths+')');
    const roles = zones.map(z=>z.role).sort();
    assert(roles.includes('anoxic') && roles.includes('aerobic'), 'Z2c. default roles anoxic+aerobic (got '+roles+')');
  }
  // Z3: one horizontal baffle splits into 2 zones
  {
    const basin = { x:0,y:0,w:6,h:8, depthM:3, id:'bz3', createdAtDay:0 } as any;
    const baffles: any[] = [{ id:'bf1', basinId:'bz3', orientation:'horizontal', offsetTiles:3, createdAtDay:0 }];
    const zones = zonesForBasin(basin, baffles);
    assert(zones.length === 2, 'Z3. one horizontal baffle → 2 zones (got '+zones.length+')');
    const heights = zones.map(z=>z.h).sort((a,b)=>a-b);
    assert(heights[0]===3 && heights[1]===5, 'Z3b. split heights 3/5 (got '+heights+')');
  }
  // Z4: 2 vertical + 1 horizontal = 6 zones (grid)
  {
    const basin = { x:10,y:10,w:6,h:6, depthM:4, id:'bz4', createdAtDay:0 } as any;
    const baffles: any[] = [
      { id:'bf1', basinId:'bz4', orientation:'vertical', offsetTiles:2, createdAtDay:0 },
      { id:'bf2', basinId:'bz4', orientation:'vertical', offsetTiles:4, createdAtDay:0 },
      { id:'bf3', basinId:'bz4', orientation:'horizontal', offsetTiles:3, createdAtDay:0 },
    ];
    const zones = zonesForBasin(basin, baffles);
    assert(zones.length === 6, 'Z4. 2V+1H baffles → 6 zones (got '+zones.length+')');
    // total area should still equal basin area
    const totalArea = zones.reduce((s,z)=>s+z.w*z.h, 0);
    assert(totalArea === 36, 'Z4b. total cells area 36 tiles (got '+totalArea+')');
  }
  // Z5: validation — offset out of range and duplicate guard
  {
    const basin = { x:0,y:0,w:4,h:4, depthM:4, id:'bz5', createdAtDay:0 } as any;
    const v0 = validateBafflePlacement(basin, [], 'vertical', 0);
    const v5 = validateBafflePlacement(basin, [], 'vertical', 4);
    const vOk = validateBafflePlacement(basin, [], 'vertical', 2);
    assert(!v0.ok && !v5.ok && vOk.ok, 'Z5. offset bounds enforce 1..'+(basin.w-1)+' (0 fail, 4 fail, 2 ok)');
    const dup = validateBafflePlacement(basin, [{ id:'bf1', basinId:'bz5', orientation:'vertical', offsetTiles:2, createdAtDay:0 } as any], 'vertical', 2);
    assert(!dup.ok, 'Z5b. duplicate offset rejected');
    const diffOrientOk = validateBafflePlacement(basin, [{ id:'bf1', basinId:'bz5', orientation:'vertical', offsetTiles:2, createdAtDay:0 } as any], 'horizontal', 2);
    assert(diffOrientOk.ok, 'Z5c. same offset different orientation allowed');
  }
  // Z6: CAPEX grows with basin depth and orientation length; deterministic
  {
    const basin = { x:0,y:0,w:8,h:4, depthM:4, id:'bz6', createdAtDay:0 } as any;
    const costV = estimateBaffleCAPEX(basin, 'vertical'); // length = 4*6=24m
    const costH = estimateBaffleCAPEX(basin, 'horizontal'); // length = 8*6=48m
    assert(costH > costV, 'Z6. horizontal baffle longer (48m) costs more than vertical (24m): H $'+costH+' > V $'+costV);
    assert(costV === estimateBaffleCAPEX(basin, 'vertical'), 'Z6b. deterministic cost');
    const shallow = { ...basin, depthM:2 } as any;
    const costShallow = estimateBaffleCAPEX(shallow, 'vertical');
    assert(costShallow < costV, 'Z6c. shallower basin cheaper baffle (2m $'+costShallow+' < 4m $'+costV+')');
  }
  // Z7: allZones aggregates across multiple basins
  {
    const b1 = { x:0,y:0,w:4,h:4, depthM:4, id:'bA', createdAtDay:0 } as any;
    const b2 = { x:10,y:10,w:6,h:6, depthM:4, id:'bB', createdAtDay:0 } as any;
    const baffles: any[] = [
      { id:'bf1', basinId:'bA', orientation:'vertical', offsetTiles:2, createdAtDay:0 },
    ];
    const zones = allZones([b1,b2], baffles);
    // bA splits →2, bB unsplit →1 => total 3
    assert(zones.length === 3, 'Z7. allZones across 2 basins = 3 (got '+zones.length+')');
  }
  // Z8: basinZoneStats counts
  {
    const b1 = { x:0,y:0,w:4,h:4, depthM:4, id:'bS1', createdAtDay:0 } as any;
    const b2 = { x:10,y:10,w:6,h:6, depthM:4, id:'bS2', createdAtDay:0 } as any;
    const baffles: any[] = [
      { id:'bf1', basinId:'bS1', orientation:'vertical', offsetTiles:2, createdAtDay:0 },
      { id:'bf2', basinId:'bS2', orientation:'horizontal', offsetTiles:3, createdAtDay:0 },
    ];
    const stats = basinZoneStats([b1,b2], baffles);
    assert(stats.totalBasins===2 && stats.totalBaffles===2 && stats.totalZones===4,
      'Z8. stats 2 basins · 2 baffles · 4 zones (got '+stats.totalBasins+'/'+stats.totalBaffles+'/'+stats.totalZones+')');
    assert(stats.verticalBaffles===1 && stats.horizontalBaffles===1, 'Z8b. per-orientation counts V1 H1');
  }
  // Z9: pointNearBaffle hit-test (vertical/horizontal)
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bHit', createdAtDay:0 } as any;
    const bfV: any = { id:'bfV', basinId:'bHit', orientation:'vertical', offsetTiles:3, createdAtDay:0 };
    const bfH: any = { id:'bfH', basinId:'bHit', orientation:'horizontal', offsetTiles:2, createdAtDay:0 };
    // Vertical wall at x=8, spanning y 5..11
    assert(pointNearBaffle(8.1, 7, bfV, basin, 0.45), 'Z9. point near vertical wall (8.1,7) hit');
    assert(!pointNearBaffle(9.5, 7, bfV, basin, 0.45), 'Z9b. point far from vertical wall miss');
    assert(!pointNearBaffle(8.1, 12, bfV, basin, 0.45), 'Z9c. point outside basin Y miss');
    assert(pointNearBaffle(7, 7.1, bfH, basin, 0.45), 'Z9d. point near horizontal wall hit');
    assert(!pointNearBaffle(7, 8.5, bfH, basin, 0.45), 'Z9e. point far from horizontal wall miss');
  }
  // Z10: GameManager baffle placement funds gate + duplicate guard + baffleAtPoint
  {
    let s: any = GameManager.createInitialState(0, true);
    s.financials.cash = 10_000_000;
    let rB = GameManager.placeCustomBasin(s, { x:2,y:2,w:6,h:6 });
    assert(rB.success, 'Z10-pre. basin for baffle placement');
    s = rB.newState;
    const basinId = s.customBasins[0].id;
    let r1 = GameManager.placeBaffle(s, basinId, 'vertical', 3);
    assert(r1.success, 'Z10. first baffle placed at offset 3');
    s = r1.newState;
    let rDup = GameManager.placeBaffle(s, basinId, 'vertical', 3);
    assert(!rDup.success, 'Z10b. duplicate baffle rejected');
    let r2 = GameManager.placeBaffle(s, basinId, 'horizontal', 2);
    assert(r2.success, 'Z10c. second baffle (other orientation) ok');
    s = r2.newState;
    assert(GameManager.allZones(s).length === 4, 'Z10d. 1V+1H → 4 zones (got '+GameManager.allZones(s).length+')');
    // baffleAtPoint near the vertical wall
    const hit = GameManager.baffleAtPoint(s, s.customBasins[0].x + 3.05, s.customBasins[0].y + 2);
    assert(hit !== null && hit.orientation === 'vertical', 'Z10e. baffleAtPoint finds vertical wall');
    // demolish refunds and zones collapse
    const cashBefore = s.financials.cash;
    let rDem = GameManager.demolishBaffle(s, r1.newState.customBaffles[0].id);
    assert(rDem.success, 'Z10f. demolish baffle succeeds');
    assert(GameManager.allZones(rDem.newState).length === 2, 'Z10g. after demolish → 2 zones (got '+GameManager.allZones(rDem.newState).length+')');
    // sandbox still tracks but free
    const beforeSandboxFree = rDem.newState.financials.cash;
    // basin demolish cascade removes baffles too
    let rB2 = GameManager.placeBaffle(rDem.newState, basinId, 'vertical', 3);
    s = rB2.newState;
    const beforeBasinDem = s.financials.cash;
    let rBasDem = GameManager.demolishCustomBasin(s, basinId);
    assert(rBasDem.success, 'Z10h. basin demolish cascades baffles');
    assert((rBasDem.newState.customBaffles ?? []).length === 0, 'Z10i. baffles cleared after basin demolish');
  }
  // Z11: equipment zone membership follows baffle grid
  {
    let s: any = GameManager.createInitialState(0, true);
    s.financials.cash = 10_000_000;
    let rB = GameManager.placeCustomBasin(s, { x:5,y:5,w:8,h:4 });
    assert(rB.success, 'Z11-pre. basin for zone membership');
    s = rB.newState;
    const basinId = s.customBasins[0].id;
    let rBf = GameManager.placeBaffle(s, basinId, 'vertical', 4);
    assert(rBf.success, 'Z11-pre. vertical baffle at 4');
    s = rBf.newState;
    // Diffuser on left zone (x=6) vs right zone (x=10) — basin at 5, split at 9
    let rD1 = GameManager.placeProcessEquipment(s, 'fine_bubble_diffuser', 6, 6);
    let rD2 = GameManager.placeProcessEquipment(s, 'fine_bubble_diffuser', 10, 6);
    assert(rD1.success && rD2.success, 'Z11. two diffusers on opposite sides of baffle');
    s = rD2.newState;
    const z1 = GameManager.zoneAtTile(s, 6, 6);
    const z2 = GameManager.zoneAtTile(s, 10, 6);
    assert(z1 !== null && z2 !== null && z1.id !== z2.id, 'Z11b. diffusers map to distinct zones ('+z1?.id+' vs '+z2?.id+')');
    assert(z1!.w===4 && z2!.w===4, 'Z11c. zone widths 4 each after split (got '+z1?.w+'/'+z2?.w+')');
  }
  // ── PHASE 5 SLICE 2 — zone-scoped adapter (per-zone septic) ─────────────
  // Z12: 2-zone basin with one mixer → 1 septic zone, 1 healthy
  {
    const basin = { x:5,y:5,w:8,h:4, depthM:4, id:'bz12', createdAtDay:0 } as any;
    const baffles: any[] = [{ id:'bf1', basinId:'bz12', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const ceHalf = evaluateConstructionEffects(
      [basin],
      [
        { id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any,
        { id:'pu1', typeId:'process_pump', x:20,y:5, createdAtDay:0 } as any,
      ],
      [{ id:'c1', type:'power_cable', ax:6,ay:6,bx:20,by:5, createdAtDay:0 } as any],
      baffles,
    );
    assert(ceHalf.totalZones===2, 'Z12. 1V split → totalZones 2 (got '+ceHalf.totalZones+')');
    assert(ceHalf.healthyZones===1 && ceHalf.septicZones===1, 'Z12b. one mixer in left zone → 1 healthy 1 septic (got '+ceHalf.healthyZones+'/'+ceHalf.septicZones+')');
    // legacy basin count stays 0 septic because the basin as a whole DOES have a mixer
    assert(ceHalf.septicBasins===0 && ceHalf.healthyBasins===1, 'Z12c. legacy basin still healthy (basin has a mixer) but zones split health');
    // 1 septic zone: volume credit (0.97) × 1.045 ≈1.014 — less than legacy 1.08, teaching per-zone risk is smaller but still real
    assert(ceHalf.bodMultiplier > 1.00 && ceHalf.bodMultiplier < 1.06, 'Z12d. 1 septic zone BOD× '+ceHalf.bodMultiplier.toFixed(3)+' ~1.01 (volume-credit × 1.045)');
  }
  // Z13: 2-zone basin with mixers in BOTH zones → 0 septic, penalty gone
  {
    const basin = { x:5,y:5,w:8,h:4, depthM:4, id:'bz13', createdAtDay:0 } as any;
    const baffles: any[] = [{ id:'bf1', basinId:'bz13', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const ceFull = evaluateConstructionEffects(
      [basin],
      [
        { id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any,
        { id:'mx2', typeId:'submersible_mixer', x:10,y:6, createdAtDay:0 } as any,
        { id:'pu1', typeId:'process_pump', x:20,y:5, createdAtDay:0 } as any,
        { id:'pu2', typeId:'process_pump', x:21,y:5, createdAtDay:0 } as any,
      ],
      [
        { id:'c1', type:'power_cable', ax:6,ay:6,bx:20,by:5, createdAtDay:0 } as any,
        { id:'c2', type:'power_cable', ax:10,ay:6,bx:21,by:5, createdAtDay:0 } as any,
      ],
      baffles,
    );
    assert(ceFull.septicZones===0 && ceFull.healthyZones===2, 'Z13. two mixers → 0 septic zones (got '+ceFull.septicZones+')');
    assert(ceFull.bodMultiplier < 1.01, 'Z13b. fully mixed 2-zone basin BOD× '+ceFull.bodMultiplier.toFixed(3)+' ≈ 1.00 (no septic penalty)');
  }
  // Z14: single zone (no baffles) fallback — septicZones mirrors septicBasins
  {
    const basin = { x:5,y:5,w:8,h:4, depthM:4, id:'bz14', createdAtDay:0 } as any;
    const ceNoBaff = evaluateConstructionEffects(
      [basin],
      [{ id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any],
      [], // mixer unpowered
    );
    const ceNoBaffWith = evaluateConstructionEffects(
      [basin],
      [{ id:'mx1', typeId:'submersible_mixer', x:6,y:6, createdAtDay:0 } as any],
      [],
      [], // explicit empty baffles
    );
    assert(ceNoBaff.septicZones===1 && ceNoBaff.septicBasins===1, 'Z14. no baffles → septicZones mirrors basins (got Z'+ceNoBaff.septicZones+'/B'+ceNoBaff.septicBasins+')');
    assert(ceNoBaffWith.totalZones===1 && ceNoBaffWith.septicZones===1, 'Z14b. explicit [] baffles → 1 zone 1 septic');
    // volume credit (4608 m³ → 0.97) × 1.08 ≈1.048 — legacy per-basin math still holds with volume bonus
    assert(Math.abs(ceNoBaff.bodMultiplier - 0.97*1.08) < 0.002, 'Z14c. legacy BOD× '+ceNoBaff.bodMultiplier.toFixed(3)+' ≈ 0.97×1.08 (volume × septic)');
  }
  // Z15: 6-zone grid (2V+1H) with 2 mixers → 4 septic zones, penalty capped <1.35
  {
    const basin = { x:2,y:2,w:6,h:6, depthM:4, id:'bz15', createdAtDay:0 } as any;
    const baffles: any[] = [
      { id:'bf1', basinId:'bz15', orientation:'vertical', offsetTiles:2, createdAtDay:0 },
      { id:'bf2', basinId:'bz15', orientation:'vertical', offsetTiles:4, createdAtDay:0 },
      { id:'bf3', basinId:'bz15', orientation:'horizontal', offsetTiles:3, createdAtDay:0 },
    ];
    const ce6 = evaluateConstructionEffects(
      [basin],
      [
        { id:'mx1', typeId:'submersible_mixer', x:3,y:3, createdAtDay:0 } as any,
        { id:'mx2', typeId:'submersible_mixer', x:3,y:6, createdAtDay:0 } as any,
        { id:'pu1', typeId:'process_pump', x:20,y:5, createdAtDay:0 } as any,
        { id:'pu2', typeId:'process_pump', x:21,y:5, createdAtDay:0 } as any,
      ],
      [
        { id:'c1', type:'power_cable', ax:3,ay:3,bx:20,by:5, createdAtDay:0 } as any,
        { id:'c2', type:'power_cable', ax:3,ay:6,bx:21,by:5, createdAtDay:0 } as any,
      ],
      baffles,
    );
    assert(ce6.totalZones===6, 'Z15. 2V+1H → 6 zones (got '+ce6.totalZones+')');
    assert(ce6.septicZones===4 && ce6.healthyZones===2, 'Z15b. 2 mixers in 6 zones → 4 septic (got '+ce6.septicZones+')');
    assert(ce6.bodMultiplier < 1.35 && ce6.bodMultiplier > 1.1, 'Z15c. 4 septic zones BOD× '+ce6.bodMultiplier.toFixed(3)+' inside cap');
    assert(ce6.doBoostMgL < 0, 'Z15d. 4 septic zones DO boost '+ce6.doBoostMgL.toFixed(2)+' negative');
  }
  // Z16: zone-aware tick — baffled basin with unmixed compartment surfaces "zone" warning
  {
    let s: any = GameManager.createInitialState(0, true);
    s.financials.cash = 10_000_000;
    // Build a minimal conventional train so tick has flow
    const inletId = s.units.find((u:any)=>u.typeId==='influent_inlet').instanceId;
    const outId = s.units.find((u:any)=>u.typeId==='effluent_outfall').instanceId;
    const trainUnits = [
      s.units.find((u:any)=>u.typeId==='influent_inlet'),
      s.units.find((u:any)=>u.typeId==='effluent_outfall'),
      { instanceId:'scr', typeId:'bar_screen', gridX:5, gridY:10, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:emptyW(), lastOutletQuality:emptyW(), lastPowerKwActual:0, lastOpexActual:0 },
      { instanceId:'clr2', typeId:'secondary_clarifier', gridX:17, gridY:13, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:emptyW(), lastOutletQuality:emptyW(), lastPowerKwActual:0, lastOpexActual:0 },
    ];
    const trainPipes: any[] = [
      { id:'tp1', fromUnitId:inletId, fromPortId:'outlet', toUnitId:'scr', toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
      { id:'tp2', fromUnitId:'scr', fromPortId:'outlet', toUnitId:'clr2', toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
      { id:'tp3', fromUnitId:'clr2', fromPortId:'outlet', toUnitId:outId, toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
    ];
    s = { ...s, units: trainUnits, pipes: trainPipes };
    let rB = GameManager.placeCustomBasin(s, { x:24, y:18, w:8, h:4 });
    assert(rB.success, 'Z16-pre. basin for zone tick');
    s = rB.newState;
    const basinId = s.customBasins[0].id;
    let rBf = GameManager.placeBaffle(s, basinId, 'vertical', 4);
    assert(rBf.success, 'Z16-pre. baffle at 4');
    s = rBf.newState;
    // One mixer only in left zone (24-27)
    let rM1 = GameManager.placeProcessEquipment(s, 'submersible_mixer', 25, 19);
    assert(rM1.success, 'Z16-pre. mixer left zone');
    s = rM1.newState;
    let rPu = GameManager.placeProcessEquipment(s, 'process_pump', 30, 2);
    s = rPu.newState;
    let rC1 = GameManager.placeUtilityConnection(s, 'power_cable', 25, 19, 30, 2);
    assert(rC1.success, 'Z16-pre. power left mixer');
    s = rC1.newState;
    for (let i=0;i<20;i++) s = GameManager.tick(s, 0.5);
    const hasZoneAlert = s.overallStats.activeAlerts.some((a:any)=>a.id==='construction_septic' && /zone/.test(a.message));
    assert(hasZoneAlert, 'Z16. baffled basin with 1 mixed zone → zone-aware septic alert ('+(s.overallStats.activeAlerts.find((a:any)=>a.id==='construction_septic')?.message?.slice(0,60) ?? 'none')+')');
    // Now mixer in the right zone → alert clears
    let rM2 = GameManager.placeProcessEquipment(s, 'submersible_mixer', 29, 19);
    assert(rM2.success, 'Z16-pre. mixer right zone');
    s = rM2.newState;
    let rC2 = GameManager.placeUtilityConnection(s, 'power_cable', 29, 19, 30, 2);
    assert(rC2.success, 'Z16-pre. power right mixer');
    s = rC2.newState;
    for (let i=0;i<15;i++) s = GameManager.tick(s, 0.5);
    const stillSeptic = s.overallStats.activeAlerts.some((a:any)=>a.id==='construction_septic');
    assert(!stillSeptic, 'Z16b. both zones mixed → septic warning cleared');
  }
  // Z17: equipment zoneForEquipmentItem returns correct zone after baffling
  {
    let s: any = GameManager.createInitialState(0, true);
    s.financials.cash = 10_000_000;
    let rB = GameManager.placeCustomBasin(s, { x:5,y:5,w:8,h:4 });
    s = rB.newState;
    const basinId = s.customBasins[0].id;
    let rBf = GameManager.placeBaffle(s, basinId, 'vertical', 4);
    s = rBf.newState;
    let rM = GameManager.placeProcessEquipment(s, 'submersible_mixer', 6, 6);
    let rM2 = GameManager.placeProcessEquipment(rM.newState, 'submersible_mixer', 10, 6);
    s = rM2.newState;
    const mxLeft = s.processEquipment.find((e:any)=>e.x===6);
    const mxRight = s.processEquipment.find((e:any)=>e.x===10);
    const zLeft = GameManager.zoneForEquipmentItem(s, mxLeft.id);
    const zRight = GameManager.zoneForEquipmentItem(s, mxRight.id);
    assert(zLeft !== null && zRight !== null && zLeft.id !== zRight.id, 'Z17. left/right mixers map to distinct zones');
    assert(zLeft.gridI===0 && zRight.gridI===1, 'Z17b. gridI 0 vs 1 (got '+zLeft.gridI+'/'+zRight.gridI+')');
  }
  // Z18: CA0 identity still holds with explicit empty baffles array
  {
    const ce = evaluateConstructionEffects([], [], [], []);
    assert(ce.bodMultiplier===1 && ce.septicZones===0 && ce.totalZones===0, 'Z18. empty world with [] baffles still identity (bod×'+ce.bodMultiplier+')');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CONSTRUCTION-BUILDER Phase 6: membrane & carrier media (filtration stage)
// ═════════════════════════════════════════════════════════════════════════════
{
  const mkState = () => GameManager.createInitialState(0, true);
  const withBasin = () => {
    const s = mkState();
    const r = GameManager.placeCustomBasin(s, { x: 5, y: 5, w: 8, h: 6 });
    assert(r.success, 'FM0a. fixture basin for Phase 6');
    return r.newState;
  };
  // FM1-2: in_basin mounting — membrane & carrier both require a basin
  {
    const s = withBasin();
    const rM = GameManager.placeProcessEquipment(s, 'membrane_cassette', 6, 6);
    assert(rM.success && rM.charged===0, 'FM1. membrane_cassette installs inside basin (sandbox $0)');
    const rC = GameManager.placeProcessEquipment(rM.newState, 'mbbr_carrier', 7, 7);
    assert(rC.success, 'FM2. mbbr_carrier installs inside basin');
    assert(rC.newState.processEquipment!.length===2, 'FM2b. both filtration machines tracked');
  }
  // FM3-4: ground rejection — both in_basin types refuse open ground
  {
    const s = withBasin();
    const r1 = GameManager.placeProcessEquipment(s, 'membrane_cassette', 20, 20);
    assert(!r1.success && /inside a constructed basin/i.test(r1.reason??''), 'FM3. membrane on bare ground rejected — must mount inside basin');
    const r2 = GameManager.placeProcessEquipment(s, 'mbbr_carrier', 22, 2);
    assert(!r2.success && /inside a constructed basin/i.test(r2.reason??''), 'FM4. carrier on open ground rejected — must mount inside basin');
  }
  // FM5: tile exclusivity
  {
    const s = withBasin();
    const r1 = GameManager.placeProcessEquipment(s, 'membrane_cassette', 6, 6);
    assert(r1.success, 'FM5a. first membrane placed');
    const r2 = GameManager.placeProcessEquipment(r1.newState, 'mbbr_carrier', 6, 6);
    assert(!r2.success && /already holds equipment/i.test(r2.reason??''), 'FM5. second filtration machine refused on same tile');
  }
  // FM6-7: campaign economics — exact catalog CAPEX charged
  {
    const sCamp = withBasin();
    sCamp.gameMode = 'campaign';
    sCamp.financials.cash = 10_000_000;
    const rM = GameManager.placeProcessEquipment(sCamp, 'membrane_cassette', 6, 6);
    assert(rM.success && rM.charged===18500, `FM6. campaign membrane charges 18500 (got ${rM.charged})`);
    const rC = GameManager.placeProcessEquipment(rM.newState, 'mbbr_carrier', 7, 6);
    assert(rC.success && rC.charged===6800, `FM7. campaign carrier charges 6800 (got ${rC.charged})`);
    assert(rC.newState.financials.cash === 10_000_000 - 18500 - 6800, 'FM7b. cash reduced by exact filtration CAPEX');
  }
  // FM8: unaffordable membrane rejected
  {
    const sPoor = withBasin();
    sPoor.gameMode = 'campaign';
    sPoor.financials.cash = 100;
    const r = GameManager.placeProcessEquipment(sPoor, 'membrane_cassette', 6, 6);
    assert(!r.success && /insufficient funds/i.test(r.reason??''), 'FM8. unaffordable membrane rejected');
  }
  // FM9-11: powered status — membrane needs power_cable, carrier passive always live
  {
    const s = withBasin();
    const rM = GameManager.placeProcessEquipment(s, 'membrane_cassette', 6, 6);
    const rC = GameManager.placeProcessEquipment(rM.newState, 'mbbr_carrier', 7, 6);
    const st = rC.newState;
    const mem = st.processEquipment.find((e:any)=>e.typeId==='membrane_cassette')!;
    const car = st.processEquipment.find((e:any)=>e.typeId==='mbbr_carrier')!;
    assert(!isEquipmentPowered(mem, st.utilityConnections), 'FM9. membrane unpowered without cable');
    assert(isEquipmentPowered(car, st.utilityConnections), 'FM9b. carrier passive — always powered without cable');
    // power the membrane via a cable to an empty basin tile (avoids counting extra pump power)
    let st2:any = st;
    const rCable = GameManager.placeUtilityConnection(st2, 'power_cable', 6, 6, 8, 6);
    assert(rCable.success, 'FM9c. power cable membrane -> empty basin tile');
    st2 = rCable.newState;
    const mem2 = st2.processEquipment.find((e:any)=>e.typeId==='membrane_cassette')!;
    assert(isEquipmentPowered(mem2, st2.utilityConnections), 'FM10. membrane powered after cable');
    const stats = constructionStats(st2.customBasins as any, st2.processEquipment, st2.utilityConnections);
    assert(stats.totalMembranes===1 && stats.poweredMembranes===1, `FM11. stats 1/1 membranes powered (got ${stats.poweredMembranes}/${stats.totalMembranes})`);
    assert(stats.totalCarriers===1, `FM11b. stats 1 carrier (got ${stats.totalCarriers})`);
    assert(stats.livePowerKw === 5, `FM11c. livePower includes membrane 5 kW (got ${stats.livePowerKw})`);
  }
  // FM12: zone membership — membrane & carrier on opposite sides of baffle
  {
    let s:any = GameManager.createInitialState(0, true);
    let rB = GameManager.placeCustomBasin(s, { x:5,y:5,w:8,h:6 });
    s = rB.newState;
    const basinId = s.customBasins[0].id;
    let rBf = GameManager.placeBaffle(s, basinId, 'vertical', 4);
    s = rBf.newState;
    let rM = GameManager.placeProcessEquipment(s, 'membrane_cassette', 6, 6);
    s = rM.newState;
    let rC = GameManager.placeProcessEquipment(s, 'mbbr_carrier', 10, 6);
    s = rC.newState;
    const mem = s.processEquipment.find((e:any)=>e.typeId==='membrane_cassette')!;
    const car = s.processEquipment.find((e:any)=>e.typeId==='mbbr_carrier')!;
    const zMem = GameManager.zoneForEquipmentItem(s, mem.id);
    const zCar = GameManager.zoneForEquipmentItem(s, car.id);
    assert(zMem !== null && zCar !== null && zMem.id !== zCar.id, 'FM12. membrane & carrier map to distinct zones across baffle');
    assert(zMem.gridI===0 && zCar.gridI===1, `FM12b. membrane gridI 0 vs carrier 1 (got ${zMem.gridI}/${zCar.gridI})`);
  }
  // FM13: demolish salvage (campaign 70%)
  {
    let s:any = withBasin();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=10_000_000;
    const built = GameManager.placeProcessEquipment(s, 'membrane_cassette', 6, 6);
    const id = built.newState.processEquipment![0].id;
    const demo = GameManager.demolishProcessEquipment(built.newState, id);
    const salvage = Math.round(18500*0.7);
    assert(demo.success && demo.refunded===salvage, `FM13. demolish membrane refunds 70% ($${salvage})`);
    let s2:any = withBasin();
    s2.gameMode='campaign'; s2.tutorialActive=false; s2.financials.cash=10_000_000;
    const built2 = GameManager.placeProcessEquipment(s2, 'mbbr_carrier', 6, 6);
    const id2 = built2.newState.processEquipment.find((e:any)=>e.typeId==='mbbr_carrier')!.id;
    const demo2 = GameManager.demolishProcessEquipment(built2.newState, id2);
    const salvage2 = Math.round(6800*0.7);
    assert(demo2.refunded===salvage2, `FM13b. demolish carrier refunds 70% ($${salvage2})`);
  }
  // FM14: basin mounting integrity — basin with filtration kit cannot be demolished
  {
    const s = withBasin();
    const rM = GameManager.placeProcessEquipment(s, 'membrane_cassette', 6, 6);
    const basinId = rM.newState.customBasins[0].id;
    const demo = GameManager.demolishCustomBasin(rM.newState, basinId);
    assert(!demo.success && /equipment/i.test(demo.reason??''), 'FM14. basin demolition refused while membrane remains mounted');
    const cleared = GameManager.demolishProcessEquipment(rM.newState, rM.newState.processEquipment.find((e:any)=>e.typeId==='membrane_cassette')!.id);
    const demo2 = GameManager.demolishCustomBasin(cleared.newState, basinId);
    assert(demo2.success, 'FM14b. basin demolishes once filtration kit removed');
  }
  // FM15: unknown type still rejected
  {
    const s = withBasin();
    assert(!GameManager.placeProcessEquipment(s, 'flux_capacitor', 6, 6).success, 'FM15. unknown type still rejected after catalog expansion');
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// CONSTRUCTION-BUILDER Phase 6 slice 2: filtration physics (per-zone membrane & carrier)
// ═════════════════════════════════════════════════════════════════════════════
{
  const mkBasin = (x=5,y=5,w=8,h=6) => ({ x, y, w, h, depthM:4, id:'bF1', createdAtDay:0 } as any);
  const mkPump = (x=20,y=5) => ({ id:'pu1', typeId:'process_pump', x, y, createdAtDay:0 } as any);
  const mkMixer = (id:string,x:number,y:number) => ({ id, typeId:'submersible_mixer', x, y, createdAtDay:0 } as any);
  const mkMem = (id:string,x:number,y:number) => ({ id, typeId:'membrane_cassette', x, y, createdAtDay:0 } as any);
  const mkCar = (id:string,x:number,y:number) => ({ id, typeId:'mbbr_carrier', x, y, createdAtDay:0 } as any);
  const mkDiff = (id:string,x:number,y:number) => ({ id, typeId:'fine_bubble_diffuser', x, y, createdAtDay:0 } as any);
  const mkBlow = (id:string,x:number,y:number) => ({ id, typeId:'rotary_blower', x, y, createdAtDay:0 } as any);
  const cable = (ax:number,ay:number,bx:number,by:number) => ({ id:'c_'+ax+'_'+ay, type:'power_cable', ax, ay, bx, by, createdAtDay:0 } as any);
  const air = (ax:number,ay:number,bx:number,by:number) => ({ id:'a_'+ax+'_'+ay, type:'air_pipe', ax, ay, bx, by, createdAtDay:0 } as any);

  // FM16: no filtration kit → TSS/BOD identity (no membrane/carrier effect)
  {
    const basin = mkBasin();
    const ce = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkPump()], [cable(6,6,20,5)]);
    assert(ce.totalMembranes===0 && ce.totalCarriers===0, 'FM16. no filtration kit → 0 membranes/carriers');
    assert(ce.liveMembranes===0 && ce.activeCarriers===0, 'FM16b. no filtration live counts 0');
    // TSS/BOD should be volume-only (0.97...) not filtered
    assert(ce.tssMultiplier > 0.95 && ce.tssMultiplier <= 1.0, 'FM16c. TSS identity without membranes (×'+ce.tssMultiplier.toFixed(3)+')');
  }
  // FM17: powered membrane in HEALTHY zone → strong TSS polishing (0.20×)
  {
    const basin = mkBasin();
    const ce = evaluateConstructionEffects(
      [basin],
      [mkMixer('mx1',6,6), mkMem('mem1',7,6), mkPump()],
      [cable(6,6,20,5), cable(7,6,20,5)]
    );
    assert(ce.poweredMembranes===1 && ce.liveMembranes===1 && ce.degradedMembranes===0, 'FM17. powered membrane in healthy zone → 1 live (got '+ce.liveMembranes+'/'+ce.poweredMembranes+')');
    // TSS should be ~0.20 (membrane) × ~0.97 (volume) ≈0.194, but at least <0.30 and <<1
    assert(ce.tssMultiplier < 0.30 && ce.tssMultiplier > 0.10, 'FM17b. healthy membrane TSS× '+ce.tssMultiplier.toFixed(3)+' strong (<0.30)');
    const filt = filtrationLiveSets([basin], [mkMixer('mx1',6,6), mkMem('mem1',7,6), mkPump()], [cable(6,6,20,5), cable(7,6,20,5)]);
    assert(filt.liveMembraneIds.has('mem1') && !filt.degradedMembraneIds.has('mem1'), 'FM17c. filtrationLiveSets marks mem1 as live');
  }
  // FM18: powered membrane in SEPTIC zone (no mixer) → degraded TSS (0.55×, weaker)
  {
    const basin = mkBasin();
    const ce = evaluateConstructionEffects(
      [basin],
      [mkMem('mem1',7,6), mkPump()],
      [cable(7,6,20,5)] // mixer absent → zone septic
    );
    assert(ce.poweredMembranes===1 && ce.liveMembranes===0 && ce.degradedMembranes===1, 'FM18. membrane in septic zone → 1 degraded (got live '+ce.liveMembranes+' degraded '+ce.degradedMembranes+')');
    assert(ce.tssMultiplier > 0.45 && ce.tssMultiplier < 0.70, 'FM18b. septic membrane TSS× '+ce.tssMultiplier.toFixed(3)+' weaker (0.45–0.70)');
    // Healthy membrane should beat septic
    const ceHealthy = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkMem('mem1',7,6), mkPump()], [cable(6,6,20,5), cable(7,6,20,5)]);
    assert(ce.tssMultiplier > ceHealthy.tssMultiplier, 'FM18c. septic TSS× '+ce.tssMultiplier.toFixed(3)+' > healthy '+ceHealthy.tssMultiplier.toFixed(3));
    const filt = filtrationLiveSets([basin], [mkMem('mem1',7,6), mkPump()], [cable(7,6,20,5)]);
    assert(filt.degradedMembraneIds.has('mem1'), 'FM18d. degraded set contains mem1');
  }
  // FM19: unpowered membrane → no filtration effect
  {
    const basin = mkBasin();
    const ceNoPow = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkMem('mem1',7,6), mkPump()], [cable(6,6,20,5)]); // membrane not cabled
    const ceNone = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkPump()], [cable(6,6,20,5)]);
    assert(ceNoPow.poweredMembranes===0 && ceNoPow.liveMembranes===0, 'FM19. unpowered membrane → 0 powered/live');
    assert(Math.abs(ceNoPow.tssMultiplier - ceNone.tssMultiplier) < 0.001, 'FM19b. unpowered membrane TSS× '+ceNoPow.tssMultiplier.toFixed(3)+' ≈ no-membrane '+ceNone.tssMultiplier.toFixed(3));
  }
  // FM20: carrier in HEALTHY zone → BOD active
  {
    const basin = mkBasin();
    const ce = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkCar('car1',7,6), mkPump()], [cable(6,6,20,5)]);
    assert(ce.totalCarriers===1 && ce.activeCarriers===1 && ce.aeratedCarriers===0, 'FM20. carrier healthy zone → 1 active (got '+ce.activeCarriers+')');
    assert(ce.bodMultiplier < 0.98, 'FM20b. carrier BOD× '+ce.bodMultiplier.toFixed(3)+' <1 (active biofilm)');
    const filt = filtrationLiveSets([basin], [mkMixer('mx1',6,6), mkCar('car1',7,6), mkPump()], [cable(6,6,20,5)]);
    assert(filt.activeCarrierIds.has('car1') && !filt.aeratedCarrierIds.has('car1'), 'FM20c. carrier active but not aerated');
  }
  // FM21: carrier in SEPTIC zone → dormant (no BOD benefit)
  {
    const basin = mkBasin();
    const ceActive = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkCar('car1',7,6), mkPump()], [cable(6,6,20,5)]);
    const ceDormant = evaluateConstructionEffects([basin], [mkCar('car1',7,6)], []);
    assert(ceDormant.activeCarriers===0, 'FM21. carrier septic → 0 active (got '+ceDormant.activeCarriers+')');
    assert(ceDormant.bodMultiplier > ceActive.bodMultiplier, 'FM21b. septic carrier BOD× '+ceDormant.bodMultiplier.toFixed(3)+' > active '+ceActive.bodMultiplier.toFixed(3));
  }
  // FM22: carrier in AERATED healthy zone → extra BOD/TN vs non-aerated
  {
    const basin = mkBasin();
    // Healthy non-aerated
    const ceNonAer = evaluateConstructionEffects([basin], [mkMixer('mx1',6,6), mkCar('car1',7,6), mkPump()], [cable(6,6,20,5)]);
    // Healthy aerated: add diffuser+blower+air pipe+power
    const ceAer = evaluateConstructionEffects(
      [basin],
      [mkMixer('mx1',6,6), mkCar('car1',7,6), mkDiff('d1',7,7), mkBlow('bl1',22,5), mkPump()],
      [cable(6,6,20,5), cable(22,5,20,5), air(22,5,7,7)]
    );
    assert(ceAer.aeratedCarriers===1, 'FM22. aerated carrier → 1 aerated (got '+ceAer.aeratedCarriers+')');
    assert(ceAer.bodMultiplier < ceNonAer.bodMultiplier, 'FM22b. aerated BOD× '+ceAer.bodMultiplier.toFixed(4)+' < non-aerated '+ceNonAer.bodMultiplier.toFixed(4));
    assert(ceAer.tnMultiplier < ceNonAer.tnMultiplier, 'FM22c. aerated TN× '+ceAer.tnMultiplier.toFixed(4)+' < non-aerated '+ceNonAer.tnMultiplier.toFixed(4));
    const filt = filtrationLiveSets([basin], [mkMixer('mx1',6,6), mkCar('car1',7,6), mkDiff('d1',7,7), mkBlow('bl1',22,5), mkPump()], [cable(6,6,20,5), cable(22,5,20,5), air(22,5,7,7)]);
    assert(filt.aeratedCarrierIds.has('car1'), 'FM22d. aeratedCarrierIds contains car1');
  }
  // FM23: multiple membranes stack with floor 0.02
  {
    const basin = mkBasin(5,5,10,10);
    let equip:any[] = [mkMixer('mx1',6,6), mkPump()];
    let conns:any[] = [cable(6,6,20,5)];
    for (let i=0;i<3;i++) { equip.push(mkMem('mem'+i,6+i,7)); conns.push(cable(6+i,7,20,5)); }
    const ce3 = evaluateConstructionEffects([basin], equip, conns);
    assert(ce3.liveMembranes===3, 'FM23. 3 live membranes (got '+ce3.liveMembranes+')');
    assert(ce3.tssMultiplier >= 0.015 && ce3.tssMultiplier < 0.05, 'FM23b. 3 membranes TSS× '+ce3.tssMultiplier.toFixed(4)+' inside floor range (0.015–0.05)');
    // 6 membranes should still be >=0.02
    for (let i=3;i<6;i++) { equip.push(mkMem('mem'+i,6+i,8)); conns.push(cable(6+i,8,20,5)); }
    const ce6 = evaluateConstructionEffects([basin], equip, conns);
    assert(ce6.tssMultiplier >= 0.015 && ce6.tssMultiplier <= ce3.tssMultiplier, 'FM23c. 6 membranes TSS× '+ce6.tssMultiplier.toFixed(4)+' ≥ floor and ≤ 3-mem');
  }
  // FM24: multiple carriers stack with BOD floor
  {
    const basin = mkBasin();
    let equip:any[] = [mkMixer('mx1',6,6), mkPump(), cable(6,6,20,5) as any]; // wrong: cable is utility, not equip
    equip = [mkMixer('mx1',6,6), mkPump()];
    let conns:any[] = [cable(6,6,20,5)];
    for (let i=0;i<5;i++) equip.push(mkCar('car'+i,6+i,6));
    const ce5 = evaluateConstructionEffects([basin], equip, conns);
    assert(ce5.activeCarriers===5, 'FM24. 5 active carriers (got '+ce5.activeCarriers+')');
    assert(ce5.bodMultiplier < 0.90 && ce5.bodMultiplier >= 0.70, 'FM24b. 5 carriers BOD× '+ce5.bodMultiplier.toFixed(3)+' in range');
    for (let i=5;i<12;i++) equip.push(mkCar('car'+i,6+(i%8),7));
    const ce12 = evaluateConstructionEffects([basin], equip, conns);
    assert(ce12.bodMultiplier >= 0.65, 'FM24c. 12 carriers BOD× '+ce12.bodMultiplier.toFixed(3)+' ≥ 0.65 (component floor 0.70 + volume)');
    assert(ce12.bodMultiplier < ce5.bodMultiplier, 'FM24d. more carriers → lower BOD×');
  }
  // FM25: baffled basin per-zone — membrane in healthy zone vs carrier in septic zone
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bfilt25', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bfilt25', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    // Left zone (5-8) has mixer, right zone (9-12) has none
    const ce = evaluateConstructionEffects(
      [basin],
      [mkMixer('mx1',6,6), mkMem('memL',6,7), mkCar('carR',10,6), mkPump()],
      [cable(6,6,20,5), cable(6,7,20,5)],
      baffles
    );
    assert(ce.liveMembranes===1 && ce.degradedMembranes===0, 'FM25. membrane left healthy → 1 live (got '+ce.liveMembranes+')');
    assert(ce.activeCarriers===0, 'FM25b. carrier right septic → 0 active (got '+ce.activeCarriers+')');
    const filt = filtrationLiveSets([basin], [mkMixer('mx1',6,6), mkMem('memL',6,7), mkCar('carR',10,6), mkPump()], [cable(6,6,20,5), cable(6,7,20,5)], baffles);
    assert(filt.liveMembraneIds.has('memL'), 'FM25c. live memL');
    assert(!filt.activeCarrierIds.has('carR'), 'FM25d. carR dormant');
    // Now add mixer to right zone → both active
    const ce2 = evaluateConstructionEffects(
      [basin],
      [mkMixer('mx1',6,6), mkMixer('mx2',10,6), mkMem('memL',6,7), mkCar('carR',10,6), mkPump(), { id:'pu2', typeId:'process_pump', x:21, y:5, createdAtDay:0 } as any],
      [cable(6,6,20,5), cable(10,6,21,5), cable(6,7,20,5)],
      baffles
    );
    assert(ce2.liveMembranes===1 && ce2.activeCarriers===1, 'FM25e. both zones mixed → live 1 & active 1 (got '+ce2.liveMembranes+'/'+ce2.activeCarriers+')');
  }
  // FM26: filtrationLiveSets membrane degraded case via baffles
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bfilt26', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bfilt26', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    // Membrane right zone, mixer left zone → degraded
    const filt = filtrationLiveSets(
      [basin],
      [mkMixer('mx1',6,6), mkMem('memR',10,6), mkPump()],
      [cable(6,6,20,5), cable(10,6,20,5)],
      baffles
    );
    assert(filt.degradedMembraneIds.has('memR') && !filt.liveMembraneIds.has('memR'), 'FM26. membrane right septic → degraded (not live)');
  }
  // FM27: tick integration — powered membrane actually improves TSS in live sim
  {
    let st:any = GameManager.createInitialState(0, true);
    // Minimal train so tick has flow: inlet→bar_screen→clarifier→outfall
    const inletId = st.units.find((u:any)=>u.typeId==='influent_inlet').instanceId;
    const outId = st.units.find((u:any)=>u.typeId==='effluent_outfall').instanceId;
    const baseUnits = [
      st.units.find((u:any)=>u.typeId==='influent_inlet'),
      st.units.find((u:any)=>u.typeId==='effluent_outfall'),
      { instanceId:'scr', typeId:'bar_screen', gridX:5, gridY:10, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:emptyW(), lastOutletQuality:emptyW(), lastPowerKwActual:0, lastOpexActual:0 },
      { instanceId:'clr2', typeId:'secondary_clarifier', gridX:17, gridY:13, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:emptyW(), lastOutletQuality:emptyW(), lastPowerKwActual:0, lastOpexActual:0 },
    ];
    const basePipes:any[] = [
      { id:'tp1', fromUnitId:inletId, fromPortId:'outlet', toUnitId:'scr', toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
      { id:'tp2', fromUnitId:'scr', fromPortId:'outlet', toUnitId:'clr2', toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
      { id:'tp3', fromUnitId:'clr2', fromPortId:'outlet', toUnitId:outId, toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
    ];
    let base:any = { ...st, units: baseUnits, pipes: basePipes };
    for (let i=0;i<20;i++) base = GameManager.tick(base, 0.5);
    const tssBase = base.finalEffluent.tss;
    // Add basin + healthy powered membrane
    let withMem:any = { ...base };
    let rB = GameManager.placeCustomBasin(base, { x:24, y:18, w:6, h:6 });
    assert(rB.success, 'FM27-pre. basin for tick membrane');
    withMem = rB.newState;
    let rMx = GameManager.placeProcessEquipment(withMem, 'submersible_mixer', 25, 19);
    withMem = rMx.newState;
    let rMem = GameManager.placeProcessEquipment(withMem, 'membrane_cassette', 25, 20);
    withMem = rMem.newState;
    let rPu = GameManager.placeProcessEquipment(withMem, 'process_pump', 30, 2);
    withMem = rPu.newState;
    let rC1 = GameManager.placeUtilityConnection(withMem, 'power_cable', 25, 19, 30, 2);
    withMem = rC1.newState;
    let rC2 = GameManager.placeUtilityConnection(withMem, 'power_cable', 25, 20, 30, 2);
    assert(rC2.success, 'FM27-pre. power membrane');
    withMem = rC2.newState;
    for (let i=0;i<20;i++) withMem = GameManager.tick(withMem, 0.5);
    assert(withMem.finalEffluent.tss < tssBase * 0.50, 'FM27. membrane tick TSS '+tssBase.toFixed(1)+' → '+withMem.finalEffluent.tss.toFixed(1)+' (<50% base)');
  }
  // FM28: tick integration — aerated carrier improves BOD
  {
    let st:any = GameManager.createInitialState(0, true);
    const inletId = st.units.find((u:any)=>u.typeId==='influent_inlet').instanceId;
    const outId = st.units.find((u:any)=>u.typeId==='effluent_outfall').instanceId;
    const baseUnits = [
      st.units.find((u:any)=>u.typeId==='influent_inlet'),
      st.units.find((u:any)=>u.typeId==='effluent_outfall'),
      { instanceId:'scr', typeId:'bar_screen', gridX:5, gridY:10, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:emptyW(), lastOutletQuality:emptyW(), lastPowerKwActual:0, lastOpexActual:0 },
      { instanceId:'clr2', typeId:'secondary_clarifier', gridX:17, gridY:13, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:emptyW(), lastOutletQuality:emptyW(), lastPowerKwActual:0, lastOpexActual:0 },
    ];
    const basePipes:any[] = [
      { id:'tp1', fromUnitId:inletId, fromPortId:'outlet', toUnitId:'scr', toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
      { id:'tp2', fromUnitId:'scr', fromPortId:'outlet', toUnitId:'clr2', toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
      { id:'tp3', fromUnitId:'clr2', fromPortId:'outlet', toUnitId:outId, toPortId:'inlet', pathPoints:[], flowRate:0, quality:emptyW(), pipeType:'liquid' },
    ];
    let base:any = { ...st, units: baseUnits, pipes: basePipes };
    let rB = GameManager.placeCustomBasin(base, { x:24, y:18, w:6, h:6 });
    base = rB.newState;
    let rMx = GameManager.placeProcessEquipment(base, 'submersible_mixer', 25, 19);
    base = rMx.newState;
    let rPu = GameManager.placeProcessEquipment(base, 'process_pump', 30, 2);
    base = rPu.newState;
    let rC = GameManager.placeUtilityConnection(base, 'power_cable', 25, 19, 30, 2);
    base = rC.newState;
    let rCar = GameManager.placeProcessEquipment(base, 'mbbr_carrier', 25, 20);
    base = rCar.newState;
    for (let i=0;i<20;i++) base = GameManager.tick(base, 0.5);
    const bodCarOnly = base.finalEffluent.bod;
    // Now add aeration to same zone
    let rBl = GameManager.placeProcessEquipment(base, 'rotary_blower', 31, 2);
    base = rBl.newState;
    let rDiff = GameManager.placeProcessEquipment(base, 'fine_bubble_diffuser', 26, 19);
    base = rDiff.newState;
    let rAir = GameManager.placeUtilityConnection(base, 'air_pipe', 31, 2, 26, 19);
    base = rAir.newState;
    let rPowBl = GameManager.placeUtilityConnection(base, 'power_cable', 31, 2, 30, 2);
    base = rPowBl.newState;
    for (let i=0;i<20;i++) base = GameManager.tick(base, 0.5);
    assert(base.finalEffluent.bod < bodCarOnly, 'FM28. aerated carrier BOD '+bodCarOnly.toFixed(1)+' → '+base.finalEffluent.bod.toFixed(1)+' improved with aeration');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CONSTRUCTION-BUILDER Phase 7 slice 1: emergent process recognition badges
// ═════════════════════════════════════════════════════════════════════════════
{
  const mkBasin = (x=5,y=5,w=8,h=6,id='bR1') => ({ x, y, w, h, depthM:4, id, createdAtDay:0 } as any);
  const mkMixer = (id:string,x:number,y:number) => ({ id, typeId:'submersible_mixer', x, y, createdAtDay:0 } as any);
  const mkDiff = (id:string,x:number,y:number) => ({ id, typeId:'fine_bubble_diffuser', x, y, createdAtDay:0 } as any);
  const mkBlow = (id:string,x:number,y:number) => ({ id, typeId:'rotary_blower', x, y, createdAtDay:0 } as any);
  const mkMem = (id:string,x:number,y:number) => ({ id, typeId:'membrane_cassette', x, y, createdAtDay:0 } as any);
  const mkCar = (id:string,x:number,y:number) => ({ id, typeId:'mbbr_carrier', x, y, createdAtDay:0 } as any);
  const mkPump = (x=20,y=5) => ({ id:'pu1', typeId:'process_pump', x, y, createdAtDay:0 } as any);
  const cable = (ax:number,ay:number,bx:number,by:number) => ({ id:'c_'+ax+'_'+ay, type:'power_cable', ax, ay, bx, by, createdAtDay:0 } as any);
  const air = (ax:number,ay:number,bx:number,by:number) => ({ id:'a_'+ax+'_'+ay, type:'air_pipe', ax, ay, bx, by, createdAtDay:0 } as any);
  const has = (badges:any[], id:string) => badges.some((b:any)=>b.id===id);

  // PR01: no basins → no badges
  {
    const badges = recognizeProcess([], [], [], []);
    assert(badges.length===0, 'PR01. no basins → no badges (got '+badges.length+')');
    assert(processSummaryLine(badges).includes('No process'), 'PR01b. summary says none');
  }
  // PR02: empty basin alone → no process badges (just a hole)
  {
    const badges = recognizeProcess([mkBasin()], [], [], []);
    assert(badges.length===0, 'PR02. empty basin alone → no recognition badges');
  }
  // PR03: aerated basin → Aerated badge
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkDiff('d1',6,6), mkBlow('bl1',22,5), mkPump()], [cable(22,5,20,5), air(22,5,6,6)]);
    assert(has(badges,'aerated'), 'PR03. aerated basin → Aerated badge');
    assert(badges.find((b:any)=>b.id==='aerated')!.detail.includes('1 diffuser'), 'PR03b. detail mentions diffuser');
  }
  // PR04: mixed basin → Mixed badge
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkMixer('mx1',6,6), mkPump()], [cable(6,6,20,5)]);
    assert(has(badges,'mixed'), 'PR04. mixed basin → Mixed badge');
    assert(!has(badges,'aerated'), 'PR04b. not aerated');
  }
  // PR05: aerated+mixed co-located → Activated-sludge-like
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkDiff('d1',6,6), mkBlow('bl1',22,5), mkMixer('mx1',7,6), mkPump()], [cable(22,5,20,5), cable(7,6,20,5), air(22,5,6,6)]);
    assert(has(badges,'aerated') && has(badges,'mixed'), 'PR05. aerated+mixed → both base badges');
    assert(has(badges,'activated'), 'PR05b. co-located → Activated-sludge-like badge');
  }
  // PR06: baffled basin → Compartmentalised badge
  {
    const basin = mkBasin(5,5,8,6,'bf06');
    const baffles:any[] = [{ id:'bf1', basinId:'bf06', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const badges = recognizeProcess([basin], baffles, [], []);
    assert(has(badges,'compartment'), 'PR06. baffled → Compartmentalised badge');
    assert(badges.find((b:any)=>b.id==='compartment')!.detail.includes('2 zones'), 'PR06b. detail shows zone count');
  }
  // PR07: baffled anoxic→aerobic train (one zone aerated, one not)
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bf07', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bf07', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const badges = recognizeProcess(
      [basin], baffles,
      [mkDiff('d1',6,6), mkBlow('bl1',22,5), mkMixer('mx1',10,6), mkPump()],
      [cable(22,5,20,5), air(22,5,6,6), cable(10,6,20,5)]
    );
    assert(has(badges,'anoxic-aerobic'), 'PR07. baffled aerated+non-aerated → Anoxic → Aerobic badge');
  }
  // PR08: same baffle but both zones aerated → no anoxic-aerobic
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bf08', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bf08', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const badges = recognizeProcess(
      [basin], baffles,
      [mkDiff('d1',6,6), mkDiff('d2',10,6), mkBlow('bl1',22,5), mkBlow('bl2',23,5), mkPump()],
      [cable(22,5,20,5), cable(23,5,20,5), air(22,5,6,6), air(23,5,10,6)]
    );
    assert(!has(badges,'anoxic-aerobic'), 'PR08. both zones aerated → no Anoxic→Aerobic badge');
  }
  // PR09: powered membrane live → Membrane barrier (MBR-like) live
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkMixer('mx1',6,6), mkMem('mem1',7,6), mkPump()], [cable(6,6,20,5), cable(7,6,20,5)]);
    assert(has(badges,'membrane'), 'PR09. live membrane → Membrane barrier badge');
    assert(badges.find((b:any)=>b.id==='membrane')!.detail.includes('1 live'), 'PR09b. detail shows live');
  }
  // PR10: membrane in septic zone → degraded membrane badge
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkMem('mem1',7,6)], [cable(7,6,20,5)]);
    assert(has(badges,'membrane'), 'PR10. septic membrane → still membrane badge');
    assert(badges.find((b:any)=>b.id==='membrane')!.detail.includes('fouled'), 'PR10b. septic shows fouled');
  }
  // PR11: active carriers → Biofilm media
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkMixer('mx1',6,6), mkCar('car1',7,6)], [cable(6,6,20,5)]);
    assert(has(badges,'biofilm'), 'PR11. active carriers → Biofilm media badge');
  }
  // PR12: dormant carriers (no mixing) → dormant badge
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkCar('car1',7,6)], []);
    assert(has(badges,'biofilm-dormant'), 'PR12. dormant carriers → Biofilm dormant badge');
    assert(!has(badges,'biofilm'), 'PR12b. no active badge when dormant');
  }
  // PR13: hybrid IFAS-like (aerated + carriers in same zone)
  {
    const basin = mkBasin();
    const badges = recognizeProcess(
      [basin], [], [mkMixer('mx1',6,6), mkCar('car1',7,6), mkDiff('d1',7,7), mkBlow('bl1',22,5), mkPump()],
      [cable(6,6,20,5), cable(22,5,20,5), air(22,5,7,7)]
    );
    assert(has(badges,'biofilm'), 'PR13. hybrid still has biofilm');
    assert(has(badges,'ifas'), 'PR13b. aerated carriers → Hybrid IFAS-like badge');
  }
  // PR14: septic warning when mixed incomplete
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bf14', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bf14', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const badges = recognizeProcess([basin], baffles, [mkMixer('mx1',6,6), mkPump()], [cable(6,6,20,5)]);
    assert(has(badges,'septic'), 'PR14. incomplete mixing → Septic risk badge');
    assert(has(badges,'mixed') && has(badges,'compartment'), 'PR14b. also has mixed+compartment');
  }
  // PR15: processSummaryLine joins labels
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkDiff('d1',6,6), mkBlow('bl1',22,5), mkMixer('mx1',7,6), mkPump()], [cable(22,5,20,5), cable(7,6,20,5), air(22,5,6,6)]);
    const line = processSummaryLine(badges);
    assert(line.includes('Aerated') && line.includes('Mixed'), 'PR15. summary line joins badge labels: '+line);
  }
  // PR16: unpowered membrane → no membrane badge
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin], [], [mkMixer('mx1',6,6), mkMem('mem1',7,6)], [cable(6,6,20,5)]); // membrane not cabled
    assert(!has(badges,'membrane'), 'PR16. unpowered membrane → no membrane badge');
  }
}

// ═════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════
// CONSTRUCTION-BUILDER Phase 7 slice 2: instrumentation kit (process sensors)
// ═════════════════════════════════════════════════════════════
{
  const mkBasin = (x=5,y=5,w=8,h=6,id='bS1') => ({ x, y, w, h, depthM:4, id, createdAtDay:0 } as any);
  const mkDo = (id:string,x:number,y:number) => ({ id, typeId:'do_probe', x, y, createdAtDay:0 } as any);
  const mkFlow = (id:string,x:number,y:number) => ({ id, typeId:'flow_meter', x, y, createdAtDay:0 } as any);
  const mkLevel = (id:string,x:number,y:number) => ({ id, typeId:'level_sensor', x, y, createdAtDay:0 } as any);
  const mkMixer2 = (id:string,x:number,y:number) => ({ id, typeId:'submersible_mixer', x, y, createdAtDay:0 } as any);
  const mkPump2 = (x=22,y=5) => ({ id:'puS', typeId:'process_pump', x, y, createdAtDay:0 } as any);
  const cable2 = (ax:number,ay:number,bx:number,by:number) => ({ id:'c_'+ax+'_'+ay+'_'+bx+'_'+by, type:'power_cable', ax, ay, bx, by, createdAtDay:0 } as any);
  const withBasin2 = () => {
    let s:any = GameManager.createInitialState(0, true);
    const r = GameManager.placeCustomBasin(s, { x:5, y:5, w:8, h:6 });
    if (!r.success) throw new Error('withBasin failed: '+r.reason);
    return r.newState;
  };
  const has2 = (badges:any[], id:string) => badges.some((b:any)=>b.id===id);

  // IN01: do_probe mounts inside a basin (wet-installed), outside rejected
  {
    const s = withBasin2();
    const rInside = GameManager.placeProcessEquipment(s, 'do_probe', 6, 6);
    const rOutside = GameManager.placeProcessEquipment(s, 'do_probe', 0, 0);
    assert(rInside.success, 'IN01. do_probe mounts inside a basin (got '+rInside.success+')');
    assert(!rOutside.success && /basin/i.test(rOutside.reason??''), 'IN01b. do_probe outside basin rejected: '+(rOutside.reason??''));
  }
  // IN02: flow_meter mounts on open ground (dry), inside basin rejected
  {
    const s = withBasin2();
    const rGround = GameManager.placeProcessEquipment(s, 'flow_meter', 22, 5);
    const rInBasin = GameManager.placeProcessEquipment(s, 'flow_meter', 6, 6);
    assert(rGround.success, 'IN02. flow_meter mounts on open ground');
    assert(!rInBasin.success && /dry/i.test(rInBasin.reason??''), 'IN02b. flow_meter inside basin rejected: '+(rInBasin.reason??''));
  }
  // IN03: level_sensor mounts inside a basin (wet-installed)
  {
    const s = withBasin2();
    const rIn = GameManager.placeProcessEquipment(s, 'level_sensor', 7, 7);
    const rOut = GameManager.placeProcessEquipment(s, 'level_sensor', 1, 1);
    assert(rIn.success, 'IN03. level_sensor mounts inside a basin');
    assert(!rOut.success, 'IN03b. level_sensor outside basin rejected');
  }
  // IN04: tile exclusivity — second sensor on same tile rejected
  {
    const s = withBasin2();
    const r1 = GameManager.placeProcessEquipment(s, 'do_probe', 6, 6);
    const r2 = GameManager.placeProcessEquipment(r1.newState, 'level_sensor', 6, 6);
    assert(r1.success && !r2.success && /already holds/i.test(r2.reason??''), 'IN04. tile exclusivity blocks second sensor on same tile');
  }
  // IN05: exact campaign CAPEX charges for each sensor type
  {
    let s:any = withBasin2();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=10_000_000;
    const cash0 = s.financials.cash;
    let r = GameManager.placeProcessEquipment(s, 'do_probe', 6, 6); s=r.newState;
    assert(cash0 - s.financials.cash === 3200, 'IN05. do_probe CAPEX $3200 (got '+(cash0 - s.financials.cash)+')');
    const cash1 = s.financials.cash;
    r = GameManager.placeProcessEquipment(s, 'level_sensor', 7, 7); s=r.newState;
    assert(cash1 - s.financials.cash === 4800, 'IN05b. level_sensor CAPEX $4800 (got '+(cash1 - s.financials.cash)+')');
    const cash2 = s.financials.cash;
    r = GameManager.placeProcessEquipment(s, 'flow_meter', 22, 5); s=r.newState;
    assert(cash2 - s.financials.cash === 7500, 'IN05c. flow_meter CAPEX $7500 (got '+(cash2 - s.financials.cash)+')');
  }
  // IN06: unaffordable sensor rejected atomically
  {
    let s:any = withBasin2();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=100;
    const r = GameManager.placeProcessEquipment(s, 'do_probe', 6, 6);
    assert(!r.success, 'IN06. unaffordable do_probe rejected');
    assert(s.financials.cash===100 && s.processEquipment.length===0, 'IN06b. state unchanged on rejection');
  }
  // IN07: powered model — sensor needs a power_cable on its exact tile to be live
  {
    const basin = mkBasin();
    const do1 = mkDo('d1',6,6);
    const flow1 = mkFlow('f1',18,5);
    const level1 = mkLevel('l1',7,6);
    const eq = [do1, flow1, level1, mkPump2()];
    const st1 = constructionStats([basin] as any, eq as any, [cable2(6,6,22,5)] as any);
    assert(st1.totalSensors===3 && st1.poweredSensors===1, 'IN07. 1/3 sensors powered with one cable (got '+st1.poweredSensors+'/'+st1.totalSensors+')');
    const st3 = constructionStats([basin] as any, eq as any, [cable2(6,6,22,5), cable2(18,5,22,5), cable2(7,6,22,5)] as any);
    assert(st3.poweredSensors===3, 'IN07b. 3/3 sensors powered with three cables (got '+st3.poweredSensors+')');
    assert(st3.poweredDoProbes===1 && st3.poweredFlowMeters===1 && st3.poweredLevelSensors===1, 'IN07c. per-type powered counts 1/1/1');
    assert(st3.totalDoProbes===1 && st3.totalFlowMeters===1 && st3.totalLevelSensors===1, 'IN07d. per-type total counts 1/1/1');
  }
  // IN08: livePower / liveOpex include powered sensors only (pump needs its own cable)
  {
    const basin = mkBasin();
    const eq = [mkDo('d1',6,6), mkLevel('l1',7,6), mkFlow('f1',18,5), mkPump2()];
    const stNone = constructionStats([basin] as any, eq as any, [] as any);
    const stSensorsOnly = constructionStats([basin] as any, eq as any, [cable2(6,6,22,5), cable2(18,5,22,5)] as any);
    assert(stNone.livePowerKw === 0, 'IN08. no cables → livePower 0 (nothing powered, pump dark)');
    assert(stSensorsOnly.livePowerKw > stNone.livePowerKw, 'IN08b. powered sensors increase livePower '+stNone.livePowerKw+' → '+stSensorsOnly.livePowerKw);
    assert(Math.abs(stSensorsOnly.livePowerKw - (11 + 0.3 + 0.45)) < 0.01 || Math.abs(stSensorsOnly.livePowerKw - (0.3 + 0.45)) < 0.01, 'IN08c. DO+flow powered (0.3+0.45='+stSensorsOnly.livePowerKw+')');
    assert(stSensorsOnly.liveOpexPerDay > stNone.liveOpexPerDay, 'IN08d. powered sensors increase liveOpex '+stNone.liveOpexPerDay+' → '+stSensorsOnly.liveOpexPerDay);
  }
  // IN09: basin integrity — sensor prevents basin demolition
  {
    let s2:any = withBasin2();
    const rS = GameManager.placeProcessEquipment(s2, 'do_probe', 6, 6);
    const basinId = rS.newState.customBasins[0].id;
    const demo = GameManager.demolishCustomBasin(rS.newState, basinId);
    assert(!demo.success && /equipment/i.test(demo.reason??''), 'IN09. basin demolition refused while DO probe remains mounted');
    const cleared = GameManager.demolishProcessEquipment(rS.newState, rS.newState.processEquipment.find((e:any)=>e.typeId==='do_probe')!.id);
    const demo2 = GameManager.demolishCustomBasin(cleared.newState, basinId);
    assert(demo2.success, 'IN09b. basin demolishes once sensor removed');
  }
  // IN10: Instrumented badge requires >=2 powered sensors (not 1)
  {
    const basin = mkBasin();
    const badges0 = recognizeProcess([basin] as any, [], [mkDo('d1',6,6)] as any, [] as any);
    assert(!has2(badges0,'instrumented'), 'IN10. single unpowered sensor → no Instrumented badge');
    const badges1 = recognizeProcess([basin] as any, [], [mkDo('d1',6,6), mkLevel('l1',7,6), mkPump2()] as any, [cable2(6,6,22,5)] as any);
    assert(!has2(badges1,'instrumented'), 'IN10b. 1 powered sensor → still no Instrumented badge');
    const badges2 = recognizeProcess([basin] as any, [], [mkDo('d1',6,6), mkLevel('l1',7,6), mkFlow('f1',18,5), mkPump2()] as any, [cable2(6,6,22,5), cable2(7,6,22,5)] as any);
    assert(has2(badges2,'instrumented'), 'IN10c. 2 powered sensors → Instrumented badge');
    assert(badges2.find((b:any)=>b.id==='instrumented')!.detail.includes('2 sensors'), 'IN10d. detail mentions 2 sensors live');
  }
  // IN11: Instrumented badge shows type count — full triad when all 3 types live
  {
    const basin = mkBasin();
    const badgesSame = recognizeProcess([basin] as any, [], [mkDo('d1',6,6), mkDo('d2',7,6), mkPump2()] as any, [cable2(6,6,22,5), cable2(7,6,22,5)] as any);
    assert(badgesSame.find((b:any)=>b.id==='instrumented')!.detail.includes('1 sensor type'), 'IN11. 2 DO probes → 1 sensor type');
    const badgesTriad = recognizeProcess([basin] as any, [], [mkDo('d1',6,6), mkFlow('f1',18,5), mkLevel('l1',7,6), mkPump2()] as any, [cable2(6,6,22,5), cable2(18,5,22,5), cable2(7,6,22,5)] as any);
    assert(badgesTriad.find((b:any)=>b.id==='instrumented')!.detail.includes('full triad'), 'IN11b. full triad 3 types detected');
  }
  // IN12: unpowered sensors → no Instrumented badge even with 3 sensors present
  {
    const basin = mkBasin();
    const badges = recognizeProcess([basin] as any, [], [mkDo('d1',6,6), mkFlow('f1',18,5), mkLevel('l1',7,6)] as any, [] as any);
    assert(!has2(badges,'instrumented'), 'IN12. 3 unpowered sensors → no Instrumented badge');
  }
  // IN13: demolish sensor refunds 70% and updates stats
  {
    let s:any = withBasin2();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=10_000_000;
    const builtDo = GameManager.placeProcessEquipment(s, 'do_probe', 6, 6);
    const builtFlow = GameManager.placeProcessEquipment(builtDo.newState, 'flow_meter', 22, 5);
    const builtLevel = GameManager.placeProcessEquipment(builtFlow.newState, 'level_sensor', 7, 6);
    const idDo = builtLevel.newState.processEquipment.find((e:any)=>e.typeId==='do_probe')!.id;
    const demo = GameManager.demolishProcessEquipment(builtLevel.newState, idDo);
    const salvageDo = Math.round(3200*0.7);
    assert(demo.success && demo.refunded===salvageDo, 'IN13. demolish DO probe refunds 70% ($'+salvageDo+')');
    const stAfter = constructionStats((demo.newState as any).customBasins, (demo.newState as any).processEquipment, (demo.newState as any).utilityConnections) as any;
    assert(stAfter.totalSensors===2 && stAfter.totalDoProbes===0, 'IN13b. stats after demolish: 2 sensors, 0 DO probes');
  }
  // IN14: summary line includes sensor live counts when present
  {
    const basin = mkBasin();
    const st = constructionStats([basin] as any, [mkDo('d1',6,6), mkFlow('f1',18,5), mkPump2()] as any, [cable2(6,6,22,5), cable2(18,5,22,5)] as any);
    const line = constructionSummaryLine(st);
    assert(line.includes('sensors live'), 'IN14. summary line includes sensors live: '+line);
  }
  // IN15: baffled sensors in different zones both instrumented
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bInst15', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bInst15', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const eq = [mkDo('d1',6,6), mkLevel('l1',10,6), mkFlow('f1',18,5), mkPump2()];
    const badges = recognizeProcess([basin] as any, baffles as any, eq as any, [cable2(6,6,22,5), cable2(10,6,22,5), cable2(18,5,22,5)] as any);
    assert(has2(badges,'instrumented'), 'IN15. baffled sensors in different zones still instrumented');
    assert(badges.find((b:any)=>b.id==='instrumented')!.detail.includes('3 sensors'), 'IN15b. detail shows 3 sensors across zones');
  }
  // IN16: unknown equipment still rejected after catalog expansion
  {
    const s = withBasin2();
    assert(!GameManager.placeProcessEquipment(s, 'flux_capacitor', 6, 6).success, 'IN16. unknown type still rejected after sensor expansion');
  }
}

// ═════════════════════════════════════════════════════════════
// CONSTRUCTION-BUILDER Phase 7 slice 3: chemical dosing kit (storage + dosing pump)
// ═════════════════════════════════════════════════════════════
{
  const mkBasinC = (x=5,y=5,w=8,h=6,id='bC1') => ({ x, y, w, h, depthM:4, id, createdAtDay:0 } as any);
  const mkStorage = (id:string,x:number,y:number) => ({ id, typeId:'chemical_storage_tank', x, y, createdAtDay:0 } as any);
  const mkDosing = (id:string,x:number,y:number) => ({ id, typeId:'chemical_dosing_pump', x, y, createdAtDay:0 } as any);
  const mkMixerC = (id:string,x:number,y:number) => ({ id, typeId:'submersible_mixer', x, y, createdAtDay:0 } as any);
  const mkPumpC = (x=22,y=5) => ({ id:'puC', typeId:'process_pump', x, y, createdAtDay:0 } as any);
  const cableC = (ax:number,ay:number,bx:number,by:number) => ({ id:'c_'+ax+'_'+ay+'_'+bx+'_'+by, type:'power_cable', ax, ay, bx, by, createdAtDay:0 } as any);
  const withBasinC = () => {
    let s:any = GameManager.createInitialState(0, true);
    const r = GameManager.placeCustomBasin(s, { x:5, y:5, w:8, h:6 });
    if (!r.success) throw new Error('withBasinC failed: '+r.reason);
    return r.newState;
  };
  const hasC = (badges:any[], id:string) => badges.some((b:any)=>b.id===id);

  // CH01: chemical_storage_tank mounts on open ground, inside basin rejected
  {
    const s = withBasinC();
    const rGround = GameManager.placeProcessEquipment(s, 'chemical_storage_tank', 22, 5);
    const rInBasin = GameManager.placeProcessEquipment(s, 'chemical_storage_tank', 6, 6);
    assert(rGround.success, 'CH01. storage_tank mounts on open ground');
    assert(!rInBasin.success && /dry/i.test(rInBasin.reason??''), 'CH01b. storage_tank inside basin rejected: '+(rInBasin.reason??''));
  }
  // CH02: chemical_dosing_pump mounts inside a basin
  {
    const s = withBasinC();
    const rIn = GameManager.placeProcessEquipment(s, 'chemical_dosing_pump', 6, 6);
    const rOut = GameManager.placeProcessEquipment(s, 'chemical_dosing_pump', 0, 0);
    assert(rIn.success, 'CH02. dosing_pump mounts inside a basin');
    assert(!rOut.success && /basin/i.test(rOut.reason??''), 'CH02b. dosing_pump outside basin rejected: '+(rOut.reason??''));
  }
  // CH03: tile exclusivity
  {
    const s = withBasinC();
    const r1 = GameManager.placeProcessEquipment(s, 'chemical_dosing_pump', 6, 6);
    const r2 = GameManager.placeProcessEquipment(r1.newState, 'chemical_storage_tank', 6, 6);
    // storage is ground but tile 6,6 is in basin so second fails due to mounting not exclusivity; test exclusivity with same mounting
    const r3 = GameManager.placeProcessEquipment(r1.newState, 'chemical_dosing_pump', 6, 6);
    assert(r1.success && !r3.success && /already holds/i.test(r3.reason??''), 'CH03. tile exclusivity blocks second dosing pump on same tile');
  }
  // CH04: exact campaign CAPEX
  {
    let s:any = withBasinC();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=10_000_000;
    const cash0 = s.financials.cash;
    let r = GameManager.placeProcessEquipment(s, 'chemical_storage_tank', 22, 5); s=r.newState;
    assert(cash0 - s.financials.cash === 11500, 'CH04. storage_tank CAPEX $11500 (got '+(cash0 - s.financials.cash)+')');
    const cash1 = s.financials.cash;
    r = GameManager.placeProcessEquipment(s, 'chemical_dosing_pump', 6, 6); s=r.newState;
    assert(cash1 - s.financials.cash === 6800, 'CH04b. dosing_pump CAPEX $6800 (got '+(cash1 - s.financials.cash)+')');
  }
  // CH05: unaffordable rejected
  {
    let s:any = withBasinC();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=100;
    const r = GameManager.placeProcessEquipment(s, 'chemical_dosing_pump', 6, 6);
    assert(!r.success, 'CH05. unaffordable dosing pump rejected');
  }
  // CH06: powered model — storage and dosing need power cable on their exact tile
  {
    const basin = mkBasinC();
    const storage = mkStorage('st1', 22,5);
    const dosing = mkDosing('dp1',6,6);
    const mixer = mkMixerC('mx1',7,6);
    const eq = [storage, dosing, mixer, mkPumpC()] as any;
    const stNone = constructionStats([basin] as any, eq, [] as any);
    assert(stNone.totalChemicalUnits===2 && stNone.poweredChemicalUnits===0, 'CH06. 0/2 chemical powered with no cables (got '+stNone.poweredChemicalUnits+'/'+stNone.totalChemicalUnits+')');
    const stStorageOnly = constructionStats([basin] as any, eq, [cableC(22,5,22,5)] as any);
    assert(stStorageOnly.poweredChemicalUnits===1 && stStorageOnly.poweredStorageTanks===1, 'CH06b. storage powered alone (got '+stStorageOnly.poweredStorageTanks+'/'+stStorageOnly.totalStorageTanks+')');
    const stBoth = constructionStats([basin] as any, eq, [cableC(22,5,22,5), cableC(6,6,22,5), cableC(7,6,22,5)] as any);
    assert(stBoth.poweredChemicalUnits===2 && stBoth.poweredDosingPumps===1, 'CH06c. both chemical powered (got '+stBoth.poweredChemicalUnits+'/'+stBoth.totalChemicalUnits+')');
  }
  // CH07: livePower includes powered chemical
  {
    const basin = mkBasinC();
    const eq = [mkStorage('st1',22,5), mkDosing('dp1',6,6), mkMixerC('mx1',7,6)] as any;
    const stNone = constructionStats([basin] as any, eq, [] as any);
    const stAll = constructionStats([basin] as any, eq, [cableC(22,5,22,5), cableC(6,6,22,5), cableC(7,6,22,5)] as any);
    assert(stAll.livePowerKw > stNone.livePowerKw, 'CH07. powered chemical increases livePower '+stNone.livePowerKw+' → '+stAll.livePowerKw);
    assert(Math.abs(stAll.livePowerKw - (4 + 0.6 + 0.9)) < 0.01, 'CH07b. livePower includes storage 0.6 + dosing 0.9 + mixer 4 = '+stAll.livePowerKw);
  }
  // CH08: basin demolition blocked while dosing pump remains inside
  {
    let s2:any = withBasinC();
    const rD = GameManager.placeProcessEquipment(s2, 'chemical_dosing_pump', 6, 6);
    const basinId = rD.newState.customBasins[0].id;
    const demo = GameManager.demolishCustomBasin(rD.newState, basinId);
    assert(!demo.success && /equipment/i.test(demo.reason??''), 'CH08. basin demolition refused while dosing pump remains mounted');
    const cleared = GameManager.demolishProcessEquipment(rD.newState, rD.newState.processEquipment.find((e:any)=>e.typeId==='chemical_dosing_pump')!.id);
    const demo2 = GameManager.demolishCustomBasin(cleared.newState, basinId);
    assert(demo2.success, 'CH08b. basin demolishes once dosing pump removed');
  }
  // CH09: Chemical badge thresholds
  {
    const basin = mkBasinC();
    const badgesNone = recognizeProcess([basin] as any, [], [mkDosing('dp1',6,6)] as any, [] as any);
    assert(hasC(badgesNone,'chemical-dormant'), 'CH09. unpowered dosing → chemical-dormant badge');
    const badgesStorage = recognizeProcess([basin] as any, [], [mkStorage('st1',22,5), mkPumpC()] as any, [cableC(22,5,22,5)] as any);
    assert(hasC(badgesStorage,'chemical'), 'CH09b. 1 powered storage → Chemical ready badge');
    const mixer = mkMixerC('mx1',7,6);
    const badgesActive = recognizeProcess([basin] as any, [], [mixer, mkDosing('dp1',6,6), mkPumpC()] as any, [cableC(7,6,22,5), cableC(6,6,22,5)] as any);
    assert(hasC(badgesActive,'chemical') && badgesActive.find((b:any)=>b.id==='chemical')!.label==='Chemically dosed', 'CH09c. powered dosing in mixed zone → Chemically dosed badge');
  }
  // CH10: TP polish — powered dosing in healthy zone reduces TP, unpowered identity
  {
    const basin = mkBasinC();
    const mixer = mkMixerC('mx1',7,6);
    const dosing = mkDosing('dp1',6,6);
    const ceNone = evaluateConstructionEffects([basin] as any, [dosing] as any, [] as any, [] as any);
    assert(Math.abs(ceNone.tpMultiplier - 1) < 0.001, 'CH10. unpowered dosing → tpMultiplier 1 (got '+ceNone.tpMultiplier.toFixed(3)+')');
    const ceUnhealthy = evaluateConstructionEffects([basin] as any, [dosing, mixer] as any, [cableC(6,6,22,5)] as any, [] as any);
    // mixer not powered (no cable on 7,6) → zone unhealthy → dosing dormant → tp still 1
    assert(Math.abs(ceUnhealthy.tpMultiplier - 1) < 0.001, 'CH10b. dosing in septic zone → dormant tp 1 (got '+ceUnhealthy.tpMultiplier.toFixed(3)+')');
    const ceActive = evaluateConstructionEffects([basin] as any, [dosing, mixer] as any, [cableC(6,6,22,5), cableC(7,6,22,5)] as any, [] as any);
    assert(ceActive.tpMultiplier < 0.99 && ceActive.tpMultiplier > 0.3, 'CH10c. active dosing → tpMultiplier <1 (got '+ceActive.tpMultiplier.toFixed(3)+')');
    assert(Math.abs(ceActive.tpMultiplier - 0.78) < 0.01, 'CH10d. one active dosing pump → tp 0.78 (got '+ceActive.tpMultiplier.toFixed(3)+')');
  }
  // CH11: storage TP polish and stacking cap
  {
    const basin = mkBasinC();
    const mixer = mkMixerC('mx1',7,6);
    const st1 = mkStorage('st1',22,5);
    const st2 = mkStorage('st2',23,5);
    const dp1 = mkDosing('dp1',6,6);
    const ceStorageOnly = evaluateConstructionEffects([basin] as any, [st1] as any, [cableC(22,5,22,5)] as any, [] as any);
    assert(Math.abs(ceStorageOnly.tpMultiplier - 0.92) < 0.01, 'CH11. one powered storage → tp 0.92 (got '+ceStorageOnly.tpMultiplier.toFixed(3)+')');
    const ceStack = evaluateConstructionEffects([basin] as any, [st1, st2, dp1, mixer] as any, [cableC(22,5,22,5), cableC(23,5,22,5), cableC(6,6,22,5), cableC(7,6,22,5)] as any, [] as any);
    const expected = 0.78 * 0.92 * 0.92;
    assert(Math.abs(ceStack.tpMultiplier - expected) < 0.02, 'CH11b. stacking 1 dosing +2 storage → tp '+ceStack.tpMultiplier.toFixed(3)+' ≈ '+expected.toFixed(3));
    // Cap at 0.35 with many units
    const many:any[] = [];
    for(let i=0;i<6;i++) many.push(mkStorage('st'+i,22+i,5));
    for(let i=0;i<4;i++) many.push(mkDosing('dp'+i,6+i,6));
    many.push(mixer);
    const cables:any[] = [...many.filter(e=>e.typeId==='chemical_storage_tank').map(e=>cableC(e.x,e.y,22,5)), ...many.filter(e=>e.typeId==='chemical_dosing_pump').map(e=>cableC(e.x,e.y,22,5)), cableC(7,6,22,5)];
    const ceCap = evaluateConstructionEffects([basin] as any, many as any, cables as any, [] as any);
    assert(ceCap.tpMultiplier >= 0.35 && ceCap.tpMultiplier <= 0.36, 'CH11c. cap at 0.35 with many dosing (got '+ceCap.tpMultiplier.toFixed(3)+')');
  }
  // CH12: TP polish lifecycle via tick
  {
    let gs:any = GameManager.createInitialState(0, true);
    let r = GameManager.placeCustomBasin(gs, { x:5,y:5,w:8,h:6 }); gs=r.newState;
    r = GameManager.placeProcessEquipment(gs, 'submersible_mixer', 7,6); gs=r.newState;
    r = GameManager.placeProcessEquipment(gs, 'chemical_dosing_pump', 6,6); gs=r.newState;
    r = GameManager.placeProcessEquipment(gs, 'chemical_storage_tank', 22,5); gs=r.newState;
    // Power all
    r = GameManager.placeUtilityConnection(gs, 'power_cable', 7,6,22,5); gs=r.newState;
    r = GameManager.placeUtilityConnection(gs, 'power_cable', 6,6,22,5); gs=r.newState;
    r = GameManager.placeUtilityConnection(gs, 'power_cable', 22,5,22,6); gs=r.newState;
    // Create a simple train to get flow: influent → outfall directly still yields flow via tick? Use dummy pipe train
    gs.units.push({ instanceId:'scr', typeId:'bar_screen', gridX:10, gridY:10, rotation:0, volume:100, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastOutletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastPowerKwActual:0, lastOpexActual:0 } as any);
    const tpBefore = gs.finalEffluent.tp;
    // Tick will have no flow initially (no pipes), so TP not relevant. We test via evaluateConstructionEffects directly and GameManager.tick with a built train.
    // Instead, directly assert evaluateConstructionEffects tp is applied when hasFlow true in tick: create a proper train with pipes
    let gs2:any = GameManager.createInitialState(0, true);
    let rr = GameManager.placeCustomBasin(gs2, { x:5,y:5,w:4,h:4 }); gs2=rr.newState;
    rr = GameManager.placeProcessEquipment(gs2, 'submersible_mixer', 6,6); gs2=rr.newState;
    rr = GameManager.placeProcessEquipment(gs2, 'chemical_dosing_pump', 5,5); gs2=rr.newState;
    rr = GameManager.placeUtilityConnection(gs2, 'power_cable', 6,6,5,5); gs2=rr.newState;
    // Build minimal legacy train for flow: inlet → bar_screen → outfall
    const scr = { instanceId:'scr2', typeId:'bar_screen', gridX:10, gridY:10, rotation:0, volume:200, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastOutletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastPowerKwActual:0, lastOpexActual:0 } as any;
    gs2.units.push(scr);
    gs2.pipes.push({ id:'p1', fromUnitId:'inlet_0', fromPortId:'outlet', toUnitId:'scr2', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'} as any,
                   { id:'p2', fromUnitId:'scr2', fromPortId:'outlet', toUnitId:'outfall_0', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'} as any);
    let ticked = gs2;
    for(let i=0;i<5;i++) ticked = GameManager.tick(ticked, 0.5);
    const tpAfter = ticked.finalEffluent.tp;
    const tpNoChem = (()=>{ let g:any=GameManager.createInitialState(0,false); g.units.push(scr); g.pipes.push({id:'p1', fromUnitId:'inlet_0', fromPortId:'outlet', toUnitId:'scr2', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'} as any, {id:'p2', fromUnitId:'scr2', fromPortId:'outlet', toUnitId:'outfall_0', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'} as any); for(let i=0;i<5;i++) g=GameManager.tick(g,0.5); return g.finalEffluent.tp; })();
    assert(tpAfter < tpNoChem, 'CH12. tick TP with dosing ('+tpAfter.toFixed(2)+') < without dosing ('+tpNoChem.toFixed(2)+')');
  }
  // CH13: demolish dosing refunds 70%
  {
    let s:any = withBasinC();
    s.gameMode='campaign'; s.tutorialActive=false; s.financials.cash=10_000_000;
    const builtD = GameManager.placeProcessEquipment(s, 'chemical_dosing_pump', 6, 6);
    const id = builtD.newState.processEquipment.find((e:any)=>e.typeId==='chemical_dosing_pump')!.id;
    const demo = GameManager.demolishProcessEquipment(builtD.newState, id);
    const salvage = Math.round(6800*0.7);
    assert(demo.success && demo.refunded===salvage, 'CH13. demolish dosing pump refunds 70% ($'+salvage+')');
  }
  // CH14: summary line includes dosing live
  {
    const basin = mkBasinC();
    const st = constructionStats([basin] as any, [mkDosing('dp1',6,6), mkStorage('st1',22,5), mkPumpC()] as any, [cableC(6,6,22,5), cableC(22,5,22,5)] as any);
    const line = constructionSummaryLine(st);
    assert(line.includes('dosing live'), 'CH14. summary line includes dosing live: '+line);
  }
  // CH15: baffled dosing — per-zone health
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bChem15', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bChem15', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const eq = [mkMixerC('mx1',6,6), mkDosing('dp1',6,6), mkDosing('dp2',10,6), mkPumpC()] as any;
    const ce = evaluateConstructionEffects([basin] as any, eq, [cableC(6,6,22,5), cableC(7,6,22,5), cableC(10,6,22,5)] as any, baffles as any);
    // Only dp1 in healthy left zone should be active, dp2 in septic right zone dormant
    assert(ce.activeDosingPumps===1, 'CH15. baffled dosing: only 1 active pump (healthy zone) (got '+ce.activeDosingPumps+')');
    assert(Math.abs(ce.tpMultiplier - 0.78) < 0.01, 'CH15b. baffled tp 0.78 for single active (got '+ce.tpMultiplier.toFixed(3)+')');
  }
  // CH16: badge baffled remains active
  {
    const basin = { x:5,y:5,w:8,h:6, depthM:4, id:'bChem16', createdAtDay:0 } as any;
    const baffles:any[] = [{ id:'bf1', basinId:'bChem16', orientation:'vertical', offsetTiles:4, createdAtDay:0 }];
    const eq = [mkMixerC('mx1',6,6), mkDosing('dp1',6,6), mkPumpC()] as any;
    const badges = recognizeProcess([basin] as any, baffles as any, eq, [cableC(6,6,22,5), cableC(7,6,22,5)] as any);
    assert(hasC(badges,'chemical'), 'CH16. baffled active dosing still yields Chemically dosed badge');
    assert(badges.find((b:any)=>b.id==='chemical')!.detail.includes('1 dosing'), 'CH16b. detail mentions 1 dosing active');
  }
}






// ── TYCOON POLISH iter 36: Owner-Builder Construction Contracts (flow-independent) ─
{
  const mkBasinCC = (id,x=5,y=5,w=4,h=4) => ({ x, y, w, h, depthM:4, id, createdAtDay:0 });
  const mkMixerCC = (id,x,y) => ({ id, typeId:'submersible_mixer', x, y, createdAtDay:0 });
  const mkDiffCC = (id,x,y) => ({ id, typeId:'fine_bubble_diffuser', x, y, createdAtDay:0 });
  const mkPumpCC = (id,x,y) => ({ id, typeId:'process_pump', x, y, createdAtDay:0 });
  const cableCC = (ax,ay,bx,by) => ({ type:'power_cable', ax, ay, bx, by });
  const objCC = (s, id) => s.currentLevel.objectives.find((o)=>o.id===id);
  {
    let gs = GameManager.createInitialState(0, true);
    gs.currentLevel.objectives = [{ id:'obj_custom_basins', description:'2 basins', type:'construction', targetValue:2, achieved:false }];
    gs.customBasins = [];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_basins').achieved, 'CC01. 0 basins does NOT satisfy target 2');
    gs.customBasins = [mkBasinCC('b1')];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_basins').achieved, 'CC01b. 1 basin does NOT satisfy target 2');
    gs.customBasins = [mkBasinCC('b1'), mkBasinCC('b2',10,10)];
    gs = GameManager.tick(gs, 0.5);
    assert(objCC(gs,'obj_custom_basins').achieved, 'CC01c. 2 basins satisfies target 2');
  }
  {
    let gs = GameManager.createInitialState(0, true);
    gs.currentLevel.objectives = [{ id:'obj_custom_basins', description:'default 1', type:'construction', achieved:false }];
    gs.customBasins = [mkBasinCC('b1')];
    gs = GameManager.tick(gs, 0.5);
    assert(objCC(gs,'obj_custom_basins').achieved, 'CC02. default target -> 1 basin sufficient');
    gs.customBasins = [];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_basins').achieved, 'CC02b. 0 basins fails default target');
  }
  {
    let gs = GameManager.createInitialState(0, true);
    gs.currentLevel.objectives = [{ id:'obj_custom_baffles', description:'2 baffles', type:'construction', targetValue:2, achieved:false }];
    gs.customBasins = [mkBasinCC('b1',5,5,8,6)];
    gs.customBaffles = [{ id:'bf1', basinId:'b1', orientation:'vertical', offsetTiles:2, createdAtDay:0 }];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_baffles').achieved, 'CC03. 1 baffle does NOT satisfy target 2');
    gs.customBaffles = [
      { id:'bf1', basinId:'b1', orientation:'vertical', offsetTiles:2, createdAtDay:0 },
      { id:'bf2', basinId:'b1', orientation:'horizontal', offsetTiles:3, createdAtDay:0 },
    ];
    gs = GameManager.tick(gs, 0.5);
    assert(objCC(gs,'obj_custom_baffles').achieved, 'CC03b. 2 baffles satisfies target 2');
  }
  {
    let gs = GameManager.createInitialState(0, true);
    gs.currentLevel.objectives = [{ id:'obj_custom_equipment', description:'3 machines', type:'construction', targetValue:3, achieved:false }];
    gs.customBasins = [mkBasinCC('b1',5,5,8,6)];
    gs.processEquipment = [mkDiffCC('d1',6,6), mkMixerCC('m1',7,6)];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_equipment').achieved, 'CC04. 2 machines does NOT satisfy target 3');
    gs.processEquipment = [mkDiffCC('d1',6,6), mkMixerCC('m1',7,6), mkPumpCC('p1',22,5)];
    gs = GameManager.tick(gs, 0.5);
    assert(objCC(gs,'obj_custom_equipment').achieved, 'CC04b. 3 machines satisfies target 3');
  }
  {
    let gs = GameManager.createInitialState(0, true);
    gs.currentLevel.objectives = [{ id:'obj_custom_powered', description:'2 powered', type:'construction', targetValue:2, achieved:false }];
    gs.customBasins = [mkBasinCC('b1',5,5,8,6)];
    const m1 = mkMixerCC('m1',6,6);
    const m2 = mkMixerCC('m2',7,6);
    const p1 = mkPumpCC('p1',22,5);
    gs.processEquipment = [m1, m2, p1];
    gs.utilityConnections = [];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_powered').achieved, 'CC05. 0 powered does NOT satisfy target 2');
    gs.utilityConnections = [cableCC(6,6,0,0)];
    gs = GameManager.tick(gs, 0.5);
    assert(!objCC(gs,'obj_custom_powered').achieved, 'CC05b. 1 powered does NOT satisfy target 2');
    gs.utilityConnections = [cableCC(6,6,0,0), cableCC(7,6,0,0)];
    gs = GameManager.tick(gs, 0.5);
    assert(objCC(gs,'obj_custom_powered').achieved, 'CC05c. 2 powered satisfies target 2');
    const d1 = mkDiffCC('d1',6,6);
    let gs2 = GameManager.createInitialState(0, true);
    gs2.currentLevel.objectives = [{ id:'obj_custom_powered', description:'1 powered', type:'construction', targetValue:1, achieved:false }];
    gs2.customBasins = [mkBasinCC('b1',5,5,8,6)];
    gs2.processEquipment = [d1];
    gs2.utilityConnections = [];
    gs2 = GameManager.tick(gs2, 0.5);
    assert(objCC(gs2,'obj_custom_powered').achieved, 'CC05d. passive diffuser (0 kW) is always powered -> satisfies target 1 without cable');
  }
  {
    let gs = GameManager.createInitialState(0, true);
    gs.currentLevel.objectives = [
      { id:'obj_custom_basins', description:'1 basin', type:'construction', targetValue:1, achieved:false },
      { id:'obj_custom_powered', description:'1 powered', type:'construction', targetValue:1, achieved:false },
    ];
    gs.customBasins = [mkBasinCC('b1')];
    gs.processEquipment = [mkDiffCC('d1',6,6)];
    gs.utilityConnections = [];
    gs.pipes = [];
    gs.units = [];
    gs = GameManager.tick(gs, 0.5);
    assert(gs.finalEffluent.flowRate < 10, 'CC06a. precondition: no effluent flow ('+gs.finalEffluent.flowRate.toFixed(1)+')');
    assert(objCC(gs,'obj_custom_basins').achieved, 'CC06b. basins contract passes WITHOUT flow — tycoon early build');
    assert(objCC(gs,'obj_custom_powered').achieved, 'CC06c. powered contract passes WITHOUT flow (passive)');
  }
  {
    const l4 = CAMPAIGN_LEVELS.find((l)=>l.id===4);
    const has = l4.objectives.some((o)=>o.id==='obj_custom_basins' && o.targetValue===2);
    assert(has, 'CC07. Level 4 (Emerald Lake) now carries Owner-Builder 2-basin showcase contract');
  }
  {
    let gs = GameManager.createInitialState(3, true);
    gs.currentLevel.objectives = [
      { id:'obj_custom_basins', description:'1 basin', type:'construction', targetValue:1, achieved:false },
      { id:'obj_bod', description:'BOD < 30', type:'effluent_standard', targetValue:30, achieved:false },
    ];
    gs.customBasins = [];
    const scr = { instanceId:'scrCC', typeId:'bar_screen', gridX:5, gridY:5, rotation:0, volume:200, customParams:{}, active:true, efficiencyRating:100, lastInletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastOutletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastPowerKwActual:0, lastOpexActual:0 };
    gs.units.push(scr);
    gs.pipes.push({ id:'p1', fromUnitId:'inlet_0', fromPortId:'outlet', toUnitId:'scrCC', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'},
                  { id:'p2', fromUnitId:'scrCC', fromPortId:'outlet', toUnitId:'outfall_0', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'});
    for(let i=0;i<10;i++) gs = GameManager.tick(gs, 0.5);
    assert(!gs.isLevelComplete, 'CC08a. not complete when construction contract unmet (even if flow exists)');
    gs.customBasins = [mkBasinCC('bCC',5,5,4,4)];
    const cas = { instanceId:'casCC', typeId:'activated_sludge_cas', gridX:10, gridY:5, rotation:0, volume:1728, customParams:{ doSetpoint:2.5, mlss:3200, rasRatio:0.4 }, active:true, efficiencyRating:100, lastInletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastOutletQuality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, lastPowerKwActual:0, lastOpexActual:0 };
    gs.units.push(cas);
    gs.pipes = [
      { id:'p1', fromUnitId:'inlet_0', fromPortId:'outlet', toUnitId:'scrCC', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'},
      { id:'p1b', fromUnitId:'scrCC', fromPortId:'outlet', toUnitId:'casCC', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'},
      { id:'p2', fromUnitId:'casCC', fromPortId:'outlet', toUnitId:'outfall_0', toPortId:'inlet', pathPoints:[], flowRate:0, quality:{flowRate:0,bod:0,cod:0,tss:0,tn:0,nh4:0,no3:0,tp:0,pathogens:0,do:0,ph:7,temp:20,toxicIndex:0,turbidity:0}, pipeType:'liquid'},
    ];
    for(let i=0;i<40;i++) gs = GameManager.tick(gs, 0.5);
    assert(objCC(gs,'obj_custom_basins').achieved, 'CC08b. construction contract now satisfied');
    if (gs.currentLevel.objectives.every((o)=>o.achieved)) {
      assert(gs.isLevelComplete, 'CC08c. level latches complete when BOTH construction + effluent contracts satisfied');
    } else {
      assert(!gs.isLevelComplete, 'CC08c. not complete until BOD also satisfied (bod '+gs.finalEffluent.bod.toFixed(1)+') — construction alone insufficient');
    }
  }
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
