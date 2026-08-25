/** Probe: how much diurnal strength can the L3 template train take? */
import { GameManager } from '../../src/gameplay/GameManager';
import type { PipeConnection, PlacedUnit, UnitTypeId } from '../../src/types/simulation';

const mkPipe = (id: string, f: string, fp: string, t: string, tp: string): PipeConnection => ({
  id, fromUnitId: f, fromPortId: fp, toUnitId: t, toPortId: tp,
  pathPoints: [[0, 0, 0], [1, 0, 0]] as Array<[number, number, number]>,
  flowRate: 1000, quality: { flowRate: 1000 } as any, pipeType: 'liquid' as const,
});

function run(strength: number) {
  // Inject strength through the module knob for the probe.
  const gsK = GameManager.createInitialState(2, false);
  (gsK as any).__probeDiurnalStrength = undefined;
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
    mkPipe('p11', cl.instanceId, 'sludge_outlet', m1.instanceId, 'ras_inlet', 'ras')
  ];
  for (let i = 0; i < 250; i++) sK = GameManager.tick(sK, 1);
  const violByHour: Record<number, number> = {};
  let worstStreak = 0, cur = 0;
  for (let d = 0; d < 2; d++) {
    for (const step of [300, 300, 300, 300, 300]) {
      sK = GameManager.tick(sK, step);
      const st = (sK as any).complianceStreakDays ?? 0;
      if (st === 0) { cur = 0; } else { cur++; if (cur > worstStreak) worstStreak = cur; }
      const h = Math.floor((((sK as any).gameTimeDays % 1) * 24));
      const vcount = (sK as any).lastSimulationViolations?.length
        ?? (sK as any).plantStats?.violations?.length ?? -1;
      violByHour[h] = vcount;
    }
  }
  console.log(`strength=${strength} streakAfterWarmup=${(sK as any).complianceStreakDays} worstGap=${worstStreak}`);
  console.log('  violations by hour:', JSON.stringify(violByHour));
}

for (const s of [1]) run(s);
