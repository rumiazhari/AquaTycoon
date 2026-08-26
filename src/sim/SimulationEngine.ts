import { GameFinancials, PlantOverallStats } from '../types/game';
import {
  GasStream, PipeConnection, PlacedUnit, TreatmentStandard, WaterQuality, emptyGas
} from '../types/simulation';
import { calculateUnitProcess, EnvironmentFactors, ProcessResult } from './UnitProcessModels';
import { advanceMbrFouling, FRESH_MBR_FOULING, FOUL_FLUX_REF_LMH, SCOUR_MIN_NM3H_PER_M2 } from './processes/MBR';
import { cloneWater, emptyWater, mixWaterStreams } from './WaterStream';
import { evaluatePermitCriteria } from './PermitEngine';
import { evaluateTechEffects } from './TechEffects';
import { refreshPipeHydraulics } from '../design/PipeSizing';

export interface SimulationStepResult {
  updatedUnits: PlacedUnit[];
  updatedPipes: PipeConnection[];
  finalEffluent: WaterQuality;
  overallStats: PlantOverallStats;
  financials: GameFinancials;
  /** Set when the relaxation loop hit its iteration cap without converging */
  converged: boolean;
  iterationsUsed: number;
}

/** Guards against NaN/Infinity/negative hydraulic values polluting the network. */
function sanitizeStream(w: WaterQuality): WaterQuality {
  const s = (v: number, floor = 0) => (!Number.isFinite(v) ? floor : Math.max(floor, v));
  return {
    flowRate: s(w.flowRate),
    bod: s(w.bod),
    cod: s(w.cod),
    tss: s(w.tss),
    tn: s(w.tn),
    nh4: s(w.nh4),
    no3: s(w.no3),
    tp: s(w.tp),
    pathogens: s(w.pathogens),
    do: Number.isFinite(w.do) ? Math.max(0, Math.min(14, w.do)) : 0,
    ph: Number.isFinite(w.ph) ? Math.min(14, Math.max(2, w.ph)) : 7,
    temp: Number.isFinite(w.temp) ? w.temp : 20,
    toxicIndex: s(w.toxicIndex),
    turbidity: s(w.turbidity)
  };
}

/** Liquid payload carried on a pipe for the given source unit + port. */
function streamForPort(unit: PlacedUnit, portId: string): WaterQuality {
  const ps = unit.portStreams?.[portId];
  if (ps) return sanitizeStream(ps);
  // Legacy fallback: sludge_outlet -> lastSludge-style stream stored under
  // the old single-sludge field; anything else -> main outlet.
  if (portId !== 'outlet') {
    const legacy = (unit as PlacedUnit & { lastSludgeQuality?: WaterQuality }).lastSludgeQuality;
    if (legacy && portId.includes('sludge')) return sanitizeStream(legacy);
  }
  return sanitizeStream(unit.lastOutletQuality ?? emptyWater());
}

