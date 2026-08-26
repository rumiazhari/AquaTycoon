/**
 * Equipment catalogs (Prompt §N/R/T) — components carry ENGINEERING attributes
 * rather than game bonuses. All prices in $, capacities in SI units.
 */

// ── Construction materials ───────────────────────────────────────────────────

export interface ConstructionMaterial {
  id: string;
  label: string;
  /** $ per m³ concrete workmanship (formwork+rebar+pour included). */
  concreteCostPerM3: number;
  /** Multiplier on concrete cost for specialty linings/steel shells. */
  shellCostFactor: number;
  corrosionResistance: number; // 0..1
  chemicalResistance: number;  // 0..1
  expectedServiceLifeYr: number;
}

export const CONSTRUCTION_MATERIALS: Record<string, ConstructionMaterial> = {
  reinforced_concrete: {
    id: 'reinforced_concrete', label: 'Reinforced Concrete',
    concreteCostPerM3: 480, shellCostFactor: 1.0,
    corrosionResistance: 0.6, chemicalResistance: 0.45, expectedServiceLifeYr: 50,
  },
  epoxy_concrete: {
    id: 'epoxy_concrete', label: 'Epoxy-Lined Concrete',
    concreteCostPerM3: 480, shellCostFactor: 1.35,
    corrosionResistance: 0.8, chemicalResistance: 0.75, expectedServiceLifeYr: 50,
  },
  frp: {
    id: 'frp', label: 'FRP',
    concreteCostPerM3: 520, shellCostFactor: 1.9,
    corrosionResistance: 0.95, chemicalResistance: 0.92, expectedServiceLifeYr: 35,
  },
  ss316: {
    id: 'ss316', label: 'Stainless Steel 316',
    concreteCostPerM3: 520, shellCostFactor: 3.2,
    corrosionResistance: 0.97, chemicalResistance: 0.95, expectedServiceLifeYr: 40,
  },
};

/** Ordered list for UI material selectors. */
export const CONCRETE_MATERIALS_LIST: ConstructionMaterial[] = Object.values(CONSTRUCTION_MATERIALS);

// ── Pipe materials (Prompt §K) ───────────────────────────────────────────────

export interface PipeMaterial {
  id: string;
  label: string;
  roughnessM: number;       // Darcy-Weisbach absolute roughness
  costPerM_per100mmDia: number; // $/m at DN100 baseline; scales ~linearly with D
  maxPressureBar: number;
  corrosionResistance: number; // 0..1 (affects condition decay in raw sewage)
  serviceLifeYr: number;
}

export const PIPE_MATERIALS: Record<string, PipeMaterial> = {
  pvc:          { id: 'pvc', label: 'PVC', roughnessM: 0.0015e-3, costPerM_per100mmDia: 38, maxPressureBar: 10, corrosionResistance: 0.95, serviceLifeYr: 50 },
  hdpe:         { id: 'hdpe', label: 'HDPE', roughnessM: 0.0015e-3, costPerM_per100mmDia: 46, maxPressureBar: 16, corrosionResistance: 0.97, serviceLifeYr: 55 },
  ductile_iron: { id: 'ductile_iron', label: 'Ductile Iron', roughnessM: 0.25e-3, costPerM_per100mmDia: 72, maxPressureBar: 25, corrosionResistance: 0.55, serviceLifeYr: 60 },
  carbon_steel: { id: 'carbon_steel', label: 'Carbon Steel', roughnessM: 0.045e-3, costPerM_per100mmDia: 85, maxPressureBar: 40, corrosionResistance: 0.4, serviceLifeYr: 30 },
  stainless:    { id: 'stainless', label: 'Stainless 316L', roughnessM: 0.002e-3, costPerM_per100mmDia: 190, maxPressureBar: 40, corrosionResistance: 0.98, serviceLifeYr: 50 },
};

// ── Blowers (Prompt §F/N) ────────────────────────────────────────────────────

export interface BlowerModel {
  id: string;
  label: string;
  ratedAirflowM3h: number;
  ratedPressureKPa: number;
  /** Wire-to-air efficiency at rated duty. */
  isentropicEfficiency: number;
  motorEfficiency: number;
  minimumTurndown: number; // fraction of rated airflow
  hasVFD: boolean;
  capex: number;
  annualMaintenanceCost: number;
  mtbfHours: number;
}

