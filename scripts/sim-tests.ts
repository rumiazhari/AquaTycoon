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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
