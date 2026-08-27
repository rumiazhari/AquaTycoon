import { CampaignLevel, GameFinancials, PlantOverallStats, SimulationSpeed, TechNode } from '../types/game';
import { PipeConnection, PlacedUnit, UnitTypeId, WaterQuality } from '../types/simulation';
import { CAMPAIGN_LEVELS } from './LevelsData';
import { TECH_TREE_NODES } from './TechTreeData';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { emptyWater } from '../sim/WaterStream';
import { SimulationEngine } from '../sim/SimulationEngine';
import { analyzeActiveLiquidPath, hasActiveProcessTypeOnPath } from './PlantTopology';
import { TUTORIAL_STEPS } from './TutorialSteps';
import { REAL_SECONDS_PER_GAME_DAY, INITIAL_GAME_TIME_DAYS, getDayNightFactor } from './GameTime';
import { applyDiurnalInfluent, DIURNAL_DEFAULT_STRENGTH } from '../sim/InfluentProfile';
import { resolveFootprint } from '../sim/UnitDimensions';
import { isEngineerable, workingVolumeM3 } from '../design/Geometry';
import { casDesignPoint } from "../sim/processes/ActivatedSludge";
import { blueprintFromTemplate, CommissioningState } from '../design/UnitBlueprint';
import { estimatePipeCAPEX, estimateSeedSludgeCAPEX } from '../design/CostEstimator';
import { FRESH_MBR_FOULING, membraneCipCostUsd, performMembraneClean, membraneReplacementCostUsd } from '../sim/processes/MBR';
import { pathLengthM } from '../sim/hydraulics/PipeHydraulics';
import {
  CustomBasin,
  BASIN_DEFAULT_DEPTH_M,
  BASIN_MIN_DEPTH_M,
  BASIN_MAX_DEPTH_M,
  estimateBasinCAPEX,
  validateBasinPlacement,
  validateBasinEdit,
} from '../design/CustomBasin';
import {
  ProcessEquipmentItem,
  EQUIPMENT_TYPES,
  estimateEquipmentCAPEX,
  validateEquipmentPlacement,
} from '../design/ProcessEquipment';
import {
  UtilityConnection,
  UtilityConnectionType,
  estimateUtilityCAPEX,
  validateUtilityConnection,
  pointNearUtility,
} from '../design/UtilityConnection';
import {
  poweredEquipmentIds as _poweredIds,
  aeratedDiffuserIds as _aeratedIds,
  constructionStats as _constructionStats,
  ConstructionStats,
} from '../design/ConstructionNetwork';
import { evaluateConstructionEffects } from '../design/ConstructionAdapter';
import { reclaimedWaterBonusPerDay } from '../design/ConstructionAdapter';
import {
  BaffleWall,
  BaffleOrientation,
  BasinZone,
  estimateBaffleCAPEX,
  validateBafflePlacement,
  zonesForBasin as _zonesForBasin,
  allZones as _allZones,
  basinZoneStats as _basinZoneStats,
  BasinZoneStats,
  pointNearBaffle,
} from '../design/BasinZone';
import { evaluatePermitCriteria } from '../sim/PermitEngine';
import {
  seasonalBonusPerDay,
  seasonalLabel,
} from '../design/SeasonalProfile';
import {
  sludgeCircularBonusPerDay,
  sludgeCircularLabel,
} from '../design/SludgeCircular';
import {
  greenDividendBonusPerDay,
  greenDividendLabel,
} from '../design/GreenDividend';
import {
  activeInfluentEventForDay,
  applyInfluentEvent,
} from '../design/InfluentEvents';

/**
 * Municipal overdraft financing — tycoon polish iter 39.
 * When campaign cash goes negative the city charges overdraft interest.
 * 18% APR municipal bridge financing: 0.18/365 ≈ 0.000493 per day.
 * $10k debt ≈ $4.9/day, $25k ≈ $12.3/day, max $50k debt ≈ $24.7/day.
 * Pure domain: overdraftFinancingCostPerDay(cash) is testable headlessly.
 * Sandbox never charges (cash fixed at $9,999,999).
 */
export const OVERDRAFT_ANNUAL_RATE = 0.18;
export const OVERDRAFT_DAILY_RATE = OVERDRAFT_ANNUAL_RATE / 365;
export function overdraftFinancingCostPerDay(cash: number, dailyRate: number = OVERDRAFT_DAILY_RATE): number {
  if (!Number.isFinite(cash) || cash >= 0) return 0;
  return -cash * dailyRate;
}

/**
 * TYCOON TRUST — municipal trust dividend iter 44 (reputation pressure).
 * Sustained permit compliance earns the city's trust: the municipal
 * tariff authority grants a premium on treated water after a compliance
 * streak. Rewards building a *reliable* plant, not a one-tick lucky ratio.
 *
 *   2-day streak → 3.0% tariff bonus
 *   4-day streak → 6.0%
 *   8-day streak → 12%  (cap, 8 × 1.5%)
 *
 * Pure domain: trustBonusPerDay(streak, flow, tariff) is headlessly testable.
 * Flow-gated (>10 m³/d) and tariff-gated, streak floored to whole days.
 * Needs ≥2 full compliant days to start earning; resets to $0 on any
 * violation (complianceScore < 90 or no outfall flow).
 */
export const TRUST_BONUS_RATE_PER_DAY = 0.015;
export const TRUST_BONUS_MAX_RATE = 0.12;
export const TRUST_BONUS_MIN_STREAK_DAYS = 2;
export function trustBonusPerDay(streakDays: number, flowM3d: number, tariffPerM3: number): number {
  if (!Number.isFinite(streakDays) || streakDays < TRUST_BONUS_MIN_STREAK_DAYS) return 0;
  if (!Number.isFinite(flowM3d) || flowM3d <= 10) return 0;
  if (!Number.isFinite(tariffPerM3) || tariffPerM3 <= 0) return 0;
  const wholeDays = Math.floor(streakDays);
  if (wholeDays < TRUST_BONUS_MIN_STREAK_DAYS) return 0;
  const rate = Math.min(TRUST_BONUS_MAX_RATE, wholeDays * TRUST_BONUS_RATE_PER_DAY);
  if (rate <= 0) return 0;
  return flowM3d * tariffPerM3 * rate;
}
export function trustBonusRate(streakDays: number): number {
  if (!Number.isFinite(streakDays) || streakDays < TRUST_BONUS_MIN_STREAK_DAYS) return 0;
  const wholeDays = Math.floor(streakDays);
  if (wholeDays < TRUST_BONUS_MIN_STREAK_DAYS) return 0;
  return Math.min(TRUST_BONUS_MAX_RATE, wholeDays * TRUST_BONUS_RATE_PER_DAY);
}

export interface NextStepSuggestion {
  unitTypeId: UnitTypeId;
  name: string;
  gridX: number;
  gridY: number;
  hint: string;
  category: string;
}

export interface GameState {
  currentLevel: CampaignLevel;
  gameMode: 'campaign' | 'sandbox';
  simSpeed: SimulationSpeed;
  gameTimeDays: number;
  financials: GameFinancials;
  units: PlacedUnit[];
  pipes: PipeConnection[];
  techTree: TechNode[];
  overallStats: PlantOverallStats;
  finalEffluent: WaterQuality;
  selectedUnitId: string | null;
  activeTab: string;
  isLevelComplete: boolean;
  levelVictoryModalOpen: boolean;
  sandboxCustomInfluent: WaterQuality;
  isNight: boolean;
  /** Smooth day/night blend factor in [0,1] (0=night, 1=day) from the game clock. */
  dayNightFactor: number;
  suggestion: NextStepSuggestion | null;
  complianceStreakDays: number;
  tutorialActive: boolean;
  tutorialStep: number;
  /**
   * MISSION §AK Phase-1 item 14: amplitude of the dynamic municipal influent
   * curve in [0,1]. Full municipal swing since iter 15 (§AK items 5/6
   * closed): template trains are verified peak-ready — see src/design/PeakFlow.ts.
   */
  diurnalInfluentStrength: number;
  /**
   * CONSTRUCTION-BUILDER mission (Phase 1): player-drawn rectangular basins.
   * These coexist with legacy predefined units; both systems reject overlap
   * against each other. Equipment/ports arrive in later builder phases.
   */
  customBasins: CustomBasin[];
  /**
   * CONSTRUCTION-BUILDER Phase 2: physical machines the player installs
   * (diffusers/mixers inside drawn basins, pumps/blowers on open ground).
   * Each occupies exactly one tile; ground machines block legacy units and
   * basin drawing symmetrically.
   */
  processEquipment: ProcessEquipmentItem[];
  /**
   * CONSTRUCTION-BUILDER Phase 3: utility connections between hosts
   * (water_pipe / air_pipe / power_cable). Straight tile-to-tile lines
   * rendered atop the site; functional simulation wiring lands in Phase 4.
   */
  utilityConnections: UtilityConnection[];
  /** Selected utility line id for Inspect/Demolish. */
  selectedUtilityId?: string | null;
  /**
   * CONSTRUCTION-BUILDER Phase 5: interior baffle walls that partition
   * each CustomBasin into functional zones (anoxic/aerobic/settling).
   * Zones themselves are DERIVED from basins+baffles (see BasinZone.ts)
   * so only baffles are persisted. Empty = each basin is one zone.
   */
  customBaffles: BaffleWall[];
  /** Selected baffle id for Inspect/Demolish. */
  selectedBaffleId?: string | null;
}

export class GameManager {
  /**
   * Latest final-effluent snapshot, refreshed each tick. The advisor reads it
   * to give objective-aware hints (e.g. "TP still high → add chemical P")
   * without threading the whole GameState through computeNextSuggestion.
   * Starts null so a fresh plant gets construction guidance, not chemistry tips.
   */
  private static lastFinalEffluent: import('../types/simulation').WaterQuality | null = null;

  public static createInitialState(levelIndex: number = 0, isSandbox: boolean = false): GameState {
    // Fresh level → clear any stale advisor chemistry snapshot from a previous
    // session/level so suggestions start from construction guidance, not
    // leftover effluent data.
    GameManager.lastFinalEffluent = null;
    const level = CAMPAIGN_LEVELS[levelIndex] || CAMPAIGN_LEVELS[0];
    const [mapW, mapH] = level.mapSize;
    const midY = Math.floor(mapH / 2) - 1;

    // Initial pre-placed influent inlet (left edge) and effluent outfall (right edge)
    const inletUnit: PlacedUnit = {
      instanceId: 'inlet_0',
      typeId: 'influent_inlet',
      gridX: 2,
      gridY: midY,
      rotation: 0,
      volume: 100,
      customParams: {},
      active: true,
      efficiencyRating: 100,
      lastInletQuality: emptyWater(),
      lastOutletQuality: { ...level.influentSpec },
      lastPowerKwActual: 0,
      lastOpexActual: 0
    };

    const outfallUnit: PlacedUnit = {
      instanceId: 'outfall_0',
      typeId: 'effluent_outfall',
      gridX: mapW - 4,
      gridY: midY,
      rotation: 0,
      volume: 100,
      customParams: {},
      active: true,
      efficiencyRating: 100,
      lastInletQuality: emptyWater(),
      lastOutletQuality: emptyWater(),
      lastPowerKwActual: 0,
      lastOpexActual: 0
    };

    // Tech tree initialization
    const techTree = TECH_TREE_NODES.map(node => ({
      ...node,
      unlocked: isSandbox || level.unlockedTechIds.includes(node.id) || node.unlocked
    }));

    const financials: GameFinancials = {
      cash: isSandbox ? 9999999 : level.startingBudget,
      dailyRevenue: 0,
      dailyOpex: 0,
      dailyPowerCost: 0,
      dailyChemicalCost: 0,
      dailySludgeDisposalCost: 0,
      dailyBiogasRevenue: 0,
      dailyFines: 0,
      dailyFinancingCost: 0,
      dailyReclaimBonus: 0,
      dailyTrustBonus: 0,
      dailySeasonalBonus: 0,
      dailyBiosolidsBonus: 0,
      dailyGreenBonus: 0,
      totalTreatedM3: 0,
      netDailyProfit: 0
    };

    const initialStats: PlantOverallStats = {
      complianceScore: 0,
      overallBodRemoval: 0,
      overallCodRemoval: 0,
      overallTssRemoval: 0,
      overallTnRemoval: 0,
      overallTpRemoval: 0,
      overallPathogenLogKill: 0,
      totalPowerDemandKw: 0,
      totalGreenGenerationKw: 0,
      energySelfSufficiencyPercent: 0,
      publicApproval: 50,
      activeAlerts: []
    };

    const initialUnits = [inletUnit, outfallUnit];
    const initialSuggestion = GameManager.computeNextSuggestion(initialUnits, level);

    return {
      currentLevel: {
        ...level,
        objectives: level.objectives.map(o => ({ ...o, achieved: false }))
      },
      gameMode: isSandbox ? 'sandbox' : 'campaign',
      simSpeed: 1,
      gameTimeDays: INITIAL_GAME_TIME_DAYS,
      financials,
      units: initialUnits,
      pipes: [],
      techTree,
      overallStats: initialStats,
      finalEffluent: emptyWater(),
      selectedUnitId: null,
      activeTab: 'preliminary',
      isLevelComplete: false,
      levelVictoryModalOpen: false,
      sandboxCustomInfluent: { ...level.influentSpec },
      isNight: false,
      dayNightFactor: getDayNightFactor(INITIAL_GAME_TIME_DAYS),
      suggestion: initialSuggestion,
      complianceStreakDays: 0,
      tutorialActive: false,
      tutorialStep: 0,
      diurnalInfluentStrength: DIURNAL_DEFAULT_STRENGTH,
      customBasins: [],
      processEquipment: [],
      utilityConnections: [],
      selectedUtilityId: null,
      customBaffles: [],
      selectedBaffleId: null
    };
  }

