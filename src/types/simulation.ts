export interface WaterQuality {
  flowRate: number;      // m3/day
  bod: number;           // mg/L (Biochemical Oxygen Demand 5-day)
  cod: number;           // mg/L (Chemical Oxygen Demand)
  tss: number;           // mg/L (Total Suspended Solids)
  tn: number;            // mg/L (Total Nitrogen = NH4 + NO3 + Organic N)
  nh4: number;           // mg/L (Ammonia Nitrogen)
  no3: number;           // mg/L (Nitrate Nitrogen)
  tp: number;            // mg/L (Total Phosphorus)
  pathogens: number;     // CFU/100mL (E. coli / Coliforms)
  do: number;            // mg/L (Dissolved Oxygen)
  ph: number;            // pH units (6.0 - 9.0)
  temp: number;          // °C
  toxicIndex: number;    // 0 - 100 (Heavy metals, industrial toxics)
  turbidity: number;     // NTU
}

export type UnitCategory = 
  | 'preliminary'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'sludge'
  | 'hydraulics'
  | 'decoration';

export type UnitTypeId =
  // Preliminary
  | 'bar_screen'
  | 'grit_chamber'
  | 'equalization_basin'
  // Primary
  | 'primary_clarifier_circular'
  | 'primary_clarifier_rect'
  | 'daf_unit'
  // Secondary
  | 'activated_sludge_cas'
  | 'a2o_bardenpho'
  | 'mbbr_reactor'
  | 'mbr_membrane'
  | 'secondary_clarifier'
  | 'trickling_filter'
  | 'sbr_reactor'
  // Tertiary
  | 'sand_filter'
  | 'chemical_phosphorus'
  | 'uv_disinfection'
  | 'chlorination_basin'
  | 'reverse_osmosis'
  | 'advanced_oxidation_aop'
  // Sludge
  | 'sludge_thickener'
  | 'anaerobic_digester'
  | 'sludge_dewatering_press'
  | 'solar_drying_bed'
  // Hydraulics / Utility
  | 'pump_station'
  | 'pipe_junction'
  | 'effluent_outfall'
  | 'influent_inlet';

export interface UnitPort {
  id: string;
  name: string;
  type: 'inlet' | 'outlet' | 'sludge_outlet' | 'ras_inlet' | 'gas_outlet' | 'recycle_outlet';
  relativePosition: [number, number, number]; // [x, y, z] offset in grid tiles
}

export interface UnitDefinition {
  id: UnitTypeId;
  name: string;
  category: UnitCategory;
  description: string;
  engineeringInfo: string;
  footprint: [number, number]; // [width, length] in grid tiles (e.g. [2, 2])
  capex: number;               // $ construction cost
  baseOpexPerDay: number;      // $ base operational cost/day
  powerConsumptionKw: number;  // kW power demand
  minHRT_hours: number;        // Nominal Hydraulic Retention Time (hours)
  sludgeYieldRatio?: number;   // kg dry sludge per kg BOD/TSS removed
  biogasYieldRatio?: number;   // m3 biogas per kg COD removed
  unlockedByDefault: boolean;
  requiredTechId?: string;
  ports: UnitPort[];
  defaultParams: Record<string, number>;
  paramDefinitions: {
    key: string;
    label: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    description: string;
  }[];
}

export interface PlacedUnit {
  instanceId: string;
  typeId: UnitTypeId;
  gridX: number;
  gridY: number;
  rotation: 0 | 90 | 180 | 270;
  volume: number; // m3
  customParams: Record<string, number>;
  active: boolean;
  efficiencyRating: number; // 0 - 100%
  // Real-time engineering calculated values
  lastInletQuality: WaterQuality;
  lastOutletQuality: WaterQuality;
  lastSludgeQuality?: WaterQuality;
  lastGasProducedM3Day?: number;
  lastPowerKwActual: number;
  lastOpexActual: number;
  sludgeBlanketHeightPercent?: number;
  dissolvedOxygenActual?: number;
  mlssActual?: number; // mg/L Mixed Liquor Suspended Solids
  sviActual?: number;  // mL/g Sludge Volume Index
}

export interface PipeConnection {
  id: string;
  fromUnitId: string;
  fromPortId: string;
  toUnitId: string;
  toPortId: string;
  pathPoints: [number, number, number][]; // 3D waypoints
  flowRate: number; // m3/day
  quality: WaterQuality;
  pipeType: 'liquid' | 'sludge' | 'ras' | 'gas' | 'chemical';
}

export interface TreatmentStandard {
  maxBod: number;       // mg/L
  maxCod: number;       // mg/L
  maxTss: number;       // mg/L
  maxTn: number;        // mg/L
  maxNh4: number;       // mg/L
  maxTp: number;        // mg/L
  maxPathogens: number; // CFU/100mL
  minDo: number;        // mg/L
  minPh: number;
  maxPh: number;
  maxTurbidity: number; // NTU
}
