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
import { blueprintFromTemplate } from '../design/UnitBlueprint';

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
   * curve in [0,1]. Template trains are currently average-day designs; until
   * peak-flow equipment sizing lands (items 5/6) new games start at a gentle
   * 0.4 swing. Raise to DIURNAL_DEFAULT_STRENGTH=1 after template resizing.
   */
  diurnalInfluentStrength: number;
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
      diurnalInfluentStrength: DIURNAL_DEFAULT_STRENGTH
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
    // (default 0.4 for legacy template trains; raise to 1.0 after peak-flow resizing).
    const dynamicInfluent = applyDiurnalInfluent(activeInfluent, newDays, state.diurnalInfluentStrength ?? 1);

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
      dynamicInfluent,
      state.currentLevel.standards,
      state.financials,
      state.currentLevel.tariffPerM3,
      0.15,
      45,
      { daylight, wind, dtDays: simDeltaDays },
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

      if (hasEffluentFlow) {
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

    // C. Cost check
    if (!tutorialGrant && state.gameMode !== 'sandbox' && state.financials.cash < def.capex) {
      return { newState: state, success: false, reason: `Insufficient funds ($${def.capex.toLocaleString()} required)` };
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

    // Engineerable families start with a blueprint from the template default
    // geometry so the new architecture is live from the first placement; the
    // player refines it afterwards in the Unit Designer (Prompt §C/D).
    const blueprint = isEngineerable(typeId)
      ? blueprintFromTemplate(typeId) ?? undefined
      : undefined;

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
        ? { phase: 'empty' as const, daysInPhase: 0, seededWithSludge: true }
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
