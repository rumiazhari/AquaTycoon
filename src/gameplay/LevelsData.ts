import { CampaignLevel } from '../types/game';
import { createInfluentWater } from '../sim/WaterStream';

export const CAMPAIGN_LEVELS: CampaignLevel[] = [
  // ==========================================
  // LEVEL 1: SEASIDE HAVEN (Coastal Municipal)
  // ==========================================
  {
    id: 1,
    biome: 'coastal',
    code: 'LVL-01',
    title: 'Seaside Haven',
    subtitle: 'Coastal Suburb Domestic Treatment',
    district: 'Emerald Coast Municipality',
    difficulty: 'Beginner',
    briefing: 'Construct a primary and secondary treatment line for a growing coastal town using the engineered design validator reference flow (VALIDATOR_REFERENCE_FLOW_M3D = 3500 m³/day). Prevent beach pollution fines by reducing organic loads (BOD) and suspended solids (TSS) before outfall discharge. Peak-flow design basis ensures templates validate clean at the contracted design flow.',
    backgroundStory: 'Tourism is the lifeblood of Seaside Haven. However, raw discharge into the bay is threatening the blue-flag beach status. The mayor has provided an initial municipal grant to construct your first automated WWTP.',
    mapSize: [40, 30],
    startingBudget: 350000,
    tariffPerM3: 0.45,
    bonusReward: 80000,
    unlockedTechIds: ['tech_basics'],
    influentSpec: createInfluentWater({
      flowRate: 3500,
      bod: 210,
      cod: 420,
      tss: 230,
      tn: 35,
      nh4: 25,
      tp: 5.5,
      pathogens: 5e5,
      toxicIndex: 0
    }),
    standards: {
      maxBod: 25,
      maxCod: 90,
      maxTss: 30,
      maxTn: 25,
      maxNh4: 15,
      maxTp: 4.0,
      maxPathogens: 1000,
      minDo: 4.0,
      minPh: 6.5,
      maxPh: 8.5,
      maxTurbidity: 15
    },
    objectives: [
      { id: 'obj_connect', description: 'Connect Influent Inlet to Outfall via Treatment Units', type: 'zero_spill', achieved: false },
      { id: 'obj_bod', description: 'Reduce Effluent BOD < 25 mg/L', type: 'effluent_standard', targetValue: 25, achieved: false },
      { id: 'obj_tss', description: 'Reduce Effluent TSS < 30 mg/L', type: 'effluent_standard', targetValue: 30, achieved: false },
      { id: 'obj_pathogen', description: 'Disinfect Pathogens < 1,000 CFU/100mL (UV / Chlorination)', type: 'effluent_standard', targetValue: 1000, achieved: false },
      { id: 'obj_profit', description: 'Achieve Positive Daily Operating Cash Flow', type: 'budget_target', achieved: false }
    ],
    availableUnits: [
      'influent_inlet',
      'bar_screen',
      'grit_chamber',
      'primary_clarifier_circular',
      'activated_sludge_cas',
      'secondary_clarifier',
      'uv_disinfection',
      'sludge_thickener',
      'solar_array',
      'pump_station',
      'effluent_outfall'
    ],
    weather: 'sunny'
  },

  // ==========================================
  // LEVEL 2: HOP & CREAM DISTRICT (Food & Brewery)
  // ==========================================
  {
    id: 2,
    biome: 'farmland',
    code: 'LVL-02',
    title: 'Hop & Cream District',
    subtitle: 'High Organic Industrial Brewery & Dairy',
    district: 'Industrial Food Park',
    difficulty: 'Intermediate',
    briefing: 'Manage massive organic shock loads from local craft breweries and dairy processing plants. High COD and FOG require equalization, DAF, and robust biological aeration to prevent sludge bulking.',
    backgroundStory: 'The craft beer and artisanal cheese boom has overwhelmed local sewers. High sugar and whey cause severe oxygen depletion in the river. You must deploy equalizers and DAF to tackle the extreme BOD (1,200 mg/L).',
    mapSize: [48, 36],
    startingBudget: 550000,
    tariffPerM3: 0.75,
    bonusReward: 140000,
    unlockedTechIds: ['tech_basics', 'tech_daf_flotation', 'tech_compact_tanks'],
    influentSpec: createInfluentWater({
      flowRate: 5000,
      bod: 1100,
      cod: 2400,
      tss: 650,
      tn: 55,
      nh4: 35,
      tp: 9.0,
      pathogens: 2e5,
      toxicIndex: 10
    }),
    standards: {
      maxBod: 30,
      maxCod: 140, // two-stage bio + sand polishing achievable
      maxTss: 35,
      maxTn: 20,
      maxNh4: 10,
      maxTp: 3.0,
      maxPathogens: 1000,
      minDo: 4.5,
      minPh: 6.5,
      maxPh: 8.5,
      maxTurbidity: 12
    },
    objectives: [
      { id: 'obj_eq', description: 'Install Equalization Basin to dampen shock loads', type: 'zero_spill', achieved: false },
      { id: 'obj_bod', description: 'Reduce Influent BOD from 1,100 to < 30 mg/L (97% removal)', type: 'effluent_standard', targetValue: 30, achieved: false },
      { id: 'obj_cod', description: 'Reduce Effluent COD < 120 mg/L', type: 'effluent_standard', targetValue: 120, achieved: false },
      { id: 'obj_aeration', description: 'Maintain Aeration DO > 2.0 mg/L without sludge bulking', type: 'effluent_standard', achieved: false }
    ],
    availableUnits: [
      'influent_inlet',
      'bar_screen',
      'grit_chamber',
      'equalization_basin',
      'daf_unit',
      'primary_clarifier_circular',
      'primary_clarifier_rect',
      'activated_sludge_cas',
      'secondary_clarifier',
      'sand_filter',
      'uv_disinfection',
      'chlorination_basin',
      'sludge_thickener',
      'sludge_dewatering_press',
      'pump_station',
      'solar_array',
      'pipe_junction',
      'effluent_outfall'
    ],
    weather: 'rainy'
  },

  // ==========================================
  // LEVEL 3: SYNTHVILLE (Chemical & Textile Park)
  // ==========================================
  {
    id: 3,
    biome: 'industrial',
    code: 'LVL-03',
    title: 'Synthville Petrochem & Dyes',
    subtitle: 'Toxic Synthetic Organics & Heavy Metals',
    district: 'Special Chemical Economic Zone',
    difficulty: 'Advanced',
    briefing: 'Industrial wastewater containing synthetic textile azo dyes, petrochemicals, and heavy toxics. Biological bugs will die unless you use resilient MBBR biofilm, chemical coagulation, and Advanced Oxidation (O3/AOP).',
    backgroundStory: 'Discharges from chemical synthesis plants are turning the river neon purple. Strict new environmental laws threaten to shut down the industrial zone unless you achieve 99% toxic degradation.',
    mapSize: [56, 42],
    startingBudget: 850000,
    tariffPerM3: 1.20,
    bonusReward: 220000,
    unlockedTechIds: ['tech_basics', 'tech_mbbr_biofilm', 'tech_chemical_removal', 'tech_advanced_oxidation'],
    influentSpec: createInfluentWater({
      flowRate: 6500,
      bod: 450,
      cod: 1850,
      tss: 380,
      tn: 75,
      nh4: 60,
      tp: 12.0,
      pathogens: 1e5,
      toxicIndex: 75, // High toxicity!
      turbidity: 280
    }),
    standards: {
      maxBod: 20,
      maxCod: 80,
      maxTss: 20,
      maxTn: 15,
      maxNh4: 5,
      maxTp: 1.0,
      maxPathogens: 200,
      minDo: 5.0,
      minPh: 6.5,
      maxPh: 8.5,
      maxTurbidity: 8
    },
    objectives: [
      { id: 'obj_toxic', description: 'Eliminate Toxic Index to < 5 using MBBR & Advanced Oxidation (O3/AOP)', type: 'effluent_standard', targetValue: 5, achieved: false },
      { id: 'obj_cod', description: 'Degrade Recalcitrant COD < 80 mg/L', type: 'effluent_standard', targetValue: 80, achieved: false },
      { id: 'obj_tp', description: 'Chemical Phosphorus Precipitation TP < 1.0 mg/L', type: 'effluent_standard', targetValue: 1.0, achieved: false },
      { id: 'obj_compliance', description: 'Maintain 90%+ Compliance for 3 consecutive days', type: 'effluent_standard', achieved: false }
    ],
    availableUnits: [
      'influent_inlet',
      'bar_screen',
      'grit_chamber',
      'equalization_basin',
      'primary_clarifier_circular',
      'mbbr_reactor',
      'secondary_clarifier',
      'chemical_phosphorus',
      'advanced_oxidation_aop',
      'uv_disinfection',
      'sludge_thickener',
      'anaerobic_digester',
      'sludge_dewatering_press',
      'pump_station',
      'solar_array',
      'pipe_junction',
      'effluent_outfall'
    ],
    weather: 'industrial_spike'
  },

  // ==========================================
  // LEVEL 4: EMERALD LAKE ECO-CITY (Nutrient & Energy)
  // ==========================================
  {
    id: 4,
    biome: 'lake_forest',
    code: 'LVL-04',
    title: 'Emerald Lake Eco-City',
    subtitle: 'Biological Nutrient Removal & Net-Zero Energy',
    district: 'Protected Watershed Biosphere',
    difficulty: 'Master',
    briefing: 'A pristine lake is experiencing eutrophication and toxic cyanobacteria blooms. Deploy 3-Stage A2O Nutrient Removal (TN < 5 mg/L, TP < 0.2 mg/L) and Anaerobic Digestion with Biogas CHP to achieve 50%+ Energy Self-Sufficiency!',
    backgroundStory: 'The UNESCO-listed Emerald Lake is on the brink of ecological collapse. The city council has mandated state-of-the-art biological nutrient removal (BNR) alongside circular energy recovery from sludge digestion.',
    mapSize: [64, 48],
    startingBudget: 1400000,
    tariffPerM3: 0.95,
    bonusReward: 350000,
    unlockedTechIds: ['tech_basics', 'tech_biological_nutrients', 'tech_granular_filtration', 'tech_anaerobic_digestion', 'tech_solar_drying'],
    influentSpec: createInfluentWater({
      flowRate: 12000,
      bod: 260,
      cod: 520,
      tss: 290,
      tn: 58,
      nh4: 45,
      tp: 7.8,
      pathogens: 1e6,
      toxicIndex: 0
    }),
    standards: {
      maxBod: 10,
      maxCod: 40,
      maxTss: 10,
      maxTn: 5.0, // Strict TN!
      maxNh4: 1.5,
      maxTp: 0.2, // Ultra-low TP!
      maxPathogens: 100,
      minDo: 6.0,
      minPh: 6.8,
      maxPh: 8.2,
      maxTurbidity: 3
    },
    objectives: [
      { id: 'obj_tn', description: 'Biological Nitrification/Denitrification TN < 5.0 mg/L', type: 'effluent_standard', targetValue: 5.0, achieved: false },
      { id: 'obj_tp', description: 'Total Phosphorus TP < 0.2 mg/L (A2O + Chemical polishing)', type: 'effluent_standard', targetValue: 0.2, achieved: false },
      { id: 'obj_energy', description: 'Reach 50%+ Plant Energy Self-Sufficiency via Anaerobic Biogas CHP', type: 'power_neutrality', targetValue: 50, achieved: false },
      { id: 'obj_sand', description: 'Filter Suspended Solids TSS < 10 mg/L with Sand Filters', type: 'effluent_standard', targetValue: 10, achieved: false }
    ],
    availableUnits: [
      'influent_inlet',
      'bar_screen',
      'grit_chamber',
      'equalization_basin',
      'primary_clarifier_circular',
      'primary_clarifier_rect',
      'a2o_bardenpho',
      'secondary_clarifier',
      'sand_filter',
      'chemical_phosphorus',
      'uv_disinfection',
      'sludge_thickener',
      'anaerobic_digester',
      'sludge_dewatering_press',
      'solar_drying_bed',
      'pump_station',
      'solar_array',
      'pipe_junction',
      'effluent_outfall',
      'wind_turbine'
    ],
    weather: 'sunny'
  },

  // ==========================================
  // LEVEL 5: NEW OASIS WATER RECLAMATION (Potable Reuse)
  // ==========================================
  {
    id: 5,
    biome: 'desert',
    code: 'LVL-05',
    title: 'New Oasis Megapolis',
    subtitle: 'Direct / Indirect Potable Water Reuse (NEWater)',
    district: 'Arid Desert Metropolis',
    difficulty: 'Extreme',
    briefing: 'Water is liquid gold in the arid desert. Transform raw municipal wastewater into ultra-pure drinking grade reclaimed water using Membrane Bioreactors (MBR), Reverse Osmosis (RO), and UV-AOP disinfection.',
    backgroundStory: 'With zero natural freshwater lakes or rivers, New Oasis relies 100% on high-tech water recycling. You must engineer a closed-loop multi-barrier facility producing zero-turbidity water safe for drinking.',
    mapSize: [72, 54],
    startingBudget: 2800000,
    tariffPerM3: 2.50, // High value reclaimed water!
    bonusReward: 600000,
    unlockedTechIds: ['tech_basics', 'tech_membrane_mbr', 'tech_reverse_osmosis', 'tech_advanced_oxidation', 'tech_anaerobic_digestion', 'tech_dewatering'],
    influentSpec: createInfluentWater({
      flowRate: 18000,
      bod: 280,
      cod: 600,
      tss: 310,
      tn: 50,
      nh4: 38,
      tp: 6.5,
      pathogens: 2e6,
      toxicIndex: 5
    }),
    standards: {
      maxBod: 1.0,  // Drinking grade
      maxCod: 5.0,
      maxTss: 0.1,  // Zero solids
      maxTn: 2.0,
      maxNh4: 0.5,
      maxTp: 0.05,
      maxPathogens: 0, // 0 CFU Pathogen absolute barrier
      minDo: 5.5, // reclaimed-water oxygenation (potable reuse)
      minPh: 7.0,
      maxPh: 8.0,
      maxTurbidity: 0.2 // Crystal clear
    },
    objectives: [
      { id: 'obj_mbr', description: 'Deploy MBR Membrane Bioreactor for zero TSS effluent', type: 'effluent_standard', targetValue: 0.1, achieved: false },
      { id: 'obj_ro', description: 'Produce Ultra-Pure Permeate with Reverse Osmosis (RO)', type: 'effluent_standard', targetValue: 1.0, achieved: false },
      { id: 'obj_pathogen_zero', description: 'Achieve 0 CFU/100mL Pathogen Inactivation via UV-AOP Multi-Barrier', type: 'effluent_standard', targetValue: 0, achieved: false },
      { id: 'obj_volume', description: 'Reclaim and sell >10,000 m³/day of high-value purified water', type: 'treat_volume', targetValue: 10000, achieved: false }
    ],
    availableUnits: [
      'influent_inlet',
      'bar_screen',
      'grit_chamber',
      'equalization_basin',
      'primary_clarifier_circular',
      'mbr_membrane',
      'mbbr_reactor',
      'sand_filter',
      'chemical_phosphorus',
      'reverse_osmosis',
      'advanced_oxidation_aop',
      'uv_disinfection',
      'sludge_thickener',
      'anaerobic_digester',
      'sludge_dewatering_press',
      'solar_drying_bed',
      'pump_station',
      'solar_array',
      'pipe_junction',
      'effluent_outfall',
      'wind_turbine'
    ],
    weather: 'sunny'
  }
];
