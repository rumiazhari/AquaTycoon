// Probe 3: per-unit quality cascade at steady state
import { GameManager } from '../../src/gameplay/GameManager';

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
for (let i = 0; i <= 400; i++) s = GameManager.tick(s, 0.5);

const byType: Record<string, any> = {};
for (const u of s.units) byType[u.typeId] = u;
for (const t of ['influent_inlet', 'bar_screen', 'grit_chamber', 'primary_clarifier_circular', 'activated_sludge_cas', 'secondary_clarifier', 'uv_disinfection', 'effluent_outfall']) {
  const u = byType[t];
  const q = u.lastOutletQuality;
  if (!q) { console.log(`${t}: no outlet quality`); continue; }
  console.log(`${t}: flow=${q.flowRate.toFixed(0)} bod=${q.bod.toFixed(1)} cod=${q.cod.toFixed(1)} tss=${q.tss.toFixed(1)} nh4=${(q.nh4??0).toFixed(1)} tn=${(q.tn??0).toFixed(1)} tp=${(q.tp??0).toFixed(1)} turb=${q.turbidity.toFixed(1)}`);
}
console.log('\nCAS customParams:', JSON.stringify(byType['activated_sludge_cas'].customParams));
console.log('CAS blueprint equipment:', JSON.stringify(byType['activated_sludge_cas'].blueprint?.equipment));
