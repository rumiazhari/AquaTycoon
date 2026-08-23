import { PlacedUnit, UnitDefinition, UnitTypeId, WaterQuality } from '../types/simulation';
import { cloneWater, emptyWater } from './WaterStream';

export interface ProcessResult {
  effluent: WaterQuality;
  sludge?: WaterQuality;
  gasProducedM3Day?: number;
  powerKw: number;
  opexDay: number;
  efficiency: number;
  sludgeBlanketHeight?: number;
  dissolvedOxygen?: number;
  mlss?: number;
  svi?: number;
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
      { id: 'outlet', name: 'Nitrified Mixed Liquor', type: 'outlet', relativePosition: [2.5, 0.5, 0] },
      { id: 'recycle_outlet', name: 'Internal Nitrate Recycle', type: 'recycle_outlet', relativePosition: [0, 0.5, 1.5] }
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
      { id: 'sludge_outlet', name: 'RAS / WAS Sludge', type: 'sludge_outlet', relativePosition: [0, 0.2, 2] }
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
}

/**
 * Executes high-precision environmental engineering mass-balance calculations
 * for a specific placed unit given its incoming stream and operational parameters.
 *
 * forwardInflow (optional) is the main-line hydraulic throughput entering via
 * 'inlet' ports only — i.e. excluding recycle streams (RAS / internal nitrate).
 * It lets reactors pass stable net throughput instead of compounding recycles.
 */
