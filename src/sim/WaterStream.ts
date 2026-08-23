import { WaterQuality } from '../types/simulation';

export function emptyWater(): WaterQuality {
  return {
    flowRate: 0,
    bod: 0,
    cod: 0,
    tss: 0,
    tn: 0,
    nh4: 0,
    no3: 0,
    tp: 0,
    pathogens: 0,
    do: 0,
    ph: 7.0,
    temp: 20,
    toxicIndex: 0,
    turbidity: 0
  };
}

export function cloneWater(w: WaterQuality): WaterQuality {
  return { ...w };
}

export function createInfluentWater(params: Partial<WaterQuality> = {}): WaterQuality {
  return {
    flowRate: 5000,
    bod: 220,
    cod: 450,
    tss: 250,
    tn: 40,
    nh4: 30,
    no3: 1,
    tp: 6.5,
    pathogens: 1e6,
    do: 0.5,
    ph: 7.2,
    temp: 20,
    toxicIndex: 0,
    turbidity: 180,
    ...params
  };
}

/**
 * Mass balance mixing of multiple water streams
 */
export function mixWaterStreams(streams: { quality: WaterQuality; flow: number }[]): WaterQuality {
  const activeStreams = streams.filter(s => s.flow > 0.001);
  if (activeStreams.length === 0) return emptyWater();

  const totalFlow = activeStreams.reduce((acc, s) => acc + s.flow, 0);
  if (totalFlow <= 0) return emptyWater();

  let bodMass = 0;
  let codMass = 0;
  let tssMass = 0;
  let tnMass = 0;
  let nh4Mass = 0;
  let no3Mass = 0;
  let tpMass = 0;
  let pathogenCount = 0;
  let doMass = 0;
  let phSum = 0;
  let tempSum = 0;
  let toxicSum = 0;
  let turbSum = 0;

  for (const s of activeStreams) {
    const q = s.flow;
    const w = s.quality;
    bodMass += w.bod * q;
    codMass += w.cod * q;
    tssMass += w.tss * q;
    tnMass += w.tn * q;
    nh4Mass += w.nh4 * q;
    no3Mass += w.no3 * q;
    tpMass += w.tp * q;
    pathogenCount += w.pathogens * q;
    doMass += w.do * q;
    phSum += w.ph * q;
    tempSum += w.temp * q;
    toxicSum += w.toxicIndex * q;
    turbSum += w.turbidity * q;
  }

  return {
    flowRate: totalFlow,
    bod: Math.max(0, bodMass / totalFlow),
    cod: Math.max(0, codMass / totalFlow),
    tss: Math.max(0, tssMass / totalFlow),
    tn: Math.max(0, tnMass / totalFlow),
    nh4: Math.max(0, nh4Mass / totalFlow),
    no3: Math.max(0, no3Mass / totalFlow),
    tp: Math.max(0, tpMass / totalFlow),
    pathogens: Math.max(0, pathogenCount / totalFlow),
    do: Math.max(0, doMass / totalFlow),
    ph: phSum / totalFlow,
    temp: tempSum / totalFlow,
    toxicIndex: Math.max(0, toxicSum / totalFlow),
    turbidity: Math.max(0, turbSum / totalFlow)
  };
}

/**
 * Calculates a dynamic RGB/Hex color representation of the water quality
 * High TSS & BOD -> Murky dark brownish grey
 * Aerated Biological -> Frothy amber/brown
 * Settled/Filtered -> Light translucent aqua
 * High Purity / Disinfected -> Crystal cyan/blue
 */
export function calcWaterColorHex(w: WaterQuality, isAerated: boolean = false): string {
  if (w.flowRate <= 0.01) return '#334155'; // Dry / empty pipe

  if (isAerated) {
    // Frothy bubbly mixed liquor color
    return '#854d0e';
  }

  const turbidityScore = Math.min(1, (w.tss + w.turbidity) / 300);
  const organicScore = Math.min(1, w.bod / 200);

  if (turbidityScore > 0.6 || organicScore > 0.6) {
    // Murky sewage brown/grey
    const r = Math.round(110 + 40 * organicScore);
    const g = Math.round(80 + 30 * organicScore);
    const b = Math.round(60 + 20 * (1 - turbidityScore));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  } else if (turbidityScore > 0.2 || organicScore > 0.2) {
    // Secondary treated / light greenish blue
    return '#0d9488'; // Teal
  } else {
    // Crystal clear polished water
    return '#06b6d4'; // Cyan
  }
}
