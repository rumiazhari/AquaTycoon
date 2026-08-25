// Autopilot diagnostic probe: replicate sim-tests Test S Stage A and dump economy state.
import { GameManager } from './src/gameplay/GameManager';
import { emptyWater } from './src/sim/WaterStream';

const mkPipe = (id: string, from: any, fromPort: string, to: any, toPort: string, kind: any = 'liquid') => ({
  id, fromUnitId: from, fromPortId: fromPort, toUnitId: to, toPortId: toPort, pathPoints: [], flowRate: 0, quality: emptyWater(), pipeType: kind,
});

const gs = GameManager.createInitialState(0, false);
let s: any = { ...gs, simSpeed: 5 as const };
const place = (type: string, x: number, y: number, params?: Record<string, number>) => {
  const r = GameManager.placeUnit(s, type, x, y);
  if (!r.success) { console.error('place fail:', type, r.reason); return null; }
  s = r.newState;
  const u = s.units[s.units.length - 1];
  if (params) Object.assign(u.customParams, params);
  return u;
};

const startCash = s.financials.cash;
const scr = place('bar_screen', 5, 20)!;
const grt = place('grit_chamber', 8, 20)!;
const pri = place('primary_clarifier_circular', 11, 20)!;
const cas = place('activated_sludge_cas', 16, 20, { doSetpoint: 2.5 })!;
const cl = place('secondary_clarifier', 22, 23)!;

for (const u of s.units) {
  console.log(`unit ${u.typeId}: vol=${u.volume.toFixed(1)} m3 params=${JSON.stringify(u.customParams)}`);
}
console.log(`startCash=$${startCash.toFixed(0)} afterBuildings=$${s.financials.cash.toFixed(0)} spent=$${(startCash - s.financials.cash).toFixed(0)}`);

s.pipes = [
  mkPipe('sp1', 'inlet_0', 'outlet', scr.instanceId, 'inlet'),
  mkPipe('sp2', scr.instanceId, 'outlet', grt.instanceId, 'inlet'),
  mkPipe('sp3', grt.instanceId, 'outlet', pri.instanceId, 'inlet'),
  mkPipe('sp4', pri.instanceId, 'outlet', cas.instanceId, 'inlet'),
  mkPipe('sp5', cas.instanceId, 'outlet', cl.instanceId, 'inlet'),
  mkPipe('sp6', cl.instanceId, 'outlet', 'outfall_0', 'inlet'),
  mkPipe('sp7', cl.instanceId, 'sludge_outlet', cas.instanceId, 'ras_inlet', 'ras')
];

let prevCash = s.financials.cash;
for (let i = 0; i < 300; i++) {
  s = GameManager.tick(s, 1);
  if ((i+1) % 100 === 0) {
    const f = s.financials;
    console.log(`t=${i+1} cash=$${f.cash.toFixed(0)} rev=${f.dailyRevenue?.toFixed(1) ?? '?'} opex=${f.dailyOpex?.toFixed(1) ?? '?'} power=${f.dailyPowerCost?.toFixed(1) ?? '?'} chem=${f.dailyChemicalCost?.toFixed(1) ?? '?'} fines=${f.dailyFines?.toFixed(1) ?? '?'}`);
  }
}
console.log('objectives:', JSON.stringify(s.currentLevel.objectives.map((o:any)=>({id:o.id,val:o.currentValue??o.value,target:o.targetValue??o.target,ach:o.achieved}))));
const flows = s.pipes.map((p:any)=>`${p.id}:${(p.flowRate??0).toFixed(0)}`).join(' ');
console.log('pipeFlows', flows);
const outf = s.units.find((u:any)=>u.typeId==='effluent_outfall');
if (outf?.lastOutletQuality) {
  const q = outf.lastOutletQuality;
  console.log(`OUTFALL eff: bod=${q.bod?.toFixed(1)} cod=${q.cod?.toFixed(1)} tss=${q.tss?.toFixed(1)} nh4=${q.nh4?.toFixed(2)} tn=${q.tn?.toFixed(2)} tp=${q.tp?.toFixed(2)} path=${q.pathogens?.toExponential(2)} do=${q.do?.toFixed(1)} ph=${q.ph?.toFixed(1)} turb=${q.turbidity?.toFixed(0)} flow=${q.flowRate?.toFixed(0)}`);
}
console.log(`after 300 ticks: cash=$${s.financials.cash.toFixed(0)} net=$${(s.financials.cash - prevCash).toFixed(0)}`);
console.log(`compliance=${s.overallStats.complianceScore}% levelComplete=${s.isLevelComplete} day=${s.gameTimeDays?.toFixed?.(2) ?? '?'}`);
const out = cl.lastOutletQuality || emptyWater();
console.log(`clarifier outlet: cod=${out.cod?.toFixed(1)} bod=${out.bod?.toFixed(1)} tss=${out.tss?.toFixed(1)} nh4=${out.nh4?.toFixed(2)} tn=${out.tn?.toFixed(2)} tp=${out.tp?.toFixed(2)} ecoli=${out.ecoli?.toExponential?.(2) ?? out.ecoli}`);
if (s.financials.revenueHistory?.length) {
  const rh = s.financials.revenueHistory.slice(-3);
  console.log('revenue tail:', JSON.stringify(rh.map((r: any) => ({ d: r.day ?? r.dayIndex, rev: r.revenue ?? r.amount }))));
}