  /** Collision/bounds test for a footprint at a given lot */
  private static fitsAt(
    units: PlacedUnit[], x: number, y: number, fw: number, fl: number, mapW: number, mapH: number
  ): boolean {
    if (x < 0 || y < 0 || x + fw > mapW || y + fl > mapH) return false;
    return !units.some(u => {
      const ud = UNIT_DEFINITIONS[u.typeId];
      if (!ud) return false;
      const [uw, ul] = (u.rotation === 90 || u.rotation === 270) ? [ud.footprint[1], ud.footprint[0]] : ud.footprint;
      return x < u.gridX + uw && x + fw > u.gridX && y < u.gridY + ul && y + fl > u.gridY;
    });
  }

  /**
   * Nudges a preferred suggestion position outward (spiral search) until the
   * footprint actually fits — keeps the green ghost box perfectly aligned
   * even when the player placed earlier units somewhere unexpected.
   */
  public static resolveFreeSpot(
    units: PlacedUnit[],
    level: CampaignLevel,
    prefX: number,
    prefY: number,
    fw: number,
    fl: number
  ): { x: number; y: number } {
    const [mapW, mapH] = level.mapSize;
    if (GameManager.fitsAt(units, prefX, prefY, fw, fl, mapW, mapH)) return { x: prefX, y: prefY };
    for (let r = 1; r <= 12; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = prefX + dx;
          const y = prefY + dy;
          if (GameManager.fitsAt(units, x, y, fw, fl, mapW, mapH)) return { x, y };
        }
      }
    }
    return {
      x: Math.min(Math.max(0, prefX), Math.max(0, mapW - fw)),
      y: Math.min(Math.max(0, prefY), Math.max(0, mapH - fl))
    };
  }

  /**
   * Intelligently recommends the next wastewater treatment step for non-engineers
   */
  public static computeNextSuggestion(units: PlacedUnit[], level: CampaignLevel): NextStepSuggestion | null {
    const raw = GameManager.rawNextSuggestion(units, level);
    if (!raw) return null;
    // Align the ghost to a REAL free spot so it never overlaps player-placed units
    const def = UNIT_DEFINITIONS[raw.unitTypeId];
    if (!def) return null;
    const spot = GameManager.resolveFreeSpot(
      units, level,
      Math.min(raw.gridX, level.mapSize[0] - def.footprint[0]),
      Math.min(raw.gridY, level.mapSize[1] - def.footprint[1]),
      def.footprint[0], def.footprint[1]
    );
    return { ...raw, gridX: spot.x, gridY: spot.y };
  }

  private static rawNextSuggestion(units: PlacedUnit[], level: CampaignLevel): NextStepSuggestion | null {
    const hasType = (t: UnitTypeId) => units.some(u => u.typeId === t);
    const inlet = units.find(u => u.typeId === 'influent_inlet');
    const midY = inlet ? inlet.gridY : Math.floor(level.mapSize[1] / 2) - 1;

    // Find the rightmost placed treatment unit (excluding outfall)
    const treatmentUnits = units.filter(u => u.typeId !== 'influent_inlet' && u.typeId !== 'effluent_outfall');
    const lastUnit = treatmentUnits.length > 0
      ? treatmentUnits.reduce((prev, curr) => (curr.gridX > prev.gridX ? curr : prev))
      : inlet;

    const nextX = lastUnit ? lastUnit.gridX + (UNIT_DEFINITIONS[lastUnit.typeId]?.footprint[0] || 2) + 1 : 6;
    const suggest = (
      unitTypeId: UnitTypeId, name: string, hint: string, category: string,
      x: number = nextX, y: number = midY
    ): NextStepSuggestion => ({ unitTypeId, name, gridX: x, gridY: y, hint, category });

    // ── Priority 1-3: LEVEL-SPECIFIC OBJECTIVE-AWARE GUIDANCE ─────────────

    if (level.id === 5) {
      return GameManager.suggestLevel5(units, level, hasType, suggest);
    }
    if (level.id === 4) {
      return GameManager.suggestLevel4(units, level, hasType, suggest);
    }
    if (level.id === 3) {
      return GameManager.suggestLevel3(units, level, hasType, suggest);
    }

    // ── Levels 1 & 2: conventional-train sequencing ──────────────────────

    // Step 1: Preliminary Screen
    if (!hasType('bar_screen')) {
      return suggest('bar_screen', 'Mechanical Bar Screen',
        'Step 1: Place a Bar Screen right after the Inlet to filter out coarse debris & rags.', 'preliminary');
    }

    // Level 2 shock-load control first
    if (level.id === 2 && !hasType('equalization_basin')) {
      return suggest('equalization_basin', 'Equalization Basin',
        'Step 2: Install Equalization Basin to dampen severe brewery organic shock loads.', 'preliminary');
    }

    if (!hasType('grit_chamber')) {
      return suggest('grit_chamber', 'Vortex Grit Chamber',
        'Step 2: Place a Vortex Grit Chamber to separate abrasive sand and heavy grit.', 'preliminary');
    }

    // Step 3: Primary Clarifier / DAF
    if (level.id === 2 && !hasType('daf_unit') && !hasType('primary_clarifier_circular')) {
      return suggest('daf_unit', 'Dissolved Air Flotation (DAF)',
        'Step 3: Deploy DAF to float out fats, oils, and brewery grease (FOG).', 'primary');
    }

    if (!hasType('primary_clarifier_circular') && !hasType('primary_clarifier_rect') && !hasType('daf_unit')) {
      return suggest('primary_clarifier_circular', 'Primary Clarifier',
        'Step 3: Add a Primary Clarifier to settle out 50-60% of suspended solids.', 'primary');
    }

    // Step 4: Biological Secondary Treatment
    const hasBio = hasType('activated_sludge_cas') || hasType('a2o_bardenpho') || hasType('mbbr_reactor') || hasType('mbr_membrane');
    if (!hasBio) {
      const bioType: UnitTypeId = level.id === 4 ? 'a2o_bardenpho' : (level.id === 3 ? 'mbbr_reactor' : (level.id === 5 ? 'mbr_membrane' : 'activated_sludge_cas'));
      const def = UNIT_DEFINITIONS[bioType];
      return suggest(bioType, def.name,
        `Step 4: Build a biological reactor (${def.name}) to digest dissolved organic BOD.`, 'secondary');
    }

    // Step 5: Secondary Clarifier (for CAS/A2O/MBBR)
    if (!hasType('mbr_membrane') && !hasType('secondary_clarifier')) {
      return suggest('secondary_clarifier', 'Secondary Clarifier',
        'Step 5: Install a Secondary Clarifier to separate activated biomass from purified effluent.', 'secondary');
    }

    // Step 6: Tertiary / Disinfection
    if (!hasType('uv_disinfection') && !hasType('chlorination_basin')) {
      return suggest('uv_disinfection', 'UV Disinfection Chamber',
        'Step 6: Install UV Disinfection to destroy pathogens without chemical residues.', 'tertiary');
    }

    // Sludge Handling Suggestion
    if (!hasType('sludge_thickener') && level.availableUnits.includes('sludge_thickener')) {
      return suggest('sludge_thickener', 'Gravity Sludge Thickener',
        'Pro-Tip: Place a Sludge Thickener to process settled solids from clarifiers.',
        'sludge', 6, Math.max(1, midY - 6));
    }

    // Optional renewable energy
    if (!hasType('solar_array') && level.availableUnits.includes('solar_array')) {
      return suggest('solar_array', 'Solar Panel Array',
        'Pro-Tip: Add Solar Panels to offset plant power demand and boost green rating.',
        'power', 8, Math.max(1, midY + 7));
    }

    return null;
  }

  /** Level 3 Synthville: toxic/COD-driven guidance (AOP, chemical P). */
  private static suggestLevel3(
    _units: PlacedUnit[], level: CampaignLevel,
    hasType: (t: UnitTypeId) => boolean,
    suggest: (t: UnitTypeId, n: string, h: string, c: string, x?: number, y?: number) => NextStepSuggestion
  ): NextStepSuggestion | null {
    const eff = GameManager.lastFinalEffluent;
    // Chemistry gaps are evaluated against the level's own objectives; with no
    // effluent yet (or no flow) the objectives are trivially unmet, so the
    // required polishing steps are recommended proactively.
    const hasFlow = !!eff && eff.flowRate > 10;
    const objTarget = (id: string) => level.objectives.find(o => o.id === id)?.targetValue;
    const toxicHigh = !hasFlow || eff.toxicIndex > (objTarget('obj_toxic') ?? 5);
    const codHigh = !hasFlow || eff.cod > (objTarget('obj_cod') ?? 80);
    const tpHigh = !hasFlow || eff.tp > (objTarget('obj_tp') ?? 1.0);

    // Core train first — nothing works without it.
    if (!hasType('bar_screen'))
      return suggest('bar_screen', 'Mechanical Bar Screen', 'Step 1: Screen coarse solids before biological treatment.', 'preliminary');
    if (!hasType('grit_chamber'))
      return suggest('grit_chamber', 'Vortex Grit Chamber', 'Step 2: Remove grit to protect downstream MBBR carriers.', 'preliminary');
    if (!hasType('mbbr_reactor'))
      return suggest('mbbr_reactor', 'MBBR Biofilm Reactor', 'Step 3: MBBR carrier biofilm survives this toxic industrial load where activated sludge would wash out.', 'secondary');
    if (!hasType('secondary_clarifier'))
      return suggest('secondary_clarifier', 'Secondary Clarifier', 'Step 4: Settle biofilm slough before polishing.', 'secondary');

    // Objective-aware chemistry: guide by CURRENT effluent gaps.
    if ((toxicHigh || codHigh) && !hasType('advanced_oxidation_aop'))
      return suggest('advanced_oxidation_aop', 'Advanced Oxidation (O₃/AOP)',
        `Toxic Index ${hasFlow ? eff.toxicIndex.toFixed(1) : '?'} / COD ${hasFlow ? eff.cod.toFixed(0) : '?'} still high — hydroxyl-radical AOP degrades recalcitrant azo dyes & petrochemicals.`, 'tertiary');
    if (tpHigh && !hasType('chemical_phosphorus'))
      return suggest('chemical_phosphorus', 'Chemical Phosphorus Removal',
        `TP ${hasFlow ? eff.tp.toFixed(2) : '?'} mg/L above the ${objTarget('obj_tp') ?? 1.0} target — alum/ferric precipitation strips phosphate chemically.`, 'tertiary');
    if (!hasType('uv_disinfection'))
      return suggest('uv_disinfection', 'UV Disinfection Chamber', 'Step 5: UV destroys pathogens to meet the 200 CFU permit.', 'tertiary');

    // Compliance streak needs sustained performance — suggest monitoring aids.
    if (!hasType('sludge_thickener') && level.availableUnits.includes('sludge_thickener'))
      return suggest('sludge_thickener', 'Gravity Sludge Thickener', 'Pro-Tip: Thicken waste sludge before disposal to cut handling costs.', 'sludge', 6, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));

    return null;
  }

  /** Level 4 Emerald Lake: nutrient removal + energy self-sufficiency chain. */
  private static suggestLevel4(
    _units: PlacedUnit[], level: CampaignLevel,
    hasType: (t: UnitTypeId) => boolean,
    suggest: (t: UnitTypeId, n: string, h: string, c: string, x?: number, y?: number) => NextStepSuggestion
  ): NextStepSuggestion | null {
    const eff = GameManager.lastFinalEffluent;
    const hasFlow = !!eff && eff.flowRate > 10;

    if (!hasType('bar_screen'))
      return suggest('bar_screen', 'Mechanical Bar Screen', 'Step 1: Screening protects the A2O process stream.', 'preliminary');
    if (!hasType('grit_chamber'))
      return suggest('grit_chamber', 'Vortex Grit Chamber', 'Step 2: Grit removal prevents A2O mixer wear.', 'preliminary');
    if (!hasType('a2o_bardenpho'))
      return suggest('a2o_bardenpho', 'A2O Bardenpho Reactor', 'Step 3: Anaerobic-Anoxic-Aerobic zones achieve TN < 5 via nitrification + denitrification.', 'secondary');
    if (!hasType('secondary_clarifier'))
      return suggest('secondary_clarifier', 'Secondary Clarifier', 'Step 4: Clarify mixed liquor; REMEMBER to pipe the RAS return back to the A2O reactor!', 'secondary');

    // The lake permit needs BOTH polishing steps; sand filter first (it also
    // shields the downstream steps), then chemical P if TP is still high.
    const tssHigh = !hasFlow || eff.tss > 10;
    if (tssHigh && !hasType('sand_filter'))
      return suggest('sand_filter', 'Rapid Sand Filter', `TSS ${hasFlow ? eff.tss.toFixed(1) : '?'} mg/L — sand filtration polishes below 10 mg/L for the lake permit.`, 'tertiary');

    const tpHigh = !hasFlow || eff.tp > 0.2;
    if (tpHigh && !hasType('chemical_phosphorus'))
      return suggest('chemical_phosphorus', 'Chemical Phosphorus Polishing',
        `TP ${hasFlow ? eff.tp.toFixed(2) : '?'} mg/L — bio-P alone rarely reaches 0.2; ferric/alum polishing finishes the job.`, 'tertiary');

    if (!hasType('uv_disinfection'))
      return suggest('uv_disinfection', 'UV Disinfection Chamber', 'Step 5: UV inactivates pathogens to protect the UNESCO watershed.', 'tertiary');

    // ── Energy self-sufficiency chain: thickener → digester → CHP ──────────
    const needSludgeChain = !hasType('sludge_thickener') || !hasType('anaerobic_digester');
    if (needSludgeChain) {
      if (!hasType('sludge_thickener'))
        return suggest('sludge_thickener', 'Gravity Sludge Thickener', 'Energy chain ①: thicken WAS/sludge to raise digester loading and biogas yield.', 'sludge', 6, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));
      return suggest('anaerobic_digester', 'Anaerobic Digester', 'Energy chain ②: digest thickened sludge — biogas CHP generates on-site power toward 50% self-sufficiency.', 'sludge', 12, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));
    }

    // Renewables if biogas alone cannot reach the target.
    if (level.availableUnits.includes('wind_turbine') && !hasType('wind_turbine'))
      return suggest('wind_turbine', 'Wind Turbine', 'Still short of 50% self-sufficiency? Wind adds round-the-clock green generation.', 'power', 18, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));
    if (level.availableUnits.includes('solar_array') && !hasType('solar_array'))
      return suggest('solar_array', 'Solar Panel Array', 'Daylight solar generation tops up the energy budget.', 'power', 24, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));

    return null;
  }

  /** Level 5 New Oasis: potable-reuse multi-barrier train. */
  private static suggestLevel5(
    _units: PlacedUnit[], level: CampaignLevel,
    hasType: (t: UnitTypeId) => boolean,
    suggest: (t: UnitTypeId, n: string, h: string, c: string, x?: number, y?: number) => NextStepSuggestion
  ): NextStepSuggestion | null {
    const eff = GameManager.lastFinalEffluent;

    if (!hasType('bar_screen'))
      return suggest('bar_screen', 'Mechanical Bar Screen', 'Step 1: Screening is the first barrier protecting membranes.', 'preliminary');
    if (!hasType('grit_chamber'))
      return suggest('grit_chamber', 'Vortex Grit Chamber', 'Step 2: Grit would abrade MBR pump impellers.', 'preliminary');
    if (!hasType('mbr_membrane'))
      return suggest('mbr_membrane', 'MBR Membrane Bioreactor', 'Step 3: MBR combines biology with an absolute membrane barrier — near-zero TSS feed for RO.', 'secondary');
    if (!hasType('reverse_osmosis'))
      return suggest('reverse_osmosis', 'Reverse Osmosis (RO)', 'Step 4: RO rejects dissolved salts, organics and pathogens for drinking-grade permeate.', 'tertiary');
    if (!hasType('uv_disinfection') && !hasType('advanced_oxidation_aop'))
      return suggest('uv_disinfection', 'UV Disinfection Chamber', 'Step 5: Final UV barrier achieves the 0-CFU potable reuse requirement.', 'tertiary');

    // RO fouling guard: RO feed must be low-turbidity.
    const roFoulingRisk = !eff || eff.tss > 2 || eff.turbidity > 3;
    if (roFoulingRisk && !hasType('sand_filter'))
      return suggest('sand_filter', 'Rapid Sand Filter', 'RO fouling risk — prefiltering sand-polished feed extends membrane life and recovery.', 'tertiary');

    // Throughput objective (>10,000 m³/d): suggest capacity additions.
    const throughputShort = !eff || eff.flowRate < 10000;
    if (!throughputShort) return null;

    // Sludge route keeps MBR running; renewables offset the heavy membrane power.
    if (!hasType('sludge_thickener') && level.availableUnits.includes('sludge_thickener'))
      return suggest('sludge_thickener', 'Gravity Sludge Thickener', 'Handle MBR waste sludge to sustain throughput.', 'sludge', 6, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));
    if (level.availableUnits.includes('solar_array') && !hasType('solar_array'))
      return suggest('solar_array', 'Solar Panel Array', 'Membrane trains are power-hungry — solar offsets grid draw for the desert climate.', 'power', 10, Math.max(1, Math.floor(level.mapSize[1] / 2) - 7));

    return null;
  }

  /**
   * Advances game state by delta time in seconds
   */
  public static tick(state: GameState, deltaSec: number): GameState {
    if (state.simSpeed === 0) return state;

    const speedMultiplier = state.simSpeed;
    const simDeltaDays = (deltaSec * speedMultiplier) / REAL_SECONDS_PER_GAME_DAY;
    const newDays = state.gameTimeDays + simDeltaDays;
    // Day/night derived from the actual simulated clock (smooth blend factor).
    const dayNightFactor = getDayNightFactor(newDays);
    const isNight = dayNightFactor < 0.5;

    // Influent choice
    const activeInfluent = state.gameMode === 'sandbox' ? state.sandboxCustomInfluent : state.currentLevel.influentSpec;

    // Dynamic influent (MISSION §AK Phase-1 item 14): the plant sees a real
    // municipal diurnal curve — night trough ≈04:30, morning peak ≈10:00,
    // evening bump ≈20:00. Amplitude controlled by state.diurnalInfluentStrength
    // (default 1.0 — templates are peak-ready as of §AK items 5/6 closure).
    const dynamicInfluent = applyDiurnalInfluent(activeInfluent, newDays, state.diurnalInfluentStrength ?? 1);

    // TYCOON RANDOM EVENTS iter 48 — storm surge & industrial shock influent spikes.
    // The municipal sewer is not a flat lab beaker: storm infiltration brings a
    // hydraulic surge (diluted but higher mass load) and organic shocks hammer
    // BOD/toxics. Events are deterministic hashes of the integer day (replayable,
    // no Math.random) and gate the influent feeding the solver.
    const influentEvent = activeInfluentEventForDay(newDays);
    const eventInfluent = influentEvent ? applyInfluentEvent(dynamicInfluent, influentEvent) : dynamicInfluent;

    // Environmental factors driving renewable generation.
    // SOLAR uses the SAME smooth day-night factor as the visual sky (Prompt 3.3
    // item 15): sunrise visually matches production beginning, midday = peak,
    // sunset matches the decline, night = zero. WIND meanders on simulated
    // days, never wall-clock time.
    const daylight = getDayNightFactor(newDays);
    const wind = 0.15 + 0.85 * Math.max(0, 0.5 + 0.5 * Math.sin(newDays * 2.9) * Math.sin(newDays * 1.31 + 1.7));

    // Solve process engineering mass-balance
    const simResult = SimulationEngine.stepSimulation(
      state.units,
      state.pipes,
      eventInfluent,
      state.currentLevel.standards,
      state.financials,
      state.currentLevel.tariffPerM3,
      0.15,
      45,
      { daylight, wind, dtDays: simDeltaDays },
      // Unlocked tech ids drive centralized passive bonuses (e.g. CHP +20%)
      new Set(state.techTree.filter(t => t.unlocked).map(t => t.id))
    );

    // ── CONSTRUCTION-BUILDER Phase 4 slice 2 + Phase 5 slice 2: thin adapter
    //    — live construction network (basin volume / aeration / mixer / power)
    //    + zone-aware septic (each baffled zone needs its own powered mixer).
    //    Zero construction = zero effect (100% backward compatible).
    //    Phase 7 slice 4: reagent consumable scales with treated flow (tycoon pressure).
    {
      // Reagent cost is flow-scaled — solve the plant first, then ask what it really costs to treat that flow
      const flowForReagent = simResult.finalEffluent.flowRate;
      const ce = evaluateConstructionEffects(
        state.customBasins ?? [],
        state.processEquipment ?? [],
        state.utilityConnections ?? [],
        state.customBaffles ?? [],
        flowForReagent,
      );
      const hasFlow = simResult.finalEffluent.flowRate > 10;
      let effChanged = false;
      if (hasFlow && (ce.bodMultiplier !== 1 || ce.tnMultiplier !== 1 || ce.tssMultiplier !== 1 || ce.codMultiplier !== 1 || ce.tpMultiplier !== 1 || (ce as any).toxicMultiplier !== 1 || (ce as any).pathogensMultiplier !== 1 || ce.doBoostMgL !== 0)) {
        const eff = simResult.finalEffluent;
        const next = { ...eff } as WaterQuality;
        const cl = (v: number, lo = 0) => Number.isFinite(v) ? Math.max(lo, v) : lo;
        next.bod = cl(eff.bod * ce.bodMultiplier);
        next.cod = cl(eff.cod * ce.codMultiplier);
        next.tss = cl(eff.tss * ce.tssMultiplier);
        next.tn  = cl(eff.tn  * ce.tnMultiplier);
        // NH₄ tracks with TN (nitrogen species share the load)
        next.nh4 = cl(eff.nh4 * ce.tnMultiplier);
        next.no3 = cl(eff.no3 * ce.tnMultiplier);
        // TP: construction precipitates phosphate chemically + via TSS barrier
        // Chemical dosing tpMultiplier stacks with the TSS-derived TP credit.
        next.tp  = cl(eff.tp  * (ce.tssMultiplier * 0.5 + 0.5) * ce.tpMultiplier);
        next.turbidity = cl(eff.turbidity * ce.tssMultiplier);
        next.do = Math.max(0, Math.min(14, cl(eff.do, 0) + ce.doBoostMgL));
        // RO SLICE 2 tertiary polishing — dissolved salts / micropollutants / pathogens
        const toxicMul = (ce as any).toxicMultiplier ?? 1;
        const pathMul  = (ce as any).pathogensMultiplier ?? 1;
        if (toxicMul !== 1) next.toxicIndex = cl(eff.toxicIndex * toxicMul, 0);
        if (pathMul  !== 1) next.pathogens  = cl(eff.pathogens  * pathMul, 0);
        simResult.finalEffluent = next;
        effChanged = true;
      }
      // Power / OPEX: live-powered machines are summed honestly (blower/mixer/pump
      // only count with a power_cable; passive diffuser always live). Phase 7 slice 4
      // adds flow-scaled reagent consumable on top (active dosing pumps only).
      // RO SLICE 3 adds flow-scaled brine haulage (one powered brine_tank handles one skid cheaply, otherwise premium).
      const reagentCost = (ce as any).reagentOpexPerDay ?? 0;
      const brineCost = (ce as any).brineOpexPerDay ?? 0;
      if (ce.extraPowerKw !== 0 || ce.extraOpexPerDay !== 0 || reagentCost !== 0 || brineCost !== 0) {
        const powerCostPerKwh = 0.15;
        const extraPowerCost = ce.extraPowerKw * 24 * powerCostPerKwh;
        // DailyOpex is power + chemicals/opex. Construction static OPEX is treated like
        // unit OPEX (40% chemical, 60% other) — sum = extraPowerCost + extraOpex.
        // Reagent consumable is 100% chemical on top (ferric/alum).
        // Brine disposal is 100% sludge/disposal on top (evapo/haul).
        simResult.financials.dailyPowerCost += extraPowerCost;
        simResult.financials.dailyChemicalCost += ce.extraOpexPerDay * 0.4 + reagentCost;
        simResult.financials.dailySludgeDisposalCost = (simResult.financials.dailySludgeDisposalCost ?? 0) + brineCost;
        simResult.financials.dailyOpex += extraPowerCost + ce.extraOpexPerDay + reagentCost + brineCost;
        simResult.financials.netDailyProfit = simResult.financials.dailyRevenue - simResult.financials.dailyOpex - simResult.financials.dailyFines;
        // Power demand and self-sufficiency
        simResult.overallStats.totalPowerDemandKw += ce.extraPowerKw;
        const gen = simResult.overallStats.totalGreenGenerationKw;
        const dem = simResult.overallStats.totalPowerDemandKw;
        const selfConsumed = Math.min(gen, dem);
        simResult.overallStats.energySelfSufficiencyPercent = dem > 0 ? Math.min(100, (selfConsumed / dem) * 100) : (gen > 0 ? 100 : 0);
        simResult.overallStats.publicApproval = Math.max(10, Math.min(100, simResult.overallStats.complianceScore + (simResult.overallStats.energySelfSufficiencyPercent > 40 ? 10 : 0)));
      }
      // Re-evaluate permit compliance when the effluent shifted
      if (effChanged) {
        const hasEffFlow = simResult.finalEffluent.flowRate > 10;
        const criteria = evaluatePermitCriteria(simResult.finalEffluent, state.currentLevel.standards);
        const violations: string[] = [];
        let checked = 0;
        if (hasEffFlow) {
          for (const cr of criteria) { checked++; if (!cr.pass) violations.push(cr.engineMessage); }
        } else { violations.push('No treated effluent flow reaching outfall!'); }
        const maxPoints = Math.max(1, checked);
        const complianceScore = hasEffFlow ? Math.max(0, Math.round(((maxPoints - violations.length) / maxPoints) * 100)) : 0;
        simResult.overallStats.complianceScore = complianceScore;
        simResult.overallStats.publicApproval = Math.max(10, Math.min(100, complianceScore + (simResult.overallStats.energySelfSufficiencyPercent > 40 ? 10 : 0)));
        // Replace error alerts with fresh construction-aware ones, keep green-energy alert
        const keepSuccess = simResult.overallStats.activeAlerts.filter(a => a.type === 'success');
        const nextAlerts: typeof simResult.overallStats.activeAlerts = [...keepSuccess];
        if (violations.length > 0 && hasEffFlow) {
          nextAlerts.unshift({ id: 'viol_alert', type: 'error', message: `Regulatory Standard Exceeded: ${violations.join(', ')}`, timestamp: Date.now() });
        }
        // Septic warning when adapter flags dead zones (zone-aware when baffled)
        if ((ce.septicZones > 0 || ce.septicBasins > 0) && hasEffFlow) {
          const zoneScoped = (state.customBaffles?.length ?? 0) > 0 && ce.totalZones !== (state.customBasins?.length ?? 0);
          const n = zoneScoped ? ce.septicZones : ce.septicBasins;
          const label = zoneScoped ? `zone${n>1?'s':''}` : `basin${n>1?'s':''}`;
          nextAlerts.push({ id: 'construction_septic', type: 'warning' as const, message: `Septic dead zone: ${n} ${label} without a powered mixer — add a mixer + power cable to prevent anaerobic decay.`, timestamp: Date.now() });
        }
        if (simResult.overallStats.energySelfSufficiencyPercent > 50 && !nextAlerts.some(a => a.id === 'green_energy_alert')) {
          // Preserve existing logic already pushed green alert earlier if applicable; re-add if needed
          const hasGreen = keepSuccess.some(a => a.id === 'green_energy_alert');
          if (!hasGreen && simResult.overallStats.energySelfSufficiencyPercent > 50) {
            nextAlerts.push({ id: 'green_energy_alert', type: 'success', message: `High Green Energy: Plant is ${simResult.overallStats.energySelfSufficiencyPercent.toFixed(0)}% self-sufficient!`, timestamp: Date.now() });
          }
        }
        simResult.overallStats.activeAlerts = nextAlerts;
      } else if ((ce.septicZones > 0 || ce.septicBasins > 0) && simResult.finalEffluent.flowRate > 10) {
        // Even without effluent shift, surface the warning (zone-aware)
        if (!simResult.overallStats.activeAlerts.some(a => a.id === 'construction_septic')) {
          const zoneScoped = (state.customBaffles?.length ?? 0) > 0 && ce.totalZones !== (state.customBasins?.length ?? 0);
          const n = zoneScoped ? ce.septicZones : ce.septicBasins;
          const label = zoneScoped ? `zone${n>1?'s':''}` : `basin${n>1?'s':''}`;
          simResult.overallStats.activeAlerts = [
            ...simResult.overallStats.activeAlerts,
            { id: 'construction_septic', type: 'warning' as const, message: `Septic dead zone: ${n} ${label} without a powered mixer — add a mixer + power cable to prevent anaerobic decay.`, timestamp: Date.now() },
          ];
        }
      }
      // RO SLICE 3: brine haulage warning when RO is live but insufficient powered brine handling
      {
        const brineUnhandled = (ce as any).unhandledBrineSkids ?? 0;
        const brineHandled = (ce as any).handledBrineSkids ?? 0;
        const brineLive = (ce as any).liveRoSkids ?? 0;
        const hasFlow2 = simResult.finalEffluent.flowRate > 10;
        if (brineUnhandled > 0 && hasFlow2 && brineLive > 0) {
          if (!simResult.overallStats.activeAlerts.some(a => a.id === 'brine_haulage')) {
            simResult.overallStats.activeAlerts.push({
              id: 'brine_haulage',
              type: 'warning' as const,
              message: `Brine haulage: ${brineUnhandled} RO skid${brineUnhandled>1?'s':''} brine hauled off-site at premium ($${((ce as any).brineOpexPerDay ?? 0).toFixed(0)}/d) — add ${brineUnhandled} powered Brine Holding Tank${brineUnhandled>1?'s':''} to close the zero-liquid loop and cut disposal to ~¼ cost.`,
              timestamp: Date.now(),
            });
          }
        } else if ((brineUnhandled === 0 && brineHandled > 0) || !hasFlow2) {
          // Clear stale haulage alert when handling closes the loop or flow stops
          if (simResult.overallStats.activeAlerts.some(a => a.id === 'brine_haulage')) {
            simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'brine_haulage');
          }
        }
      }
      // ── TYCOON DIVIDEND iter 43 — reclaimed water premium (potable reuse) ──────
      // Flow-scaled tariff bonus when RO-polished effluent is reclaimed-grade
      // (TSS/pathogen/turbidity/toxic all pass). Uses the POLISHED effluent
      // (after RO multipliers) so quality gating reflects real potable output.
      {
        const liveRo = (ce as any).liveRoSkids ?? 0;
        const hasFlowB = simResult.finalEffluent.flowRate > 10;
        const hasBasins = (state.customBasins?.length ?? 0) > 0;
        if (liveRo > 0 && hasFlowB && hasBasins) {
          const bonus = reclaimedWaterBonusPerDay(liveRo, simResult.finalEffluent.flowRate, state.currentLevel.tariffPerM3, simResult.finalEffluent as any);
          if (bonus > 0.5) {
            simResult.financials.dailyReclaimBonus = bonus;
            simResult.financials.dailyRevenue += bonus;
            simResult.financials.netDailyProfit += bonus;
            const ratePct = Math.round(Math.min(0.36, liveRo * 0.15) * 100);
            if (!simResult.overallStats.activeAlerts.some(a => a.id === 'reclaim_bonus')) {
              simResult.overallStats.activeAlerts.push({
                id: 'reclaim_bonus',
                type: 'success' as const,
                message: `Potable reuse bonus: +$${bonus.toFixed(0)}/d premium for reclaimed water (${ratePct}% × ${liveRo} RO skid${liveRo>1?'s':''} — TSS/pathogen polishing qualifies) — zero-liquid loop adding value!`,
                timestamp: Date.now(),
              });
            }
          } else {
            simResult.financials.dailyReclaimBonus = 0;
            if (simResult.overallStats.activeAlerts.some(a => a.id === 'reclaim_bonus')) {
              simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'reclaim_bonus');
            }
          }
        } else {
          simResult.financials.dailyReclaimBonus = 0;
          if (simResult.overallStats.activeAlerts.some(a => a.id === 'reclaim_bonus')) {
            simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'reclaim_bonus');
          }
        }
      }
    }

    // ── Tycoon polish iter 39: municipal overdraft financing cost ──────────
    // When campaign cash is negative the city charges 18% APR overdraft
    // interest — a few dollars per day on a small dip, ~$25/day at the
    // -$50k floor. Sandbox never charges; cost is added to dailyFinancingCost
    // and subtracted from net profit (not hidden in OPEX). An alert surfaces
    // the bleed so the player notices before snowballing.
    if (state.gameMode !== 'sandbox' && state.financials.cash < 0) {
      const financingPerDay = overdraftFinancingCostPerDay(state.financials.cash);
      simResult.financials.dailyFinancingCost = (simResult.financials.dailyFinancingCost ?? 0) + financingPerDay;
      simResult.financials.netDailyProfit -= financingPerDay;
      if (financingPerDay > 0.01 && !simResult.overallStats.activeAlerts.some(a => a.id === 'overdraft_financing')) {
        simResult.overallStats.activeAlerts.push({
          id: 'overdraft_financing',
          type: 'warning' as const,
          message: `Overdraft financing: $${financingPerDay.toFixed(1)}/day interest on $${Math.round(-state.financials.cash).toLocaleString()} debt (18% APR) — restore positive cash to stop charges.`,
          timestamp: Date.now(),
        });
      }
    } else {
      simResult.financials.dailyFinancingCost = simResult.financials.dailyFinancingCost ?? 0;
    }

    // ── TYCOON TRUST iter 44 — municipal trust dividend (reputation pressure) ──
    // Sustained permit compliance (≥90 & flow>10) builds municipal trust:
    // +1.5% tariff premium per whole compliant day, cap 12% at 8 days, min 2 days.
    // Compliance streak is the authoritative counter (also drives Level 3 3-day
    // objective). Trust bonus is flow-scaled like reclaim and stacks with it.
    // No construction gate — any reliable plant earns trust, even Level 1.
    const compliantNow = simResult.overallStats.complianceScore >= 90 && simResult.finalEffluent.flowRate > 10;
    const complianceStreakDays = compliantNow ? state.complianceStreakDays + simDeltaDays : 0;
    {
      const flowTrusted = simResult.finalEffluent.flowRate;
      const trustBonus = trustBonusPerDay(complianceStreakDays, flowTrusted, state.currentLevel.tariffPerM3);
      if (trustBonus > 0.5) {
        simResult.financials.dailyTrustBonus = trustBonus;
        simResult.financials.dailyRevenue += trustBonus;
        simResult.financials.netDailyProfit += trustBonus;
        const ratePct = Math.round(trustBonusRate(complianceStreakDays) * 100);
        const streakWhole = Math.floor(complianceStreakDays);
        if (!simResult.overallStats.activeAlerts.some(a => a.id === 'trust_bonus')) {
          simResult.overallStats.activeAlerts.push({
            id: 'trust_bonus',
            type: 'success' as const,
            message: `Municipal trust dividend: +$${trustBonus.toFixed(0)}/d tariff premium (${ratePct}% × ${streakWhole}d streak — sustained compliance) — city trusts your plant!`,
            timestamp: Date.now(),
          });
        }
      } else {
        simResult.financials.dailyTrustBonus = 0;
        if (simResult.overallStats.activeAlerts.some(a => a.id === 'trust_bonus')) {
          simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'trust_bonus');
        }
      }
    }

    // ── TYCOON SEASONAL iter 45 — annual tariff cycle (drought premium) ─────
    // Summer drought scarcity lifts the municipal tariff up to +12%; winter
    // surplus discounts to −12%. Deterministic sinusoid over 365 days,
    // flow-gated (>10 m³/d) and tariff-gated, no construction gate.
    // Stacks with reclaim + trust (all three can be live simultaneously).
    // Negative winter discount reduces revenue/profit and shows as amber
    // seasonal adjustment rather than a failure.
    {
      const flowS = simResult.finalEffluent.flowRate;
      const tariffS = state.currentLevel.tariffPerM3;
      const seasonalBonus = seasonalBonusPerDay(flowS, tariffS, newDays);
      // Always store the raw bonus (positive = summer premium, negative = winter discount)
      simResult.financials.dailySeasonalBonus = seasonalBonus;
      if (flowS > 10 && tariffS > 0) {
        simResult.financials.dailyRevenue += seasonalBonus;
        simResult.financials.netDailyProfit += seasonalBonus;
      }
      const hasMeaningful = Math.abs(seasonalBonus) > 0.5 && flowS > 10 && tariffS > 0;
      if (hasMeaningful) {
        const lbl = seasonalLabel(newDays);
        const isPremium = seasonalBonus > 0;
        const alertId = 'seasonal_bonus';
        const existing = simResult.overallStats.activeAlerts.find(a => a.id === alertId);
        if (!existing) {
          simResult.overallStats.activeAlerts.push({
            id: alertId,
            type: isPremium ? 'success' : 'info',
            message: isPremium
              ? `Summer drought premium: ${lbl.pct} tariff (${lbl.season} — scarcity lifts price to $${seasonalBonus.toFixed(0)}/d at ${flowS.toFixed(0)} m³/d)`
              : `Winter tariff discount: ${lbl.pct} tariff (${lbl.season} — surplus lowers price $${seasonalBonus.toFixed(0)}/d)`,
            timestamp: Date.now(),
          });
        } else {
          // Refresh message if season/pct shifted meaningfully across ticks
          const wantPremium = seasonalBonus > 0;
          const wantType = wantPremium ? 'success' : 'info';
          if (existing.type !== wantType || !existing.message.includes(lbl.pct)) {
            simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.map(a =>
              a.id === alertId ? {
                ...a,
                type: wantType as any,
                message: wantPremium
                  ? `Summer drought premium: ${lbl.pct} tariff (${lbl.season} — scarcity lifts price to $${seasonalBonus.toFixed(0)}/d at ${flowS.toFixed(0)} m³/d)`
                  : `Winter tariff discount: ${lbl.pct} tariff (${lbl.season} — surplus lowers price $${seasonalBonus.toFixed(0)}/d)`,
              } : a
            );
          }
        }
      } else {
        if (simResult.overallStats.activeAlerts.some(a => a.id === 'seasonal_bonus')) {
          simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'seasonal_bonus');
        }
        // Ensure stored bonus is zeroed when no flow (so HUD doesn't show ghost pill)
        if (flowS <= 10) simResult.financials.dailySeasonalBonus = 0;
      }
    }

    // ── TYCOON SLUDGE CIRCULAR iter 46 — biosolids fertilizer offtake ────────
    // Flow-gated circular dividend: thickener alone earns fertilizer sales,
    // thickener+digester earns more (biogas residue), full loop thickener+
    // digester+dewatering earns the maximum. Tariff-independent (commodity).
    // Stacks with reclaim/trust/seasonal. No construction is NOT a failure —
    // absence simply gives 0 bonus and no alert.
    {
      const flowB = simResult.finalEffluent.flowRate;
      const hasThickener = simResult.updatedUnits.some(u => u.typeId === 'sludge_thickener');
      const hasDigester = simResult.updatedUnits.some(u => u.typeId === 'anaerobic_digester');
      const hasDewatering = simResult.updatedUnits.some(u => u.typeId === 'sludge_dewatering_press' || u.typeId === 'solar_drying_bed');
      const bonus = sludgeCircularBonusPerDay(flowB, hasThickener, hasDigester, hasDewatering);
      if (bonus > 0.5 && flowB > 10) {
        simResult.financials.dailyBiosolidsBonus = bonus;
        simResult.financials.dailyRevenue += bonus;
        simResult.financials.netDailyProfit += bonus;
        const label = sludgeCircularLabel(hasThickener, hasDigester, hasDewatering);
        if (!simResult.overallStats.activeAlerts.some(a => a.id === 'biosolids_bonus')) {
          simResult.overallStats.activeAlerts.push({
            id: 'biosolids_bonus',
            type: 'success' as const,
            message: `Biosolids circular: +$${bonus.toFixed(0)}/d fertilizer offtake (${label} — closed sludge loop adds value!)`,
            timestamp: Date.now(),
          });
        }
      } else {
        simResult.financials.dailyBiosolidsBonus = 0;
        if (simResult.overallStats.activeAlerts.some(a => a.id === 'biosolids_bonus')) {
          simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'biosolids_bonus');
        }
      }
    }

    // ── TYCOON GREEN DIVIDEND iter 47 — energy independence subsidy ──────────
    // City pays a tariff premium when the plant is ≥50% self-sufficient
    // (biogas CHP + solar + wind offsetting demand). Flow×tariff×8% gated on
    // selfPct>=50, flow>10, tariff>0. Stacks with all other dividends.
    {
      const flowG = simResult.finalEffluent.flowRate;
      const selfPct = simResult.overallStats.energySelfSufficiencyPercent;
      const tariffG = state.currentLevel.tariffPerM3;
      const bonus = greenDividendBonusPerDay(flowG, tariffG, selfPct);
      if (bonus > 0.5 && flowG > 10) {
        simResult.financials.dailyGreenBonus = bonus;
        simResult.financials.dailyRevenue += bonus;
        simResult.financials.netDailyProfit += bonus;
        const label = greenDividendLabel(selfPct);
        if (!simResult.overallStats.activeAlerts.some(a => a.id === 'green_bonus')) {
          simResult.overallStats.activeAlerts.push({
            id: 'green_bonus',
            type: 'success' as const,
            message: `Green energy dividend: +$${bonus.toFixed(0)}/d subsidy (${label} — ${Math.round(selfPct)}% self-sufficiency offsets grid!)`,
            timestamp: Date.now(),
          });
        }
      } else {
        simResult.financials.dailyGreenBonus = 0;
        if (simResult.overallStats.activeAlerts.some(a => a.id === 'green_bonus')) {
          simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'green_bonus');
        }
      }
    }

    // ── TYCOON RANDOM EVENTS iter 48 — storm surge & industrial shock ─────────
    // Munipical sewer variability: a deterministic hash of the integer day decides
    // whether today's influent is hit by a storm (hydraulic surge, diluted
    // concentrations but higher mass) or an industrial organic shock (high BOD/
    // toxics). The influent was already modified via eventInfluent before the
    // solver; this block surfaces/clears the warning alert so the operator
    // learns to over-size clarifiers and aeration for resilience.
    {
      const hasFlowEv = simResult.finalEffluent.flowRate > 10;
      if (influentEvent && hasFlowEv) {
        if (!simResult.overallStats.activeAlerts.some(a => a.id === 'influent_event')) {
          const isStorm = influentEvent.type === 'storm_surge';
          const dur = influentEvent.type === 'storm_surge' ? '1.4 d' : '1.0 d';
          simResult.overallStats.activeAlerts.push({
            id: 'influent_event',
            type: 'warning' as const,
            message: isStorm
              ? `Storm surge: +${Math.round((influentEvent.flowMul - 1) * 100)}% hydraulic load (${simResult.finalEffluent.flowRate.toFixed(0)} m³/d) — diluted ×${influentEvent.strengthMul.toFixed(2)} but masses surge for ${dur}! Size clarifiers for peaks.`
              : `Industrial shock: BOD/COD ×${influentEvent.strengthMul.toFixed(2)} organics + toxics ×${influentEvent.toxicMul.toFixed(1)} ( ${dur} ) — equalization & aeration stressed; watch permit limits!`,
            timestamp: Date.now(),
          });
        }
      } else {
        if (simResult.overallStats.activeAlerts.some(a => a.id === 'influent_event')) {
          simResult.overallStats.activeAlerts = simResult.overallStats.activeAlerts.filter(a => a.id !== 'influent_event');
        }
      }
    }

    // Apply financial cash flow
    const cashDelta = (simResult.financials.netDailyProfit * simDeltaDays);
    const updatedFinancials: GameFinancials = {
      ...simResult.financials,
      cash: state.gameMode === 'sandbox' ? 9999999 : Math.max(-50000, state.financials.cash + cashDelta)
    };

    // BUG FIX: accumulate treated volume consistently with simulated days (was ~12x too fast)
    updatedFinancials.totalTreatedM3 = state.financials.totalTreatedM3 + (simResult.finalEffluent.flowRate * simDeltaDays);

    // Check Level Objectives — evaluated from CURRENT simulation state every
    // tick. Operational objectives reflect live plant performance (no
    // permanent latching after one lucky tick); construction objectives
    // require the unit to be integrated into the ACTIVE liquid train.
    // Level completion, once legitimately reached, remains permanent.
    const topology = analyzeActiveLiquidPath(simResult.updatedUnits, simResult.updatedPipes);
    const eff = simResult.finalEffluent;
    const hasEffluentFlow = eff.flowRate > 10;

    const updatedObjectives = state.currentLevel.objectives.map(obj => {
      const target = obj.targetValue ?? 0;
      let currentlyMet = false;

      // ── Owner-builder construction contracts — flow-independent (tycoon) ─
      if (obj.id === 'obj_custom_basins') {
        currentlyMet = (state.customBasins?.length ?? 0) >= (target || 1);
      } else if (obj.id === 'obj_custom_baffles') {
        currentlyMet = (state.customBaffles?.length ?? 0) >= (target || 2);
      } else if (obj.id === 'obj_custom_equipment') {
        currentlyMet = (state.processEquipment?.length ?? 0) >= (target || 3);
      } else if (obj.id === 'obj_custom_powered') {
        const powered = _poweredIds(state.processEquipment ?? [], state.utilityConnections ?? []);
        currentlyMet = powered.size >= (target || 2);
      } else if (hasEffluentFlow) {
        switch (obj.id) {
          case 'obj_connect':
            // Real continuous liquid path influent → train → outfall.
            currentlyMet = topology.influentToOutfall;
            break;
          case 'obj_eq':
            // An Equalization Basin that actually receives flow on the train.
            currentlyMet = hasActiveProcessTypeOnPath('equalization_basin', simResult.updatedUnits, simResult.updatedPipes, 1, topology);
            break;
          case 'obj_aeration': {
            // Active connected biological reactor with DO >= target (default 2).
            const doTarget = target || 2.0;
            currentlyMet = simResult.updatedUnits.some(u =>
              topology.activeUnitIds.has(u.instanceId) &&
              (u.typeId === 'activated_sludge_cas' || u.typeId === 'a2o_bardenpho') &&
              (u.dissolvedOxygenActual ?? 0) >= doTarget
            );
            break;
          }
          case 'obj_bod': currentlyMet = eff.bod <= (target || 30); break;
          case 'obj_cod': currentlyMet = eff.cod <= (target || 100); break;
          case 'obj_tss': currentlyMet = eff.tss <= (target || 30); break;
          case 'obj_tn': currentlyMet = eff.tn <= (target || 10); break;
          case 'obj_tp': currentlyMet = eff.tp <= (target || 1); break;
          case 'obj_pathogen': currentlyMet = eff.pathogens <= (target || 1000); break;
          case 'obj_pathogen_zero':
            // Honor targetValue exactly: 0 means the modeled 0-CFU state.
            currentlyMet = eff.pathogens <= Math.max(0, target);
            break;
          case 'obj_toxic': currentlyMet = eff.toxicIndex <= (target || 5); break;
          case 'obj_profit':
            // CURRENT daily operating cash flow must be positive.
            currentlyMet = simResult.financials.netDailyProfit > 0;
            break;
          case 'obj_energy':
            currentlyMet = simResult.overallStats.energySelfSufficiencyPercent >= (target || 50);
            break;
          case 'obj_volume':
            // "Reclaim and sell >X m³/day" → CURRENT throughput, not cumulative.
            currentlyMet = eff.flowRate >= (target || 5000);
            break;
          case 'obj_sand':
            // Sand filter ON THE TRAIN + final TSS at/below target.
            currentlyMet =
              hasActiveProcessTypeOnPath('sand_filter', simResult.updatedUnits, simResult.updatedPipes, 1, topology) &&
              eff.tss <= (target || 10);
            break;
          case 'obj_mbr':
            // MBR integrated, receiving flow, and delivering target TSS.
            currentlyMet =
              hasActiveProcessTypeOnPath('mbr_membrane', simResult.updatedUnits, simResult.updatedPipes, 1, topology) &&
              eff.tss <= (target || 0.1);
            break;
          case 'obj_ro': {
            // RO integrated + receiving flow + its ultra-pure result reaching
            // the outfall (permeate quality ≈ final effluent quality).
            const roActive = hasActiveProcessTypeOnPath('reverse_osmosis', simResult.updatedUnits, simResult.updatedPipes, 1, topology);
            const ultraPure =
              eff.bod <= 1.5 && eff.tss <= 0.5 && eff.toxicIndex <= 2 &&
              eff.pathogens <= Math.max(1, target * 10);
            currentlyMet = roActive && ultraPure && topology.influentToOutfall;
            break;
          }
          case 'obj_pump': {
            // Pump station integrated on the active liquid train AND actually
            // delivering flow at its duty point (real intersection of pump curve
            // with system curve). Accept 'ok' or "oversized" — both mean the
            // pump is running and pushing flow.
            currentlyMet = simResult.updatedUnits.some(u =>
              topology.activeUnitIds.has(u.instanceId) &&
              u.typeId === 'pump_station' &&
              u.pumpRuntime?.status !== 'failed_unit' &&
              (u.pumpRuntime?.dutyFlowM3h ?? 0) > 0
            );
            break;
          }
          case 'obj_cas_sizing': {
            // CAS sized for sufficient HRT at the level's contract design flow.
            const hrtCandidates = simResult.updatedUnits
              .filter(u => topology.activeUnitIds.has(u.instanceId) &&
                (u.typeId === 'activated_sludge_cas' || u.typeId === 'a2o_bardenpho'))
              .map(u => casDesignPoint(u,
                state.currentLevel.influentSpec.bod,
                state.currentLevel.influentSpec.nh4,
                state.currentLevel.influentSpec.flowRate))
              .filter(dp => dp && dp.hrtHoursAtDesignFlow >= target);
            currentlyMet = hrtCandidates.length > 0;
            break;
          }
          case 'obj_eq_sizing': {
            // Equalization Basin sized with sufficient working volume for the
            // level's contract design flow. Check blueprint geometry volume.
            const eqCandidates = simResult.updatedUnits
              .filter(u =>
                topology.activeUnitIds.has(u.instanceId) &&
                u.typeId === 'equalization_basin' &&
                u.blueprint &&
                workingVolumeM3(u.blueprint.design.geometry) >= target
              );
            currentlyMet = eqCandidates.length > 0;
            break;
          }
          case 'obj_compliance':
            // Consecutive-day streak; resets automatically when compliance drops.
            currentlyMet = complianceStreakDays >= (target || 3);
            break;
          default:
            currentlyMet = obj.achieved;
        }
      }

      return { ...obj, achieved: currentlyMet };
    });

    const allObjectivesMet = updatedObjectives.length > 0 && updatedObjectives.every(o => o.achieved);
    const becameComplete = allObjectivesMet && !state.isLevelComplete;

    // BUG FIX: pay the Municipal Grant Bonus exactly once on level completion
    if (becameComplete && state.gameMode !== 'sandbox') {
      updatedFinancials.cash += state.currentLevel.bonusReward;
    }

    const suggestion = GameManager.computeNextSuggestion(simResult.updatedUnits, state.currentLevel);
    GameManager.lastFinalEffluent = simResult.finalEffluent;

    return {
      ...state,
      gameTimeDays: newDays,
      units: simResult.updatedUnits,
      pipes: simResult.updatedPipes,
      financials: updatedFinancials,
      overallStats: simResult.overallStats,
      finalEffluent: simResult.finalEffluent,
      currentLevel: {
        ...state.currentLevel,
        objectives: updatedObjectives
      },
      isLevelComplete: state.isLevelComplete || allObjectivesMet,
      levelVictoryModalOpen: state.levelVictoryModalOpen || becameComplete,
      isNight,
      dayNightFactor,
      suggestion,
      complianceStreakDays
    };
  }

  /**
   * Places a new unit on the plant grid.
   *
   * options.seededWithSludge (backlog #1 follow-up): false places an UNSEEDED
   * CAS reactor at def.capex − estimateSeedSludgeCAPEX(volume) instead of the
   * contractor-seeded default; ignored for families without commissioning.
   */
  public static placeUnit(
    state: GameState,
    typeId: UnitTypeId,
    gridX: number,
    gridY: number,
    rotation: 0 | 90 | 180 | 270 = 0,
    options?: { seededWithSludge?: boolean }
  ): { newState: GameState; success: boolean; reason?: string } {
    const def = UNIT_DEFINITIONS[typeId];
    if (!def) return { newState: state, success: false, reason: 'Invalid unit type' };

    // ── Campaign domain rules (enforced HERE, not just in the UI, so direct
    //    calls cannot bypass availability/technology gating). Sandbox may
    //    intentionally bypass campaign availability/tech restrictions. ──
    if (state.gameMode !== 'sandbox') {
      // A. Level availability
      if (!state.currentLevel.availableUnits.includes(typeId)) {
        return { newState: state, success: false, reason: `${def.name} is not available in this level` };
      }
      // B. Required technology must be unlocked
      if (def.requiredTechId) {
        const tech = state.techTree.find(n => n.id === def.requiredTechId);
        if (!tech || !tech.unlocked) {
          return { newState: state, success: false, reason: `Requires technology: ${tech?.title ?? def.requiredTechId}` };
        }
      }
      // F. Tutorial restrictions: during an active tutorial step that names a
      //    specific unit, only that unit may be placed.
      const tutStep = state.tutorialActive ? TUTORIAL_STEPS[state.tutorialStep] : undefined;
      if (tutStep?.unitTypeId && tutStep.unitTypeId !== typeId) {
        return { newState: state, success: false, reason: `Tutorial step requires placing a different unit first` };
      }
    }

    // Tutorial training grant: the step's required unit is fully funded so
    // following the guided build never drains the player's real budget.
    const tutStep = state.tutorialActive ? TUTORIAL_STEPS[state.tutorialStep] : undefined;
    const tutorialGrant = !!tutStep?.unitTypeId && tutStep.unitTypeId === typeId;

    // Engineerable families start with a blueprint from the template default
    // geometry so the new architecture is live from the first placement; the
    // player refines it afterwards in the Unit Designer (Prompt §C/D).
    // (Hoisted ABOVE the cash gate: the unseeded-placement discount below is
    // derived from the template working volume and must shape affordability.)
    const blueprint = isEngineerable(typeId)
      ? blueprintFromTemplate(typeId) ?? undefined
      : undefined;

    // Backlog #1 follow-up — direct unseeded placement. Only the CAS family
    // consumes commissioning seeding today; for every other family the flag
    // is ignored (full contractor price) so nobody banks a phantom discount
    // on a unit where seeding does nothing.
    const wantSeeded = options?.seededWithSludge !== false;
    const consumesSeed = typeId === 'activated_sludge_cas' && !!blueprint;
    const seedCredit = consumesSeed && !wantSeeded
      ? estimateSeedSludgeCAPEX(workingVolumeM3(blueprint!.design.geometry))
      : 0;
    // Owner-builder skips the bundled haul-in: construction price drops by
    // the seed-sludge share (floored at $0); biomass then ramps naturally.
    const effectiveCapex = Math.max(0, def.capex - seedCredit);

    // C. Cost check
    if (!tutorialGrant && state.gameMode !== 'sandbox' && state.financials.cash < effectiveCapex) {
      return { newState: state, success: false, reason: `Insufficient funds ($${effectiveCapex.toLocaleString()} required)` };
    }

    // Boundary check — engineered units use their real blueprint footprint.
    const tmpForBounds: PlacedUnit = {
      instanceId: '_tmp', typeId, gridX, gridY, rotation,
      volume: def.footprint[0] * def.footprint[1] * 144,
      customParams: {}, active: true, efficiencyRating: 100,
      lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(),
      lastPowerKwActual: 0, lastOpexActual: 0,
    };
    const [w, l] = resolveFootprint(tmpForBounds, rotation);
    const [mapW, mapH] = state.currentLevel.mapSize;
    if (gridX < 0 || gridY < 0 || gridX + w > mapW || gridY + l > mapH) {
      return { newState: state, success: false, reason: 'Out of grid boundary' };
    }

    // Overlap check — uses each unit's resolved footprint (engineered-aware).
    const isOverlapping = state.units.some(u => {
      const [uw, ul] = resolveFootprint(u);
      return (
        gridX < u.gridX + uw &&
        gridX + w > u.gridX &&
        gridY < u.gridY + ul &&
        gridY + l > u.gridY
      );
    });

    if (isOverlapping) {
      return { newState: state, success: false, reason: 'Tile lot already occupied' };
    }

    // CONSTRUCTION-BUILDER Phase 1: a player-drawn basin occupies its tiles —
    // predefined units may not tunnel into it.
    if ((state.customBasins ?? []).some(b =>
      gridX < b.x + b.w && gridX + w > b.x &&
      gridY < b.y + b.h && gridY + l > b.y
    )) {
      return { newState: state, success: false, reason: 'Tile lot already occupied by a constructed basin' };
    }

    // Phase 2: ground-installed equipment claims its tile — legacy units may
    // not drop a lot on top of a pump or blower skid.
    const groundEquipBlocked = (state.processEquipment ?? []).some(e => {
      const def = EQUIPMENT_TYPES[e.typeId];
      return def?.mounting === 'ground' &&
        gridX < e.x + 1 && gridX + w > e.x &&
        gridY < e.y + 1 && gridY + l > e.y;
    });
    if (groundEquipBlocked) {
      return { newState: state, success: false, reason: 'Tile lot already occupied by installed equipment' };
    }

    const newUnit: PlacedUnit = {
      instanceId: `unit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      typeId,
      gridX,
      gridY,
      rotation,
      volume: blueprint
        ? workingVolumeM3(blueprint.design.geometry)
        : (w * 6) * (l * 6) * 4.0, // m3 nominal
      // Contractor hands over a SEEDED, commissioned reactor (seed sludge
      // trucked in at startup — standard practice), so engineered units
      // perform near-design from the first flow instead of taking the
      // multi-week unseeded culture-growth ramp. Only CAS consumes this
      // today; other engineerable families ignore it.
      commissioning: blueprint
        ? {
            phase: 'empty' as const,
            daysInPhase: 0,
            seededWithSludge: consumesSeed ? wantSeeded : true,
          }
        : undefined,
      customParams: { ...def.defaultParams },
      active: true,
      efficiencyRating: 100,
      lastInletQuality: emptyWater(),
      lastOutletQuality: emptyWater(),
      lastPowerKwActual: def.powerConsumptionKw,
      lastOpexActual: def.baseOpexPerDay,
      ...(blueprint ? { blueprint } : {}),
    };

    const newCash = state.gameMode === 'sandbox'
      ? state.financials.cash
      : (tutorialGrant ? state.financials.cash : state.financials.cash - effectiveCapex);
    const updatedUnits = [...state.units, newUnit];
    const newSuggestion = GameManager.computeNextSuggestion(updatedUnits, state.currentLevel);

    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: newCash },
        units: updatedUnits,
        selectedUnitId: newUnit.instanceId,
        suggestion: newSuggestion
      },
      success: true
    };
  }

  /**
   * CONSTRUCTION-BUILDER Phase 1: places a player-drawn rectangular basin.
   *
   * The domain layer owns ALL validation (bounds, size, depth, overlap vs
   * basins AND legacy unit lots) and the quantity-based cost, exactly like
   * placeUnit — no UI path can bypass the rules. Sandbox skips the cash
   * gate only. Refund on demolition = 50% civil-works salvage.
   */
  public static placeCustomBasin(
    state: GameState,
    rect: { x: number; y: number; w: number; h: number }
  ): { newState: GameState; success: boolean; reason?: string; charged?: number } {
    // Normalize incoming drag corners defensively (UI may pass any corner order).
    const norm = {
      x: Math.min(rect.x, rect.x + rect.w - 1) === rect.x ? rect.x : rect.x,
      y: rect.y,
      w: Math.abs(rect.w),
      h: Math.abs(rect.h),
    };
    const depthM = BASIN_DEFAULT_DEPTH_M;

    // Legacy units AND ground-installed equipment as blocking rects for the
    // candidate footprint (you cannot pour concrete over an installed skid).
    const unitRects = state.units.map(u => {
      const [uw, ul] = resolveFootprint(u);
      return { x: u.gridX, y: u.gridY, w: uw, h: ul };
    });
    for (const e of state.processEquipment ?? []) {
      if (EQUIPMENT_TYPES[e.typeId]?.mounting === 'ground') {
        unitRects.push({ x: e.x, y: e.y, w: 1, h: 1 });
      }
    }
    const v = validateBasinPlacement(
      norm, depthM,
      state.currentLevel.mapSize,
      state.customBasins ?? [],
      unitRects
    );
    if (!v.ok) {
      return { newState: state, success: false, reason: v.reason };
    }

    const capex = estimateBasinCAPEX({ ...norm, depthM });
    if (state.gameMode !== 'sandbox' && state.financials.cash < capex) {
      return {
        newState: state, success: false,
        reason: `Insufficient funds ($${capex.toLocaleString()} required)`
      };
    }

    const basin: CustomBasin = {
      id: `basin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      x: norm.x, y: norm.y, w: norm.w, h: norm.h,
      depthM,
      createdAtDay: state.gameTimeDays,
    };
    const newCash = state.gameMode === 'sandbox'
      ? state.financials.cash
      : state.financials.cash - capex;

    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: newCash },
        customBasins: [...(state.customBasins ?? []), basin],
      },
      success: true,
      charged: state.gameMode === 'sandbox' ? 0 : capex,
    };
  }

  /** Demolition refund rate for custom civil works (concrete is worth less than kit). */
  public static readonly CUSTOM_BASIN_SALVAGE_RATE = 0.5;

  /**
   * CONSTRUCTION-BUILDER Phase 1: demolishes a player-drawn basin with a 50%
   * salvage refund (campaign/sandbox aware). Mounting integrity: a basin that
   * still holds installed equipment cannot be demolished — un-bolt the
   * machines first. Utilities that touch the basin are cascade-removed with
   * their own salvage.
   */
  public static demolishCustomBasin(state: GameState, basinId: string): {
    newState: GameState; success: boolean; refunded?: number; reason?: string;
  } {
    const basin = (state.customBasins ?? []).find(b => b.id === basinId);
    if (!basin) return { newState: state, success: false };

    const occupied = (state.processEquipment ?? []).some(e =>
      e.x >= basin.x && e.x < basin.x + basin.w &&
      e.y >= basin.y && e.y < basin.y + basin.h
    );
    if (occupied) {
      return {
        newState: state, success: false,
        reason: 'Remove the installed equipment inside this basin first',
      };
    }

    const refunded = (state.gameMode !== 'sandbox' && !state.tutorialActive)
      ? Math.round(estimateBasinCAPEX(basin) * GameManager.CUSTOM_BASIN_SALVAGE_RATE)
      : 0;

    // Cascade-remove any utility that has an endpoint inside the basin rect
    const attached = (state.utilityConnections ?? []).filter(c =>
      (c.ax >= basin.x && c.ax < basin.x + basin.w && c.ay >= basin.y && c.ay < basin.y + basin.h) ||
      (c.bx >= basin.x && c.bx < basin.x + basin.w && c.by >= basin.y && c.by < basin.y + basin.h)
    );
    const utilSalvage = (state.gameMode !== 'sandbox' && !state.tutorialActive)
      ? attached.reduce((s, c) => s + Math.round(estimateUtilityCAPEX(c.type, c.ax, c.ay, c.bx, c.by) * GameManager.UTILITY_SALVAGE_RATE), 0)
      : 0;
    const remainingUtils = (state.utilityConnections ?? []).filter(c => !attached.includes(c));

    // Phase 5: also cascade-remove baffles interior to this basin
    const removedBaffles = (state.customBaffles ?? []).filter(b => b.basinId === basinId);
    const baffleSalvage = (state.gameMode !== 'sandbox' && !state.tutorialActive)
      ? removedBaffles.reduce((s, bf) => s + Math.round(estimateBaffleCAPEX(basin, bf.orientation) * GameManager.BAFFLE_SALVAGE_RATE), 0)
      : 0;

    return {
      newState: {
        ...state,
        financials: {
          ...state.financials,
          cash: state.financials.cash + refunded + utilSalvage + baffleSalvage,
        },
        customBasins: (state.customBasins ?? []).filter(b => b.id !== basinId),
        utilityConnections: remainingUtils,
        selectedUtilityId: attached.some(c => c.id === state.selectedUtilityId) ? null : state.selectedUtilityId,
        customBaffles: (state.customBaffles ?? []).filter(b => b.basinId !== basinId),
        selectedBaffleId: removedBaffles.some(b => b.id === state.selectedBaffleId) ? null : state.selectedBaffleId,
      },
      success: true,
      refunded: refunded + utilSalvage + baffleSalvage,
    };
  }

  /** Demolition refund rate for kit equipment (mirrors legacy units' 70%). */
  public static readonly EQUIPMENT_SALVAGE_RATE = 0.7;

  /**
   * CONSTRUCTION-BUILDER Phase 2: installs one machine at a tile.
   * The domain layer owns ALL mounting rules via validateEquipmentPlacement
   * (in_basin types must sit inside a drawn basin; ground types must sit on
   * free open ground). Cash-gated like every other build action — sandbox
   * skips only the cash gate. Catalog price is flat per machine.
   */
  public static placeProcessEquipment(
    state: GameState,
    typeId: string,
    tileX: number,
    tileY: number
  ): { newState: GameState; success: boolean; reason?: string; charged?: number } {
    const def = EQUIPMENT_TYPES[typeId];
    if (!def) return { newState: state, success: false, reason: 'Unknown equipment type' };

    const unitRects = state.units.map(u => {
      const [uw, ul] = resolveFootprint(u);
      return { x: u.gridX, y: u.gridY, w: uw, h: ul };
    });
    const v = validateEquipmentPlacement(
      typeId, tileX, tileY,
      state.currentLevel.mapSize,
      state.customBasins ?? [],
      state.processEquipment ?? [],
      unitRects
    );
    if (!v.ok) {
      return { newState: state, success: false, reason: v.reason };
    }

    const capex = estimateEquipmentCAPEX(typeId);
    if (state.gameMode !== 'sandbox' && state.financials.cash < capex) {
      return {
        newState: state, success: false,
        reason: `Insufficient funds ($${capex.toLocaleString()} required)`,
      };
    }

    const item: ProcessEquipmentItem = {
      id: `equip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      typeId,
      x: tileX,
      y: tileY,
      createdAtDay: state.gameTimeDays,
    };
    const newCash = state.gameMode === 'sandbox'
      ? state.financials.cash
      : state.financials.cash - capex;

    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: newCash },
        processEquipment: [...(state.processEquipment ?? []), item],
      },
      success: true,
      charged: state.gameMode === 'sandbox' ? 0 : capex,
    };
  }

  /** Removes one installed machine and refunds its salvage (70% of CAPEX). Cascade-removes any utility that touched its tile. */
  public static demolishProcessEquipment(state: GameState, itemId: string): {
    newState: GameState; success: boolean; refunded?: number;
  } {
    const item = (state.processEquipment ?? []).find(e => e.id === itemId);
    if (!item) return { newState: state, success: false };

    const refunded = (state.gameMode !== 'sandbox' && !state.tutorialActive)
      ? Math.round(estimateEquipmentCAPEX(item.typeId) * GameManager.EQUIPMENT_SALVAGE_RATE)
      : 0;

    const attached = (state.utilityConnections ?? []).filter(c =>
      (c.ax === item.x && c.ay === item.y) || (c.bx === item.x && c.by === item.y)
    );
    const utilSalvage = (state.gameMode !== 'sandbox' && !state.tutorialActive)
      ? attached.reduce((s, c) => s + Math.round(estimateUtilityCAPEX(c.type, c.ax, c.ay, c.bx, c.by) * GameManager.UTILITY_SALVAGE_RATE), 0)
      : 0;

    return {
      newState: {
        ...state,
        financials: {
          ...state.financials,
          cash: state.financials.cash + refunded + utilSalvage,
        },
        processEquipment: (state.processEquipment ?? []).filter(e => e.id !== itemId),
        utilityConnections: (state.utilityConnections ?? []).filter(c => !attached.includes(c)),
        selectedUtilityId: attached.some(c => c.id === state.selectedUtilityId) ? null : state.selectedUtilityId,
      },
      success: true,
      refunded: refunded + utilSalvage,
    };
  }

  /** The machine standing on a tile, if any (click hit-testing). */
  public static equipmentAtTile(state: GameState, tx: number, ty: number): ProcessEquipmentItem | null {
    return (state.processEquipment ?? []).find(e => e.x === tx && e.y === ty) ?? null;
  }

  /** True when the tile lies inside any custom basin (used by ghost validity + clicks). */
  public static tileInCustomBasin(state: GameState, tx: number, ty: number): boolean {
    return (state.customBasins ?? []).some(b =>
      tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h
    );
  }

  // ── CONSTRUCTION-BUILDER Phase 3: utility connections ────────────────────

  /** Salvage fraction for utilities (trenches/excels less retained than kit). */
  public static readonly UTILITY_SALVAGE_RATE = 0.6;

  /**
   * Installs a utility connection (straight tile-to-tile line) between two
   * host tiles (equipment or basin). Cash-gated like every other builder
   * action; sandbox skips only the cash gate. Cost = length × rate + fixed
   * tie-in (see UtilityConnection.estimateUtilityCAPEX).
   */
  public static placeUtilityConnection(
    state: GameState,
    type: UtilityConnectionType,
    ax: number, ay: number, bx: number, by: number
  ): { newState: GameState; success: boolean; reason?: string; charged?: number } {
    const v = validateUtilityConnection(
      type, ax, ay, bx, by,
      state.currentLevel.mapSize,
      state.customBasins ?? [],
      state.processEquipment ?? [],
      state.utilityConnections ?? []
    );
    if (!v.ok) return { newState: state, success: false, reason: v.reason };
    const capex = estimateUtilityCAPEX(type, ax, ay, bx, by);
    if (state.gameMode !== 'sandbox' && state.financials.cash < capex) {
      return { newState: state, success: false, reason: `Insufficient funds ($${capex.toLocaleString()} required)` };
    }
    const conn: UtilityConnection = {
      id: `util_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type, ax, ay, bx, by,
      createdAtDay: state.gameTimeDays,
    };
    const newCash = state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash - capex;
    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: newCash },
        utilityConnections: [...(state.utilityConnections ?? []), conn],
        selectedUtilityId: conn.id,
      },
      success: true,
      charged: state.gameMode === 'sandbox' ? 0 : capex,
    };
  }

  /** Removes one utility line and refunds its salvage (60%). */
  public static demolishUtilityConnection(state: GameState, connId: string): {
    newState: GameState; success: boolean; refunded?: number;
  } {
    const conn = (state.utilityConnections ?? []).find(c => c.id === connId);
    if (!conn) return { newState: state, success: false };
    const refunded = (state.gameMode !== 'sandbox' && !state.tutorialActive)
      ? Math.round(estimateUtilityCAPEX(conn.type, conn.ax, conn.ay, conn.bx, conn.by) * GameManager.UTILITY_SALVAGE_RATE)
      : 0;
    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: state.financials.cash + refunded },
        utilityConnections: (state.utilityConnections ?? []).filter(c => c.id !== connId),
        selectedUtilityId: state.selectedUtilityId === connId ? null : state.selectedUtilityId,
      },
      success: true,
      refunded,
    };
  }

  /** Hit-test: which utility line is near the tile-center point? */
  public static utilityAtPoint(state: GameState, px: number, pz: number): UtilityConnection | null {
    for (const c of state.utilityConnections ?? []) {
      if (pointNearUtility(px, pz, c, 0.65)) return c;
    }
    return null;
  }

  /** All utilities that touch a given tile (endpoint on that tile). */
  public static utilitiesAtTile(state: GameState, tx: number, ty: number): UtilityConnection[] {
    return (state.utilityConnections ?? []).filter(c =>
      (c.ax === tx && c.ay === ty) || (c.bx === tx && c.by === ty)
    );
  }

  // ── CONSTRUCTION-BUILDER Phase 5: interior baffle walls (zones) ────────────
  /** Salvage for demolished baffles (interior concrete keeps less value). */
  public static readonly BAFFLE_SALVAGE_RATE = 0.6;

  /**
   * Installs one interior baffle wall inside a player-drawn basin, partitioning
   * it into an extra zone. Cash-gated like every builder action; sandbox skips
   * only the cash gate. Cost is wall area × $55 + fixed (see BasinZone).
   */
  public static placeBaffle(
    state: GameState,
    basinId: string,
    orientation: BaffleOrientation,
    offsetTiles: number,
  ): { newState: GameState; success: boolean; reason?: string; charged?: number } {
    const basin = (state.customBasins ?? []).find(b => b.id === basinId);
    const v = validateBafflePlacement(basin, state.customBaffles ?? [], orientation, offsetTiles);
    if (!v.ok) return { newState: state, success: false, reason: v.reason };
    const capex = estimateBaffleCAPEX(basin!, orientation);
    if (state.gameMode !== 'sandbox' && state.financials.cash < capex) {
      return { newState: state, success: false, reason: `Insufficient funds ($${capex.toLocaleString()} required)` };
    }
    const baffle: BaffleWall = {
      id: `baffle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      basinId,
      orientation,
      offsetTiles,
      createdAtDay: state.gameTimeDays,
    };
    const newCash = state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash - capex;
    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: newCash },
        customBaffles: [...(state.customBaffles ?? []), baffle],
        selectedBaffleId: baffle.id,
      },
      success: true,
      charged: state.gameMode === 'sandbox' ? 0 : capex,
    };
  }

  /** Removes one baffle wall and refunds its salvage (60%). Zones re-derive. */
  public static demolishBaffle(state: GameState, baffleId: string): {
    newState: GameState; success: boolean; refunded?: number;
  } {
    const baffle = (state.customBaffles ?? []).find(b => b.id === baffleId);
    if (!baffle) return { newState: state, success: false };
    const basin = (state.customBasins ?? []).find(b => b.id === baffle.basinId);
    const refunded = (state.gameMode !== 'sandbox' && !state.tutorialActive && basin)
      ? Math.round(estimateBaffleCAPEX(basin, baffle.orientation) * GameManager.BAFFLE_SALVAGE_RATE)
      : 0;
    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: state.financials.cash + refunded },
        customBaffles: (state.customBaffles ?? []).filter(b => b.id !== baffleId),
        selectedBaffleId: state.selectedBaffleId === baffleId ? null : state.selectedBaffleId,
      },
      success: true,
      refunded,
    };
  }

  /** All zones derived for a specific basin (empty if basin unknown). */
  public static zonesForBasin(state: GameState, basinId: string): BasinZone[] {
    const basin = (state.customBasins ?? []).find(b => b.id === basinId);
    if (!basin) return [];
    return _zonesForBasin(basin, state.customBaffles ?? []);
  }

  /** All zones across the entire plant. */
  public static allZones(state: GameState): BasinZone[] {
    return _allZones(state.customBasins ?? [], state.customBaffles ?? []);
  }

  /** Zone that contains a given tile (or null). */
  public static zoneAtTile(state: GameState, tx: number, ty: number): BasinZone | null {
    const zones = GameManager.allZones(state);
    return zones.find(z => tx >= z.x && tx < z.x + z.w && ty >= z.y && ty < z.y + z.h) ?? null;
  }

  /** Which baffle is near (px,pz) in world tile-space (for click selection). */
  public static baffleAtPoint(state: GameState, px: number, pz: number): BaffleWall | null {
    for (const bf of state.customBaffles ?? []) {
      const basin = (state.customBasins ?? []).find(b => b.id === bf.basinId);
      if (!basin) continue;
      if (pointNearBaffle(px, pz, bf, basin, 0.55)) return bf;
    }
    return null;
  }

  /** Zone that hosts a specific equipment tile (null for ground kit). */
  public static zoneForEquipmentItem(state: GameState, itemId: string): BasinZone | null {
    const item = (state.processEquipment ?? []).find(e => e.id === itemId);
    if (!item) return null;
    return GameManager.zoneAtTile(state, item.x, item.y);
  }

  public static basinZoneStats(state: GameState): BasinZoneStats {
    return _basinZoneStats(state.customBasins ?? [], state.customBaffles ?? []);
  }

  // ── CONSTRUCTION-BUILDER P1 — BASIN DIRECT EDITING (depth + resize) ─────────
  /**
   * Retunes a basin's depth (campaign charges the civil delta, sandbox free).
   * Shallowing refunds 50% of the saved concrete/excavation. Pure domain,
   * cash-gated, no React.
   */
  public static updateBasinDepth(
    state: GameState,
    basinId: string,
    newDepthM: number
  ): { newState: GameState; success: boolean; reason?: string; charged?: number; refunded?: number } {
    const basin = (state.customBasins ?? []).find(b => b.id === basinId);
    if (!basin) return { newState: state, success: false, reason: 'Unknown basin' };
    const depth = Number(newDepthM);
    if (!Number.isFinite(depth) || depth < BASIN_MIN_DEPTH_M || depth > BASIN_MAX_DEPTH_M) {
      return { newState: state, success: false, reason: `Depth must be ${BASIN_MIN_DEPTH_M}–${BASIN_MAX_DEPTH_M} m` };
    }
    if (Math.abs(depth - basin.depthM) < 0.001) return { newState: state, success: true };
    const equipmentTiles = (state.processEquipment ?? [])
      .filter(e => e.x >= basin.x && e.x < basin.x + basin.w && e.y >= basin.y && e.y < basin.y + basin.h)
      .map(e => ({ x: e.x, y: e.y }));
    const baffleOffsets = (state.customBaffles ?? []).map(bf => ({ basinId: bf.basinId, orientation: bf.orientation as 'vertical' | 'horizontal', offsetTiles: bf.offsetTiles }));
    const unitRects = state.units.map(u => {
      const [uw, ul] = resolveFootprint(u);
      return { x: u.gridX, y: u.gridY, w: uw, h: ul };
    });
    for (const e of state.processEquipment ?? []) {
      if (EQUIPMENT_TYPES[e.typeId]?.mounting === 'ground') unitRects.push({ x: e.x, y: e.y, w: 1, h: 1 });
    }
    const rect = { x: basin.x, y: basin.y, w: basin.w, h: basin.h };
    const v = validateBasinEdit(basinId, rect, depth, state.currentLevel.mapSize, state.customBasins ?? [], unitRects, equipmentTiles, baffleOffsets);
    if (!v.ok) return { newState: state, success: false, reason: v.reason };
    const oldCapex = estimateBasinCAPEX(basin);
    const newCapex = estimateBasinCAPEX({ ...rect, depthM: depth });
    const delta = newCapex - oldCapex;
    if (state.gameMode !== 'sandbox' && !state.tutorialActive && delta > 0 && state.financials.cash < delta) {
      return { newState: state, success: false, reason: `Insufficient funds (needs $${delta.toLocaleString()} more concrete)` };
    }
    const refund = (!state.tutorialActive && state.gameMode !== 'sandbox' && delta < 0) ? Math.round(-delta * GameManager.CUSTOM_BASIN_SALVAGE_RATE) : 0;
    const charged = delta > 0 && state.gameMode !== 'sandbox' && !state.tutorialActive ? delta : 0;
    const newCash = state.gameMode === 'sandbox' || state.tutorialActive
      ? state.financials.cash
      : state.financials.cash - charged + refund;
    const nextBasins = (state.customBasins ?? []).map(b => b.id === basinId ? { ...b, depthM: depth } : b);
    return {
      newState: { ...state, financials: { ...state.financials, cash: newCash }, customBasins: nextBasins },
      success: true,
      ...(charged > 0 ? { charged } : {}),
      ...(refund > 0 ? { refunded: refund } : {}),
    };
  }

  /**
   * Resizes a basin's footprint (campaign charges delta, 50% salvage on shrink).
   * Validates against overlaps (excluding self), stranded equipment, baffle validity.
   */
  public static updateBasinRect(
    state: GameState,
    basinId: string,
    newRect: { x: number; y: number; w: number; h: number }
  ): { newState: GameState; success: boolean; reason?: string; charged?: number; refunded?: number } {
    const basin = (state.customBasins ?? []).find(b => b.id === basinId);
    if (!basin) return { newState: state, success: false, reason: 'Unknown basin' };
    const norm = { x: Math.floor(newRect.x), y: Math.floor(newRect.y), w: Math.max(1, Math.floor(newRect.w)), h: Math.max(1, Math.floor(newRect.h)) };
    // no-op
    if (norm.x === basin.x && norm.y === basin.y && norm.w === basin.w && norm.h === basin.h) return { newState: state, success: true };
    const equipmentTiles = (state.processEquipment ?? [])
      .filter(e => e.x >= basin.x && e.x < basin.x + basin.w && e.y >= basin.y && e.y < basin.y + basin.h)
      .map(e => ({ x: e.x, y: e.y }));
    const baffleOffsets = (state.customBaffles ?? []).map(bf => ({ basinId: bf.basinId, orientation: bf.orientation as 'vertical' | 'horizontal', offsetTiles: bf.offsetTiles }));
    const unitRects = state.units.map(u => {
      const [uw, ul] = resolveFootprint(u);
      return { x: u.gridX, y: u.gridY, w: uw, h: ul };
    });
    for (const e of state.processEquipment ?? []) {
      if (EQUIPMENT_TYPES[e.typeId]?.mounting === 'ground') unitRects.push({ x: e.x, y: e.y, w: 1, h: 1 });
    }
    const v = validateBasinEdit(basinId, norm, basin.depthM, state.currentLevel.mapSize, state.customBasins ?? [], unitRects, equipmentTiles, baffleOffsets);
    if (!v.ok) return { newState: state, success: false, reason: v.reason };
    const oldCapex = estimateBasinCAPEX(basin);
    const newCapex = estimateBasinCAPEX({ ...norm, depthM: basin.depthM });
    const delta = newCapex - oldCapex;
    if (state.gameMode !== 'sandbox' && !state.tutorialActive && delta > 0 && state.financials.cash < delta) {
      return { newState: state, success: false, reason: `Insufficient funds (needs $${delta.toLocaleString()} more)` };
    }
    const refund = (!state.tutorialActive && state.gameMode !== 'sandbox' && delta < 0) ? Math.round(-delta * GameManager.CUSTOM_BASIN_SALVAGE_RATE) : 0;
    const charged = delta > 0 && state.gameMode !== 'sandbox' && !state.tutorialActive ? delta : 0;
    const newCash = state.gameMode === 'sandbox' || state.tutorialActive
      ? state.financials.cash
      : state.financials.cash - charged + refund;
    const nextBasins = (state.customBasins ?? []).map(b => b.id === basinId ? { ...b, x: norm.x, y: norm.y, w: norm.w, h: norm.h } : b);
    return {
      newState: { ...state, financials: { ...state.financials, cash: newCash }, customBasins: nextBasins },
      success: true,
      ...(charged > 0 ? { charged } : {}),
      ...(refund > 0 ? { refunded: refund } : {}),
    };
  }

  /**
   * Demolishes an existing unit and refunds 70% of its initial cost
   */
  public static demolishUnit(state: GameState, instanceId: string): GameState {
    const unit = state.units.find(u => u.instanceId === instanceId);
    if (!unit || unit.typeId === 'influent_inlet' || unit.typeId === 'effluent_outfall') {
      return state; // Cannot demolish inlet or outfall
    }

    const def = UNIT_DEFINITIONS[unit.typeId];
    // Tutorial-granted units were never paid for — no refund exploit allowed
    const refund = (def && !state.tutorialActive) ? Math.round(def.capex * 0.7) : 0;
    // Attached pipes go down with the unit — pay out their salvage too (§AK 11).
    const attachedPipeSalvage = (!state.tutorialActive && state.gameMode !== 'sandbox')
      ? Math.round(state.pipes
          .filter(p => p.fromUnitId === instanceId || p.toUnitId === instanceId)
          .reduce((s, p) => s + (p.capexPaid ?? 0) * GameManager.PIPE_SALVAGE_RATE, 0))
      : 0;
    const updatedUnits = state.units.filter(u => u.instanceId !== instanceId);
    const newSuggestion = GameManager.computeNextSuggestion(updatedUnits, state.currentLevel);

    return {
      ...state,
      financials: {
        ...state.financials,
        cash: state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash + refund + attachedPipeSalvage
      },
      units: updatedUnits,
      pipes: state.pipes.filter(p => p.fromUnitId !== instanceId && p.toUnitId !== instanceId),
      selectedUnitId: state.selectedUnitId === instanceId ? null : state.selectedUnitId,
      suggestion: newSuggestion
    };
  }

  // ── Pipe CAPEX billing (§AK item 11 — quantity-based CAPEX) ────────────────

  /** Salvage fraction recovered when demolishing billed pipe — matches the
   *  70% unit-demolition refund policy. Never-billed legacy pipes return $0. */
  public static readonly PIPE_SALVAGE_RATE = 0.7;

  /** Installation quote for one pipe: material × DN-equivalent × path length —
   *  exactly the number the PFD panel shows as its estimate. Unsized drafts
   *  (an auto-sized pipe exists before its first DN pick) price at the bottom
   *  of the ladder, DN80. */
  private static pipeQuote(diameterM: number | undefined, materialId: string | undefined, lengthM: number): number {
    return estimatePipeCAPEX(diameterM ?? 0.1, materialId, lengthM);
  }

  /**
   * Bills and installs player-built pipe connections ATOMICALLY (§AK item 11).
   * Quote = Σ estimatePipeCAPEX over the drafts at their polyline path length;
   * rejected wholesale when cash can't cover it. Sandbox and the tutorial
   * training grant (mirroring placeUnit) build for free, but still record
   * capexPaid so later change orders price from a real basis. Auto-sizer re-picks
   * never route through purchase/update, so they stay inside this lump sum.
   */
  public static purchasePipes(
    state: GameState,
    drafts: PipeConnection[]
  ): { newState: GameState; success: boolean; reason?: string; charged?: number } {
    if (drafts.length === 0) return { newState: state, success: true };
    const quotes = drafts.map(p => GameManager.pipeQuote(p.diameterM, p.materialId, pathLengthM(p.pathPoints)));
    const total = quotes.reduce((a, b) => a + b, 0);
    const free = state.gameMode === 'sandbox' || state.tutorialActive;
    if (!free && state.financials.cash < total) {
      return { newState: state, success: false, reason: `Insufficient funds for piping ($${total.toLocaleString()} required)` };
    }
    const priced = drafts.map((p, i) => ({ ...p, capexPaid: free ? 0 : quotes[i] }));
    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: free ? state.financials.cash : state.financials.cash - total },
        pipes: [...state.pipes, ...priced],
      },
      success: true,
      ...(free || total === 0 ? {} : { charged: total }),
    };
  }

  /**
   * Player change order on one pipe's engineering (DN / material) from the PFD
   * panel. Upsizes charge only the positive delta vs what was already paid
   * (capexPaid); downsizes refund nothing — installed pipe doesn't un-weld.
   * A pipe with no capexPaid (legacy save) prices its first edit as a delta
   * from the current configuration's estimate.
   */
  public static updatePipeEngineering(
    state: GameState,
    pipeId: string,
    patch: Partial<PipeConnection>
  ): { newState: GameState; success: boolean; reason?: string; charged?: number } {
    const pipe = state.pipes.find(p => p.id === pipeId);
    if (!pipe) return { newState: state, success: false, reason: 'Unknown pipe' };
    const length = pathLengthM(pipe.pathPoints);
    const oldBasis = pipe.capexPaid ?? GameManager.pipeQuote(pipe.diameterM, pipe.materialId, length);
    const newQuote = GameManager.pipeQuote(
      patch.diameterM !== undefined ? patch.diameterM : pipe.diameterM,
      patch.materialId !== undefined ? patch.materialId : pipe.materialId,
      length
    );
    const charged = Math.max(0, newQuote - oldBasis);
    const free = state.gameMode === 'sandbox' || state.tutorialActive;
    if (!free && state.financials.cash < charged) {
      return { newState: state, success: false, reason: `Insufficient funds for pipe upgrade ($${charged.toLocaleString()} required)` };
    }
    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: free ? state.financials.cash : state.financials.cash - charged },
        pipes: state.pipes.map(p =>
          p.id === pipeId ? { ...p, ...patch, capexPaid: oldBasis + (free ? 0 : charged) } : p
        ),
      },
      success: true,
      ...(free || charged === 0 ? {} : { charged }),
    };
  }

  /**
   * Removes pipes by id and credits PIPE_SALVAGE_RATE of anything actually
   * billed. Tutorial pipes refund nothing (training grant); sandbox never
   * moves cash.
   */
  public static removePipes(state: GameState, pipeIds: ReadonlySet<string>): { newState: GameState; refunded: number } {
    const removed = state.pipes.filter(p => pipeIds.has(p.id));
    const refunded = (!state.tutorialActive && state.gameMode !== 'sandbox')
      ? Math.round(removed.reduce((s, p) => s + (p.capexPaid ?? 0) * GameManager.PIPE_SALVAGE_RATE, 0))
      : 0;
    return {
      newState: {
        ...state,
        financials: {
          ...state.financials,
          cash: state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash + refunded,
        },
        pipes: state.pipes.filter(p => !pipeIds.has(p.id)),
      },
      refunded,
    };
  }

  /**
   * Writes a placed unit's runtime commissioning state (seed-sludge choice).
   *
   * Economics (backlog #1): seeding is free only as part of the original
   * construction scope — placeUnit hands over a contractor-seeded reactor
   * whose inoculum was bundled into the CAPEX. Every LATER transition INTO
   * seeded operation buys a fresh truckload of seed sludge at
   * estimateSeedSludgeCAPEX(volume); going unseeded never refunds (the
   * culture is spent). This closes the free instant-biomass loophole where
   * toggling the designer checkbox re-enabled the seeded performance boost
   * at zero cost. Sandbox bypasses all money gates, like every other charge.
   */
  public static setUnitCommissioning(
    state: GameState,
    unitId: string,
    next: CommissioningState
  ): { newState: GameState; success: boolean; reason?: string; seedCapexCharged?: number } {
    const unit = state.units.find(u => u.instanceId === unitId);
    if (!unit) return { newState: state, success: false, reason: 'Unknown unit' };

    const wasSeeded = unit.commissioning?.seededWithSludge ?? false;
    let charged = 0;
    if (next.seededWithSludge && !wasSeeded && state.gameMode !== 'sandbox') {
      const cost = estimateSeedSludgeCAPEX(unit.volume);
      if (state.financials.cash < cost) {
        return {
          newState: state,
          success: false,
          reason: `Insufficient funds for seed sludge ($${cost.toLocaleString()} required)`,
        };
      }
      charged = cost;
    }

    const newState: GameState = {
      ...state,
      financials: { ...state.financials, cash: state.financials.cash - charged },
      units: state.units.map(u =>
        u.instanceId === unitId ? { ...u, commissioning: { ...next } } : u
      ),
    };
    return {
      newState,
      success: true,
      ...(charged > 0 ? { seedCapexCharged: charged } : {}),
    };
  }

  /**
   * Operational membrane cleaning (CIP) — migration slice 3 economics.
   * Domain-layer write so the CIP charge is enforced even if a future UI path
   * calls this directly (same pattern as setUnitCommissioning). Charges the
   * quoted chemical/labor cost outside sandbox, then applies
   * performMembraneClean to the unit's fouling state.
   */
  public static cleanMbrMembranes(
    state: GameState,
    unitId: string
  ): { newState: GameState; success: boolean; reason?: string; cipCostCharged?: number } {
    const unit = state.units.find(u => u.instanceId === unitId);
    if (!unit) return { newState: state, success: false, reason: 'Unknown unit' };
    if (unit.typeId !== 'mbr_membrane') {
      return { newState: state, success: false, reason: 'Unit has no membrane cassettes' };
    }

    const mem = unit.blueprint?.equipment as
      { materialId?: string; moduleCount?: number; areaPerModuleM2?: number } | undefined;
    const cost = membraneCipCostUsd(
      mem?.materialId ?? 'pvdf_hollow_fiber',
      (mem?.moduleCount ?? 9) * (mem?.areaPerModuleM2 ?? 850),
    );
    const charged = state.gameMode === 'sandbox' ? 0 : cost;
    if (state.financials.cash < charged) {
      return {
        newState: state,
        success: false,
        reason: `Insufficient funds for CIP clean ($${cost.toLocaleString()} required)`,
      };
    }

    const prevFoul = unit.mbrFouling ?? FRESH_MBR_FOULING;
    const newState: GameState = {
      ...state,
      financials: { ...state.financials, cash: state.financials.cash - charged },
      units: state.units.map(u =>
        u.instanceId === unitId ? { ...u, mbrFouling: performMembraneClean(prevFoul) } : u
      ),
    };
    return {
      newState,
      success: true,
      ...(charged > 0 ? { cipCostCharged: charged } : {}),
    };
  }

  /**
   * Membrane cassette replacement — migration slice 4 end-of-life economics.
   * Domain-layer write so the replacement CAPEX is enforced even if a future
   * UI path calls this directly (same pattern as cleanMbrMembranes). Charges
   * the quoted module price outside sandbox, then swaps the unit's fouling
   * state for brand-new cassettes (fresh resistance, zero age, online).
   */
  public static replaceMbrMembranes(
    state: GameState,
    unitId: string
  ): { newState: GameState; success: boolean; reason?: string; replacementCapexCharged?: number } {
    const unit = state.units.find(u => u.instanceId === unitId);
    if (!unit) return { newState: state, success: false, reason: 'Unknown unit' };
    if (unit.typeId !== 'mbr_membrane') {
      return { newState: state, success: false, reason: 'Unit has no membrane cassettes' };
    }

    const mem = unit.blueprint?.equipment as
      { materialId?: string; moduleCount?: number; areaPerModuleM2?: number } | undefined;
    const cost = membraneReplacementCostUsd(
      mem?.materialId ?? 'pvdf_hollow_fiber',
      (mem?.moduleCount ?? 9) * (mem?.areaPerModuleM2 ?? 850),
    );
    const charged = state.gameMode === 'sandbox' ? 0 : cost;
    if (state.financials.cash < charged) {
      return {
        newState: state,
        success: false,
        reason: `Insufficient funds for membrane replacement ($${cost.toLocaleString()} required)`,
      };
    }

    const newState: GameState = {
      ...state,
      financials: { ...state.financials, cash: state.financials.cash - charged },
      units: state.units.map(u =>
        u.instanceId === unitId ? { ...u, mbrFouling: { ...FRESH_MBR_FOULING } } : u
      ),
    };
    return {
      newState,
      success: true,
      ...(charged > 0 ? { replacementCapexCharged: charged } : {}),
    };
  }

  // ── CONSTRUCTION-BUILDER Phase 4: functional network ───────────────────
  public static poweredEquipmentIds(state: GameState): Set<string> {
    return _poweredIds(state.processEquipment ?? [], state.utilityConnections ?? []);
  }
  public static aeratedDiffuserIds(state: GameState): Set<string> {
    return _aeratedIds(state.processEquipment ?? [], state.utilityConnections ?? []);
  }
  public static constructionStats(state: GameState): ConstructionStats {
    return _constructionStats(state.customBasins ?? [], state.processEquipment ?? [], state.utilityConnections ?? []);
  }

  /**
   * Unlocks a technology node in the tech tree.
   * Enforces prerequisites at the domain layer — UI gating alone is not
   * sufficient (direct calls must not bypass the tech tree).
   */
  public static unlockTech(state: GameState, techId: string): { newState: GameState; success: boolean; reason?: string } {
    const node = state.techTree.find(n => n.id === techId);
    if (!node) return { newState: state, success: false, reason: 'Unknown technology' };
    if (node.unlocked) return { newState: state, success: true, reason: 'Already unlocked' };

    // Prerequisite enforcement (campaign AND sandbox — a prerequisite chain
    // is part of game rules, not campaign difficulty).
    const missing = (node.prerequisites ?? []).filter(pid => {
      const pre = state.techTree.find(n => n.id === pid);
      return !pre || !pre.unlocked;
    });
    if (missing.length > 0) {
      const names = missing.map(id => state.techTree.find(n => n.id === id)?.title ?? id).join(', ');
      return { newState: state, success: false, reason: `Requires prior research: ${names}` };
    }

    if (state.gameMode !== 'sandbox' && state.financials.cash < node.cost) {
      return { newState: state, success: false, reason: `Insufficient funds ($${node.cost.toLocaleString()} required)` };
    }

    const newCash = state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash - node.cost;
    const updatedTechTree = state.techTree.map(n => (n.id === techId ? { ...n, unlocked: true } : n));

    return {
      newState: {
        ...state,
        financials: { ...state.financials, cash: newCash },
        techTree: updatedTechTree
      },
      success: true
    };
  }
}
