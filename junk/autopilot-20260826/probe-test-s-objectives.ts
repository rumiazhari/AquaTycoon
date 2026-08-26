// Probe: replicate sim-tests Test S and dump per-objective state + pump telemetry.
import { GameManager } from '../../src/gameplay/GameManager';
import { UNIT_DEFINITIONS } from '../../src/sim/UnitProcessModels';
import type { PlacedUnit, PipeConnection, UnitTypeId } from '../../src/types/simulation';

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
const mkPipe = (id: string, from: string, fromPort: string, to: string, toPort: string, kind?: string): PipeConnection =>
  ({ id, fromUnitId: from, fromPort, toUnitId: to, toPort, pipeClass: 'gravity', ...(kind ? { kind } : {}) } as any);

const scr = place('bar_screen', 5, 20)!;
const grt = place('grit_chamber', 8, 20)!;
const pri = place('primary_clarifier_circular', 11, 20)!;
const cas = place('activated_sludge_cas', 16, 20, { doSetpoint: 2.5 })!;
const cl = place('secondary_clarifier', 22, 23)!;
s.pipes = [
  mkPipe('sp1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
  mkPipe('sp2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
  mkPipe('sp3', grt.instanceId, 'outlet', pri.instanceId, 'inlet'),
  mkPipe('sp4', pri.instanceId, 'outlet', cas.instanceId, 'inlet'),
  mkPipe('sp5', cas.instanceId, 'outlet', cl.instanceId, 'inlet'),
  mkPipe('sp6', cl.instanceId, 'outlet', 'outfall_0', 'inlet'),
  mkPipe('sp7', cl.instanceId, 'sludge_outlet', cas.instanceId, 'ras_inlet', 'ras')
];
for (let i = 0; i < 300; i++) s = GameManager.tick(s, 1);

const pumpCapex = UNIT_DEFINITIONS.pump_station.capex;
let waitTicks = 0;
while (s.financials.cash < pumpCapex && waitTicks < 1200) { s = GameManager.tick(s, 1); waitTicks++; }
console.log(`pump wait ticks=${waitTicks} cash=$${s.financials.cash.toFixed(0)} pumpCapex=$${pumpCapex}`);
const pmp = place('pump_station', 26, 20);

const uvCapex = UNIT_DEFINITIONS.uv_disinfection.capex;
waitTicks = 0;
while (s.financials.cash < uvCapex && waitTicks < 1200) { s = GameManager.tick(s, 1); waitTicks++; }
console.log(`uv wait ticks=${waitTicks} cash=$${s.financials.cash.toFixed(0)} uvCapex=$${uvCapex}`);
const uv = place('uv_disinfection', 29, 20);
console.log(`pmp=${pmp ? pmp.instanceId : 'FAILED'} uv=${uv ? uv.instanceId : 'FAILED'}`);

if (pmp && uv) {
  s.pipes = s.pipes.filter((p: PipeConnection) => !(p.fromUnitId === cl.instanceId && p.toUnitId === 'outfall_0'));
  s.pipes.push(
    mkPipe('sp8', cl.instanceId, 'outlet', pmp.instanceId, 'inlet'),
    mkPipe('sp9', pmp.instanceId, 'outlet', uv.instanceId, 'inlet'),
    mkPipe('sp10', uv.instanceId, 'outlet', 'outfall_0', 'inlet')
  );
  for (let i = 0; i < 600; i++) s = GameManager.tick(s, 1);
}

console.log('\n=== OBJECTIVE STATE ===');
for (const o of s.currentLevel.objectives) {
  console.log(`${o.achieved ? 'MET ' : 'MISS'} ${o.id} target=${o.targetValue ?? '-'}`);
}
console.log('\n=== PUMP TELEMETRY ===');
const pu = s.units.find((u: any) => u.typeId === 'pump_station');
console.log(JSON.stringify(pu?.pumpRuntime, null, 1));
console.log(`isLevelComplete=${s.isLevelComplete} profit=$${s.financials.netDailyProfit.toFixed(0)}/d effFlow=${s.finalEffluent.flowRate.toFixed(0)} m³/d bod=${s.finalEffluent.bod.toFixed(1)} path=${s.finalEffluent.pathogens.toFixed(0)}`);
