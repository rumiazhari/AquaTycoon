import { GameFinancials, PlantOverallStats } from '../types/game';
import { PipeConnection, PlacedUnit, TreatmentStandard, WaterQuality } from '../types/simulation';
import { calculateUnitProcess, ProcessResult } from './UnitProcessModels';
import { cloneWater, emptyWater, mixWaterStreams } from './WaterStream';

export interface SimulationStepResult {
  updatedUnits: PlacedUnit[];
  updatedPipes: PipeConnection[];
  finalEffluent: WaterQuality;
  overallStats: PlantOverallStats;
  financials: GameFinancials;
}

export class SimulationEngine {
  /**
   * Solves the complete hydraulic and biochemical network for one simulation tick.
   */
  public static stepSimulation(
    units: PlacedUnit[],
    pipes: PipeConnection[],
    influentSpec: WaterQuality,
    standards: TreatmentStandard,
    currentFinancials: GameFinancials,
    tariffPerM3: number,
    powerCostPerKwh: number = 0.15,
    sludgeDisposalCostPerTon: number = 45
  ): SimulationStepResult {
    const unitMap = new Map<string, PlacedUnit>();
    units.forEach(u => unitMap.set(u.instanceId, { ...u }));

    const updatedPipes = pipes.map(p => ({ ...p }));
    const unitResults = new Map<string, ProcessResult>();

    // 1. Find Influent Inlet units and set their initial outlet stream
    const inletUnits = units.filter(u => u.typeId === 'influent_inlet');
    for (const inlet of inletUnits) {
      const liveInfluent = cloneWater(influentSpec);
      unitMap.get(inlet.instanceId)!.lastOutletQuality = liveInfluent;
    }

    // 2. Iterative network relaxation solver (handles loops like RAS recycle and internal nitrate recycles)
    const MAX_ITERATIONS = 4;
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Propagate flow along each pipe
      for (const pipe of updatedPipes) {
        const fromUnit = unitMap.get(pipe.fromUnitId);
        if (!fromUnit) continue;

        let sourceQuality = fromUnit.lastOutletQuality || emptyWater();
        if (pipe.fromPortId === 'sludge_outlet' && fromUnit.lastSludgeQuality) {
          sourceQuality = fromUnit.lastSludgeQuality;
        }

        pipe.quality = cloneWater(sourceQuality);
        pipe.flowRate = sourceQuality.flowRate;
      }

      // Compute each unit's inlet from all connected pipes to its inlet ports
      for (const unit of units) {
        if (unit.typeId === 'influent_inlet') continue;

        // Incoming streams to liquid inlets
        const incomingLiquidPipes = updatedPipes.filter(
          p => p.toUnitId === unit.instanceId && (p.toPortId === 'inlet' || p.toPortId === 'ras_inlet')
        );

        let mergedInlet = emptyWater();
        if (incomingLiquidPipes.length > 0) {
          mergedInlet = mixWaterStreams(
            incomingLiquidPipes.map(p => ({ quality: p.quality, flow: p.flowRate }))
          );
        }

        // BUG FIX: track the main-line (forward) hydraulic throughput separately from
        // recycles (RAS / internal nitrate). Without this, recycle loops compounded
        // flow every relaxation pass and inflated plant throughput ~4x.
        const forwardInflow = incomingLiquidPipes
          .filter(p => p.toPortId === 'inlet')
          .reduce((acc, p) => acc + p.flowRate, 0);

        // Run unit process calculation
        const result = calculateUnitProcess(unit, mergedInlet, forwardInflow);
        unitResults.set(unit.instanceId, result);

        // Update unit state
        const targetUnit = unitMap.get(unit.instanceId)!;
        targetUnit.lastInletQuality = mergedInlet;
        targetUnit.lastOutletQuality = result.effluent;
        targetUnit.lastSludgeQuality = result.sludge;
        targetUnit.lastGasProducedM3Day = result.gasProducedM3Day;
        targetUnit.lastPowerKwActual = result.powerKw;
        targetUnit.lastOpexActual = result.opexDay;
        targetUnit.efficiencyRating = result.efficiency;
        targetUnit.sludgeBlanketHeightPercent = result.sludgeBlanketHeight;
        targetUnit.dissolvedOxygenActual = result.dissolvedOxygen;
        targetUnit.mlssActual = result.mlss;
        targetUnit.sviActual = result.svi;
      }
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
    let totalPowerDemandKw = 0;
    let totalBiogasGenerationKw = 0;
    let totalUnitOpex = 0;

    for (const u of unitMap.values()) {
      if (u.lastPowerKwActual > 0) {
        totalPowerDemandKw += u.lastPowerKwActual;
      } else if (u.lastPowerKwActual < 0) {
        totalBiogasGenerationKw += Math.abs(u.lastPowerKwActual);
      }
      totalUnitOpex += (u.lastOpexActual || 0);
    }

    const netPowerKw = Math.max(0, totalPowerDemandKw - totalBiogasGenerationKw);
    const energySelfSufficiency = totalPowerDemandKw > 0
      ? Math.min(100, (totalBiogasGenerationKw / totalPowerDemandKw) * 100)
      : 0;

    // 5. Compliance Check against Environmental Standards
    const violations: string[] = [];
    if (hasFlow) {
      if (eff.bod > standards.maxBod) violations.push(`BOD (${eff.bod.toFixed(1)} > ${standards.maxBod} mg/L)`);
      if (eff.cod > standards.maxCod) violations.push(`COD (${eff.cod.toFixed(1)} > ${standards.maxCod} mg/L)`);
      if (eff.tss > standards.maxTss) violations.push(`TSS (${eff.tss.toFixed(1)} > ${standards.maxTss} mg/L)`);
      if (eff.tn > standards.maxTn) violations.push(`TN (${eff.tn.toFixed(1)} > ${standards.maxTn} mg/L)`);
      if (eff.tp > standards.maxTp) violations.push(`TP (${eff.tp.toFixed(2)} > ${standards.maxTp} mg/L)`);
      if (eff.pathogens > standards.maxPathogens) violations.push(`Pathogens (${eff.pathogens.toFixed(0)} > ${standards.maxPathogens} CFU)`);
      if (eff.do < standards.minDo) violations.push(`DO (${eff.do.toFixed(1)} < ${standards.minDo} mg/L)`);
    } else {
      violations.push('No treated effluent flow reaching outfall!');
    }

    const maxPoints = 7;
    const complianceScore = hasFlow ? Math.max(0, Math.round(((maxPoints - violations.length) / maxPoints) * 100)) : 0;

    // 6. Economic Calculations (Per Day)
    const dailyTreatedM3 = eff.flowRate;
    const dailyTariffRevenue = complianceScore >= 80 ? (dailyTreatedM3 * tariffPerM3) : (dailyTreatedM3 * tariffPerM3 * 0.4);
    const dailyBiogasElectricityRevenue = totalBiogasGenerationKw * 24 * powerCostPerKwh;
    const dailyPowerCost = netPowerKw * 24 * powerCostPerKwh;
    const dailyChemicalCost = totalUnitOpex * 0.4;
    const dailySludgeCost = (dailyTreatedM3 * 0.001) * sludgeDisposalCostPerTon;
    const dailyFines = violations.length > 0 && hasFlow ? (violations.length * 850) : (hasFlow ? 0 : 200);

    const totalDailyOpex = dailyPowerCost + dailyChemicalCost + dailySludgeCost + totalUnitOpex * 0.6;
    const totalDailyRevenue = dailyTariffRevenue + dailyBiogasElectricityRevenue;
    const netDailyProfit = totalDailyRevenue - totalDailyOpex - dailyFines;

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
      totalBiogasGenerationKw,
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
      totalTreatedM3: currentFinancials.totalTreatedM3, // accumulated by GameManager per simulated day
      netDailyProfit
    };

    return {
      updatedUnits: Array.from(unitMap.values()),
      updatedPipes,
      finalEffluent,
      overallStats,
      financials
    };
  }
}
