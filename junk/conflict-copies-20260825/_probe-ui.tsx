import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnitInspector } from '../src/ui/UnitInspector';
import { emptyWater } from '../src/sim/WaterStream';

const u: any = {
  instanceId: 'u1', typeId: 'activated_sludge_cas', gridX: 2, gridY: 2, rotation: 0,
  volume: 100, customParams: {}, active: true, efficiencyRating: 90,
  lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(),
  lastPowerKwActual: 10, lastOpexActual: 5,
  dissolvedOxygenActual: 5.1, mlssActual: 0, sviActual: undefined,
};
const html = renderToStaticMarkup(React.createElement(UnitInspector as any, { unit: u, onClose: () => {}, onUpdateParams: () => {}, onDemolish: () => {} } as any));
const i = html.indexOf('MLSS');
console.log('MLSS ctx:', JSON.stringify(html.slice(i - 20, i + 260)));
const j = html.indexOf('>SVI<');
console.log('SVI ctx:', JSON.stringify(html.slice(j, j + 200)));
console.log('has >3200 mg/L<:', html.includes('>3200 mg/L<'), '| has >0 mg/L<:', html.includes('>0 mg/L<'));
