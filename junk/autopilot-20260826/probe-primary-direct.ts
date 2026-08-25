// Probe 4: call calculateUnitProcess directly for the primary clarifier
import { calculateUnitProcess } from '../../src/sim/UnitProcessModels';
import type { PlacedUnit } from '../../src/types/simulation';

const mkUnit = (id: string, typeId: string): PlacedUnit => ({
  instanceId: id, typeId, position: { x: 0, y: 0 }, rotation: 0,
  customParams: {}, commissioning: 'seeded', lastInletQuality: null, lastOutletQuality: null,
} as any);

const def = { footprint: [4, 4] } as any;
const inlet = {
  flowRate: 3348, bod: 203.6, cod: 428.6, tss: 154.0, tn: 35.7, nh4: 25.5, no3: 1,
  tp: 5.6, pathogens: 500000, do: 0.5, ph: 7.2, temp: 20, toxicIndex: 0, turbidity: 145.5,
} as any;

const u = mkUnit('pri', 'primary_clarifier_circular');
const r = calculateUnitProcess(u, inlet, {} as any, {} as any);
console.log('direct calculateUnitProcess:', JSON.stringify({
  flow: r.effluent?.flowRate, bod: r.effluent?.bod, cod: r.effluent?.cod, tss: r.effluent?.tss, turb: r.effluent?.turbidity,
}, null, 1));
console.log('unit.volume =', (u as any).volume);
