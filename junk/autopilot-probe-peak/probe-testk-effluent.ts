/**
 * Probe: which effluent criterion breaks Test K's Level-3 MBBR train under
 * full-strength diurnal, and at what hour. Read-only scratch — junk/.
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
  sK = r.newState;
  const u = sK.units[sK.units.length - 1] as PlacedUnit;
  if (params) Object.assign(u.customParams, params);
  return u;
};
const scr = place('bar_screen', 10, 20)!;
const grt = place('grit_chamber', 13, 20)!;
const m1 = place('mbbr_reactor', 16, 20, { carrierFillRatioPercent: 100 })!;
const m2 = place('mbbr_reactor', 19, 24, { carrierFillRatioPercent: 100 })!;
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
  mkPipe('p5', m2.instanceId, 'outlet', cl.instanceId, 'inlet'),
  mkPipe('p6', cl.instanceId, 'outlet', a1.instanceId, 'inlet'),
  mkPipe('p7', a1.instanceId, 'outlet', cp1.instanceId, 'inlet'),
  mkPipe('p8', cp1.instanceId, 'outlet', cp2.instanceId, 'inlet'),
  mkPipe('p9', cp2.instanceId, 'outlet', uv.instanceId, 'inlet'),
  mkPipe('p10', uv.instanceId, 'outlet', 'outfall_0', 'inlet'),
  mkPipe('p11', cl.instanceId, 'sludge_outlet', m1.instanceId, 'ras_inlet', 'ras'),
];
for (let i = 0; i < 250; i++) sK = GameManager.tick(sK, 1);

// Sample one full day of final effluent vs Level-3 standards.
const STD: Array<[string, string, number, boolean]> = [
  ['bod', 'maxBod', 20, true], ['cod', 'maxCod', 80, true], ['tss', 'maxTss', 20, true],
  ['tn', 'maxTn', 15, true], ['nh4', 'maxNh4', 5, true], ['tp', 'maxTp', 1.0, true],
  ['pathogens', 'maxPathogens', 200, true], ['do', 'minDo', 5, false],
  ['ph', 'minPh', 6.5, false], ['ph', 'maxPh', 8.5, true], ['turbidity', 'maxTurbidity', 8, true],
];
const worst: Record<string, number> = {};
const worstHour: Record<string, number> = {};
const uvU = sK.units.find((u: PlacedUnit) => u.typeId === 'uv_disinfection');
for (let i = 0; i < 24; i++) {
  sK = GameManager.tick(sK, 1);
  const hour = ((sK.gameTimeDays % 1) * 24).toFixed(1);
  const eff = uvU!.lastOutletQuality;
  for (const [k, stdKey, limit] of STD) {
    const v = (eff as any)[k];
    const bad =
      stdKey.startsWith('max') ? v > limit : stdKey.startsWith('min') ? v < limit : false;
    if (bad && (worst[stdKey] === undefined || Math.abs(v - limit) > Math.abs(worst[stdKey] - limit))) {
      worst[stdKey] = v; worstHour[stdKey] = Number(hour);
    }
  }
}
console.log('Criterion violations across one day (worst value @ hour):');
if (Object.keys(worst).length === 0) console.log('  NONE — clean all 24 h');
for (const k of Object.keys(worst)) console.log(`  ${k}: ${worst[k].toPrecision(3)} @ h=${worstHour[k]}`);

// Also show streak state and a few raw values at the worst hour
console.log(`complianceStreakDays after warm-up+day: ${sK.complianceStreakDays}`);
