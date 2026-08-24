import { CampaignLevel, GameFinancials, PlantOverallStats, SimulationSpeed, TechNode } from '../types/game';
import { PipeConnection, PlacedUnit, UnitTypeId, WaterQuality } from '../types/simulation';
import { CAMPAIGN_LEVELS } from './LevelsData';
import { TECH_TREE_NODES } from './TechTreeData';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { emptyWater } from '../sim/WaterStream';
import { SimulationEngine } from '../sim/SimulationEngine';
import { TUTORIAL_STEPS } from './TutorialSteps';

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
  suggestion: NextStepSuggestion | null;
  complianceStreakDays: number;
  tutorialActive: boolean;
  tutorialStep: number;
}

export class GameManager {
  public static createInitialState(levelIndex: number = 0, isSandbox: boolean = false): GameState {
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
      gameTimeDays: 0,
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
      suggestion: initialSuggestion,
      complianceStreakDays: 0,
      tutorialActive: false,
      tutorialStep: 0
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

    // Step 1: Preliminary Screen
    if (!hasType('bar_screen')) {
      return {
        unitTypeId: 'bar_screen',
        name: 'Mechanical Bar Screen',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 1: Place a Bar Screen right after the Inlet to filter out coarse debris & rags.',
        category: 'preliminary'
      };
    }

    // Step 2: Grit Removal or Equalization
    if (level.id === 2 && !hasType('equalization_basin')) {
      return {
        unitTypeId: 'equalization_basin',
        name: 'Equalization Basin',
        gridX: Math.min(level.mapSize[0] - 8, nextX),
        gridY: midY,
        hint: 'Step 2: Install Equalization Basin to dampen severe brewery organic shock loads.',
        category: 'preliminary'
      };
    }

    if (!hasType('grit_chamber')) {
      return {
        unitTypeId: 'grit_chamber',
        name: 'Vortex Grit Chamber',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 2: Place a Vortex Grit Chamber to separate abrasive sand and heavy grit.',
        category: 'preliminary'
      };
    }

    // Step 3: Primary Clarifier / DAF
    if (level.id === 2 && !hasType('daf_unit') && !hasType('primary_clarifier_circular')) {
      return {
        unitTypeId: 'daf_unit',
        name: 'Dissolved Air Flotation (DAF)',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 3: Deploy DAF to float out fats, oils, and brewery grease (FOG).',
        category: 'primary'
      };
    }

    if (!hasType('primary_clarifier_circular') && !hasType('primary_clarifier_rect') && !hasType('daf_unit')) {
      return {
        unitTypeId: 'primary_clarifier_circular',
        name: 'Primary Clarifier',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 3: Add a Primary Clarifier to settle out 50-60% of suspended solids.',
        category: 'primary'
      };
    }

    // Step 4: Biological Secondary Treatment
    const hasBio = hasType('activated_sludge_cas') || hasType('a2o_bardenpho') || hasType('mbbr_reactor') || hasType('mbr_membrane');
    if (!hasBio) {
      const bioType: UnitTypeId = level.id === 4 
        ? 'a2o_bardenpho' 
        : (level.id === 3 ? 'mbbr_reactor' : (level.id === 5 ? 'mbr_membrane' : 'activated_sludge_cas'));
      const def = UNIT_DEFINITIONS[bioType];
      return {
        unitTypeId: bioType,
        name: def.name,
        gridX: Math.min(level.mapSize[0] - def.footprint[0] - 4, nextX),
        gridY: midY,
        hint: `Step 4: Build a biological reactor (${def.name}) to digest dissolved organic BOD.`,
        category: 'secondary'
      };
    }

    // Step 5: Secondary Clarifier (for CAS/A2O/MBBR)
    if (!hasType('mbr_membrane') && !hasType('secondary_clarifier')) {
      return {
        unitTypeId: 'secondary_clarifier',
        name: 'Secondary Clarifier',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 5: Install a Secondary Clarifier to separate activated biomass from purified effluent.',
        category: 'secondary'
      };
    }

    // Step 6: Tertiary / Disinfection
    if (level.id === 5 && !hasType('reverse_osmosis')) {
      return {
        unitTypeId: 'reverse_osmosis',
        name: 'Reverse Osmosis (RO)',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 6: Add Reverse Osmosis for potable desalination & 100% mineral/solute barrier.',
        category: 'tertiary'
      };
    }

    if (!hasType('uv_disinfection') && !hasType('chlorination_basin')) {
      return {
        unitTypeId: 'uv_disinfection',
        name: 'UV Disinfection Chamber',
        gridX: Math.min(level.mapSize[0] - 6, nextX),
        gridY: midY,
        hint: 'Step 6: Install UV Disinfection to destroy pathogens without chemical residues.',
        category: 'tertiary'
      };
    }

    // Sludge Handling Suggestion
    if (!hasType('sludge_thickener') && level.availableUnits.includes('sludge_thickener')) {
      return {
        unitTypeId: 'sludge_thickener',
        name: 'Gravity Sludge Thickener',
        gridX: 6,
        gridY: Math.max(1, midY - 6),
        hint: 'Pro-Tip: Place a Sludge Thickener to process settled solids from clarifiers.',
        category: 'sludge'
      };
    }

    return null;
  }