export const BLOWER_MODELS: Record<string, BlowerModel> = {
  rotary_lobe_1500: {
    id: 'rotary_lobe_1500', label: 'Rotary Lobe 1,500 m³/h',
    ratedAirflowM3h: 1500, ratedPressureKPa: 70,
    isentropicEfficiency: 0.62, motorEfficiency: 0.92,
    minimumTurndown: 0.55, hasVFD: false,
    capex: 22000, annualMaintenanceCost: 1600, mtbfHours: 26000,
  },
  turbo_3000_vfd: {
    id: 'turbo_3000_vfd', label: 'Turbo Blower 3,000 m³/h + VFD',
    ratedAirflowM3h: 3000, ratedPressureKPa: 75,
    isentropicEfficiency: 0.78, motorEfficiency: 0.95,
    minimumTurndown: 0.40, hasVFD: true,
    capex: 78000, annualMaintenanceCost: 2400, mtbfHours: 45000,
  },
  turbo_6000_vfd: {
    id: 'turbo_6000_vfd', label: 'Turbo Blower 6,000 m³/h + VFD',
    ratedAirflowM3h: 6000, ratedPressureKPa: 80,
    isentropicEfficiency: 0.80, motorEfficiency: 0.96,
    minimumTurndown: 0.45, hasVFD: true,
    capex: 132000, annualMaintenanceCost: 3600, mtbfHours: 50000,
  },
};

/** Fine-bubble diffuser families — oxygen-transfer efficiency at 4 m submergence. */
export interface DiffuserModel {
  id: string;
  label: string;
  /** Standard oxygen transfer efficiency per unit submergence (frac/m). */
  transferEfficiencyPerM: number;
  /** Design airflow per diffuser (m³/h) before coalescence losses. */
  ratedAirflowPerUnitM3h: number;
  foulingResistanceMonths: number; // months between cleanings at design load
  capexPerUnit: number;
}

export const DIFFUSER_MODELS: Record<string, DiffuserModel> = {
  coarse_bubble: {
    id: 'coarse_bubble', label: 'Coarse-Bubble Diffuser',
    transferEfficiencyPerM: 0.018, ratedAirflowPerUnitM3h: 12,
    foulingResistanceMonths: 12, capexPerUnit: 42,
  },
  fine_bubble_disc: {
    id: 'fine_bubble_disc', label: 'Fine-Bubble Disc',
    transferEfficiencyPerM: 0.032, ratedAirflowPerUnitM3h: 6,
    foulingResistanceMonths: 9, capexPerUnit: 58,
  },
  fine_bubble_panel: {
    id: 'fine_bubble_panel', label: 'Fine-Bubble Panel',
    transferEfficiencyPerM: 0.040, ratedAirflowPerUnitM3h: 24,
    foulingResistanceMonths: 7, capexPerUnit: 165,
  },
};

// ── Pumps (Prompt §M) ────────────────────────────────────────────────────────

export interface PumpModel {
  id: string;
  label: string;
  /** BEP flow (m³/h). */
  ratedFlowM3h: number;
  /** Right end of the published curve (m³/h). Beyond it efficiency collapses
   *  and the motor overheats, so continuous operation is impossible there.
   *  Defaults to 125% of rated when omitted. */
  runoutFlowM3h?: number;
  /** Shutoff head H0 (m). */
  shutoffHeadM: number;
  /** Curve coefficient: Hpump(Q) = shutoffHeadM - k*Q² with Q in m³/h. */
  curveKM2perM3h2: number;
  pumpEfficiency: number;
  motorEfficiency: number;
  npshRequiredM: number;
  minSpeedFraction: number;
  hasVFD: boolean;
  capex: number;
  annualMaintenanceCost: number;
  mtbfHours: number;
  handlesSolids: boolean; // sewage pumps pass rags; clear-liquid pumps don't
}

export const PUMP_MODELS: Record<string, PumpModel> = {
  sewage_wedge_400: {
    id: 'sewage_wedge_400', label: 'Sewage Pump 400 m³/h',
    ratedFlowM3h: 400, shutoffHeadM: 22, curveKM2perM3h2: 9.5e-6,
    pumpEfficiency: 0.74, motorEfficiency: 0.92, npshRequiredM: 5,
    minSpeedFraction: 0.65, hasVFD: false, handlesSolids: true,
    capex: 18500, annualMaintenanceCost: 1300, mtbfHours: 30000,
  },
  sewage_vfd_700: {
    id: 'sewage_vfd_700', label: 'Sewage Pump 700 m³/h VFD',
    ratedFlowM3h: 700, shutoffHeadM: 26, curveKM2perM3h2: 6.8e-6,
    pumpEfficiency: 0.79, motorEfficiency: 0.94, npshRequiredM: 6,
    minSpeedFraction: 0.45, hasVFD: true, handlesSolids: true,
    capex: 34000, annualMaintenanceCost: 2100, mtbfHours: 38000,
  },
  ras_screw_250: {
    id: 'ras_screw_250', label: 'RAS Return Pump 250 m³/h',
    ratedFlowM3h: 250, shutoffHeadM: 9, curveKM2perM3h2: 3.2e-6,
    pumpEfficiency: 0.72, motorEfficiency: 0.91, npshRequiredM: 4,
    minSpeedFraction: 0.6, hasVFD: false, handlesSolids: true,
    capex: 12500, annualMaintenanceCost: 900, mtbfHours: 32000,
  },
};