export class SimulationEngine {
  /**
   * Solves the complete hydraulic and biochemical network for one simulation tick.
   *
   * The solver is a bounded Gauss-Seidel style relaxation over the directed
   * pipe graph:
   *   - each pass recomputes every unit from its CURRENT incoming streams
   *     and immediately refreshes its outgoing per-port streams
   *   - recycle loops converge because every unit's outputs are pure
   *     functions of its inputs (no flow multiplication anywhere)
   *   - under-relaxation damps oscillation around loops; we stop as soon as
   *     flows and key concentrations settle within tolerance
   */
  public static stepSimulation(
    units: PlacedUnit[],
    pipes: PipeConnection[],
    influentSpec: WaterQuality,
    standards: TreatmentStandard,
    currentFinancials: GameFinancials,
    tariffPerM3: number,
    powerCostPerKwh: number = 0.15,
    sludgeDisposalCostPerTon: number = 45,
    env?: EnvironmentFactors,
    unlockedTechIds?: Iterable<string>
  ): SimulationStepResult {
    const unitMap = new Map<string, PlacedUnit>();
    units.forEach(u => unitMap.set(u.instanceId, { ...u }));

    const updatedPipes = pipes.map(p => ({ ...p }));
    const unitResults = new Map<string, ProcessResult>();

    // 1. Find Influent Inlet units and set their initial outlet stream
    const inletUnits = units.filter(u => u.typeId === 'influent_inlet');
    for (const inlet of inletUnits) {
      const liveInfluent = sanitizeStream(cloneWater(influentSpec));
      const u = unitMap.get(inlet.instanceId)!;
      u.lastOutletQuality = liveInfluent;
      u.portStreams = { outlet: liveInfluent };
      u.gasStreams = {};
    }

    // 1b. Initialize all pipes to zero flow so results never depend on stale
    //     pipe state (ordering-independent warm start).
    const firstTick = updatedPipes.every(p => p.flowRate === 0);
    if (firstTick) {
      for (const pipe of updatedPipes) {
        pipe.quality = emptyWater();
        pipe.flowRate = 0;
        pipe.gasFlowRate = 0;
        pipe.gasCh4Fraction = 0;
      }
    }
    // On subsequent ticks the previous converged state is retained as a warm
    // start — the relaxation then needs only 1-2 passes per steady tick.

    // Centralized technology-effects evaluation (Task: passive bonuses must be real)
    const techEffects = unlockedTechIds ? evaluateTechEffects(unlockedTechIds) : null;

    // 2. Bounded convergence-aware relaxation solver
    const MAX_ITERATIONS = 24;         // hard bound (was a fixed 4 passes)
    const FLOW_TOL = 0.01;             // relative flow tolerance
    const CONC_TOL = 0.005;            // relative concentration tolerance
    const DAMPING = 0.6;               // under-relaxation factor (stability)
    let converged = false;
    let iter = 0;
    let worstResidual = 0;
    let worstResidualKey = '?';

    const relDiff = (a: number, b: number) => {
      const scale = Math.max(Math.abs(a), Math.abs(b), 1);
      return Math.abs(a - b) / scale;
    };
    const noteResidual = (key: string, d: number): boolean => {
      if (!Number.isFinite(d)) { worstResidual = Infinity; worstResidualKey = key; converged = false; return true; }
      if (d > worstResidual) { worstResidual = d; worstResidualKey = key; }
      return false;
    };

    for (iter = 1; iter <= MAX_ITERATIONS && !converged; iter++) {
      converged = true;
      worstResidual = 0;
      worstResidualKey = '?';

      // ── 2a. Propagate streams along pipes from their SOURCE ports ──
      // Defense-in-depth flow conservation: if a topology ever attaches
      // several pipes to one source port (legacy saves, editor quirks), the
      // port's stream is DIVIDED equally between them — never duplicated.
      const pipesBySource = new Map<string, PipeConnection[]>();
      for (const pipe of updatedPipes) {
        const key = `${pipe.fromUnitId}::${pipe.fromPortId}`;
        const list = pipesBySource.get(key);
        if (list) list.push(pipe); else pipesBySource.set(key, [pipe]);
      }

      for (const [key, portPipes] of pipesBySource.entries()) {
        const sepIdx = key.indexOf('::');
        const fromUnitId = key.slice(0, sepIdx);
        const fromPortId = key.slice(sepIdx + 2);
        const fromUnit = unitMap.get(fromUnitId);
        if (!fromUnit) continue;
        const nLiquid = portPipes.filter(p => p.pipeType !== 'gas').length;

        for (const pipe of portPipes) {
          if (pipe.pipeType === 'gas') {
            const gas: GasStream = fromUnit.gasStreams?.[fromPortId] ?? emptyGas();
            pipe.flowRate = 0;
            pipe.quality = emptyWater();
            pipe.gasFlowRate = Number.isFinite(gas.flowRate) ? Math.max(0, gas.flowRate) : 0;
            pipe.gasCh4Fraction = Number.isFinite(gas.ch4Fraction)
              ? Math.min(1, Math.max(0, gas.ch4Fraction))
              : 0;
            continue;
          }

          const sourceQuality = streamForPort(fromUnit, fromPortId);
          // Split the port stream across duplicate pipes (ideal equal split)
          const shareFactor = nLiquid > 1 ? 1 / nLiquid : 1;
          const targetFlow = Math.max(0, sourceQuality.flowRate) * shareFactor;

          // Under-relaxed update toward the fresh upstream value — applied to
          // BOTH flow and quality, otherwise recycle-loop concentrations
          // oscillate in a two-cycle around their fixed point.
          pipe.flowRate = pipe.flowRate + DAMPING * (targetFlow - pipe.flowRate);
          pipe.quality = sanitizeStream(
            mixWaterStreams([
              { quality: pipe.quality, flow: 1 - DAMPING },
              { quality: sourceQuality, flow: DAMPING }
            ])
          );
          pipe.quality.flowRate = pipe.flowRate;

          if (
            noteResidual(`flow:${key}`, relDiff(pipe.flowRate, targetFlow)) ||
            relDiff(pipe.flowRate, targetFlow) > FLOW_TOL ||
            relDiff(pipe.quality.bod, sourceQuality.bod) > CONC_TOL ||
            relDiff(pipe.quality.tss, sourceQuality.tss) > CONC_TOL ||
            relDiff(pipe.quality.nh4, sourceQuality.nh4) > CONC_TOL
          ) {
            converged = false;
          }
        }
      }

      // ── 2b. Compute each unit's inlet from connected pipes & re-run process ──
      for (const unit of units) {
        if (unit.typeId === 'influent_inlet') continue;
        const targetUnit = unitMap.get(unit.instanceId);
        if (!targetUnit) continue;

        // Incoming liquid streams to liquid inlets ('inlet' + 'ras_inlet')
        const incomingLiquidPipes = updatedPipes.filter(
          p =>
            p.pipeType !== 'gas' &&
            p.toUnitId === unit.instanceId &&
            (p.toPortId === 'inlet' || p.toPortId === 'ras_inlet')
        );

        let mergedInlet = emptyWater();
        if (incomingLiquidPipes.length > 0) {
          mergedInlet = mixWaterStreams(
            incomingLiquidPipes.map(p => ({ quality: p.quality, flow: p.flowRate }))
          );
        }

        // Forward (main-line) hydraulic throughput entering via 'inlet' ports
        // only — used by legacy process paths that need net throughput.
        const forwardInflow = incomingLiquidPipes
          .filter(p => p.toPortId === 'inlet')
          .reduce((acc, p) => acc + p.flowRate, 0);

        // Outgoing liquid-pipe headloss for pump stations (duty-point context)
        const outgoingHeadlossM = updatedPipes
          .filter(p => p.pipeType !== 'gas' && p.fromUnitId === unit.instanceId)
          .reduce((acc, p) => acc + (p.cachedHydraulics?.headlossM ?? 0), 0);

        // Run unit process calculation (with pump topology context)
        const result = calculateUnitProcess(targetUnit, mergedInlet, forwardInflow, env, {
          pumpDischargeHeadlossM: outgoingHeadlossM,
        });

        // Technology passive bonuses: the digester's "+20% energy recovery"
        // tech boosts CHP electrical output (negative powerKw = generation).
        if (techEffects && targetUnit.typeId === 'anaerobic_digester' && result.powerKw < 0) {
          result.powerKw *= techEffects.energyRecoveryMultiplier;
        }
        unitResults.set(unit.instanceId, result);

        // Convergence check against this unit's previous inlet state
        const prev = targetUnit.lastInletQuality;
        if (
          relDiff(mergedInlet.flowRate, prev.flowRate) > FLOW_TOL ||
          noteResidual('unitInlet', relDiff(mergedInlet.bod, prev.bod)) ||
          relDiff(mergedInlet.bod, prev.bod) > CONC_TOL ||
          relDiff(mergedInlet.tss, prev.tss) > CONC_TOL ||
          relDiff(mergedInlet.nh4, prev.nh4) > CONC_TOL ||
          relDiff(mergedInlet.tn, prev.tn) > CONC_TOL
        ) {
          converged = false;
        }

        // ── RAS/WAS topology is physically meaningful ────────────────────
        // Configured recycle/waste streams only leave through real pipes:
        //   · WAS with no dewatering/thickening route folds back into the
        //     clarifier underflow (the pump shares the RAS sump);
        //   · RAS with no bioreactor return overflows the weir WITH the
        //     effluent — biomass washes out and the plant degrades visibly.
        // No magical internal recycle while pipes sit disconnected; the
        // AdvisoryEngine tells the player exactly what is missing.
        const hasOutgoingPipe = (portId: string) =>
          updatedPipes.some(
            p =>
              p.pipeType !== 'gas' &&
              p.fromUnitId === targetUnit.instanceId &&
              p.fromPortId === portId
          );
        let effStreams: Record<string, WaterQuality> = { ...(result.portStreams ?? {}) };

        if (
          !hasOutgoingPipe('was_outlet') &&
          (effStreams['was_outlet']?.flowRate ?? 0) > 0 &&
          effStreams['sludge_outlet']
        ) {
          effStreams['sludge_outlet'] = sanitizeStream(mixWaterStreams([
            { quality: effStreams['sludge_outlet'], flow: Math.max(0, effStreams['sludge_outlet'].flowRate) },
            { quality: effStreams['was_outlet'], flow: Math.max(0, effStreams['was_outlet'].flowRate) }
          ]));
          effStreams['was_outlet'] = { ...effStreams['was_outlet'], flowRate: 0 };
        }

        if (
          !hasOutgoingPipe('sludge_outlet') &&
          (effStreams['sludge_outlet']?.flowRate ?? 0) > 0 &&
          effStreams['outlet']
        ) {
          const mergedOverflow = sanitizeStream(mixWaterStreams([
            { quality: effStreams['outlet'], flow: Math.max(0, effStreams['outlet'].flowRate) },
            { quality: effStreams['sludge_outlet'], flow: Math.max(0, effStreams['sludge_outlet'].flowRate) }
          ]));
          effStreams['outlet'] = mergedOverflow;
          effStreams['sludge_outlet'] = { ...effStreams['sludge_outlet'], flowRate: 0 };
          Object.assign(result.effluent, mergedOverflow);
        }
        if (effStreams['sludge_outlet']) {
          result.sludge = { ...(result.sludge ?? effStreams['sludge_outlet']), ...effStreams['sludge_outlet'] } as WaterQuality;
        }

        // Update unit state (per-port streams are authoritative)
        targetUnit.lastInletQuality = sanitizeStream(mergedInlet);
        targetUnit.lastOutletQuality = sanitizeStream(result.effluent);
        targetUnit.portStreams = Object.fromEntries(
          Object.entries(effStreams).map(([k, v]) => [k, sanitizeStream(v)])
        );
        targetUnit.gasStreams = result.gasStreams ?? {};
        targetUnit.lastPowerKwActual = Number.isFinite(result.powerKw) ? result.powerKw : 0;
        targetUnit.lastOpexActual = Number.isFinite(result.opexDay) ? result.opexDay : 0;
        targetUnit.efficiencyRating = Math.round(result.efficiency);
        // Persist pump station runtime telemetry for live UI readout
        if (unit.typeId === 'pump_station' && result.pumpRuntime) {
          targetUnit.pumpRuntime = { ...result.pumpRuntime };
        }
        // MBR membrane fouling: READ by the process model (it returns the
        // current state in result.mbrFouling); ADVANCE it once per tick here
        // (outside the relaxation loop) so resistance accumulates per day,
        // not per solver pass. dtDays is the actual elapsed sim time.
        if (unit.typeId === 'mbr_membrane' && result.mbrFouling) {
          const mem = targetUnit.blueprint?.equipment as
            { materialId?: string; airScourNm3hPerM2?: number; moduleCount?: number; areaPerModuleM2?: number } | undefined;
          const installedAreaM2 = (mem?.moduleCount ?? 9) * (mem?.areaPerModuleM2 ?? 850);
          const fluxLmh = installedAreaM2 > 0
            ? (mergedInlet.flowRate * 1000) / (24 * installedAreaM2)
            : FOUL_FLUX_REF_LMH;
          const next = advanceMbrFouling({
            prev: targetUnit.mbrFouling ?? { ...FRESH_MBR_FOULING },
            materialId: mem?.materialId ?? 'pvdf_hollow_fiber',
            feedTssMgL: mergedInlet.tss,
            fluxLmh,
            airScourNm3hPerM2: mem?.airScourNm3hPerM2 ?? SCOUR_MIN_NM3H_PER_M2,
            dtDays: env?.dtDays ?? 0,
          });
          targetUnit.mbrFouling = { ...next };
        }
        // sludgeBlanketHeight is a 0..1 FRACTION in ProcessResult; the unit
        // field is named …Percent and every reader (UnitDesigner, clarifier
        // process model) divides it by 100 — so store REAL percent here.
        // (Historically the raw fraction was stored, making blankets read
        // ~0.5% and permanently disabling the overload feedback.)
        targetUnit.sludgeBlanketHeightPercent =
          typeof result.sludgeBlanketHeight === 'number' && Number.isFinite(result.sludgeBlanketHeight)
            ? Math.max(0, Math.min(98, result.sludgeBlanketHeight * 100))
            : undefined;
        targetUnit.dissolvedOxygenActual =
          result.dissolvedOxygen !== undefined && Number.isFinite(result.dissolvedOxygen)
            ? result.dissolvedOxygen : undefined;
        targetUnit.mlssActual =
          result.mlss !== undefined && Number.isFinite(result.mlss) ? result.mlss : undefined;
        targetUnit.sviActual =
          result.svi !== undefined && Number.isFinite(result.svi) ? result.svi : undefined;
      }
    }

    if (!converged) {
      // Diagnostic (never fatal): surface it so tuning can react, but keep the
      // last relaxed state — it is still mass-conserving per unit.
      console.warn(
        `[AquaTycoon sim] hydraulic network did not fully converge within ${MAX_ITERATIONS} passes ` +
        `(worst residual ${(worstResidual * 100).toFixed(1)}% at ${worstResidualKey}). ` +
        `Check for pathological recycle topologies.`
      );
    }

    // 3. Find Outfall Units & Calculate Final Effluent
    //    Uses the outfall's OUTLET quality so cascade re-aeration is included.
    const outfallUnits = units.filter(u => u.typeId === 'effluent_outfall');
    let finalEffluent = emptyWater();

    if (outfallUnits.length > 0) {
      const outfallStreams = outfallUnits.map(o => {
        const u = unitMap.get(o.instanceId)!;
        const q = u.lastOutletQuality || u.lastInletQuality || emptyWater();
        return { quality: q, flow: q.flowRate || 0 };
      });
      finalEffluent = mixWaterStreams(outfallStreams);
    }

    // 4. Calculate Overall Removal & Plant Stats
    const inf = influentSpec;
    const eff = finalEffluent;
    const hasFlow = eff.flowRate > 10;

    const bodRem = hasFlow && inf.bod > 0 ? Math.max(0, Math.min(100, ((inf.bod - eff.bod) / inf.bod) * 100)) : 0;
    const codRem = hasFlow && inf.cod > 0 ? Math.max(0, Math.min(100, ((inf.cod - eff.cod) / inf.cod) * 100)) : 0;
    const tssRem = hasFlow && inf.tss > 0 ? Math.max(0, Math.min(100, ((inf.tss - eff.tss) / inf.tss) * 100)) : 0;
    const tnRem  = hasFlow && inf.tn > 0  ? Math.max(0, Math.min(100, ((inf.tn - eff.tn) / inf.tn) * 100)) : 0;
    const tpRem  = hasFlow && inf.tp > 0  ? Math.max(0, Math.min(100, ((inf.tp - eff.tp) / inf.tp) * 100)) : 0;
    const pathogenLogKill = (hasFlow && eff.pathogens > 0 && inf.pathogens > 0)
      ? Math.max(0, Math.log10(inf.pathogens / Math.max(1, eff.pathogens)))
      : 0;

    // Power & Gas aggregation
    //   generation  = sum of all producer units (negative demand convention)
    //   selfConsumed = min(generation, demand)      — offsets on-site load
    //   gridImport   = max(demand − generation, 0)  — what we PAY for
    //   export       = max(generation − demand, 0)  — only surplus earns revenue
    let totalPowerDemandKw = 0;
    let totalGreenGenerationKw = 0;
    let totalUnitOpex = 0;

    for (const u of unitMap.values()) {
      if (u.lastPowerKwActual > 0) {
        totalPowerDemandKw += u.lastPowerKwActual;
      } else if (u.lastPowerKwActual < 0) {
        // All green generation: biogas CHP + solar PV + wind turbines
        totalGreenGenerationKw += Math.abs(u.lastPowerKwActual);
      }
      totalUnitOpex += (u.lastOpexActual || 0);
    }

    const selfConsumedKw = Math.min(totalGreenGenerationKw, totalPowerDemandKw);
    const gridImportKw = Math.max(0, totalPowerDemandKw - totalGreenGenerationKw);
    const exportedKw = Math.max(0, totalGreenGenerationKw - totalPowerDemandKw);
    const netPowerKw = gridImportKw; // grid cost applies to imports only
    const energySelfSufficiency = totalPowerDemandKw > 0
      ? Math.min(100, (selfConsumedKw / totalPowerDemandKw) * 100)
      : (totalGreenGenerationKw > 0 ? 100 : 0);

    // 5. Compliance Check against Environmental Standards
    // SINGLE SOURCE OF TRUTH (Prompt §A3): the criteria live ONLY in
    // PermitEngine — this engine, the HUD, Operator Console, PFD and advisories
    // all consume the same evaluator. No duplicated formula sets.
    const permitCriteria = evaluatePermitCriteria(eff, standards);
    const violations: string[] = [];
    let criteriaChecked = 0;
    if (hasFlow) {
      for (const cr of permitCriteria) {
        criteriaChecked++;
        if (!cr.pass) violations.push(cr.engineMessage);
      }
    } else {
      violations.push('No treated effluent flow reaching outfall!');
    }

    const maxPoints = Math.max(1, criteriaChecked); // derived, never hardcoded
    const complianceScore = hasFlow ? Math.max(0, Math.round(((maxPoints - violations.length) / maxPoints) * 100)) : 0;

    // 6. Economic Calculations (Per Day)
    const dailyTreatedM3 = eff.flowRate;
    const dailyTariffRevenue = complianceScore >= 80 ? (dailyTreatedM3 * tariffPerM3) : (dailyTreatedM3 * tariffPerM3 * 0.4);
    const dailyExportRevenue = exportedKw * 24 * powerCostPerKwh; // ONLY surplus export is credited
    const dailyBiogasElectricityRevenue = dailyExportRevenue;
    const dailyPowerCost = netPowerKw * 24 * powerCostPerKwh;
    const dailyChemicalCost = totalUnitOpex * 0.4;
    const dailySludgeCost = (dailyTreatedM3 * 0.001) * sludgeDisposalCostPerTon;
    const dailyFines = violations.length > 0 && hasFlow ? (violations.length * 850) : (hasFlow ? 0 : 200);

    const totalDailyOpex = dailyPowerCost + dailyChemicalCost + dailySludgeCost + totalUnitOpex * 0.6;
    const totalDailyRevenue = dailyTariffRevenue + dailyBiogasElectricityRevenue;
    // municipal finance: base financing cost is zero here — GameManager layers
    // overdraft interest on top based on negative cash balance (tycoon iter 39).
    const dailyFinancingCost = 0;
    const netDailyProfit = totalDailyRevenue - totalDailyOpex - dailyFines - dailyFinancingCost;

    const activeAlerts: PlantOverallStats['activeAlerts'] = [];
    if (violations.length > 0 && hasFlow) {
      activeAlerts.push({
        id: 'viol_alert',
        type: 'error',
        message: `Regulatory Standard Exceeded: ${violations.join(', ')}`,
        timestamp: Date.now()
      });
    }
    if (energySelfSufficiency > 50) {
      activeAlerts.push({
        id: 'green_energy_alert',
        type: 'success',
        message: `High Green Energy: Plant is ${energySelfSufficiency.toFixed(0)}% self-sufficient!`,
        timestamp: Date.now()
      });
    }

    const overallStats: PlantOverallStats = {
      complianceScore,
      overallBodRemoval: bodRem,
      overallCodRemoval: codRem,
      overallTssRemoval: tssRem,
      overallTnRemoval: tnRem,
      overallTpRemoval: tpRem,
      overallPathogenLogKill: pathogenLogKill,
      totalPowerDemandKw,
      totalGreenGenerationKw,
      energySelfSufficiencyPercent: energySelfSufficiency,
      publicApproval: Math.max(10, Math.min(100, complianceScore + (energySelfSufficiency > 40 ? 10 : 0))),
      activeAlerts
    };

    const financials: GameFinancials = {
      cash: currentFinancials.cash,
      dailyRevenue: totalDailyRevenue,
      dailyOpex: totalDailyOpex,
      dailyPowerCost,
      dailyChemicalCost,
      dailySludgeDisposalCost: dailySludgeCost,
      dailyBiogasRevenue: dailyBiogasElectricityRevenue,
      dailyFines,
      dailyFinancingCost,
      dailyReclaimBonus: 0,
      totalTreatedM3: currentFinancials.totalTreatedM3, // accumulated by GameManager per simulated day
      netDailyProfit
    };

    refreshPipeHydraulics(updatedPipes);

    return {
      updatedUnits: Array.from(unitMap.values()),
      updatedPipes,
      finalEffluent,
      overallStats,
      financials,
      converged,
      iterationsUsed: iter
    };
  }
}