  /**
   * Advances game state by delta time in seconds
   */
  public static tick(state: GameState, deltaSec: number): GameState {
    if (state.simSpeed === 0) return state;

    const speedMultiplier = state.simSpeed;
    const simDeltaDays = (deltaSec * speedMultiplier) / 60; // 1 real minute = 1 game day at 1x speed
    const newDays = state.gameTimeDays + simDeltaDays;
    const isNight = (Math.floor(newDays * 24) % 24) >= 19 || (Math.floor(newDays * 24) % 24) < 6;

    // Influent choice
    const activeInfluent = state.gameMode === 'sandbox' ? state.sandboxCustomInfluent : state.currentLevel.influentSpec;

    // Environmental factors driving renewable generation:
    // daylight is a bell curve between 06:00 and 19:00; wind meanders slowly.
    const hourOfDay = (newDays % 1) * 24;
    const daylight = (hourOfDay >= 6 && hourOfDay < 19)
      ? Math.max(0, Math.sin(((hourOfDay - 6) / 13) * Math.PI))
      : 0;
    const wind = 0.15 + 0.85 * Math.max(0, 0.5 + 0.5 * Math.sin(newDays * 2.9) * Math.sin(newDays * 1.31 + 1.7));

    // Solve process engineering mass-balance
    const simResult = SimulationEngine.stepSimulation(
      state.units,
      state.pipes,
      activeInfluent,
      state.currentLevel.standards,
      state.financials,
      state.currentLevel.tariffPerM3,
      0.15,
      45,
      { daylight, wind },
      // Unlocked tech ids drive centralized passive bonuses (e.g. CHP +20%)
      new Set(state.techTree.filter(t => t.unlocked).map(t => t.id))
    );

    // Apply financial cash flow
    const cashDelta = (simResult.financials.netDailyProfit * simDeltaDays);
    const updatedFinancials: GameFinancials = {
      ...simResult.financials,
      cash: state.gameMode === 'sandbox' ? 9999999 : Math.max(-50000, state.financials.cash + cashDelta)
    };

    // BUG FIX: accumulate treated volume consistently with simulated days (was ~12x too fast)
    updatedFinancials.totalTreatedM3 = state.financials.totalTreatedM3 + (simResult.finalEffluent.flowRate * simDeltaDays);

    // Track consecutive compliant days (drives obj_compliance on Level 3)
    const compliantNow = simResult.overallStats.complianceScore >= 90 && simResult.finalEffluent.flowRate > 10;
    const complianceStreakDays = compliantNow ? state.complianceStreakDays + simDeltaDays : 0;

    // Check Level Objectives
    const updatedObjectives = state.currentLevel.objectives.map(obj => {
      let achieved = obj.achieved;
      const eff = simResult.finalEffluent;
      const hasEffluentFlow = eff.flowRate > 10;

      if (!achieved && hasEffluentFlow) {
        if (obj.id === 'obj_connect') achieved = true;
        if (obj.id === 'obj_eq' && state.units.some(u => u.typeId === 'equalization_basin')) achieved = true;
        if (obj.id === 'obj_mbr' && state.units.some(u => u.typeId === 'mbr_membrane')) achieved = true;
        if (obj.id === 'obj_ro' && state.units.some(u => u.typeId === 'reverse_osmosis')) achieved = true;
        if (obj.id === 'obj_aeration' && state.units.some(u => (u.typeId === 'activated_sludge_cas' || u.typeId === 'a2o_bardenpho') && (u.dissolvedOxygenActual ?? 0) >= 2.0)) achieved = true;

        if (obj.id === 'obj_bod' && eff.bod <= (obj.targetValue || 30)) achieved = true;
        if (obj.id === 'obj_cod' && eff.cod <= (obj.targetValue || 100)) achieved = true;
        if (obj.id === 'obj_tss' && eff.tss <= (obj.targetValue || 30)) achieved = true;
        if (obj.id === 'obj_tn' && eff.tn <= (obj.targetValue || 10)) achieved = true;
        if (obj.id === 'obj_tp' && eff.tp <= (obj.targetValue || 1)) achieved = true;
        if (obj.id === 'obj_pathogen' && eff.pathogens <= (obj.targetValue || 1000)) achieved = true;
        if (obj.id === 'obj_pathogen_zero' && eff.pathogens <= 1) achieved = true;
        if (obj.id === 'obj_toxic' && eff.toxicIndex <= (obj.targetValue || 5)) achieved = true;
        if (obj.id === 'obj_profit' && updatedFinancials.netDailyProfit > 0) achieved = true;
        if (obj.id === 'obj_energy' && simResult.overallStats.energySelfSufficiencyPercent >= (obj.targetValue || 50)) achieved = true;
        if (obj.id === 'obj_volume' && updatedFinancials.totalTreatedM3 >= (obj.targetValue || 5000)) achieved = true;
        // BUG FIX: these two objectives were never evaluated, making Levels 3 & 4 unwinnable
        if (obj.id === 'obj_sand' && state.units.some(u => u.typeId === 'sand_filter') && eff.tss <= (obj.targetValue || 10)) achieved = true;
        if (obj.id === 'obj_compliance' && complianceStreakDays >= 3) achieved = true;
      }
      return { ...obj, achieved };
    });

    const allObjectivesMet = updatedObjectives.length > 0 && updatedObjectives.every(o => o.achieved);
    const becameComplete = allObjectivesMet && !state.isLevelComplete;

    // BUG FIX: pay the Municipal Grant Bonus exactly once on level completion
    if (becameComplete && state.gameMode !== 'sandbox') {
      updatedFinancials.cash += state.currentLevel.bonusReward;
    }

    const suggestion = GameManager.computeNextSuggestion(simResult.updatedUnits, state.currentLevel);

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
      suggestion,
      complianceStreakDays
    };
  }

  /**
   * Places a new unit on the plant grid
   */
  public static placeUnit(
    state: GameState,
    typeId: UnitTypeId,
    gridX: number,
    gridY: number,
    rotation: 0 | 90 | 180 | 270 = 0
  ): { newState: GameState; success: boolean; reason?: string } {
    const def = UNIT_DEFINITIONS[typeId];
    if (!def) return { newState: state, success: false, reason: 'Invalid unit type' };

    // Tutorial training grant: the step's required unit is fully funded so
    // following the guided build never drains the player's real budget.
    const tutStep = state.tutorialActive ? TUTORIAL_STEPS[state.tutorialStep] : undefined;
    const tutorialGrant = !!tutStep?.unitTypeId && tutStep.unitTypeId === typeId;

    // Cost check
    if (!tutorialGrant && state.gameMode !== 'sandbox' && state.financials.cash < def.capex) {
      return { newState: state, success: false, reason: `Insufficient funds ($${def.capex.toLocaleString()} required)` };
    }

    // Boundary check
    const [w, l] = rotation === 90 || rotation === 270 ? [def.footprint[1], def.footprint[0]] : def.footprint;
    const [mapW, mapH] = state.currentLevel.mapSize;
    if (gridX < 0 || gridY < 0 || gridX + w > mapW || gridY + l > mapH) {
      return { newState: state, success: false, reason: 'Out of grid boundary' };
    }

    // Overlap check
    const isOverlapping = state.units.some(u => {
      const uDef = UNIT_DEFINITIONS[u.typeId];
      if (!uDef) return false;
      const [uw, ul] = u.rotation === 90 || u.rotation === 270 ? [uDef.footprint[1], uDef.footprint[0]] : uDef.footprint;
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

    const newUnit: PlacedUnit = {
      instanceId: `unit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      typeId,
      gridX,
      gridY,
      rotation,
      volume: (w * 6) * (l * 6) * 4.0, // m3 nominal
      customParams: { ...def.defaultParams },
      active: true,
      efficiencyRating: 100,
      lastInletQuality: emptyWater(),
      lastOutletQuality: emptyWater(),
      lastPowerKwActual: def.powerConsumptionKw,
      lastOpexActual: def.baseOpexPerDay
    };

    const newCash = state.gameMode === 'sandbox'
      ? state.financials.cash
      : (tutorialGrant ? state.financials.cash : state.financials.cash - def.capex);
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
    const updatedUnits = state.units.filter(u => u.instanceId !== instanceId);
    const newSuggestion = GameManager.computeNextSuggestion(updatedUnits, state.currentLevel);

    return {
      ...state,
      financials: {
        ...state.financials,
        cash: state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash + refund
      },
      units: updatedUnits,
      pipes: state.pipes.filter(p => p.fromUnitId !== instanceId && p.toUnitId !== instanceId),
      selectedUnitId: state.selectedUnitId === instanceId ? null : state.selectedUnitId,
      suggestion: newSuggestion
    };
  }

  /**
   * Unlocks a technology node in the tech tree
   */
  public static unlockTech(state: GameState, techId: string): GameState {
    const node = state.techTree.find(n => n.id === techId);
    if (!node || node.unlocked) return state;

    if (state.gameMode !== 'sandbox' && state.financials.cash < node.cost) return state;

    const newCash = state.gameMode === 'sandbox' ? state.financials.cash : state.financials.cash - node.cost;
    const updatedTechTree = state.techTree.map(n => (n.id === techId ? { ...n, unlocked: true } : n));

    return {
      ...state,
      financials: { ...state.financials, cash: newCash },
      techTree: updatedTechTree
    };
  }
}
