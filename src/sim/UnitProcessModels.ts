import { GasStream, PlacedUnit, UnitDefinition, UnitTypeId, WaterQuality } from '../types/simulation';
import { cloneWater, emptyWater } from './WaterStream';
import { loadKgDay } from './MassBalance';
import { freshCommissioning } from '../design/UnitBlueprint';
import type { MembraneDesign } from '../design/UnitBlueprint';
import { stepCasRuntime } from './processes/ActivatedSludge';
import { evaluateClarifierLoad } from './processes/Clarifier';
import { stepEqualization } from './processes/Equalization';
import { stepPumpStation } from './processes/Pumping';
import {
  evaluateMbrRuntime,
  FRESH_MBR_FOULING,
  FOUL_FLUX_REF_LMH,
  SCOUR_MIN_NM3H_PER_M2,
  type MbrFoulingState,
} from './processes/MBR';

export interface ProcessResult {
  /** Main treated liquid effluent ('outlet' port). Kept for UI compatibility. */
  effluent: WaterQuality;
  /** Primary underflow/sludge stream ('sludge_outlet' port). Kept for UI compatibility. */
  sludge?: WaterQuality;
  /**
   * Explicit per-port liquid output streams, keyed by port id.
   * Every liquid-carrying port of the unit appears here exactly once;
   * SimulationEngine propagates ONLY the stream bound to the actual fromPortId,
   * so a sludge line can never silently inherit the main effluent.
   */
  portStreams?: Record<string, WaterQuality>;
  /** Explicit per-port gas outputs keyed by gas port id. Gas is never wastewater. */
  gasStreams?: Record<string, GasStream>;
  gasProducedM3Day?: number;
  powerKw: number;
  opexDay: number;
  efficiency: number;
  sludgeBlanketHeight?: number;
  dissolvedOxygen?: number;
  mlss?: number;
  svi?: number;
  /** Pump station duty-point telemetry (status, BEP%, power, cavitation). */
  pumpRuntime?: {
    status: 'ok' | 'undersized' | 'oversized' | 'no_duty_point' | 'failed_unit';
    dutyFlowM3h: number;
    dutyHeadM: number;
    bepFraction: number;
    cavitating: boolean;
    failedUnitCount: number;
    electricalPowerKw: number;
  };
  /** MBR membrane runtime operating point (fouling-resistance progression). */
  mbrFouling?: MbrFoulingState;
}

/**
 * Builds the authoritative per-port stream map from the individual named
 * outputs. Ports not explicitly produced by the process fall back to:
 *   outlet        -> main effluent
 *   sludge_outlet -> sludge stream (if any)
 *   recycle_outlet-> explicit recycle stream (if any)
 * so every legacy unit definition keeps working while new code can rely on
 * `portStreams` being complete.
 */
function buildPortStreams(
  def: UnitDefinition,
  effluent: WaterQuality,
  sludge: WaterQuality | undefined,
  extra: Record<string, WaterQuality> = {}
): Record<string, WaterQuality> {
  const streams: Record<string, WaterQuality> = { ...extra };
  for (const port of def.ports) {
    if (streams[port.id]) continue;
    if (port.type === 'inlet' || port.type === 'ras_inlet') continue;
    if (port.type === 'gas_outlet') continue; // gas handled separately in gasStreams
    if (port.type === 'outlet') streams[port.id] = sanitizeStream(cloneWater(effluent));
    else if (port.type === 'sludge_outlet') { if (sludge) streams[port.id] = sanitizeStream(cloneWater(sludge)); }
    else if (port.type === 'recycle_outlet') { /* only when explicitly produced */ }
  }
  return streams;
}

/** Sanitizes a WaterQuality stream in-place: clamps NaN/Infinity/negative. */
function sanitizeStream(w: WaterQuality): WaterQuality {
  const s = (v: number) => Number.isFinite(v) ? Math.max(0, v) : 0;
  return {
    ...w,
    flowRate: s(w.flowRate),
    bod: s(w.bod), cod: s(w.cod), tss: s(w.tss), tn: s(w.tn), nh4: s(w.nh4),
    no3: s(w.no3), tp: s(w.tp), pathogens: s(w.pathogens), do: s(w.do),
    ph: Number.isFinite(w.ph) ? Math.min(14, Math.max(2, w.ph)) : 7,
    temp: Number.isFinite(w.temp) ? Math.max(0, w.temp) : 20,
    toxicIndex: s(w.toxicIndex), turbidity: s(w.turbidity)
  };
}

/**
 * Ideal hydraulic splitter: divides an incoming stream between two branch
 * ports conserving flow while keeping concentrations unchanged.
 *   Q1 = Qin * r,  Q2 = Qin * (1 - r),  Q1 + Q2 = Qin
 */
export function splitStream(
  inlet: WaterQuality,
  ratio1: number
): { branch1: WaterQuality; branch2: WaterQuality } {
  const r = Math.min(1, Math.max(0, ratio1));
  const q1 = Math.max(0, inlet.flowRate) * r;
  const q2 = Math.max(0, inlet.flowRate) - q1;
  const b1 = cloneWater(inlet); b1.flowRate = q1;
  const b2 = cloneWater(inlet); b2.flowRate = q2;
  return { branch1: b1, branch2: b2 };
}

