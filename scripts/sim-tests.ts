/* Headless smoke tests for the fixed simulation core (run via esbuild+node) */
import { GameManager } from '../src/gameplay/GameManager';
import { SimulationEngine } from '../src/sim/SimulationEngine';
import { UNIT_DEFINITIONS } from '../src/sim/UnitProcessModels';

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
  ].map(([f, fp, t, tp], i) => ({ id: `tp${i}`, fromUnitId: f, fromPortId: fp, toUnitId: t, toPortId: tp, pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: 'liquid' }));
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

  // Under-performing plant: full train but DO setpoint at minimum → violations exist,
  // and the top param fix must measurably reduce the violation score.
  const under = GameManager.createInitialState(0, false);
  const addU = (id: string, t: string, x: number, y: number) => {
    const u = mkUnit(id, t, x, y);
    if (t === 'activated_sludge_cas') u.customParams.doSetpoint = 0.5;
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
  ].map(([f, fp, t, tp], i) => ({ id: `up${i}`, fromUnitId: f, fromPortId: fp, toUnitId: t, toPortId: tp, pathPoints: [], flowRate: 0, quality: emptyW(), pipeType: 'liquid' }));
  under.pipes.push(...P);
  let st: any = under;
  for (let i = 0; i < 25; i++) st = GameManager.tick(st, 0.5);

  assert(st.finalEffluent.flowRate > 10 && st.overallStats.complianceScore < 100,
    `Under-tuned plant violates (${st.overallStats.complianceScore}% compliance) — advisor has something to fix`);

  const advs = generateAdvisories(st);
  assert(advs.length > 0, `Advisor generated ${advs.length} advisory card(s)`);

  const paramFixes = advs.flatMap(a => a.fixes).filter(f => f.kind === 'adjust_param' && f.prediction && f.prediction.includes('✓'));
  assert(paramFixes.length > 0,
    `Advisor found ${paramFixes.length} simulated fix(es) that flip parameters to PASS (e.g. "${paramFixes[0]?.label}")`);
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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
