// Probe: steady-state financial breakdown for canonical Level-1 train (Z scenario)
import { GameManager } from '../../src/gameplay/GameManager';
import { UNIT_DEFINITIONS } from '../../src/sim/UnitProcessModels';

const gsZ = GameManager.createInitialState(0, true); // sandbox level 1
let s: any = { ...gsZ, simSpeed: 5 as const };
const place = (type: string, x: number, y: number, params?: Record<string, number>) => {
  const r = GameManager.placeUnit(s, type as any, x, y);
  if (!r.success) { console.error('place fail:', type, r.reason); return null; }
  s = r.newState;
  const u = s.units[s.units.length - 1];
  if (params) Object.assign(u.customParams, params);
  return u;
};
const mkPipe = (id: string, from: string, fromPort: string, to: string, toPort: string, kind: any = 'liquid') =>
  ({ id, fromUnitId: from, fromPortId: fromPort, toUnitId: to, toPortId: toPort, pathPoints: [], flowRate: 0, quality: null, pipeType: kind } as any);

const scr = place('bar_screen', 5, 20)!;
const grt = place('grit_chamber', 8, 20)!;
const pri = place('primary_clarifier_circular', 11, 9)!;
const cas = place('activated_sludge_cas', 15, 9, { doSetpoint: 2.5 })!;
const clr = place('secondary_clarifier', 18, 12)!;
const uv = place('uv_disinfection', 21, 10)!;
const outfall = s.units.find((u: any) => u.typeId === 'effluent_outfall')!.instanceId;
s.pipes = [
  mkPipe('z1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
  mkPipe('z2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
  mkPipe('z3', grt.instanceId, 'outlet', pri.instanceId, 'inlet'),
  mkPipe('z4', pri.instanceId, 'outlet', cas.instanceId, 'inlet'),
  mkPipe('z5', cas.instanceId, 'outlet', clr.instanceId, 'inlet'),
  mkPipe('z6', clr.instanceId, 'outlet', uv.instanceId, 'inlet'),
  mkPipe('z7', uv.instanceId, 'outlet', outfall, 'inlet'),
  mkPipe('z8', clr.instanceId, 'sludge_outlet', cas.instanceId, 'ras_inlet', 'ras')
];

for (let i = 0; i <= 400; i++) {
  s = GameManager.tick(s, 0.5);
  if (i % 100 === 0 || i === 400) {
    const f = s.financials;
    console.log(`tick ${i}: flow=${s.finalEffluent.flowRate.toFixed(0)} m³/d rev=$${f.dailyRevenue.toFixed(0)} opex=$${f.dailyOpex.toFixed(0)} net=$${f.netDailyProfit.toFixed(0)}/d fines=$${f.dailyFines} power=$${f.dailyPowerCost?.toFixed(0)} chem=$${f.dailyChemicalCost?.toFixed(0)} bod=${s.finalEffluent.bod.toFixed(1)} tss=${s.finalEffluent.tss.toFixed(1)} score=${s.overallStats.complianceScore}`);
    if (i === 400 || i === 0) {
      console.log('  violations:', JSON.stringify(s.overallStats.activeAlerts.map((a: any) => a.message)));
    }
  }
}

console.log('\n=== Level 1 objectives ===');
for (const o of s.currentLevel.objectives) console.log(` ${o.id}: target=${JSON.stringify(o.targetValue ?? o.target ?? '?')} achieved=${o.achieved}`);

console.log('\n=== Unit OPEX/power (steady state) ===');
let sumOpex = 0, sumPow = 0;
for (const u of s.units) {
  sumOpex += u.lastOpexActual || 0;
  if ((u.lastPowerKwActual || 0) > 0) sumPow += u.lastPowerKwActual;
  console.log(` ${u.typeId}: opex/day=$${(u.lastOpexActual||0).toFixed(1)} power=${(u.lastPowerKwActual||0).toFixed(2)} kW`);
}
console.log(`TOTAL unitOpex=$${sumOpex.toFixed(1)} demand=${sumPow.toFixed(2)} kW`);

console.log('\ntariffPerM3=', (gsZ as any).currentLevel?.tariffPerM3 ?? 'see level def');
const lvl = s.currentLevel;
console.log('level:', lvl.name, '| tariff fields:', Object.keys(lvl).filter(k => /tariff|revenue|fund|budget|reward/i.test(k)).map(k => `${k}=${JSON.stringify(lvl[k])}`).join(', '));
console.log('\ndefinition opex/capex:');
for (const t of ['bar_screen','grit_chamber','primary_clarifier_circular','activated_sludge_cas','secondary_clarifier','uv_disinfection']) {
  const d = (UNIT_DEFINITIONS as any)[t];
  console.log(` ${t}: capex=$${d.capex} baseOpex=$${d.opex}`);
}