export const UNIT_DEFINITIONS: Record<UnitTypeId, UnitDefinition> = {
  // ==========================================
  // PRELIMINARY
  // ==========================================
  bar_screen: {
    id: 'bar_screen',
    name: 'Mechanical Bar Screen',
    category: 'preliminary',
    description: 'Coarse & fine automated rake screen to remove large debris, rags, and plastics.',
    engineeringInfo: 'Prevents pump clogging & protects downstream mechanical units. Headloss: Δh = (V² - v²)/(2g * 0.7). Removes ~15-25% coarse solids.',
    footprint: [2, 1],
    capex: 12000,
    baseOpexPerDay: 15,
    powerConsumptionKw: 2.5,
    minHRT_hours: 0.05,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Raw Influent', type: 'inlet', relativePosition: [-1, 0.5, 0] },
      { id: 'outlet', name: 'Screened Water', type: 'outlet', relativePosition: [1, 0.5, 0] }
    ],
    defaultParams: { barSpacingMm: 15, rakeSpeedRpm: 4 },
    paramDefinitions: [
      { key: 'barSpacingMm', label: 'Bar Spacing', unit: 'mm', min: 6, max: 50, step: 1, defaultValue: 15, description: 'Smaller spacing captures more debris but increases headloss & cleaning frequency.' },
      { key: 'rakeSpeedRpm', label: 'Rake Speed', unit: 'RPM', min: 1, max: 10, step: 1, defaultValue: 4, description: 'Speed of automatic debris cleaning rake.' }
    ]
  },

  grit_chamber: {
    id: 'grit_chamber',
    name: 'Vortex Grit Chamber',
    category: 'preliminary',
    description: 'Induced vortex hydraulic separator removing sand, gravel, and heavy inert grit.',
    engineeringInfo: 'Removes particles >0.2mm (SG 2.65) via Stokes law & centrifugal acceleration. Prevents abrasive wear on downstream pumps.',
    footprint: [2, 2],
    capex: 25000,
    baseOpexPerDay: 25,
    powerConsumptionKw: 4.0,
    minHRT_hours: 0.1,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Inlet', type: 'inlet', relativePosition: [-1, 0.5, 0] },
      { id: 'outlet', name: 'Degritted Water', type: 'outlet', relativePosition: [1, 0.5, 0] }
    ],
    defaultParams: { paddleRpm: 18, airFlowM3h: 50 },
    paramDefinitions: [
      { key: 'paddleRpm', label: 'Vortex Impeller Speed', unit: 'RPM', min: 5, max: 35, step: 1, defaultValue: 18, description: 'Maintains optimum tangential velocity (0.3 m/s) to separate organic matter from heavy mineral grit.' }
    ]
  },

  equalization_basin: {
    id: 'equalization_basin',
    name: 'Flow Equalization Basin',
    category: 'preliminary',
    description: 'Large mixed buffer tank dampening diurnal hydraulic surges and organic shock loads.',
    engineeringInfo: 'Mass balance buffering prevents biological process washouts during peak rain or industrial batch discharge events.',
    footprint: [3, 3],
    capex: 45000,
    baseOpexPerDay: 40,
    powerConsumptionKw: 6.0,
    minHRT_hours: 4.0,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Inflow', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Equalized Outflow', type: 'outlet', relativePosition: [1.5, 0.5, 0] }
    ],
    defaultParams: { mixerPowerKw: 5.5, bufferLevelTarget: 50 },
    paramDefinitions: [
      { key: 'bufferLevelTarget', label: 'Target Buffer Capacity', unit: '%', min: 20, max: 90, step: 5, defaultValue: 50, description: 'Operational water level setpoint to absorb shock volume.' }
    ]
  },

  // ==========================================
  // PRIMARY TREATMENT
  // ==========================================
  primary_clarifier_circular: {
    id: 'primary_clarifier_circular',
    name: 'Circular Primary Clarifier',
    category: 'primary',
    description: 'Heavy gravity sedimentation tank with rotating bridge scraper for settleable solids.',
    engineeringInfo: 'Surface Overflow Rate (SOR) typically 30-50 m³/m²·d. Removes 50-70% TSS and 25-40% particulate BOD as raw primary sludge.',
    footprint: [3, 3],
    capex: 65000,
    baseOpexPerDay: 45,
    powerConsumptionKw: 3.5,
    minHRT_hours: 1.8,
    sludgeYieldRatio: 0.65,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Primary Influent', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Primary Settled Water', type: 'outlet', relativePosition: [1.5, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Raw Primary Sludge', type: 'sludge_outlet', relativePosition: [0, 0.2, 1.5] }
    ],
    defaultParams: { scraperSpeedRpm: 0.05, sludgeDrawRateM3h: 8 },
    paramDefinitions: [
      { key: 'sludgeDrawRateM3h', label: 'Sludge Draw Rate', unit: 'm³/h', min: 2, max: 25, step: 1, defaultValue: 8, description: 'Rate of primary bottom sludge pumping to thickener/digester.' }
    ]
  },

  primary_clarifier_rect: {
    id: 'primary_clarifier_rect',
    name: 'Rectangular Settling Tank',
    category: 'primary',
    description: 'Space-efficient rectangular sedimentation basin with chain-and-flight sludge scraper.',
    engineeringInfo: 'Ideal for tight footprint layouts. Excellent horizontal flow distribution with multi-trough effluent launders.',
    footprint: [4, 2],
    capex: 75000,
    baseOpexPerDay: 50,
    powerConsumptionKw: 4.2,
    minHRT_hours: 2.0,
    sludgeYieldRatio: 0.65,
    unlockedByDefault: false,
    requiredTechId: 'tech_compact_tanks',
    ports: [
      { id: 'inlet', name: 'Influent', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'outlet', name: 'Settled Outflow', type: 'outlet', relativePosition: [2, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Primary Sludge', type: 'sludge_outlet', relativePosition: [-1.8, 0.2, 1] }
    ],
    defaultParams: { flightSpeedMMin: 0.6 },
    paramDefinitions: [
      { key: 'flightSpeedMMin', label: 'Flight Scraper Speed', unit: 'm/min', min: 0.2, max: 1.5, step: 0.1, defaultValue: 0.6, description: 'Speed of bottom scraper conveyor.' }
    ]
  },

  daf_unit: {
    id: 'daf_unit',
    name: 'Dissolved Air Flotation (DAF)',
    category: 'primary',
    description: 'Micro-bubble flotation system targeting low-density solids, grease, oil, and algae.',
    engineeringInfo: 'Saturates recycle stream with dissolved air at 4-6 bar. Micro-bubbles (30-50μm) adhere to hydrophobic flocs and float to the surface for skimming.',
    footprint: [3, 2],
    capex: 95000,
    baseOpexPerDay: 90,
    powerConsumptionKw: 15.0,
    minHRT_hours: 0.5,
    unlockedByDefault: false,
    requiredTechId: 'tech_daf_flotation',
    ports: [
      { id: 'inlet', name: 'Oily/Greasy Influent', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Clarified Effluent', type: 'outlet', relativePosition: [1.5, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Float Sludge / Scum', type: 'sludge_outlet', relativePosition: [0, 0.5, 1] }
    ],
    defaultParams: { airPressureBar: 5.0, recyclePercent: 15 },
    paramDefinitions: [
      { key: 'airPressureBar', label: 'Saturation Pressure', unit: 'bar', min: 3, max: 7, step: 0.5, defaultValue: 5.0, description: 'Higher pressure generates finer microbubbles.' },
      { key: 'recyclePercent', label: 'Recycle Ratio', unit: '%', min: 5, max: 30, step: 1, defaultValue: 15, description: 'Percent of effluent pressurized with air and recycled.' }
    ]
  },

  // ==========================================
  // SECONDARY / BIOLOGICAL TREATMENT
  // ==========================================
  activated_sludge_cas: {
    id: 'activated_sludge_cas',
    name: 'Aeration Basin (CAS)',
    category: 'secondary',
    description: 'Suspended-growth biological reactor with fine-bubble diffused aeration for organic BOD degradation.',
    engineeringInfo: 'Heterotrophic bacteria consume soluble BOD via Monod biokinetics: μ = μ_max * S/(Ks + S) * DO/(K_DO + DO). Oxygen demand depends on organic loading and synthesis.',
    footprint: [4, 3],
    capex: 110000,
    baseOpexPerDay: 80,
    powerConsumptionKw: 28.0,
    minHRT_hours: 6.0,
    sludgeYieldRatio: 0.5,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Primary Effluent', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'ras_inlet', name: 'RAS Return', type: 'ras_inlet', relativePosition: [-2, 0.5, 1.5] },
      { id: 'outlet', name: 'Mixed Liquor', type: 'outlet', relativePosition: [2, 0.5, 0] }
    ],
    defaultParams: { doSetpoint: 2.0, targetMlss: 3200, airBlowerSpeedPercent: 75 },
    paramDefinitions: [
      { key: 'doSetpoint', label: 'Dissolved Oxygen Setpoint', unit: 'mg/L', min: 0.5, max: 5.0, step: 0.1, defaultValue: 2.0, description: 'DO concentration. Higher DO ensures high removal rate but increases blower power consumption.' },
      { key: 'targetMlss', label: 'Target MLSS', unit: 'mg/L', min: 1500, max: 5000, step: 100, defaultValue: 3200, description: 'Mixed Liquor Suspended Solids concentration in basin.' }
    ]
  },

  a2o_bardenpho: {
    id: 'a2o_bardenpho',
    name: 'A2O Nutrient Removal Reactor',
    category: 'secondary',
    description: 'Three-stage Anaerobic-Anoxic-Aerobic biological reactor achieving total Nitrogen and Phosphorus removal.',
    engineeringInfo: 'Anaerobic zone releases PO4; Anoxic zone performs Denitrification (NO3 -> N2 gas); Aerobic zone performs Nitrification (NH4 -> NO3) & Luxury P-uptake.',
    footprint: [5, 3],
    capex: 180000,
    baseOpexPerDay: 130,
    powerConsumptionKw: 35.0,
    minHRT_hours: 8.0,
    sludgeYieldRatio: 0.45,
    unlockedByDefault: false,
    requiredTechId: 'tech_biological_nutrients',
    ports: [
      { id: 'inlet', name: 'Influent', type: 'inlet', relativePosition: [-2.5, 0.5, 0] },
      { id: 'ras_inlet', name: 'RAS Return', type: 'ras_inlet', relativePosition: [-2.5, 0.5, 1.5] },
      { id: 'outlet', name: 'Nitrified Mixed Liquor', type: 'outlet', relativePosition: [2.5, 0.5, 0] }
    ],
    defaultParams: { internalRecyclePercent: 200, aerobicDo: 2.5, carbonDosingRateMgL: 0 },
    paramDefinitions: [
      { key: 'internalRecyclePercent', label: 'Internal Nitrate Recycle', unit: '%', min: 100, max: 400, step: 25, defaultValue: 200, description: 'Recycles nitrified mixed liquor back to anoxic zone for denitrification.' },
      { key: 'aerobicDo', label: 'Aerobic DO Setpoint', unit: 'mg/L', min: 1.5, max: 4.5, step: 0.1, defaultValue: 2.5, description: 'DO in nitrification zone.' },
      { key: 'carbonDosingRateMgL', label: 'External Carbon Dosing', unit: 'mg/L', min: 0, max: 40, step: 2, defaultValue: 0, description: 'Methanol/Acetate supplemental carbon for complete denitrification when influent COD/N ratio is low.' }
    ]
  },

  mbbr_reactor: {
    id: 'mbbr_reactor',
    name: 'Moving Bed Biofilm Reactor (MBBR)',
    category: 'secondary',
    description: 'High-rate compact biofilm reactor packed with thousands of fluidized plastic carriers.',
    engineeringInfo: 'Protected surface area >800 m²/m³. Biofilm provides superior resilience against toxic shock loads and hydraulic surges in half the tank volume.',
    footprint: [3, 3],
    capex: 160000,
    baseOpexPerDay: 110,
    powerConsumptionKw: 32.0,
    minHRT_hours: 3.5,
    sludgeYieldRatio: 0.35,
    unlockedByDefault: false,
    requiredTechId: 'tech_mbbr_biofilm',
    ports: [
      { id: 'inlet', name: 'Influent', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Treated Effluent', type: 'outlet', relativePosition: [1.5, 0.5, 0] }
    ],
    defaultParams: { carrierFillRatioPercent: 50, aerationRateM3h: 120 },
    paramDefinitions: [
      { key: 'carrierFillRatioPercent', label: 'Carrier Filling Ratio', unit: '%', min: 30, max: 65, step: 5, defaultValue: 50, description: 'Volume percentage of suspended media carriers.' }
    ]
  },

  mbr_membrane: {
    id: 'mbr_membrane',
    name: 'Membrane Bioreactor (MBR)',
    category: 'secondary',
    description: 'Advanced submerged hollow-fiber ultrafiltration module replacing secondary clarifier.',
    engineeringInfo: 'Pore size 0.04 μm. Operates at MLSS 8,000-12,000 mg/L. Yields crystal-clear permeate with zero suspended solids and high bacteria removal.',
    footprint: [4, 3],
    capex: 240000,
    baseOpexPerDay: 190,
    powerConsumptionKw: 48.0,
    minHRT_hours: 4.0,
    sludgeYieldRatio: 0.3,
    unlockedByDefault: false,
    requiredTechId: 'tech_membrane_mbr',
    ports: [
      { id: 'inlet', name: 'Bioreactor Feed', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'outlet', name: 'Ultrafilter Permeate', type: 'outlet', relativePosition: [2, 0.5, 0] },
      { id: 'sludge_outlet', name: 'WAS Sludge', type: 'sludge_outlet', relativePosition: [0, 0.2, 1.5] }
    ],
    defaultParams: { membraneFluxLmh: 22, relaxIntervalMin: 10 },
    paramDefinitions: [
      { key: 'membraneFluxLmh', label: 'Permeate Flux', unit: 'LMH', min: 12, max: 35, step: 1, defaultValue: 22, description: 'Liters/m²·h membrane permeate flux rate.' }
    ]
  },

  secondary_clarifier: {
    id: 'secondary_clarifier',
    name: 'Secondary Clarifier (Final Settling)',
    category: 'secondary',
    description: 'Large circular gravity clarifier separating activated sludge biomass from polished water.',
    engineeringInfo: 'Solids Flux Theory determines maximum allowable solids loading. Bottom sludge recycled as RAS to sustain reactor MLSS or purged as WAS.',
    footprint: [4, 4],
    capex: 95000,
    baseOpexPerDay: 60,
    powerConsumptionKw: 5.0,
    minHRT_hours: 3.0,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Mixed Liquor Inflow', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'outlet', name: 'Clarified Effluent', type: 'outlet', relativePosition: [2, 0.5, 0] },
      { id: 'sludge_outlet', name: 'RAS Return', type: 'sludge_outlet', relativePosition: [-1, 0.2, 2] },
      { id: 'was_outlet', name: 'WAS Waste Sludge', type: 'sludge_outlet', relativePosition: [1, 0.2, 2] }
    ],
    defaultParams: { rasRecycleRatioPercent: 75, wasPurgeRateM3d: 50 },
    paramDefinitions: [
      { key: 'rasRecycleRatioPercent', label: 'RAS Recycle Ratio', unit: '%', min: 30, max: 150, step: 5, defaultValue: 75, description: 'Return Activated Sludge pumped back to aeration basin.' },
      { key: 'wasPurgeRateM3d', label: 'WAS Purge Flow', unit: 'm³/d', min: 10, max: 200, step: 5, defaultValue: 50, description: 'Waste Activated Sludge flow to control sludge retention time (SRT).' }
    ]
  },

  trickling_filter: {
    id: 'trickling_filter',
    name: 'Trickling Bio-Filter',
    category: 'secondary',
    description: 'Packed-bed biological tower with rotating distributor arms spraying wastewater over synthetic media.',
    engineeringInfo: 'Low energy natural draught aeration. Biofilm sloughs off periodically as humus sludge.',
    footprint: [3, 3],
    capex: 80000,
    baseOpexPerDay: 35,
    powerConsumptionKw: 3.0,
    minHRT_hours: 1.5,
    sludgeYieldRatio: 0.4,
    unlockedByDefault: false,
    requiredTechId: 'tech_fixed_film',
    ports: [
      { id: 'inlet', name: 'Primary Effluent', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Filter Effluent', type: 'outlet', relativePosition: [1.5, 0.5, 0] }
    ],
    defaultParams: { distributorRpm: 1.2, recirculationRatio: 1.0 },
    paramDefinitions: [
      { key: 'recirculationRatio', label: 'Recirculation Ratio', unit: 'Q_r/Q', min: 0.5, max: 3.0, step: 0.25, defaultValue: 1.0, description: 'Ratio of recirculated effluent to keep biofilm moist.' }
    ]
  },

  sbr_reactor: {
    id: 'sbr_reactor',
    name: 'Sequencing Batch Reactor (SBR)',
    category: 'secondary',
    description: 'Time-oriented batch activated sludge system combining aeration, settling, and decanting in one tank.',
    engineeringInfo: 'Operates in cyclic phases: Fill -> React -> Settle -> Decant -> Idle. Eliminates need for separate secondary clarifiers.',
    footprint: [4, 4],
    capex: 130000,
    baseOpexPerDay: 90,
    powerConsumptionKw: 22.0,
    minHRT_hours: 6.0,
    sludgeYieldRatio: 0.45,
    unlockedByDefault: false,
    requiredTechId: 'tech_batch_reactors',
    ports: [
      { id: 'inlet', name: 'Raw/Equalized Feed', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'outlet', name: 'Decanted Effluent', type: 'outlet', relativePosition: [2, 0.5, 0] },
      { id: 'sludge_outlet', name: 'WAS Sludge', type: 'sludge_outlet', relativePosition: [0, 0.2, 2] }
    ],
    defaultParams: { cycleHours: 4.8, reactAerationFraction: 0.55 },
    paramDefinitions: [
      { key: 'cycleHours', label: 'Total Cycle Duration', unit: 'hours', min: 3.0, max: 8.0, step: 0.5, defaultValue: 4.8, description: 'Duration of full Fill-React-Settle-Decant cycle.' }
    ]
  },

  // ==========================================
  // TERTIARY & ADVANCED TREATMENT
  // ==========================================
  sand_filter: {
    id: 'sand_filter',
    name: 'Rapid Sand Filter',
    category: 'tertiary',
    description: 'Multi-media granular depth filter polishing suspended solids and residual turbidity.',
    engineeringInfo: 'Anthracite & silica sand layers capture micro-flocs. Produces ultra-low turbidity (<1 NTU) essential for UV disinfection efficiency.',
    footprint: [3, 2],
    capex: 50000,
    baseOpexPerDay: 40,
    powerConsumptionKw: 6.0,
    minHRT_hours: 0.3,
    unlockedByDefault: false,
    requiredTechId: 'tech_granular_filtration',
    ports: [
      { id: 'inlet', name: 'Clarified Inflow', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Filtered Water', type: 'outlet', relativePosition: [1.5, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Backwash Waste', type: 'sludge_outlet', relativePosition: [0, 0.2, 1] }
    ],
    defaultParams: { filtrationRateMh: 10, backwashFrequencyHours: 24 },
    paramDefinitions: [
      { key: 'filtrationRateMh', label: 'Filtration Velocity', unit: 'm/h', min: 5, max: 20, step: 1, defaultValue: 10, description: 'Hydraulic loading rate through the sand bed.' }
    ]
  },

  chemical_phosphorus: {
    id: 'chemical_phosphorus',
    name: 'Chemical Coagulation & P-Removal',
    category: 'tertiary',
    description: 'Flash mixer and flocculator dosing Alum / FeCl3 to chemically precipitate orthophosphate.',
    engineeringInfo: 'Fe³⁺ + PO₄³⁻ -> FePO₄(s) precipitate. Reduces TP below 0.1 mg/L to prevent eutrophication and algal blooms in receiving water bodies.',
    footprint: [2, 2],
    capex: 40000,
    baseOpexPerDay: 70,
    powerConsumptionKw: 4.5,
    minHRT_hours: 0.25,
    unlockedByDefault: false,
    requiredTechId: 'tech_chemical_removal',
    ports: [
      { id: 'inlet', name: 'Water Feed', type: 'inlet', relativePosition: [-1, 0.5, 0] },
      { id: 'outlet', name: 'Precipitated Stream', type: 'outlet', relativePosition: [1, 0.5, 0] }
    ],
    defaultParams: { coagulantDoseMgL: 18.0, polymerDoseMgL: 0.5 },
    paramDefinitions: [
      { key: 'coagulantDoseMgL', label: 'FeCl3 / Alum Dose', unit: 'mg/L', min: 2, max: 60, step: 2, defaultValue: 18.0, description: 'Chemical coagulant dosing rate. Increases operational chemical costs.' }
    ]
  },

  uv_disinfection: {
    id: 'uv_disinfection',
    name: 'UV Disinfection Chamber',
    category: 'tertiary',
    description: 'Low-pressure high-output UV lamp channel providing chemical-free pathogen destruction.',
    engineeringInfo: 'Delivers 254 nm germicidal UV fluence (30-45 mJ/cm²), destroying pathogen DNA/RNA. 3-5 log reduction of E. coli and viruses without chlorination DBPs.',
    footprint: [3, 1],
    capex: 55000,
    baseOpexPerDay: 50,
    powerConsumptionKw: 12.0,
    minHRT_hours: 0.05,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Polished Inflow', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Disinfected Effluent', type: 'outlet', relativePosition: [1.5, 0.5, 0] }
    ],
    defaultParams: { uvFluenceMJCm2: 35, lampPowerPercent: 100 },
    paramDefinitions: [
      { key: 'uvFluenceMJCm2', label: 'Target UV Dose', unit: 'mJ/cm²', min: 20, max: 80, step: 5, defaultValue: 35, description: 'UV irradiation dose. Higher dose overcomes residual turbidity.' }
    ]
  },

  chlorination_basin: {
    id: 'chlorination_basin',
    name: 'Chlorine Contact Basin',
    category: 'tertiary',
    description: 'Serpentine baffled contact tank dosing sodium hypochlorite for persistent disinfection.',
    engineeringInfo: 'Chick-Watson law disinfection. Provides residual protection against regrowth in long discharge outfalls.',
    footprint: [3, 2],
    capex: 35000,
    baseOpexPerDay: 65,
    powerConsumptionKw: 2.0,
    minHRT_hours: 0.5,
    unlockedByDefault: false,
    requiredTechId: 'tech_chlorination',
    ports: [
      { id: 'inlet', name: 'Inflow', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Disinfected Effluent', type: 'outlet', relativePosition: [1.5, 0.5, 0] }
    ],
    defaultParams: { chlorineDoseMgL: 5.0 },
    paramDefinitions: [
      { key: 'chlorineDoseMgL', label: 'Chlorine Dose', unit: 'mg/L', min: 1, max: 15, step: 0.5, defaultValue: 5.0, description: 'Dosing of NaOCl disinfectant.' }
    ]
  },

  reverse_osmosis: {
    id: 'reverse_osmosis',
    name: 'Reverse Osmosis (RO) Skid',
    category: 'tertiary',
    description: 'High-pressure spiral-wound membrane system removing 99.5% dissolved minerals, salts, and micropollutants.',
    engineeringInfo: 'Generates ultra-pure reclaimed water for industrial reuse or indirect potable injection. Rejects concentrated brine stream.',
    footprint: [3, 2],
    capex: 280000,
    baseOpexPerDay: 220,
    powerConsumptionKw: 65.0,
    minHRT_hours: 0.1,
    unlockedByDefault: false,
    requiredTechId: 'tech_reverse_osmosis',
    ports: [
      { id: 'inlet', name: 'RO Feed (Filtered)', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Pure Permeate', type: 'outlet', relativePosition: [1.5, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Brine Reject', type: 'sludge_outlet', relativePosition: [0, 0.2, 1] }
    ],
    defaultParams: { recoveryPercent: 75, operatingPressureBar: 18.0 },
    paramDefinitions: [
      { key: 'recoveryPercent', label: 'Water Recovery', unit: '%', min: 60, max: 88, step: 2, defaultValue: 75, description: 'Percentage of feed converted to pure product water.' }
    ]
  },

  advanced_oxidation_aop: {
    id: 'advanced_oxidation_aop',
    name: 'Advanced Oxidation (O3 / H2O2)',
    category: 'tertiary',
    description: 'Ozone and hydrogen peroxide contactor generating powerful hydroxyl radicals (•OH).',
    engineeringInfo: 'Destroys recalcitrant industrial dyes, endocrine disruptors, pharmaceuticals, and synthetic chemicals with reaction rate constants >10⁹ M⁻¹s⁻¹.',
    footprint: [3, 2],
    capex: 210000,
    baseOpexPerDay: 180,
    powerConsumptionKw: 42.0,
    minHRT_hours: 0.3,
    unlockedByDefault: false,
    requiredTechId: 'tech_advanced_oxidation',
    ports: [
      { id: 'inlet', name: 'Feed Stream', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Oxidized Effluent', type: 'outlet', relativePosition: [1.5, 0.5, 0] }
    ],
    defaultParams: { ozoneDoseMgL: 12.0, h2o2Ratio: 0.5 },
    paramDefinitions: [
      { key: 'ozoneDoseMgL', label: 'Ozone Dose', unit: 'mg/L', min: 2, max: 30, step: 1, defaultValue: 12.0, description: 'O3 gas injection concentration.' }
    ]
  },

  // ==========================================
  // SLUDGE & RESOURCE RECOVERY
  // ==========================================
  sludge_thickener: {
    id: 'sludge_thickener',
    name: 'Gravity Sludge Thickener',
    category: 'sludge',
    description: 'Deep circular picket-fence rake tank concentrating raw primary and biological sludge.',
    engineeringInfo: 'Increases sludge solids concentration from 0.8% to 4.5% solids, reducing digester heating and hydraulic volume requirements by 75%.',
    footprint: [3, 3],
    capex: 60000,
    baseOpexPerDay: 40,
    powerConsumptionKw: 4.0,
    minHRT_hours: 12.0,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Thin Sludge Feed', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Supernatant Return', type: 'outlet', relativePosition: [1.5, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Thickened Sludge', type: 'sludge_outlet', relativePosition: [0, 0.2, 1.5] }
    ],
    defaultParams: { solidsLoadingKgM2d: 40 },
    paramDefinitions: [
      { key: 'solidsLoadingKgM2d', label: 'Solids Loading Rate', unit: 'kg/m²·d', min: 20, max: 80, step: 5, defaultValue: 40, description: 'Gravity settling solids loading setpoint.' }
    ]
  },

  anaerobic_digester: {
    id: 'anaerobic_digester',
    name: 'Anaerobic Digester & Biogas CHP',
    category: 'sludge',
    description: 'Mesophilic (37°C) closed digester converting waste sludge into renewable methane biogas and green electricity.',
    engineeringInfo: 'Methanogens convert volatile fatty acids into CH4 (65%) and CO2 (35%). Destroys 50% volatile solids and generates ~0.35 m³ biogas / kg COD destroyed. Co-generation offsets plant electricity bills!',
    footprint: [4, 4],
    capex: 320000,
    baseOpexPerDay: 120,
    powerConsumptionKw: -45.0, // Negative power demand = net electricity producer!
    minHRT_hours: 360.0, // 15 days SRT
    biogasYieldRatio: 0.38,
    unlockedByDefault: false,
    requiredTechId: 'tech_anaerobic_digestion',
    ports: [
      { id: 'inlet', name: 'Thickened Sludge Feed', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Digested Biosolids', type: 'sludge_outlet', relativePosition: [2, 0.2, 0] },
      { id: 'gas_outlet', name: 'Biogas (CH4)', type: 'gas_outlet', relativePosition: [0, 1.5, 0] }
    ],
    defaultParams: { digesterTempC: 37, srtDays: 18 },
    paramDefinitions: [
      { key: 'digesterTempC', label: 'Operating Temperature', unit: '°C', min: 30, max: 42, step: 1, defaultValue: 37, description: 'Mesophilic optimal zone (35-38°C) optimizes methanogenesis kinetics.' },
      { key: 'srtDays', label: 'Sludge Retention Time', unit: 'days', min: 10, max: 30, step: 1, defaultValue: 18, description: 'Digestion residence time for volatile solids conversion.' }
    ]
  },

  sludge_dewatering_press: {
    id: 'sludge_dewatering_press',
    name: 'Dewatering Centrifuge & Belt Press',
    category: 'sludge',
    description: 'High-speed decanter centrifuge squeezing sludge into dry stackable biosolid cake for recycling.',
    engineeringInfo: 'Produces 22-28% dry cake solids with polymer conditioning. Greatly lowers hauling and landfill disposal expenses.',
    footprint: [3, 2],
    capex: 110000,
    baseOpexPerDay: 85,
    powerConsumptionKw: 22.0,
    minHRT_hours: 0.1,
    unlockedByDefault: false,
    requiredTechId: 'tech_dewatering',
    ports: [
      { id: 'inlet', name: 'Digested Sludge', type: 'inlet', relativePosition: [-1.5, 0.5, 0] },
      { id: 'outlet', name: 'Centrate Liquor Return', type: 'outlet', relativePosition: [1.5, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Dewatered Cake Out', type: 'sludge_outlet', relativePosition: [0, 0.2, 1] }
    ],
    defaultParams: { polymerDoseKgTon: 4.5, gForce: 2500 },
    paramDefinitions: [
      { key: 'polymerDoseKgTon', label: 'Polymer Conditioner', unit: 'kg/ton DS', min: 2.0, max: 10.0, step: 0.5, defaultValue: 4.5, description: 'Cationic polymer dosing to flocculate sludge particles.' }
    ]
  },

  solar_drying_bed: {
    id: 'solar_drying_bed',
    name: 'Solar Sludge Drying Bed',
    category: 'sludge',
    description: 'Greenhouse solar drying facility transforming biosolid cakes into dry pathogen-free fertilizer pellets.',
    engineeringInfo: 'Zero chemical power method utilizing ambient solar irradiance to achieve >80% dry solids.',
    footprint: [4, 3],
    capex: 75000,
    baseOpexPerDay: 15,
    powerConsumptionKw: 2.0,
    minHRT_hours: 72.0,
    unlockedByDefault: false,
    requiredTechId: 'tech_solar_drying',
    ports: [
      { id: 'inlet', name: 'Sludge Cake In', type: 'inlet', relativePosition: [-2, 0.5, 0] },
      { id: 'sludge_outlet', name: 'Dry Fertilizer Out', type: 'sludge_outlet', relativePosition: [2, 0.2, 0] }
    ],
    defaultParams: { ventilationRatePercent: 80 },
    paramDefinitions: [
      { key: 'ventilationRatePercent', label: 'Solar Greenhouse Fan Speed', unit: '%', min: 20, max: 100, step: 10, defaultValue: 80, description: 'Maintains optimal convective drying airflow.' }
    ]
  },

  // ==========================================
  // HYDRAULICS / UTILITY
  // ==========================================
  pump_station: {
    id: 'pump_station',
    name: 'Hydraulic Lift Pump Station',
    category: 'hydraulics',
    description: 'Submersible centrifugal pump station lifting gravity flows to higher hydraulic grade lines.',
    engineeringInfo: 'Provides total dynamic head (TDH) to prevent hydraulic back-flooding.',
    footprint: [2, 2],
    capex: 20000,
    baseOpexPerDay: 20,
    powerConsumptionKw: 8.0,
    minHRT_hours: 0.05,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Low Elevation Inlet', type: 'inlet', relativePosition: [-1, 0.5, 0] },
      { id: 'outlet', name: 'Pressurized Discharge', type: 'outlet', relativePosition: [1, 0.5, 0] }
    ],
    defaultParams: { pumpHeadMeters: 6.0 },
    paramDefinitions: [
      { key: 'pumpHeadMeters', label: 'Pump Head', unit: 'm', min: 2, max: 20, step: 1, defaultValue: 6.0, description: 'Lift dynamic head.' }
    ]
  },

  pipe_junction: {
    id: 'pipe_junction',
    name: 'Flow Splitter / Junction Box',
    category: 'hydraulics',
    description: 'Hydraulic manifold distributing incoming streams symmetrically between parallel trains.',
    engineeringInfo: 'Equipped with adjustable flow-splitting weir plates.',
    footprint: [1, 1],
    capex: 5000,
    baseOpexPerDay: 2,
    powerConsumptionKw: 0.1,
    minHRT_hours: 0.01,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Inflow', type: 'inlet', relativePosition: [-0.5, 0.5, 0] },
      { id: 'outlet', name: 'Outflow 1', type: 'outlet', relativePosition: [0.5, 0.5, 0] },
      { id: 'recycle_outlet', name: 'Outflow 2', type: 'recycle_outlet', relativePosition: [0, 0.5, 0.5] }
    ],
    defaultParams: { splitRatioPercent: 50 },
    paramDefinitions: [
      { key: 'splitRatioPercent', label: 'Split to Branch 1', unit: '%', min: 10, max: 90, step: 5, defaultValue: 50, description: 'Weir division ratio.' }
    ]
  },

  influent_inlet: {
    id: 'influent_inlet',
    name: 'Plant Raw Influent Works',
    category: 'hydraulics',
    description: 'Point of origin where municipal and industrial raw wastewater enters the plant facility.',
    engineeringInfo: 'Source node delivering raw sewage volume and pollutant load.',
    footprint: [2, 2],
    capex: 0,
    baseOpexPerDay: 0,
    powerConsumptionKw: 0,
    minHRT_hours: 0,
    unlockedByDefault: true,
    ports: [
      { id: 'outlet', name: 'Raw Wastewater Out', type: 'outlet', relativePosition: [1, 0.5, 0] }
    ],
    defaultParams: {},
    paramDefinitions: []
  },

  effluent_outfall: {
    id: 'effluent_outfall',
    name: 'Final Effluent Outfall Discharge',
    category: 'hydraulics',
    description: 'Submerged diffuser outfall discharging treated clean water into receiving ocean or river water body.',
    engineeringInfo: 'Point of regulatory compliance monitoring. All environmental limits are checked here!',
    footprint: [2, 2],
    capex: 10000,
    baseOpexPerDay: 10,
    powerConsumptionKw: 0,
    minHRT_hours: 0,
    unlockedByDefault: true,
    ports: [
      { id: 'inlet', name: 'Final Effluent In', type: 'inlet', relativePosition: [-1, 0.5, 0] }
    ],
    defaultParams: {},
    paramDefinitions: []
  },

  // ==========================================
  // POWER & SITE INFRASTRUCTURE
  // ==========================================
  solar_array: {
    id: 'solar_array',
    name: 'Solar Photovoltaic Array',
    category: 'power',
    description: 'Ground-mounted PV panel rows offsetting plant electricity demand during daylight hours.',
    engineeringInfo: 'Peak output ~42 kW at full sun. Output follows the day/night cycle — zero at night. Typical payback via avoided grid purchases in 6-8 years.',
    footprint: [4, 3],
    capex: 65000,
    baseOpexPerDay: 12,
    powerConsumptionKw: -42.0, // negative = generation (at peak sun)
    minHRT_hours: 0,
    unlockedByDefault: true,
    ports: [],
    defaultParams: {},
    paramDefinitions: []
  },

  wind_turbine: {
    id: 'wind_turbine',
    name: 'Wind Turbine (850 kW class)',
    category: 'power',
    description: 'Utility-scale three-blade turbine harvesting site wind resources around the clock.',
    engineeringInfo: 'Output varies with wind speed cubically; modeled as smooth 15-100% capacity factor waves. Generates day and night.',
    footprint: [2, 2],
    capex: 130000,
    baseOpexPerDay: 18,
    powerConsumptionKw: -85.0, // negative = generation (at rated wind)
    minHRT_hours: 0,
    unlockedByDefault: true,
    ports: [],
    defaultParams: {},
    paramDefinitions: []
  }
};

export interface EnvironmentFactors {
  /** 0 (midnight) → 1 (full noon sun) — drives solar output */
  daylight: number;
  /** 0.15–1.0 wind resource factor — drives turbine output */
  wind: number;
  /**
   * Simulated days elapsed this tick (fractional). Enables true dynamic
   * process state (biomass growth, commissioning, storage integration).
   * Legacy callers omit it → treated as a steady-state snapshot (dt=0):
   * dynamic states are READ but never advanced.
   */
  dtDays?: number;
}

/**
 * Executes high-precision environmental engineering mass-balance calculations
 * for a specific placed unit given its incoming stream and operational parameters.
 *
 * forwardInflow is retained in the signature for legacy call sites/tests: the
 * per-port stream architecture no longer needs a separate net-throughput hint —
 * the secondary clarifier derives forward flow analytically from Qclar/(1+r).
 */
export function calculateUnitProcess(
  unit: PlacedUnit,
  inlet: WaterQuality,
  _forwardInflow?: number,
  env?: EnvironmentFactors,
  ctx?: { pumpDischargeHeadlossM?: number }
): ProcessResult {
  // Renewable generators are standalone infrastructure with no water ports —
  // they produce power regardless of hydraulic flow.
  if (unit.typeId === 'solar_array') {
    const daylight = env ? env.daylight : 1;
    return {
      effluent: emptyWater(),
      powerKw: -Math.abs(UNIT_DEFINITIONS.solar_array.powerConsumptionKw) * daylight,
      opexDay: UNIT_DEFINITIONS.solar_array.baseOpexPerDay,
      efficiency: Math.round(daylight * 100)
    };
  }
  if (unit.typeId === 'wind_turbine') {
    const wind = env ? env.wind : 1;
    return {
      effluent: emptyWater(),
      powerKw: -Math.abs(UNIT_DEFINITIONS.wind_turbine.powerConsumptionKw) * wind,
      opexDay: UNIT_DEFINITIONS.wind_turbine.baseOpexPerDay,
      efficiency: Math.round(wind * 100)
    };
  }

  const def = UNIT_DEFINITIONS[unit.typeId];
  if (!def || inlet.flowRate <= 0.01) {
    return {
      effluent: emptyWater(),
      powerKw: 0,
      opexDay: 0,
      efficiency: 0
    };
  }

  const p = { ...def.defaultParams, ...unit.customParams };
  const eff = cloneWater(inlet);
  let sludge: WaterQuality | undefined = undefined;
  const portStreams: Record<string, WaterQuality> = {};
  const gasStreams: Record<string, GasStream> = {};
  let gasProducedM3Day = 0;
  let powerKw = def.powerConsumptionKw;
  let opexDay = def.baseOpexPerDay;
  let efficiency = 95;
  let sludgeBlanketHeight = 0.2;
  let dissolvedOxygen = eff.do;
  let mlss = 3000;
  let svi = 110;
  let pumpRuntime: ProcessResult['pumpRuntime'] = undefined;
  let mbrFouling: MbrFoulingState | undefined = undefined;

  switch (unit.typeId) {
    // -----------------------------------------------------
    case 'bar_screen': {
      const spacing = p.barSpacingMm || 15;
      // Smaller bar spacing = higher coarse solids removal (10% to 30%)
      const removalFrac = Math.max(0.08, Math.min(0.32, 0.35 - (spacing / 100)));
      eff.tss *= (1 - removalFrac);
      eff.turbidity *= (1 - removalFrac * 0.5);
      eff.bod *= 0.95; // minor coarse BOD removal
      efficiency = 98;
      break;
    }

    // -----------------------------------------------------
    case 'grit_chamber': {
      // Vortex centrifugal settling removes dense mineral TSS & grit
      const paddleRpm = p.paddleRpm || 18;
      const rpmFactor = Math.min(1.1, paddleRpm / 18);
      const gritRemoval = Math.min(0.25, 0.18 * rpmFactor);
      eff.tss *= (1 - gritRemoval);
      eff.turbidity *= 0.88;
      efficiency = 96;
      break;
    }

    // -----------------------------------------------------
    case 'equalization_basin': {
      // ── Engineered equalization (Prompt §J): real dynamic mixed-storage
      //    with mass conservation when the unit has a blueprint. The
      //    traditional tox-damping fallback remains for legacy saves. ──
      if (unit.blueprint) {
        if (!unit.eqStorage) {
          unit.eqStorage = { storedVolumeM3: 0, constituentMassKg: {} };
        }
        const eq = stepEqualization(
          unit,
          inlet,
          env?.dtDays ?? 0,
          p.eqOutflowTargetM3h
        );
        // Persist from the returned SNAPSHOT — no aliasing of the object
        // stepEqualization mutated in place this step.
        unit.eqStorage = {
          storedVolumeM3: eq.storedVolumeM3,
          constituentMassKg: eq.constituentMassKg,
        };
        Object.assign(eff, eq.effluent);
        eff.flowRate = eq.outflowM3d;
        efficiency = eq.overflowed ? 80 : 100;
        opexDay = eq.outflowM3d * 0.02; // pumping energy
        break;
      }
      // Damps peak toxic index and stabilizes pH towards neutral 7.2
      eff.toxicIndex *= 0.75;
      eff.ph = 7.2 + (eff.ph - 7.2) * 0.6;
      eff.do = Math.min(2.0, eff.do + 0.5);
      efficiency = 100;
      break;
    }

    // -----------------------------------------------------
    case 'primary_clarifier_circular':
    case 'primary_clarifier_rect': {
      // ── Load-first solids balance ───────────────────────────────────────
      // Removal fractions are decided from operating data, then ALL removed
      // loads are computed from the INCOMING load before the effluent is
      // mutated:  removedLoad = Qin·Cin − Qeff·Ceff.
      // Sludge concentration then derives from removed mass ÷ sludge flow —
      // solids can be neither created nor destroyed by the settling model.
      const area = (def.footprint[0] * 6) * (def.footprint[1] * 6); // rough m2
      const sor = inlet.flowRate / Math.max(10, area); // m/d
      // Metcalf & Eddy empirical primary settling curve: R_tss = t / (a + b*t)
      const hrtHours = (unit.volume || (area * 3.5)) / (inlet.flowRate / 24);
      let tssRemoval = (hrtHours / (0.015 + 0.02 * hrtHours)) / 100;
      tssRemoval = Math.max(0.35, Math.min(0.72, tssRemoval));
      if (sor > 60) tssRemoval *= 0.8; // SOR overload penalty

      const bodRemoval = tssRemoval * 0.55; // particulate BOD settling
      const qIn = Math.max(0, inlet.flowRate);

      // Incoming loads BEFORE any effluent mutation
      const inTssKg = loadKgDay(qIn, inlet.tss);
      const inBodKg = loadKgDay(qIn, inlet.bod);
      const inCodKg = loadKgDay(qIn, inlet.cod);
      const inTpKg = loadKgDay(qIn, inlet.tp);

      // Removed masses settle into the sludge blanket
      const removedTssKg = inTssKg * tssRemoval;
      const removedBodKg = inBodKg * bodRemoval;
      const removedCodKg = Math.min(inCodKg, removedBodKg * 1.5);
      const removedTpKg = inTpKg * 0.10; // particulate P in settling solids

      // Effluent keeps everything that did not settle
      eff.tss = Math.max(0, inlet.tss * (1 - tssRemoval));
      eff.bod = Math.max(1, inlet.bod * (1 - bodRemoval));
      eff.cod = Math.max(10, inlet.cod - (removedCodKg * 1000) / Math.max(1, qIn));
      eff.turbidity *= (1 - tssRemoval * 0.7);
      eff.tp = Math.max(0.05, (inTpKg - removedTpKg) * 1000 / Math.max(1, qIn));

      // Primary sludge output: concentration DERIVED from removed mass
      const sludgeFlow = Math.max(2, inlet.flowRate * 0.015);
      sludge = {
        ...cloneWater(inlet),
        flowRate: sludgeFlow,
        tss: (removedTssKg * 1000) / sludgeFlow,
        bod: (removedBodKg * 1000) / sludgeFlow,
        cod: (removedCodKg * 1000) / sludgeFlow,
        tp: (removedTpKg * 1000) / sludgeFlow
      };
      eff.flowRate = Math.max(0, inlet.flowRate - sludgeFlow);
      sludgeBlanketHeight = 0.35;
      efficiency = Math.round(tssRemoval * 100);
      break;
    }

    // -----------------------------------------------------
    case 'daf_unit': {
      const pAir = p.airPressureBar || 5.0;
      const pressureFactor = pAir / 5.0;
      const fogRemoval = Math.min(0.85, 0.70 * pressureFactor);

      // Load-first balance (same discipline as the primary clarifier): the
      // float sludge concentration derives from the mass removed from the
      // INCOMING stream — never from the already-reduced effluent.
      const qIn = Math.max(0, inlet.flowRate);
      const inTssKg = loadKgDay(qIn, inlet.tss);
      const inBodKg = loadKgDay(qIn, inlet.bod);

      const removedTssKg = inTssKg * fogRemoval;

      eff.tss = Math.max(0, inlet.tss * (1 - fogRemoval));
      eff.turbidity *= 0.4;
      eff.bod *= 0.75;
      eff.cod *= 0.70;

      // Float sludge / scum stream: TSS derived from actually-removed solids
      const floatFlow = Math.max(1, inlet.flowRate * 0.02);
      sludge = {
        ...cloneWater(inlet),
        flowRate: floatFlow,
        tss: (removedTssKg * 1000) / floatFlow,
        bod: Math.max(0, (inBodKg * 0.25 * 1000) / floatFlow) // 25% of incoming BOD floats
      };
      eff.flowRate = Math.max(0, qIn - floatFlow);

      efficiency = 92;
      powerKw = 15.0 * pressureFactor;
      break;
    }

    // -----------------------------------------------------
    case 'activated_sludge_cas': {
      // ── Engineered runtime (Prompt §F/G/H): only when a blueprint is
      //    present AND the unit has been commissioned. Until then the legacy
      //    snapshot path keeps old saves/tests stable. ──
      if (unit.blueprint) {
        if (!unit.commissioning) {
          // First engineered tick: seed the commissioning state machine.
          unit.commissioning = freshCommissioning();
          unit.biomassKg = 0;
        }
        const dtDays = env?.dtDays ?? 0;
        // Advance phase clock with whatever time elapsed.
        unit.commissioning = {
          ...unit.commissioning,
          daysInPhase: unit.commissioning.daysInPhase + Math.max(0, dtDays),
        };
        const casStep = stepCasRuntime(unit, {
          inlet: { ...inlet },
          controls: {
            doSetpointMgL: p.doSetpoint ?? 2.0,
            wasRateM3d: p.wasPurgeRateM3d ?? 60,
          },
          dtDays,
          commissioning: unit.commissioning,
          biomassKg: unit.biomassKg ?? 0,
        });
        // Persist dynamic state back to the unit.
        unit.commissioning = casStep.commissioning;
        unit.biomassKg = casStep.newBiomassKg;
        unit.srtDays = casStep.srtDays;
        if (!unit.condition) {
          unit.condition = {
            conditionIndex: 1.0,
            operatingHours: 0,
            diffuserFoulingFactor: 1.0,
            lastMaintenanceDay: 0,
            nextServiceDay: 90,
          };
        }
        // Slow diffuser fouling based on actual OTE demand vs capacity.
        if (casStep.diagnostics.oxygenLimited) {
          unit.condition.diffuserFoulingFactor = Math.max(
            0.7,
            unit.condition.diffuserFoulingFactor - 0.005 * Math.max(1, dtDays * 24)
          );
        }

        Object.assign(eff, casStep.effluent);
        dissolvedOxygen = casStep.actualDoMgL;
        mlss = casStep.diagnostics.mlssMgL;
        svi = casStep.diagnostics.oxygenLimited ? 175 : 105;
        powerKw = casStep.powerKw;
        efficiency = Math.round((1 - casStep.diagnostics.ourKgO2Day /
          Math.max(1e-6, casStep.diagnostics.suppliedKgO2Day)) * 100);
        // Failure surfaces as a real warning the player can fix.
        if (casStep.diagnostics.oxygenLimited && dtDays > 0) {
          opexDay = (p.wasPurgeRateM3d ?? 60) * 0.12; // chemical augmentation
        }
        break;
      }
      // Legacy snapshot path (no blueprint attached — e.g. legacy saved game).
      const doTarget = p.doSetpoint || 2.0;
      dissolvedOxygen = doTarget;
      // Monod kinetics: μ = μ_max * S / (Ks + S) * DO / (K_DO + DO)
      // K_DO ≈ 0.3 mg/L for heterotrophic bacteria (Metcalf & Eddy)
      const doFactor = doTarget / (0.3 + doTarget);
      const toxicPenalty = Math.max(0.2, 1 - (inlet.toxicIndex / 100) * 0.8);
      const baseBodRemoval = 0.93;
      const actualBodRemoval = Math.min(0.98, baseBodRemoval * doFactor * toxicPenalty);

      const removedBod = eff.bod * actualBodRemoval;
      eff.bod -= removedBod;
      eff.cod = Math.max(15, eff.cod - removedBod * 1.6);

      // Nitrification: autotrophs convert NH4 -> NO3 (need DO > ~1 mg/L)
      const nitrifRate = doTarget > 1.0 ? Math.min(0.85, 0.55 * (doTarget - 0.5)) : 0.05;
      const nitrifiedNh4 = eff.nh4 * nitrifRate;
      eff.nh4 -= nitrifiedNh4;

      // Biomass assimilation strips ~25% of phosphorus into the waste sludge
      eff.tp *= 0.75;

      // NITROGEN BOOKKEEPING: nitrification is a CONVERSION (NH4-N removed
      // joins the NO3 pool); only simultaneous denitrification inside the
      // flocs (→N₂) and biomass assimilation (~20% of converted N) actually
      // leave the liquid phase. TN stays derived from components so it can
      // never contradict them.
      const casAssimilatedN = Math.max(0, nitrifiedNh4) * 0.20;
      const casDenitrified = Math.max(0, nitrifiedNh4) * 0.30; // floc denitrification → N₂
      eff.no3 = Math.max(0, eff.no3 + nitrifiedNh4 - casAssimilatedN - casDenitrified);
      const casOrgN = Math.max(1.0, (inlet.tn - inlet.nh4 - inlet.no3) * 0.25);
      eff.tn = eff.nh4 + eff.no3 + casOrgN;

      // Biological pathogen removal: adsorption to flocs + protozoan predation
      // give conventional activated sludge ~1.5–2 log indicator-bacteria removal
      eff.pathogens = Math.max(0, eff.pathogens * 0.02);

      eff.do = doTarget;
      // NOTE: reactors pass their FULL mixed-liquor flow (feed + RAS return).
      // Loop stability comes from the secondary clarifier's mass-conserving
      // underflow split — see secondary_clarifier below.
      // Power scaled by DO setpoint: blower work
      powerKw = def.powerConsumptionKw * (0.6 + 0.4 * (doTarget / 2.0));
      efficiency = Math.round(actualBodRemoval * 100);
      mlss = p.targetMlss || 3200;
      svi = (doTarget < 1.0) ? 180 : 105; // Bulking sludge if low DO
      break;
    }

    // -----------------------------------------------------
    case 'a2o_bardenpho': {
      // ── Composite reactor model ─────────────────────────────────────────
      // The A2O/Bardenpho basin is ONE unit process; the aerobic→anoxic
      // internal nitrate recycle is INTERNAL hydraulic circulation driven by
      // the `internalRecyclePercent` operating parameter. It changes reaction
      // kinetics (more nitrate pumped back to the anoxic zone → more
      // denitrification) but NEVER net plant throughput: the external outlet
      // passes exactly the mixed-liquor flow it received (main feed + RAS).
      const irRatio = Math.max(0, (p.internalRecyclePercent ?? 200) / 100);
      const aeroDo = p.aerobicDo || 2.5;
      const carbonDose = p.carbonDosingRateMgL || 0;
      dissolvedOxygen = aeroDo;

      // Superior BOD removal
      eff.bod = Math.max(4, eff.bod * 0.04);
      eff.cod = Math.max(18, eff.cod * 0.08);

      // NITRIFICATION is a conversion: NH4-N removed appears as NO3-N.
      const nitrifRate = Math.min(0.95, 0.75 + 0.1 * aeroDo);
      const nitrifiedNh4 = eff.nh4 * nitrifRate;
      eff.nh4 -= nitrifiedNh4;

      // DENITRIFICATION converts NO3 → N2 gas which legitimately leaves the
      // liquid phase. Efficiency is driven by how much nitrate-laden liquor
      // the internal recycle returns to the anoxic zone:
      //   fraction of influent TKN cycled = IR/(1+IR)
      // plus methanol-driven denitrification of the main-line nitrate.
      const deNitrifPotential = (irRatio / (1 + irRatio)) + (carbonDose / 40) * 0.35;
      const deNitrifEfficiency = Math.min(0.98, deNitrifPotential);
      const nitrateBeforeDenit = eff.no3 + nitrifiedNh4; // converted NH4 joins NO3 pool
      const denitrifiedN2 = nitrateBeforeDenit * deNitrifEfficiency; // kg N → N2 gas
      eff.no3 = Math.max(0, nitrateBeforeDenit - denitrifiedN2);

      // Biomass assimilation + residual particulate organic N (~1.2 mg/L).
      const orgN = 1.2;
      // TN bookkeeping is derived FROM components — never assigned independently.
      eff.tn = eff.nh4 + eff.no3 + orgN;

      // Enhanced Biological Phosphorus Removal (EBPR)
      const pRemoval = Math.min(0.90, 0.75 + (carbonDose > 5 ? 0.12 : 0));
      eff.tp = Math.max(0.3, eff.tp * (1 - pRemoval));

      eff.do = aeroDo;
      opexDay = def.baseOpexPerDay + (carbonDose * inlet.flowRate * 0.001 * 0.6); // Carbon chemical cost
      powerKw = def.powerConsumptionKw * (0.8 + 0.2 * irRatio); // internal-recycle pumping energy
      efficiency = 97;

      // NOTE: no external recycle stream exists. Internal circulation never
      // leaves this unit, so it cannot create or move net plant flow.
      break;
    }

    // -----------------------------------------------------
                case 'mbbr_reactor': {
                  const fillRatio = (p.carrierFillRatioPercent || 50) / 100;
                  // MBBR is highly resilient to toxic shocks
                  const toxicResilience = Math.max(0.65, 1 - (inlet.toxicIndex / 100) * 0.35);
                  const bodRemoval = Math.min(0.95, 0.88 * (fillRatio / 0.5) * toxicResilience);

                  // --- AEROBIC TREATMENT (BOD removal + nitrification) ---
                  eff.bod *= (1 - bodRemoval);
                  eff.cod *= (1 - bodRemoval * 0.85);

                  // NITRIFICATION: biofilm nitrification leaves 35% NH4
                  const nh4After = eff.nh4 * 0.35;
                  const nitrified = Math.max(0, eff.nh4 - nh4After);
                  eff.nh4 = nh4After;
                  eff.no3 += nitrified;

                  // --- SIMULTANEOUS NITRIFICATION-DENITRIFICATION (SND) ---
                  // In real MBBR carriers, anoxic biofilm interior denitrifies a fraction
                  // of the TOTAL nitrate present (upstream + newly nitrified), using
                  // biodegradable COD diffusing from bulk. SND efficiency increases with
                  // fill ratio (more carrier = more anoxic volume).
                  // Typical SND: 30-50% of total NO3 denitrified at high fill ratios.
                  const sndFraction = 0.45 * (fillRatio / 0.5); // up to 90% at fillRatio=1.0
                  const denitrified = Math.min(eff.no3, eff.no3 * sndFraction);
                  eff.no3 -= denitrified;
                  // TN = NH4 + NO3 + organic N (80% passes through)
                  const orgNPass = Math.max(1.0, (inlet.tn - inlet.nh4 - inlet.no3) * 0.8);
                  eff.tn = eff.nh4 + eff.no3 + orgNPass;

                  eff.do = 3.0;
                  efficiency = 95;
                  break;
                }

    // -----------------------------------------------------
    case 'mbr_membrane': {
      // MEMBRANE FOULING (runtime, Mission §Q slice 2): the legacy binary
      // "fouled if raw-ish feed else perfect" heuristic is replaced by a
      // continuous resistance progression. The membrane is an absolute barrier
      // (pore << floc) REGARDLESS of fouling state — so permeate quality is
      // always excellent — but as resistance R rises the TMP needed to push
      // the design flow climbs, raising suction power and chemical/cleaning
      // opex. The player sees this via the live Diagnostics block and the
      // AdvisoryEngine, and fixes it with membrane cleaning (CIP).
      const mem = unit.blueprint?.equipment as MembraneDesign | undefined;
      const matId = mem?.materialId ?? 'pvdf_hollow_fiber';
      const installedAreaM2 = mem ? mem.moduleCount * mem.areaPerModuleM2 : 7650;
      const designFlux = mem?.designFluxLmh ?? FOUL_FLUX_REF_LMH;
      const airScour = mem?.airScourNm3hPerM2 ?? SCOUR_MIN_NM3H_PER_M2;
      const qInMbr = Math.max(0, inlet.flowRate);
      const feedTss = inlet.tss;

      // Seed (engineered, first engineered tick) or reuse the persisted
      // fouling state. This state is ADVANCED once per tick by the engine
      // (outside the relaxation loop) — here we only READ it.
      if (unit.blueprint && !unit.mbrFouling) {
        unit.mbrFouling = { ...FRESH_MBR_FOULING };
      }
      const foul = unit.mbrFouling ?? FRESH_MBR_FOULING;
      const runtime = evaluateMbrRuntime(
        { materialId: matId, installedAreaM2, designFluxLmh: designFlux, airScourNm3hPerM2: airScour },
        qInMbr,
        foul,
      );

      // ── CIP OUTAGE (slice 4): a clean-in-place takes the train valved off
      //    for the documented soak window. Zero permeate AND zero WAS (the
      //    tank is drained); suction pumps idle at mixing-only power while
      //    standby opex continues. This is cleaning's THROUGHPUT cost on top
      //    of its fee — schedule cleans for low-flow hours. ──
      if ((foul.offlineHours ?? 0) > 0) {
        eff.flowRate = 0;
        sludge = { ...cloneWater(inlet), flowRate: 0 };
        eff.tss = 0; eff.turbidity = 0; eff.bod = 0; eff.cod = 0;
        eff.pathogens = 0; eff.tp = 0; eff.do = 0;
        powerKw = def.powerConsumptionKw * 0.25;
        opexDay = def.baseOpexPerDay;
        efficiency = 99;
        mbrFouling = foul; // countdown still surfaced to UI/diagnostics
        break;
      }

      // ── Membrane absolute barrier: intact hollow fibers retain ALL solids
      //    (pore size ≈ 0.1–0.4 µm << floc size) — permeate TSS effectively
      //    zero, turbidity < 0.2 NTU, 4-log pathogen rejection, whatever the
      //    fouling resistance. ──
      eff.tss = 0;
      eff.turbidity = Math.min(0.2, eff.turbidity * 0.02);
      eff.bod = Math.max(2, eff.bod * 0.03);
      eff.cod = Math.max(12, eff.cod * 0.06);
      eff.pathogens = Math.max(0, eff.pathogens * 0.0001); // 4-log kill
      eff.tp *= 0.6; // High particulate P retention
      eff.do = 2.5;

      // ── WAS from solids retention, not arbitrary numbers ────────────────
      // The membrane retains essentially ALL incoming biomass; the WAS pump
      // is what actually removes it. Removed solids mass therefore equals
      // the incoming solids load (permeate carries ~0), so:
      //   Qwas × Xwas = Qin·Xin − Qperm·Xperm
      // with Xwas at typical MBR sludge density (10 g/L).
      //
      // HYDRAULIC COMPLEMENTARITY: Qin = Qpermeate + Qwas. Permeate flow is
      // DERIVED as whatever remains after the WAS draw — never added on top.
      const inSolidsKg = loadKgDay(qInMbr, feedTss);
      const wastedSolidsKg = Math.max(0, inSolidsKg); // membrane passes ~no solids
      const mbrWasTss = 10000; // mg/L — typical MBR waste sludge density
      const wasFlow = Math.min(qInMbr * 0.2, Math.max(2, (wastedSolidsKg * 1000) / mbrWasTss));
      sludge = {
        ...cloneWater(inlet),
        flowRate: wasFlow,
        tss: wasFlow > 0.01 ? Math.min(mbrWasTss, (wastedSolidsKg * 1000) / wasFlow) : 0,
        bod: Math.max(5, inlet.bod * 0.25),
        nh4: inlet.nh4 * 0.9 // biomass-bound liquor
      };
      // Permeate = feed minus wasting — strictly complementary (conserves flow)
      eff.flowRate = Math.max(0, qInMbr - wasFlow);
      efficiency = 99;

      // ── Fouling consequence: more resistance ⇒ more suction power + opex,
      //    plus a modest efficiency haircut as TMP climbs toward rating. ──
      powerKw = def.powerConsumptionKw * runtime.powerMult;
      opexDay = def.baseOpexPerDay * runtime.opexMult;
      // TMP approaching the material rating is the headline degradation.
      if (runtime.tmpHeadroomRatio > 1) {
        efficiency = Math.max(80, 99 - 12 * (runtime.tmpHeadroomRatio - 1));
      }

      // Expose runtime operating point for UI / diagnostics / persistence.
      mbrFouling = foul;
      break;
    }

    // -----------------------------------------------------
    case 'secondary_clarifier': {
      // ── Correct RAS mathematics ─────────────────────────────────────────
      // The recycle ratio r = rasRecycleRatioPercent/100 is defined as
      //     r = Qras / Qforward   (RAS relative to NET forward flow)
      // with clarifier mixed-liquor influent Qclar = Qforward + Qras, hence:
      //     Qforward = Qclar / (1 + r)
      //     Qras     = Qclar * r / (1 + r)
      // (NOT r * Qclar — that made "75% RAS" converge to ~300% of forward flow.)
      const r = Math.max(0, (p.rasRecycleRatioPercent ?? 75) / 100);
      const qClar = Math.max(0, inlet.flowRate);
      const qForward = qClar / (1 + r);

      // ── Escape TSS + blanket: DESIGNED GEOMETRY IS AUTHORITATIVE (§I).
      //    With a blueprint, SOR/SLR/blanket dynamics come from the real plan
      //    area and dictate the escape concentration. Regression fix (backlog
      //    #1 investigation): this result used to be recomputed unconditionally
      //    below from qForward/144, silently discarding it — custom clarifier
      //    sizing never reached the effluent and the blanket never followed
      //    the design, even though the UnitDesigner quoted the engineered
      //    numbers. Legacy saves without a blueprint keep the hardcoded
      //    144 m² ladder so old trains tick through unchanged. ──
      let escapeTss: number;
      if (unit.blueprint) {
        const state = unit as PlacedUnit;
        const load = evaluateClarifierLoad(
          unit.blueprint.design.geometry,
          qForward,
          Math.max(800, inlet.tss),
          qClar,
          Math.max(0, Math.min(0.98, (state.sludgeBlanketHeightPercent ?? 25) / 100))
        );
        escapeTss = load.escapeTssMgL;
        // Persisted via result.sludgeBlanketHeight → unit.sludgeBlanketHeightPercent
        // in SimulationEngine (single write path; no direct state mutation here).
        sludgeBlanketHeight = load.blanketLevelFraction;
      } else {
        // Legacy hardcoded 144 m² surface (standard 12x12m footprint).
        const sorLegacy = qForward / 144;
        escapeTss = sorLegacy < 16 ? 5 : sorLegacy < 24 ? 8 : sorLegacy < 32 ? 12 : sorLegacy < 45 ? 20 : 30;
        sludgeBlanketHeight = (sorLegacy > 40) ? 0.75 : 0.3;
      }
      eff.tss = escapeTss;
      eff.turbidity = Math.max(1.2, escapeTss * 0.8);
      // Particulate BOD settles with the floc; soluble BOD stays suspended.
      eff.bod = Math.max(3, inlet.bod * 0.22);
      // Floc entanglement + predation in the blanket strip ~90% of pathogens
      // that survive the bioreactor (secondary clarifiers are good polishers).
      eff.pathogens = Math.max(0, eff.pathogens * 0.1);

      // Soluble/particulate-associated dissolved pollutants follow the liquid;
      // particulate fractions leave with the wasted solids.
      const solidsCaptureFrac = Math.min(0.995, 1 - escapeTss / Math.max(50, inlet.tss));
      eff.cod = Math.max(10, eff.cod - (eff.cod * 0.55 * solidsCaptureFrac));
      eff.tn = Math.max(eff.nh4 + eff.no3 * 0.9, eff.tn - inlet.tss * solidsCaptureFrac * 0.055);
      eff.tp = Math.max(0.05, eff.tp - inlet.tp * solidsCaptureFrac * 0.25);

      // Underflow split: RAS returns to the bioreactor, WAS is purged for SRT
      // control and leaves the liquid train entirely.
      //   Qras = qForward * r ; Qwas = wasPurgeRateM3d capped by what remains
      const qRas = qForward * r;
      const wasTarget = p.wasPurgeRateM3d ?? 50;
      const qWas = Math.min(wasTarget, Math.max(0, qClar - qForward));
      eff.flowRate = Math.max(0, qForward - qWas); // net plant flow minus real wasting

      // ── Defensible solids balance ───────────────────────────────────────
      //   Qfeed·Xfeed ≈ Qeff·Xeff + Qras·Xras + Qwas·Xwas
      // Effluent carries its escape solids; ALL remaining captured solids go
      // to the underflow, shared between RAS and WAS at blanket density so
      // the balance closes by construction (no solids created/destroyed).
      const effluentSolidsKg = loadKgDay(eff.flowRate, escapeTss);
      const underflowFlow = Math.max(0, qRas + qWas);
      const underflowSolidsKg = Math.max(
        0,
        loadKgDay(qClar, inlet.tss) - effluentSolidsKg
      );
      const blanketTss = underflowFlow > 0.01 && underflowSolidsKg > 0
        ? Math.min(14000, Math.max(4000, (underflowSolidsKg * 1000) / underflowFlow))
        : 0;
      const rasStream = { ...cloneWater(inlet), flowRate: qRas, tss: blanketTss };
      const wasStream = {
        ...cloneWater(inlet),
        flowRate: qWas,
        tss: blanketTss,
        bod: Math.max(5, inlet.bod * 0.22),
        tp: Math.max(0.05, inlet.tp * (1 - solidsCaptureFrac * 0.25))
      };

      portStreams['outlet'] = cloneWater(eff);
      portStreams['sludge_outlet'] = rasStream;
      if (def.ports.some(pp => pp.id === 'was_outlet')) {
        portStreams['was_outlet'] = wasStream;
      }
      sludge = rasStream;
      efficiency = Math.round(solidsCaptureFrac * 100);
      break;
    }

    // -----------------------------------------------------
    case 'trickling_filter': {
      eff.bod = Math.max(12, eff.bod * 0.18);
      eff.cod = Math.max(30, eff.cod * 0.25);
      eff.tss = eff.tss * 0.7; // sloughing biomass requires settling
      efficiency = 88;
      break;
    }

    // -----------------------------------------------------
    case 'sbr_reactor': {
      eff.bod = Math.max(5, eff.bod * 0.06);
      eff.tss = Math.max(8, eff.tss * 0.08);
      eff.nh4 = Math.max(2, eff.nh4 * 0.15);
      eff.no3 = Math.max(3, eff.no3 * 0.4);
      eff.turbidity = 5;
      efficiency = 94;
      break;
    }

    // -----------------------------------------------------
    case 'sand_filter': {
      // MEDIA BLINDING (piping consequence): a rapid sand filter is a
      // polishing step. Feeding it raw-level solids clogs the bed — removal
      // degrades and backwash costs spike until clarification is upstream.
      const blinding = inlet.tss > 220;
      if (blinding) {
        eff.tss = Math.max(2, eff.tss * 0.55);
        eff.turbidity = Math.max(1.5, eff.turbidity * 0.6);
        eff.bod = Math.max(3, eff.bod * 0.9);
        eff.cod = Math.max(4, eff.cod * 0.96);
        eff.pathogens *= 0.75;
        opexDay = def.baseOpexPerDay * 2.4; // constant backwashing
        efficiency = 62;
      } else {
        eff.tss = Math.max(0.5, eff.tss * 0.15);
        eff.turbidity = Math.max(0.3, eff.turbidity * 0.12);
        eff.bod = Math.max(1.5, eff.bod * 0.75);
        eff.cod = Math.max(2, eff.cod * 0.85); // filters fine floc particles
        eff.pathogens *= 0.2; // 80% physical filtration
        efficiency = 96;
      }
      break;
    }

    // -----------------------------------------------------
    case 'chemical_phosphorus': {
      const dose = p.coagulantDoseMgL || 18.0;
      // Chemical precipitation of orthophosphate
      const pRemoval = Math.min(0.96, (dose / 20.0) * 0.85);
      eff.tp = Math.max(0.05, eff.tp * (1 - pRemoval));
      eff.tss = Math.max(1, eff.tss * 0.6); // coagulant flocs trap solids
      eff.turbidity *= 0.5;
      opexDay = def.baseOpexPerDay + (dose * inlet.flowRate * 0.001 * 0.85);
      efficiency = Math.round(pRemoval * 100);
      break;
    }

    // -----------------------------------------------------
    case 'uv_disinfection': {
      const dose = p.uvFluenceMJCm2 || 35;
      // UV SHADOWING (piping consequence): suspended particles absorb and
      // scatter germicidal light. Calibrated against real UVT data:
      // filtered secondary effluent (TSS ≈ 10–30, turbidity < 5) transmits
      // ~85-100% and achieves a full ~4-log kill; raw sewage collapses.
      const uvTransmittance = Math.max(0.04, Math.min(1, 1 - eff.tss / 220 - eff.turbidity / 160));
      const effectiveDose = dose * uvTransmittance;
      // Log inactivation: Log10(N0/N) = k * Dose
      const logKill = Math.min(5.5, (effectiveDose / 35.0) * 4.0);
      eff.pathogens = Math.max(0, eff.pathogens * Math.pow(10, -logKill));
      powerKw = def.powerConsumptionKw * (dose / 35.0);
      efficiency = (effectiveDose > 25) ? 99 : Math.round(uvTransmittance * 60);
      break;
    }

    // -----------------------------------------------------
    case 'chlorination_basin': {
      const dose = p.chlorineDoseMgL || 5.0;
      // CHLORINE DEMAND (piping consequence): ammonia consumes free chlorine
      // to form chloramines. Feeding high-NH4 water into the contact tank
      // starves disinfection — nitrify upstream or pay for more chemicals.
      const chlorineDemand = inlet.nh4 * 0.12;
      const freeChlorine = Math.max(0, dose - chlorineDemand);
      const logKill = Math.min(4.5, freeChlorine * 0.85);
      eff.pathogens = Math.max(0, eff.pathogens * Math.pow(10, -logKill));
      opexDay = def.baseOpexPerDay + (dose * inlet.flowRate * 0.001 * 0.5);
      efficiency = freeChlorine > 3 ? 98 : Math.round(50 + (freeChlorine / 3) * 48);
      break;
    }

    // -----------------------------------------------------
    case 'reverse_osmosis': {
      // ── RO is a SEPARATION, not destruction ─────────────────────────────
      // For every conserved constituent:
      //   Qfeed·Cfeed = Qperm·Cperm + Qrej·Crej
      // Permeate concentrations come from documented salt/contaminant
      // passage rates; the REJECT concentration is derived from the mass
      // left over. No negative or infinite concentrations are possible
      // because reject flow is strictly positive and mass is clamped ≥ 0.
      const recovery = Math.min(0.95, Math.max(0.1, (p.recoveryPercent || 75) / 100));
      const qIn = Math.max(0, inlet.flowRate);

      // MEMBRANE SCALING/FOULING (piping consequence): RO spirals require
      // filtered, low-solids feed (SDI < 3). Unpolished feed collapses both
      // rejection (higher passage) and effective recovery.
      const fouled = inlet.tss > 2 || inlet.turbidity > 3;
      const passageMult = fouled ? 8 : 1;          // membranes leak when scaled
      const effRecovery = fouled ? Math.max(0.35, recovery * 0.6) : recovery;

      const permFlow = qIn * effRecovery;
      const rejFlow = Math.max(0.001 * Math.max(1, qIn), qIn - permFlow);

      // Constituent passage fractions to the permeate (documented surrogates)
      const passages = {
        bod: 0.005 * passageMult,
        cod: 0.010 * passageMult,
        tss: fouled ? 0.30 : 0.0005,   // solids break through when scaled
        tn: 0.10 * passageMult,
        nh4: 0.05 * passageMult,
        no3: 0.15 * passageMult,       // nitrate passes RO far easier than TSS
        tp: 0.02 * passageMult,
        toxic: 0.03 * passageMult
      };

      // Permeate concentrations from passage × feed concentration
      const cPerm = {
        bod: inlet.bod * passages.bod,
        cod: inlet.cod * passages.cod,
        tss: inlet.tss * passages.tss,
        tn: inlet.tn * passages.tn,
        nh4: inlet.nh4 * passages.nh4,
        no3: inlet.no3 * passages.no3,
        tp: inlet.tp * passages.tp
      };
      const permToxicIdx = inlet.toxicIndex * passages.toxic;

      // Reject concentration from the REMAINING mass (conservation)
      const cRejFromPassage = (cFeed: number, cPermVal: number) =>
        Math.max(0, (qIn * Math.max(0, cFeed) - permFlow * Math.max(0, cPermVal)) / rejFlow);

      const cRej = {
        bod: cRejFromPassage(inlet.bod, cPerm.bod),
        cod: cRejFromPassage(inlet.cod, cPerm.cod),
        tss: cRejFromPassage(inlet.tss, cPerm.tss),
        tn: cRejFromPassage(inlet.tn, cPerm.tn),
        nh4: cRejFromPassage(inlet.nh4, cPerm.nh4),
        no3: cRejFromPassage(inlet.no3, cPerm.no3),
        tp: cRejFromPassage(inlet.tp, cPerm.tp)
      };
      const rejToxicIdx = cRejFromPassage(inlet.toxicIndex, permToxicIdx);

      // Permeate output
      eff.flowRate = permFlow;
      eff.bod = Math.min(cPerm.bod, inlet.bod);
      eff.cod = Math.min(cPerm.cod, inlet.cod);
      eff.tss = Math.min(cPerm.tss, inlet.tss);
      eff.turbidity = fouled ? Math.max(1, inlet.turbidity * 0.4) : 0.05;
      eff.tn = Math.min(cPerm.tn, inlet.tn);
      eff.nh4 = Math.min(cPerm.nh4, inlet.nh4);
      eff.no3 = Math.min(cPerm.no3, inlet.no3);
      eff.tp = Math.min(cPerm.tp, inlet.tp);
      eff.pathogens = fouled ? inlet.pathogens * 0.01 : 0; // membrane barrier unless scaled
      eff.toxicIndex = Math.max(0, Math.min(permToxicIdx, inlet.toxicIndex));

      // Brine reject carries ALL the rejected mass
      sludge = {
        ...cloneWater(inlet),
        flowRate: rejFlow,
        bod: cRej.bod,
        cod: cRej.cod,
        tss: cRej.tss,
        turbidity: Math.max(inlet.turbidity, cRej.tss),
        tn: cRej.tn,
        nh4: cRej.nh4,
        no3: cRej.no3,
        tp: cRej.tp,
        pathogens: fouled ? inlet.pathogens * 0.5 : inlet.pathogens, // retained organics hold biofilm
        toxicIndex: Math.min(rejToxicIdx, 100)
      };

      if (fouled) {
        opexDay = def.baseOpexPerDay * 1.6;           // clean-in-place chemicals
        powerKw = def.powerConsumptionKw * 1.25;      // higher pressure drop
        efficiency = 45;
      } else {
        efficiency = 100;
      }
      break;
    }

    // -----------------------------------------------------
    case 'advanced_oxidation_aop': {
      const o3Dose = p.ozoneDoseMgL || 12.0;
      // Destroys recalcitrant COD and industrial toxics
      const toxicDestroy = Math.min(0.98, (o3Dose / 15.0) * 0.9);
      eff.toxicIndex *= (1 - toxicDestroy);
      eff.cod = Math.max(5, eff.cod * 0.25);
      eff.bod = Math.max(1, eff.bod * 0.4);
      eff.pathogens = 0; // Ozone is also ultra-potent disinfectant
      opexDay = def.baseOpexPerDay + (o3Dose * inlet.flowRate * 0.001 * 1.1);
      efficiency = 99;
      break;
    }

    // -----------------------------------------------------
    case 'sludge_thickener': {
      // ── Dry-solids conservation ─────────────────────────────────────────
      // Solids in = solids in thickened sludge + solids in supernatant.
      // Thickened flow is DERIVED from the target concentration:
      //   Qthick = (capture · Qin·Xin) / XthickTarget
      const capture = 0.95;                       // 95% of incoming solids captured to underflow
      const targetThickTss = 40000;               // mg/L ≈ 4% dry solids
      const qIn = Math.max(0, inlet.flowRate);
      const inSolidsKg = loadKgDay(qIn, inlet.tss);
      const thickenedSolidsKg = inSolidsKg * capture;
      const supSolidsKg = inSolidsKg - thickenedSolidsKg;

      const thickenedFlow = Math.max(0.5, (thickenedSolidsKg * 1000) / targetThickTss);
      sludge = {
        ...cloneWater(inlet),
        flowRate: thickenedFlow,
        tss: thickenedSolidsKg > 0 ? Math.min(targetThickTss, (thickenedSolidsKg * 1000) / thickenedFlow) : 0,
        bod: inlet.bod * 1.1 // dissolved organics concentrate with the liquor
      };

      // Supernatant carries the uncaptured water and residual solids back to the plant head
      eff.flowRate = Math.max(0, qIn - thickenedFlow);
      eff.tss = eff.flowRate > 0.01 ? (supSolidsKg * 1000) / eff.flowRate : 0;
      efficiency = 95;
      break;
    }

    // -----------------------------------------------------
    case 'anaerobic_digester': {
      // ── Explicit solids accounting ──────────────────────────────────────
      //   dry solids in → volatile fraction → VS destroyed → biosolids left
      //   biogas scales with DESTROYED volatile mass (0.38 Nm³/kg VS).
      const tempC = p.digesterTempC || 37;
      const srt = p.srtDays || 18;
      const tempFactor = (tempC >= 35 && tempC <= 39) ? 1.0 : 0.75;
      const vsDestruction = Math.min(0.58, Math.max(0, (0.40 + 0.01 * (srt - 10)) * tempFactor));
      const volatileFraction = 0.8; // ~80% of sludge TSS is volatile (biodegradable)

      const qIn = Math.max(0, inlet.flowRate);
      const drySolidsKg = loadKgDay(qIn, inlet.tss);
      const volatileSolidsKg = drySolidsKg * volatileFraction;
      const fixedSolidsKg = drySolidsKg - volatileSolidsKg;   // inert — passes through
      const destroyedVsKg = volatileSolidsKg * vsDestruction;
      const remainingSolidsKg = fixedSolidsKg + (volatileSolidsKg - destroyedVsKg);

      // Biogas from DESTROYED biodegradable material only
      gasProducedM3Day = Math.max(0, destroyedVsKg * (def.biogasYieldRatio || 0.38));

      // Biogas energy CHP: 1 Nm³ biogas (~65% CH4) ≈ 2.2 kWh electric
      // (tech bonus multiplier applied by SimulationEngine via TechEffects)
      powerKw = -(gasProducedM3Day * 2.2) / 24;

      // Digestate: remaining solids leave at feed flow minus small gas/evap losses
      const digestedSludgeFlow = Math.max(0.5, qIn * 0.95);
      sludge = {
        ...cloneWater(inlet),
        flowRate: digestedSludgeFlow,
        tss: digestedSludgeFlow > 0 ? (remainingSolidsKg * 1000) / digestedSludgeFlow : 0,
        pathogens: inlet.pathogens * 0.01 // High temperature pathogen destruction (Class B / Class A)
      };

      // Biogas exits through its dedicated gas port as a GAS stream — never
      // carried on a liquid WaterQuality pipe.
      const gasPort = def.ports.find(pp => pp.type === 'gas_outlet');
      if (gasPort) {
        gasStreams[gasPort.id] = {
          flowRate: gasProducedM3Day,
          ch4Fraction: 0.65,
          h2sPpm: 25
        };
      }
      efficiency = Math.round(vsDestruction * 100);
      break;
    }

    // -----------------------------------------------------
    case 'sludge_dewatering_press': {
      // ── Dry-solids conservation ─────────────────────────────────────────
      // Feed solids split by capture efficiency into cake and centrate.
      // Cake flow DERIVES from capture mass ÷ target cake concentration.
      // Polymer dose changes cost/capture — never creates or destroys solids.
      const polymerDose = p.polymerDoseKgTon ?? 4.5;
      const capture = Math.min(0.98, 0.90 + polymerDose * 0.01);  // better dosing → better capture
      const targetCakeTss = 250000;                                // 25% dry solids
      const qIn = Math.max(0, inlet.flowRate);
      const inSolidsKg = loadKgDay(qIn, inlet.tss);
      const cakeSolidsKg = inSolidsKg * capture;
      const centrateSolidsKg = inSolidsKg - cakeSolidsKg;

      const cakeFlow = Math.max(0.2, (cakeSolidsKg * 1000) / targetCakeTss);
      sludge = {
        ...cloneWater(inlet),
        flowRate: cakeFlow,
        tss: cakeSolidsKg > 0 ? Math.min(targetCakeTss, (cakeSolidsKg * 1000) / cakeFlow) : 0,
        nh4: inlet.nh4
      };

      // Centrate: remaining water plus uncaptured fines, rich in released ammonia
      const centrateFlow = Math.max(0, qIn - cakeFlow);
      eff.flowRate = centrateFlow;
      eff.tss = centrateFlow > 0.01 ? (centrateSolidsKg * 1000) / centrateFlow : 0;
      eff.nh4 = centrateFlow > 0.01
        ? Math.max(0, (loadKgDay(qIn, inlet.nh4) + inSolidsKg * 0.02) * 1000 / centrateFlow) // released bound N
        : inlet.nh4;
      opexDay = def.baseOpexPerDay + polymerDose * 8; // polymer cost scales with dosing
      efficiency = Math.round(capture * 100);
      break;
    }

    // -----------------------------------------------------
    case 'solar_drying_bed': {
      // ── Drying removes WATER only ───────────────────────────────────────
      // Dry-solids mass conserved; product flow derives from feed solids
      // load and the target final solids fraction.
      const targetFinalTss = 850000; // 85% dry fertilizer
      const qIn = Math.max(0, inlet.flowRate);
      const inSolidsKg = loadKgDay(qIn, inlet.tss);

      const productFlow = Math.max(0.1, (inSolidsKg * 1000) / targetFinalTss);
      sludge = {
        ...cloneWater(inlet),
        flowRate: productFlow,
        tss: inSolidsKg > 0 ? Math.min(targetFinalTss, (inSolidsKg * 1000) / productFlow) : 0,
        pathogens: 0
      };
      // Evaporated water leaves as vapor — no liquid return stream.
      eff.flowRate = 0;
      efficiency = 98;
      break;
    }

    case 'pump_station': {
      // Real duty-point solver: intersect pump curve with system curve
      // (static lift + downstream pipe headloss). Delivers min(capacity, duty, demand).
      const demandedM3d = Math.max(0, inlet.flowRate);
      const dischargeHeadlossM = ctx?.pumpDischargeHeadlossM ?? 0;
      const speedCommand = unit.blueprint?.controls?.pumpSpeedCommand ?? 1.0;

      const ps = stepPumpStation(unit, demandedM3d, dischargeHeadlossM, speedCommand);

      // Apply clogging penalty on top of duty-point result (unscreened sewage → wear)
      const clogMult = inlet.tss > 350 ? 1.35 : 1.0;
      const clogOpexMult = inlet.tss > 350 ? 2.2 : 1.0;
      const clogEff = inlet.tss > 350 ? 70 : 100;

      eff.flowRate = ps.deliveredFlowM3d;
      powerKw = ps.electricalPowerKw * clogMult;
      opexDay = def.baseOpexPerDay * clogOpexMult;
      efficiency = clogEff;

      // Expose runtime telemetry for UI / diagnostics
      pumpRuntime = {
        status: ps.status,
        dutyFlowM3h: ps.dutyFlowM3h,
        dutyHeadM: ps.dutyHeadM,
        bepFraction: ps.bepFraction,
        cavitating: ps.cavitating,
        failedUnitCount: ps.failedUnitCount,
        electricalPowerKw: ps.electricalPowerKw,
      };
      break;
    }

    // -----------------------------------------------------
    case 'pipe_junction': {
      // Ideal hydraulic splitter/manifold. The configured split ratio r
      // divides the incoming flow between the two branch ports:
      //   Q1 = Qin * r,  Q2 = Qin * (1 - r),  Q1 + Q2 = Qin
      // Concentrations stay unchanged (ideal splitter). This is the ONLY unit
      // whose outlet ports may legitimately feed more than one downstream pipe.
      const splitRatio = Math.min(0.9, Math.max(0.1, (p.splitRatioPercent ?? 50) / 100));
      const { branch1, branch2 } = splitStream(inlet, splitRatio);
      const branch2Port = def.ports.find(pp => pp.type === 'recycle_outlet');
      if (branch2Port) {
        portStreams[branch2Port.id] = branch2;
        eff.flowRate = branch1.flowRate;
        efficiency = 100;
      }
      break;
    }

    // -----------------------------------------------------
    case 'influent_inlet': {
      // Pure hydraulic node — no quality transformation
      efficiency = 100;
      break;
    }

    // -----------------------------------------------------
    case 'effluent_outfall': {
      // Cascade / weir re-aeration at the discharge point: falling water
      // entrains oxygen, recovering dissolved oxygen toward saturation (~9 mg/L).
      eff.do = Math.min(9.5, eff.do + 2.5);
      efficiency = 100;
      break;
    }

    // -----------------------------------------------------
    default: {
      efficiency = 100;
      break;
    }
  }

  return {
    effluent: eff,
    sludge,
    portStreams: buildPortStreams(def, eff, sludge, portStreams),
    gasStreams,
    gasProducedM3Day,
    powerKw,
    opexDay,
    efficiency,
    sludgeBlanketHeight,
    dissolvedOxygen,
    mlss,
    svi,
    pumpRuntime,
    mbrFouling
  };
}
