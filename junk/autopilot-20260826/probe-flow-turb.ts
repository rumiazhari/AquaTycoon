// Probe 2: why is steady-state flow ~3500 not 10000? And where do COD/turbidity come from?
import { GameManager } from '../../src/gameplay/GameManager';
import { SimulationEngine } from '../../src/sim/SimulationEngine';
import { CAMPAIGN_LEVELS } from '../../src/gameplay/LevelsData';

const gsZ = GameManager.createInitialState(0, true);
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
const outfallId = s.units.find((u: any) => u.typeId === 'effluent_outfall')!.instanceId;
s.pipes = [
  mkPipe('z1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
  mkPipe('z2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
  mkPipe('z3', grt.instanceId, 'outlet', pri.instanceId, 'inlet'),
  mkPipe('z4', pri.instanceId, 'outlet', cas.instanceId, 'inlet'),
  mkPipe('z5', cas.instanceId, 'outlet', clr.instanceId, 'inlet'),
  mkPipe('z6', clr.instanceId, 'outlet', uv.instanceId, 'inlet'),
  mkPipe('z7', uv.instanceId, 'outlet', outfallId, 'inlet'),
  mkPipe('z8', clr.instanceId, 'sludge_outlet', cas.instanceId, 'ras_inlet', 'ras')
];
for (let i = 0; i <= 400; i++) {
  s = GameManager.tick(s, 0.5);
  if (i % 50 === 0) {
    const unitsById: Record<string, any> = {};
    for (const u of s.units) unitsById[u.instanceId] = u;
    const inletQ = unitsById['inlet_0']?.lastOutletQuality;
    const uvU = s.units.find((u: any) => u.typeId === 'uv_disinfection');
    console.log(`t${i}: gameTimeDay=${s.gameTimeDays.toFixed(2)} inletFlow=${(inletQ?.flowRate||0).toFixed(0)} uvOut=${(uvU?.lastOutletQuality?.flowRate||0).toFixed(0)} effFlow=${s.finalEffluent.flowRate.toFixed(0)} cod=${s.finalEffluent.cod.toFixed(1)} turb=${s.finalEffluent.turbidity.toFixed(1)} tss=${s.finalEffluent.tss.toFixed(1)}`);
  }
}

console.log('\n=== Level 1 config ===');
const lvl = CAMPAIGN_LEVELS[0];
console.log('name:', lvl.name);
console.log('influentSpec:', JSON.stringify(lvl.influentSpec));
console.log('standards:', JSON.stringify(lvl.standards ?? lvl.effluentStandards));
console.log('objectives:', lvl.objectives.map((o: any) => `${o.id}:${JSON.stringify(o.threshold ?? o.targetValue ?? o.target)}`).join(' '));

console.log('\n=== Template geometries ===');
for (const t of ['primary_clarifier_circular', 'activated_sludge_cas', 'secondary_clarifier']) {
  const u = s.units.find((x: any) => x.typeId === t)!;
  console.log(` ${t}: blueprint=${JSON.stringify(u.blueprint ?? null)}`);
}
