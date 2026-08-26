import { TreatmentStandard, WaterQuality } from './simulation';

export type GameMode = 'campaign' | 'sandbox';

export type SimulationSpeed = 0 | 1 | 2 | 5; // 0 = pause

/** Scenario biome driving procedural world generation per stage */
export type LevelBiome =
  | 'coastal'      // L1 Seaside Haven — fishing town, beaches, mild forest
  | 'farmland'     // L2 Hop & Cream District — crop belts, barns, market town
  | 'industrial'   // L3 Synthville — factories, smokestacks, sickly vegetation
  | 'lake_forest'  // L4 Emerald Lake Eco-City — pristine forest, eco skyline
  | 'desert';      // L5 New Oasis — arid dunes, mud-brick village, solar fields

export interface LevelObjective {
  id: string;
  description: string;
  type: 'effluent_standard' | 'power_neutrality' | 'budget_target' | 'zero_spill' | 'treat_volume' | 'construction' | 'engineering';
  targetValue?: number;
  achieved: boolean;
}

export interface CampaignLevel {
  id: number;
  code: string;
  title: string;
  subtitle: string;
  district: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced' | 'Master' | 'Extreme';
  briefing: string;
  backgroundStory: string;
  biome: LevelBiome;
  mapSize: [number, number]; // [width, depth] in grid tiles
  startingBudget: number;
  tariffPerM3: number;       // Revenue earned per m3 treated complying with standards
  bonusReward: number;       // Reward on completing level
  unlockedTechIds: string[];
  influentSpec: WaterQuality;
  standards: TreatmentStandard;
  objectives: LevelObjective[];
  availableUnits: string[];
  weather: 'sunny' | 'rainy' | 'storm' | 'industrial_spike';
}

export interface TechNode {
  id: string;
  title: string;
  category: 'preliminary' | 'biological' | 'tertiary' | 'sludge' | 'automation';
  description: string;
  cost: number; // Research points or $
  unlocked: boolean;
  prerequisites: string[];
  unlocksUnits: string[];
  passiveBonus?: {
    type: 'power_efficiency' | 'chemical_savings' | 'removal_boost' | 'sludge_yield_reduction';
    value: number; // e.g. 0.15 = 15% reduction
    label: string;
  };
}

export interface GameFinancials {
  cash: number;
  dailyRevenue: number;
  dailyOpex: number;
  dailyPowerCost: number;
  dailyChemicalCost: number;
  dailySludgeDisposalCost: number;
  dailyBiogasRevenue: number;
  dailyFines: number;
  /** Municipal overdraft financing cost when cash is negative (USD/day) — tycoon polish iter 39. */
  dailyFinancingCost: number;
  totalTreatedM3: number;
  netDailyProfit: number;
}

export interface PlantOverallStats {
  complianceScore: number;       // 0 - 100%
  overallBodRemoval: number;     // %
  overallCodRemoval: number;     // %
  overallTssRemoval: number;     // %
  overallTnRemoval: number;      // %
  overallTpRemoval: number;      // %
  overallPathogenLogKill: number;// log10 reduction
  totalPowerDemandKw: number;
  /** Total on-site green generation: biogas CHP + solar PV + wind */
  totalGreenGenerationKw: number;
  energySelfSufficiencyPercent: number;
  publicApproval: number;        // 0 - 100%
  activeAlerts: {
    id: string;
    type: 'warning' | 'error' | 'success' | 'info';
    message: string;
    timestamp: number;
  }[];
}