export function calculateUnitProcess(
  unit: PlacedUnit,
  inlet: WaterQuality,
  forwardInflow?: number,
  env?: EnvironmentFactors
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
  let gasProducedM3Day = 0;
  let powerKw = def.powerConsumptionKw;
  let opexDay = def.baseOpexPerDay;
  let efficiency = 95;
  let sludgeBlanketHeight = 0.2;
  let dissolvedOxygen = eff.do;
  let mlss = 3000;
  let svi = 110;

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
      // Surface Overflow Rate (SOR) = Q / Area
      const area = (def.footprint[0] * 6) * (def.footprint[1] * 6); // rough m2
      const sor = inlet.flowRate / Math.max(10, area); // m/d
      // Metcalf & Eddy empirical primary settling curve: R_tss = t / (a + b*t)
      const hrtHours = (unit.volume || (area * 3.5)) / (inlet.flowRate / 24);
      let tssRemoval = (hrtHours / (0.015 + 0.02 * hrtHours)) / 100;
      tssRemoval = Math.max(0.35, Math.min(0.72, tssRemoval));
      if (sor > 60) tssRemoval *= 0.8; // SOR overload penalty

      const bodRemoval = tssRemoval * 0.55; // particulate BOD settling
      const removedTss = eff.tss * tssRemoval;
      const removedBod = eff.bod * bodRemoval;

      eff.tss -= removedTss;
      eff.bod -= removedBod;
      eff.cod -= removedBod * 1.5;
      eff.turbidity *= (1 - tssRemoval * 0.7);
      eff.tp *= 0.90; // particulate P in settling solids

      // Primary sludge output (mass-conserving: effluent loses the drawn volume)
      const sludgeFlow = Math.max(2, inlet.flowRate * 0.015);
      sludge = {
        ...cloneWater(inlet),
        flowRate: sludgeFlow,
        tss: (removedTss * inlet.flowRate) / sludgeFlow,
        bod: (removedBod * inlet.flowRate) / sludgeFlow
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
      eff.tss *= (1 - fogRemoval);
      eff.turbidity *= 0.4;
      eff.bod *= 0.75;
      eff.cod *= 0.70;

      // Float sludge / scum stream (mass-conserving split)
      const floatFlow = Math.max(1, inlet.flowRate * 0.02);
      sludge = {
        ...cloneWater(inlet),
        flowRate: floatFlow,
        tss: (eff.tss * fogRemoval * inlet.flowRate) / floatFlow,
        bod: inlet.bod * 0.25
      };
      eff.flowRate = Math.max(0, inlet.flowRate - floatFlow);

      efficiency = 92;
      powerKw = 15.0 * pressureFactor;
      break;
    }

    // -----------------------------------------------------
    case 'activated_sludge_cas': {
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

      // Conventional CAS still removes nitrogen: simultaneous denitrification
      // inside the flocs plus N assimilated into waste biomass (~20%).
      const orgN = Math.max(1.0, (inlet.tn - inlet.nh4 - inlet.no3) * 0.25);
      eff.no3 = (eff.no3 + nitrifiedNh4) * 0.50;
      eff.tn = eff.nh4 + eff.no3 + orgN;

      // Biomass assimilation strips ~25% of phosphorus into the waste sludge
      eff.tp *= 0.75;

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
      const irRatio = (p.internalRecyclePercent || 200) / 100;
      const aeroDo = p.aerobicDo || 2.5;
      const carbonDose = p.carbonDosingRateMgL || 0;
      dissolvedOxygen = aeroDo;

      // Superior BOD removal
      eff.bod = Math.max(4, eff.bod * 0.04);
      eff.cod = Math.max(18, eff.cod * 0.08);

      // High Nitrification in Aerobic zone (NH4 -> NO3)
      const nitrifRate = Math.min(0.95, 0.75 + 0.1 * aeroDo);
      const nitrifiedNh4 = eff.nh4 * nitrifRate;
      eff.nh4 -= nitrifiedNh4;

      // High Denitrification in Anoxic zone (NO3 -> N2 gas)
      // Denitrification efficiency driven by Internal Recycle IR and available Carbon
      // BUG FIX: raised ceiling & carbon credit so strict TN < 5 mg/L permits are
      // actually reachable at max internal recycle + methanol dosing.
      const deNitrifPotential = (irRatio / (1 + irRatio)) + (carbonDose / 40) * 0.35;
      const deNitrifEfficiency = Math.min(0.98, deNitrifPotential);
      const nitrateTotal = eff.no3 + nitrifiedNh4;
      eff.no3 = nitrateTotal * (1 - deNitrifEfficiency);
      eff.tn = eff.nh4 + eff.no3 + 1.2; // residual organic N

      // Enhanced Biological Phosphorus Removal (EBPR)
      const pRemoval = Math.min(0.90, 0.75 + (carbonDose > 5 ? 0.12 : 0));
      eff.tp = Math.max(0.3, eff.tp * (1 - pRemoval));

      eff.do = aeroDo;
      opexDay = def.baseOpexPerDay + (carbonDose * inlet.flowRate * 0.001 * 0.6); // Carbon chemical cost
      powerKw = def.powerConsumptionKw * (0.8 + 0.2 * irRatio);
      efficiency = 97;
      break;
    }

    // -----------------------------------------------------
    case 'mbbr_reactor': {
      const fillRatio = (p.carrierFillRatioPercent || 50) / 100;
      // MBBR is highly resilient to toxic shocks
      const toxicResilience = Math.max(0.65, 1 - (inlet.toxicIndex / 100) * 0.35);
      const bodRemoval = Math.min(0.95, 0.88 * (fillRatio / 0.5) * toxicResilience);

      eff.bod *= (1 - bodRemoval);
      eff.cod *= (1 - bodRemoval * 0.85);
      eff.nh4 *= 0.35; // Biofilm nitrification
      eff.no3 += eff.nh4 * 0.6;
      eff.do = 3.0;
      efficiency = 95;
      break;
    }

    // -----------------------------------------------------
    case 'mbr_membrane': {
      // MEMBRANE FOULING (piping consequence): MBR cassettes are engineered
      // for biological mixed liquor from its own bioreactor. Piping raw
      // sludge or screenings straight in blinds the hollow fibers.
      const fouled = inlet.tss > 500 && inlet.tss < 4000 && inlet.bod > 300;
      if (fouled) {
        eff.tss = Math.max(1, eff.tss * 0.3);
        eff.turbidity = Math.min(6, eff.turbidity * 0.5);
        eff.bod = Math.max(8, eff.bod * 0.35);
        eff.cod = Math.max(30, eff.cod * 0.5);
        eff.pathogens = Math.max(0, eff.pathogens * 0.05);
        powerKw = def.powerConsumptionKw * 1.7; // suction strain
        opexDay = def.baseOpexPerDay * 1.8;     // chemical cleans
        efficiency = 58;
      } else {
        // Membrane absolute barrier: TSS = 0, Turbidity < 0.2 NTU, 4-log pathogen rejection!
        eff.tss = Math.max(0, eff.tss * 0.005);
        eff.turbidity = Math.min(0.2, eff.turbidity * 0.02);
        eff.bod = Math.max(2, eff.bod * 0.03);
        eff.cod = Math.max(12, eff.cod * 0.06);
        eff.pathogens = Math.max(0, eff.pathogens * 0.0001); // 4-log kill
        eff.tp *= 0.6; // High particulate P retention
        eff.do = 2.5;
      }

      const wasFlow = Math.max(10, inlet.flowRate * 0.02);
      sludge = {
        ...cloneWater(inlet),
        flowRate: wasFlow,
        tss: 10000 // 10,000 mg/L MBR sludge
      };
      eff.flowRate = Math.max(0, inlet.flowRate - wasFlow); // mass-conserving WAS draw
      if (!fouled) efficiency = 99;
      break;
    }

    // -----------------------------------------------------
    case 'secondary_clarifier': {
      // Gravity biomass separation. SOR uses the NET forward (overflow) flow —
      // the RAS underflow recirculates and does not load the clarifier surface.
      const forward = (forwardInflow !== undefined && forwardInflow > 0.01) ? forwardInflow : inlet.flowRate;
      const sor = forward / 144; // standard 12x12m footprint
      const clarifierTssRemoval = sor < 20 ? 0.96 : sor < 30 ? 0.93 : sor < 40 ? 0.88 : 0.75;

      const removedTss = eff.tss * clarifierTssRemoval;
      eff.tss -= removedTss;
      eff.turbidity = Math.max(1.2, eff.tss * 0.8);
      eff.bod = Math.max(3, eff.bod * (1 - clarifierTssRemoval * 0.28));

      // Particulate-associated pollutants settle out with the solids
      // (particulate COD ≈ 1.45 mg COD per mg VSS, plus flocculated N & P)
      eff.cod = Math.max(10, eff.cod - removedTss * 1.45);
      eff.tn = Math.max(eff.nh4 + eff.no3 * 0.9, eff.tn - removedTss * 0.06);
      eff.tp = Math.max(0.05, eff.tp - removedTss * 0.02);

      // BUG FIX: mass-conserving RAS split. The underflow is bounded by the main-line
      // forward flow, so the recycle loop converges instead of compounding ~4x.
      // Clarified effluent keeps the net throughput; RAS recirculates biomass.
      const rasFrac = (p.rasRecycleRatioPercent || 75) / 100;
      const rasFlow = Math.min(rasFrac * forward, inlet.flowRate * 0.85);
      eff.flowRate = Math.max(0, inlet.flowRate - rasFlow);

      sludge = {
        ...cloneWater(inlet),
        flowRate: rasFlow,
        tss: 6000 // 6,000 mg/L RAS
      };
      sludgeBlanketHeight = (sor > 40) ? 0.75 : 0.3;
      efficiency = Math.round(clarifierTssRemoval * 100);
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
      // scatter germicidal light. Feeding raw/unsettled water into UV makes
      // disinfection collapse. Calibrated so polished feed (TSS<10) still
      // achieves a full ~4-log kill, while raw feed gets almost nothing.
      const uvTransmittance = Math.max(0.04, 1 - (eff.turbidity / 40) - (eff.tss / 45));
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
      const recovery = (p.recoveryPercent || 75) / 100;
      // MEMBRANE SCALING/FOULING (piping consequence): RO spirals require
      // filtered, low-solids feed (SDI < 3). Piping unpolished water in
      // scales the membranes — rejection and recovery collapse.
      const fouled = inlet.tss > 2 || inlet.turbidity > 3;
      if (fouled) {
        const effRecovery = Math.max(0.35, recovery * 0.6);
        eff.flowRate = inlet.flowRate * effRecovery;
        eff.bod = Math.max(3, inlet.bod * 0.35);      // partial rejection only
        eff.cod = Math.max(10, inlet.cod * 0.4);
        eff.tss = Math.max(0.5, inlet.tss * 0.3);
        eff.turbidity = Math.max(1, inlet.turbidity * 0.4);
        eff.tn = Math.max(2, inlet.tn * 0.45);
        eff.nh4 = Math.max(0.8, inlet.nh4 * 0.45);
        eff.no3 = Math.max(1.2, inlet.no3 * 0.45);
        eff.tp = Math.max(0.15, inlet.tp * 0.4);
        eff.pathogens = inlet.pathogens * 0.01;       // only 2-log
        eff.toxicIndex = inlet.toxicIndex * 0.5;
        opexDay = def.baseOpexPerDay * 1.6;           // clean-in-place chemicals
        powerKw = def.powerConsumptionKw * 1.25;      // higher pressure drop
        sludge = {
          ...cloneWater(inlet),
          flowRate: inlet.flowRate * (1 - effRecovery),
          tss: inlet.tss * 3,
          tp: inlet.tp * 2.5
        };
        efficiency = 45;
      } else {
        // High-grade water reuse: 99.5% removal of everything!
        eff.flowRate = inlet.flowRate * recovery;
        eff.bod = 0.2;
        eff.cod = 1.0;
        eff.tss = 0;
        eff.turbidity = 0.05;
        eff.tn = 0.5;
        eff.nh4 = 0.1;
        eff.no3 = 0.4;
        eff.tp = 0.01;
        eff.pathogens = 0;
        eff.toxicIndex = 0;

        // Brine reject stream
        sludge = {
          ...cloneWater(inlet),
          flowRate: inlet.flowRate * (1 - recovery),
          tss: eff.tss * 4,
          tp: eff.tp * 4
        };
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
      // Thickens solids from ~1% to 4% (4x concentration)
      const thickenedFlow = Math.max(2, inlet.flowRate * 0.25);
      sludge = {
        ...cloneWater(inlet),
        flowRate: thickenedFlow,
        tss: inlet.tss * 3.8
      };
      eff.flowRate = inlet.flowRate * 0.75; // Supernatant return
      eff.tss = inlet.tss * 0.1;
      efficiency = 95;
      break;
    }

    // -----------------------------------------------------
    case 'anaerobic_digester': {
      const tempC = p.digesterTempC || 37;
      const srt = p.srtDays || 18;
      // Mesophilic volatile solids destruction
      const tempFactor = (tempC >= 35 && tempC <= 39) ? 1.0 : 0.75;
      const vsDestruction = Math.min(0.58, (0.40 + 0.01 * (srt - 10)) * tempFactor);

      // Biogas generation (m3/day): ~0.38 m3 biogas per kg COD/TSS destroyed
      const solidsDestroyedKg = (inlet.flowRate * (inlet.tss * 0.8) * vsDestruction) / 1000;
      gasProducedM3Day = Math.max(0, solidsDestroyedKg * (def.biogasYieldRatio || 0.38));
      
      // Biogas energy CHP: 1 m3 biogas (~65% CH4) ~ 6.0 kWh thermal / 2.2 kWh electric
      const electricityGeneratedKw = (gasProducedM3Day * 2.2) / 24;
      powerKw = -electricityGeneratedKw; // Negative power demand!

      const digestedSludgeFlow = inlet.flowRate * 0.95;
      sludge = {
        ...cloneWater(inlet),
        flowRate: digestedSludgeFlow,
        tss: inlet.tss * (1 - vsDestruction),
        pathogens: inlet.pathogens * 0.01 // High temperature pathogen destruction (Class B / Class A)
      };
      efficiency = Math.round(vsDestruction * 100);
      break;
    }

    // -----------------------------------------------------
    case 'sludge_dewatering_press': {
      const cakeFlow = Math.max(1, inlet.flowRate * 0.15);
      sludge = {
        ...cloneWater(inlet),
        flowRate: cakeFlow,
        tss: 250000 // 25% dry cake solids
      };
      eff.flowRate = inlet.flowRate * 0.85; // Centrate recycle
      eff.tss = 800; // Centrate contains some residual solids
      eff.nh4 = inlet.nh4 + 150; // Centrate is rich in dewatering ammonia
      efficiency = 96;
      break;
    }

    // -----------------------------------------------------
    case 'solar_drying_bed': {
      sludge = {
        ...cloneWater(inlet),
        flowRate: inlet.flowRate * 0.2,
        tss: 850000, // 85% dry biosolid fertilizer
        pathogens: 0
      };
      efficiency = 98;
      break;
    }

    case 'pump_station': {
      // PUMP CLOGGING (piping consequence): pumps handling unscreened sewage
      // suffer rag jamming & impeller wear — more power, more maintenance.
      if (inlet.tss > 350) {
        powerKw = def.powerConsumptionKw * 1.35;
        opexDay = def.baseOpexPerDay * 2.2;
        efficiency = 70;
      }
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
    case 'influent_inlet':
    case 'pump_station':
    case 'pipe_junction': {
      // Pure hydraulic nodes — no quality transformation
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
    gasProducedM3Day,
    powerKw,
    opexDay,
    efficiency,
    sludgeBlanketHeight,
    dissolvedOxygen,
    mlss,
    svi
  };
}