// ── Membrane modules (Prompts §Q/R — foundation for the MBR migration) ──────

export interface MembraneMaterialSpec {
  id: string;
  label: string;
  permeabilityLMHbar: number;
  chlorineToleranceppm: number;
  abrasionResistance: number; // 0..1
  maxTmpkPa: number;
  foulingCoefficient: number; // higher fouls faster
  capexPerM2: number;
  expectedLifetimeYr: number;
}

export const MEMBRANE_MATERIALS: Record<string, MembraneMaterialSpec> = {
  pvdf_hollowfiber: {
    id: 'pvdf_hollowfiber', label: 'PVDF Hollow-Fiber',
    permeabilityLMHbar: 120, chlorineToleranceppm: 5000, abrasionResistance: 0.85,
    maxTmpkPa: 60, foulingCoefficient: 1.0, capexPerM2: 95, expectedLifetimeYr: 8,
  },
  pes_hollowfiber: {
    id: 'pes_hollowfiber', label: 'PES Hollow-Fiber',
    permeabilityLMHbar: 180, chlorineToleranceppm: 200, abrasionResistance: 0.6,
    maxTmpkPa: 50, foulingCoefficient: 1.15, capexPerM2: 78, expectedLifetimeYr: 6,
  },
  ceramic_flat: {
    id: 'ceramic_flat', label: 'Ceramic Flat-Sheet',
    permeabilityLMHbar: 45, chlorineToleranceppm: 20000, abrasionResistance: 0.98,
    maxTmpkPa: 120, foulingCoefficient: 0.7, capexPerM2: 420, expectedLifetimeYr: 20,
  },
};

// ── Redundancy configurations (Prompt §O) ────────────────────────────────────

export interface RedundancyConfig {
  id: string;
  label: string;
  unitCount: number;
  /** Fraction of total installed capacity available with one unit down. */
  capacityWithOneDown: number;
  costFactor: number; // vs single unit of same total capacity
}

export const REDUNDANCY_CONFIGS: Record<string, RedundancyConfig> = {
  single_100: { id: 'single_100', label: '1 × 100%', unitCount: 1, capacityWithOneDown: 0, costFactor: 1.0 },
  duty_standby: { id: 'duty_standby', label: '2 × 100% (duty + standby)', unitCount: 2, capacityWithOneDown: 1.0, costFactor: 1.9 },
  three_50: { id: 'three_50', label: '3 × 50% (2 duty + 1 standby)', unitCount: 3, capacityWithOneDown: 1.0, costFactor: 2.4 },
  two_duty: { id: 'two_duty', label: '2 × 50% (no standby)', unitCount: 2, capacityWithOneDown: 0.5, costFactor: 1.6 },
};

/** Installed blower bank derived from model + redundancy selection. */
export function installedBlowerCapacity(blowerModelId: string, redundancyId: string): {
  unitCount: number;
  perUnitRatedAirflowM3h: number;
  totalRatedAirflowM3h: number;
  availableAirflowWithOneDownM3h: number;
  capex: number;
  annualMaintenanceCost: number;
} | null {
  const model = BLOWER_MODELS[blowerModelId];
  const red = REDUNDANCY_CONFIGS[redundancyId];
  if (!model || !red) return null;
  const capex = Math.round(model.capex * red.costFactor);
  return {
    unitCount: red.unitCount,
    perUnitRatedAirflowM3h: model.ratedAirflowM3h,
    totalRatedAirflowM3h: model.ratedAirflowM3h * red.unitCount,
    availableAirflowWithOneDownM3h: model.ratedAirflowM3h * red.capacityWithOneDown,
    capex,
    annualMaintenanceCost: model.annualMaintenanceCost * red.unitCount,
  };
}

/** Total installed diffuser oxygen-transfer efficiency at a given submergence. */
export function diffuserTransferEfficiency(
  diffuserModelId: string,
  waterDepthM: number,
  foulingFactor: number // 1 = clean, →0.7 = fouled
): number {
  const d = DIFFUSER_MODELS[diffuserModelId];
  if (!d) return 0.02;
  return Math.min(0.12, d.transferEfficiencyPerM * waterDepthM * foulingFactor);
}
