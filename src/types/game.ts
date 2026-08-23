import { TreatmentStandard, WaterQuality } from './simulation';

export type GameMode = 'campaign' | 'sandbox';

export type SimulationSpeed = 0 | 1 | 2 | 5; // 0 = pause

export interface LevelObjective {
  id: string;
  description: string;
  type: 'effluent_standard' | 'power_neutrality' | 'budget_target' | 'zero_spill' | 'treat_volume';
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
  totalBiogasGenerationKw: number;
  energySelfSufficiencyPercent: number;
  publicApproval: number;        // 0 - 100%
  activeAlerts: {
    id: string;
    type: 'warning' | 'error' | 'success' | 'info';
    message: string;
    timestamp: number;
  }[];
}
