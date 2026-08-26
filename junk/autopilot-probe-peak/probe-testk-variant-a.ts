/**
 * Probe variant A: Test K train + third MBBR reactor — does TN hold <15 all day
 * at full diurnal strength? Read-only scratch — junk/.
 */
import { GameManager } from '../../src/gameplay/GameManager';
import type { PlacedUnit, PipeConnection, UnitTypeId } from '../../src/types/simulation';

function mkPipe(id: string, fromUnitId: string, fromPortId: string, toUnitId: string, toPortId: string, pipeType: PipeConnection['pipeType'] = 'liquid'): PipeConnection {
  return { id, fromUnitId, fromPortId, toUnitId, toPortId, pathPoints: [], flowRate: 0, quality: { flowRate: 0 } as any, pipeType };
}

const gsK = GameManager.createInitialState(2, false);
let sK: any = { ...gsK, simSpeed: 1 as const };
const place = (type: UnitTypeId, x: number, y: number, params?: Record<string, number>) => {
  const r = GameManager.placeUnit(sK, type, x, y);
  if (!r.success) console.log(`PLACE FAILED: ${type} @ ${x},${y}`);
  sK = r.newState;
  const u = sK.units[sK.units.length - 1] as PlacedUnit;
  if (params) Object.assign(u.customParams, params);
  return u;
};
const scr = place('bar_screen', 10, 20)!;
const grt = place('grit_chamber', 13, 20)!;
const m1 = place('mbbr_reactor', 16, 20, { carrierFillRatioPercent: 100 })!;
const m2 = place('mbbr_reactor', 19, 24, { carrierFillRatioPercent: 100 })!;
const m3 = place('mbbr_reactor', 19, 27, { carrierFillRatioPercent: 100 })!; // VARIANT A
const cl = place('secondary_clarifier', 22, 23)!;
const a1 = place('advanced_oxidation_aop', 26, 20, { ozoneDoseMgL: 18 })!;
const cp1 = place('chemical_phosphorus', 30, 20, { coagulantDoseMgL: 60 })!;
const cp2 = place('chemical_phosphorus', 34, 20, { coagulantDoseMgL: 60 })!;
const uv = place('uv_disinfection', 38, 20)!;
sK.pipes = [
  mkPipe('p1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
  mkPipe('p2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
  mkPipe('p3', grt.instanceId, 'outlet', m1.instanceId, 'inlet'),
  mkPipe('p4', m1.instanceId, 'outlet', m2.instanceId, 'inlet'),
  mkPipe('p4b', m2.instanceId, 'outlet', m3.instanceId, 'inlet'),
  mkPipe('p5', m3.instanceId, 'outlet', cl.instanceId, 'inlet'),
  mkPipe('p6', cl.instanceId, 'outlet', a1.instanceId, 'inlet'),
  mkPipe('p7', a1.instanceId, 'outlet', cp1.instanceId, 'inlet'),
  mkPipe('p8', cp1.instanceId, 'outlet', cp2.instanceId, 'inlet'),
  mkPipe('p9', cp2.instanceId, 'outlet', uv.instanceId, 'inlet'),
  mkPipe('p10', uv.instanceId, 'outlet', 'outfall_0', 'inlet'),
  mkPipe('p11', cl.instanceId, 'sludge_outlet', m1.instanceId, 'ras_inlet', 'ras'),
];
for (let i = 0; i < 250; i++) sK = GameManager.tick(sK, 1);

const STD: Array<[string, string, number]> = [
  ['bod', 'maxBod', 20], ['cod', 'maxCod', 80], ['tss', 'maxTss', 20],
  ['tn', 'maxTn', 15], ['nh4', 'maxNh4', 5], ['tp', 'maxTp', 1.0],
  ['pathogens', 'maxPathogens', 200], ['do', 'minDo', 5],
  ['turbidity', 'maxTurbidity', 8],
];
const worst: Record<string, number> = {};
const worstHour: Record<string, number> = {};
const uvU = sK.units.find((u: PlacedUnit) => u.typeId === 'uv_disinfection');
// start the window AT the morning peak so we cover the worst hours first
for (let i = 0; i < 30; i++) sK = GameManager.tick(sK, 1); // advance to a fresh hour boundary
for (let i = 0; i < 36; i++) {
  sK = GameManager.tick(sK, 1);
  const hour = ((sK.gameTimeDays % 1) * 24).toFixed(1);
  const eff = uvU!.lastOutletQuality;
  for (const [k, stdKey, limit] of STD) {
    const v = (eff as any)[k];
    const bad = stdKey.startsWith('max') ? v > limit : v < limit;
    if (bad && (worst[stdKey] === undefined || Math.abs(v - limit) > Math.abs(worst[stdKey] - limit))) {
      worst[stdKey] = v; worstHour[stdKey] = Number(hour);
    }
  }
}
console.log('VARIANT A (3× MBBR) — violations across 36 h:');
if (Object.keys(worst).length === 0) console.log('  NONE — clean every hour');
for (const k of Object.keys(worst)) console.log(`  ${k}: ${worst[k].toPrecision(3)} @ h=${worstHour[k]}`);
console.log(`streak after window: ${sK.complianceStreakDays.toFixed(2)} d`);
