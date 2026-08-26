/**
 * DesignValidator (Prompt §AE) — engineering warnings classified
 * INFO / WARNING / CRITICAL. Warnings never hard-block construction: failure
 * is allowed to teach, but the player must see it coming.
 */

import type { PlacedUnit } from '../types/simulation';
import { planAreaM2, structuralDepthM, type BasinGeometry } from './Geometry';
import { casDesignPoint } from '../sim/processes/ActivatedSludge';
import { evaluateClarifierLoad } from '../sim/processes/Clarifier';
import {
  evaluatePipeHydraulics,
  findPumpDutyPoint,
  systemCurveK,
} from '../sim/hydraulics/PipeHydraulics';
import { PUMP_MODELS, REDUNDANCY_CONFIGS, type PumpModel } from './catalogs/Equipment';
import type { PumpingDesign } from './UnitBlueprint';

export type DesignIssueSeverity = 'info' | 'warning' | 'critical';

export interface DesignIssue {
  severity: DesignIssueSeverity;
  code: string;
  message: string;
  /** Live engineering numbers backing the warning. */
  detail?: string;
}

export function validateUnitDesign(unit: PlacedUnit): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const bp = unit.blueprint;
  if (!bp) return issues;

  // Generic structural sanity applies to every engineered asset.
  issues.push(...validateStructuralGeometry(bp.design.geometry));

  switch (bp.processType) {
    case 'activated_sludge_cas': {
      const geo = bp.design.geometry;
      const depth = geo.shape === 'rect' ? geo.waterDepthM : geo.sideWaterDepthM;

      if (depth < 3) {
        issues.push({
          severity: 'warning', code: 'cas_depth_low',
          message: `Basin water depth ${depth.toFixed(1)} m is shallow — diffuser oxygen transfer drops and blowers work harder.`,
        });
      }
      if (depth > 7.5) {
        issues.push({ severity: 'warning', code: 'cas_depth_high', message: `Depth ${depth.toFixed(1)} m exceeds common blower pressure ratings.` });
      }
      if (geo.freeboardM < 0.4) {
        issues.push({ severity: 'warning', code: 'freeboard_low', message: `Freeboard ${geo.freeboardM.toFixed(2)} m risks foam/weir overflow.` });
      }
      if (geo.numberOfParallelTrains > 1 && bp.processType === 'activated_sludge_cas') {
        const cas = bp.equipment as import('./UnitBlueprint').CASDesign;
        if (cas.blowerRedundancyId === 'single_100' || cas.blowerRedundancyId === 'two_duty') {
          issues.push({
            severity: 'critical', code: 'no_redundancy_multitrain',
            message: `${geo.numberOfParallelTrains} trains share a blower with no standby — a single failure stops aeration plant-wide.`,
          });
        }
      }

      // Capacity vs demand at the level's design flow (approximation for UI).
      const designFlow = estimateDesignFlow(unit);
      const dp = casDesignPoint(unit, 250, 30, designFlow);
      if (dp && dp.capacityMarginRatio < 1.0) {
        issues.push({
          severity: 'critical', code: 'blower_undersized',
          message: `Installed aeration transfers ~${Math.round(dp.fieldTransferCapacityKgDay)} kg O₂/d but calculated demand is ~${Math.round(dp.netDemandKgDay)} kg O₂/d.`,
          detail: `Margin ${(dp.capacityMarginRatio * 100).toFixed(0)}% — add blower capacity, more/better diffusers, or more volume.`,
        });
      } else if (dp && dp.capacityMarginRatio > 2.5) {
        issues.push({
          severity: 'info', code: 'blower_oversized',
          message: `Aeration capacity ${(dp.capacityMarginRatio * 100).toFixed(0)}% of demand — capital sitting idle; consider smaller blowers.`,
        });
      }
      if (dp) {
        if (dp.hrtHoursAtDesignFlow < 4) {
          issues.push({ severity: 'warning', code: 'hrt_short', message: `HRT only ${dp.hrtHoursAtDesignFlow.toFixed(1)} h at design flow (conventional CAS usually 4–8 h).` });
        }
        if (dp.fmRatioDay > 0.35) {
          issues.push({ severity: 'warning', code: 'fm_high', message: `F/M ${dp.fmRatioDay.toFixed(2)} d⁻¹ is above the conventional range (0.2–0.35) — bulking risk.` });
        }
        if (dp.fmRatioDay < 0.05 && dp.fmRatioDay > 0) {
          issues.push({ severity: 'info', code: 'fm_low', message: `F/M ${dp.fmRatioDay.toFixed(2)} d⁻¹ — extended aeration territory; watch MLSS creep.` });
        }
      }
      break;
    }

    case 'secondary_clarifier': {
      // Nominal check at a reference mixed-liquor feed.
      const area = planAreaM2(bp.design.geometry);
      const refForward = estimateDesignFlow(unit);
      const load = evaluateClarifierLoad(bp.design.geometry, refForward, 3200, refForward * 1.75, 0.25);
      if (load.sorM3M2Day > 24) {
        issues.push({
          severity: load.sorM3M2Day > 33 ? 'critical' : 'warning',
          code: 'sor_excessive',
          message: `SOR ${load.sorM3M2Day.toFixed(1)} m/d exceeds ${load.sorM3M2Day > 33 ? 'hard' : 'recommended'} limits at design flow.`,
          detail: 'Solids will carry over at peak. Enlarge diameter / add trains.',
        });
      }
      if (area < 40) {
        issues.push({ severity: 'info', code: 'clarifier_small', message: 'Compact clarifier: fine at low flow, fragile under storm peaks.' });
      }
      break;
    }

    case 'pump_station': {
      const design = bp.equipment as PumpingDesign;
      const model = PUMP_MODELS[design?.pumpModelId ?? 'sewage_wedge_400'];
      if (!model) break;
      const sumpGeo = bp.design.geometry;
      const sumpDepth = sumpGeo.shape === 'rect' ? sumpGeo.waterDepthM : sumpGeo.sideWaterDepthM;
      issues.push(...evaluatePumpStationDesign(
        model,
        design?.redundancyId ?? 'single_100',
        design?.staticLiftM ?? 3.5,
        sumpDepth,
        estimateDesignFlow(unit) / 24
      ));
      break;
    }
  }

  return issues;
}

/** Rough per-unit design flow used by validator heuristics (m³/d). */
function estimateDesignFlow(_unit: PlacedUnit): number {
  // Phase-1 heuristic: typical municipal module scale; replaced by contract
  // design flow once contracts carry it through placement context.
  return 5000;
}

// ── Structural sanity (Prompt §AM "unrealistic structural dimensions") ───────

/**
 * Generic civil-engineering plausibility checks for ANY engineered geometry.
 * Template defaults must pass clean — these fire only when a designer
 * genuinely draws something that cannot be built or cannot hold water.
 */
export function validateStructuralGeometry(geo: BasinGeometry): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const depth = geo.shape === 'rect' ? geo.waterDepthM : geo.sideWaterDepthM;
  const area = planAreaM2(geo);

  if (area < 1 || depth < 0.05) {
    issues.push({
      severity: 'critical', code: 'dimensions_impossible',
      message: `Unrealistic structure: ${area.toFixed(1)} m² plan area at ${depth.toFixed(2)} m water depth cannot hold water.`,
    });
    return issues;
  }
  if (depth > 12) {
    issues.push({
      severity: 'warning', code: 'depth_unrealistic',
      message: `${depth.toFixed(1)} m water depth exceeds common municipal construction practice.`,
    });
  }
  if (geo.shape === 'rect') {
    const aspect = geo.lengthM / Math.max(1, geo.widthM);
    if (aspect > 8) {
      issues.push({
        severity: 'info', code: 'aspect_unusual',
        message: `Aspect ratio ${aspect.toFixed(1)}:1 is unusual — long thin basins cost more concrete per m³ and mix poorly.`,
      });
    }
  } else if (geo.diameterM > 60) {
    issues.push({
      severity: 'warning', code: 'diameter_unrealistic',
      message: `Ø${geo.diameterM.toFixed(0)} m exceeds practical circular construction (>60 m).`,
    });
  }

  const structDepth = structuralDepthM(geo);
  const minWall = Math.max(0.15, structDepth / 30);
  if (geo.wallThicknessM < minWall) {
    issues.push({
      severity: 'critical', code: 'wall_too_thin',
      message: `Walls ${(geo.wallThicknessM * 1000).toFixed(0)} mm are unrealistically thin against ${(structDepth).toFixed(1)} m of head (≥${(minWall * 1000).toFixed(0)} mm expected).`,
    });
  } else if (geo.wallThicknessM > 1.2) {
    issues.push({
      severity: 'info', code: 'walls_overbuilt',
      message: `${geo.wallThicknessM.toFixed(2)} m walls are over-built for this head — wasted concrete budget.`,
    });
  }
  if (geo.floorThicknessM < 0.12) {
    issues.push({
      severity: 'critical', code: 'floor_too_thin',
      message: `Floor slab ${(geo.floorThicknessM * 1000).toFixed(0)} mm cannot resist uplift and loads (≥120 mm minimum practice).`,
    });
  }
  if (geo.freeboardM < 0.3) {
    issues.push({
      severity: 'warning', code: 'freeboard_low_generic',
      message: `Freeboard ${geo.freeboardM.toFixed(2)} m is insufficient — storm peaks and foam will spill over the wall.`,
    });
  }
  if (geo.numberOfParallelTrains > 8) {
    issues.push({
      severity: 'info', code: 'many_trains',
      message: `${geo.numberOfParallelTrains} parallel trains — consider larger units to cut piping and complexity.`,
    });
  }
  return issues;
}

// ── Pump-station engineering (§AM: duty point, NPSH margin, standby) ─────────

const ATMOSPHERIC_PRESSURE_HEAD_M = 10.33;
const VAPOR_PRESSURE_ALLOWANCE_M = 0.45;
/**
 * Phase-1 heuristic friction allowance for the discharge run at demand flow,
 * until sized pipes feed the validator's design context (§AK item 8 wiring).
 */
const NOMINAL_DISCHARGE_FRICTION_M = 1.5;

/**
 * Real pump-station design audit: does the installed bank have a duty point
 * at the design flow, enough NPSH margin, and standby where failure would
 * stop the plant? Pure so tests can probe catalog-independent cases.
 */
export function evaluatePumpStationDesign(
  model: PumpModel,
  redundancyId: string,
  staticLiftM: number,
  sumpDepthM: number,
  demandM3h: number
): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const red = REDUNDANCY_CONFIGS[redundancyId] ?? REDUNDANCY_CONFIGS.single_100;

  // Missing standby where there is no graceful degradation path (§AM).
  if (red.id === 'single_100') {
    issues.push({
      severity: 'warning', code: 'no_standby_pump',
      message: `${model.label} runs alone with no standby — one mechanical failure halts all pumping through this station.`,
      detail: 'Duty+standby redundancy keeps the line alive through a failure.',
    });
  } else if (red.capacityWithOneDown < 1) {
    issues.push({
      severity: 'info', code: 'partial_capacity_no_standby',
      message: `${red.label}: losing one unit leaves only ${(red.capacityWithOneDown * 100).toFixed(0)}% capacity with no full standby.`,
    });
  }

  // Duty point at design demand: static lift + nominal friction vs pump curve.
  const Ksys = systemCurveK(NOMINAL_DISCHARGE_FRICTION_M, Math.max(1, demandM3h));
  const duty = findPumpDutyPoint(model, staticLiftM, Ksys);
  if (!duty.ok) {
    issues.push({
      severity: 'critical', code: 'no_duty_point',
      message: `No valid duty point: shutoff head ${model.shutoffHeadM.toFixed(1)} m cannot overcome ${staticLiftM.toFixed(1)} m static lift plus friction.`,
      detail: 'Choose a higher-head pump or reduce the static lift.',
    });
    return issues;
  }
  // Curve-end guard (backlog #3): an intersection beyond runout means the
  // system is too easy for this pump — it would ride off the end of its own
  // curve. The duty solver caps flow there; warn that the selection is wrong.
  if (duty.atRunout) {
    issues.push({
      severity: 'warning', code: 'pump_at_runout',
      message: `${model.label}'s duty intersection lies beyond its curve end — flow caps at ~${Math.round(duty.flowM3h)} m³/h (runout); continuous operation there overloads the motor and wrecks efficiency.`,
      detail: 'Pick a lower-flow / higher-head pump, or add a VFD or throttle valve to pull the operating point back toward BEP.',
    });
  }
  const installedCapacityM3h = model.ratedFlowM3h * red.unitCount;
  if (installedCapacityM3h < demandM3h * 0.98) {
    issues.push({
      severity: 'critical', code: 'pump_undersized',
      message: `Station delivers ~${Math.round(installedCapacityM3h)} m³/h but design flow is ~${Math.round(demandM3h)} m³/h.`,
      detail: 'Add pumps, pick a larger model, or lower the design flow.',
    });
  } else if (red.unitCount > 1 &&
             installedCapacityM3h * red.capacityWithOneDown < demandM3h) {
    issues.push({
      severity: 'warning', code: 'no_margin_one_down',
      message: `With one pump down only ~${Math.round(installedCapacityM3h * red.capacityWithOneDown)} m³/h remains vs ~${Math.round(demandM3h)} m³/h design flow.`,
    });
  }
  const bepFraction = Math.min(demandM3h, installedCapacityM3h) / model.ratedFlowM3h;
  if (bepFraction < 0.4 && demandM3h > 0) {
    issues.push({
      severity: 'info', code: 'pump_far_from_bep',
      message: `Design flow sits at only ${(bepFraction * 100).toFixed(0)}% of BEP — energy is wasted far off the efficient point.`,
    });
  }

  // NPSH margin: atmosphere + sump submergence − vapor pressure − suction losses.
  const suctionLossM = 0.5 + 0.5 * Math.pow(demandM3h / model.ratedFlowM3h, 2);
  const npshAvailableM =
    ATMOSPHERIC_PRESSURE_HEAD_M + sumpDepthM - VAPOR_PRESSURE_ALLOWANCE_M - suctionLossM;
  if (npshAvailableM < model.npshRequiredM) {
    issues.push({
      severity: 'critical', code: 'npsh_insufficient',
      message: `NPSH available ≈${npshAvailableM.toFixed(1)} m is below the pump's ${model.npshRequiredM.toFixed(1)} m requirement — cavitation will destroy the impeller.`,
      detail: 'Deepen the sump or choose a low-NPSH pump.',
    });
  } else if (npshAvailableM < model.npshRequiredM * 1.25) {
    issues.push({
      severity: 'warning', code: 'npsh_margin_thin',
      message: `Thin NPSH margin: ≈${npshAvailableM.toFixed(1)} m available vs ${model.npshRequiredM.toFixed(1)} m required (<25% design margin).`,
    });
  }
  return issues;
}

export function validatePipeVelocity(diameterM: number, materialId: string | undefined, qM3Day: number, lengthM: number): DesignIssue[] {
  const h = evaluatePipeHydraulics(diameterM, materialId, lengthM, qM3Day);
  const issues: DesignIssue[] = [];
  if (h.velocityMs > 2.5) {
    issues.push({ severity: 'warning', code: 'velocity_high', message: `Pipe velocity ${h.velocityMs.toFixed(2)} m/s is aggressive (>2.5 m/s) — headloss ${h.totalHeadlossM.toFixed(1)} m over ${lengthM.toFixed(0)} m.` });
  } else if (h.velocityMs < 0.4 && qM3Day > 50) {
    issues.push({ severity: 'info', code: 'velocity_low', message: `Velocity ${h.velocityMs.toFixed(2)} m/s is low — solids may settle out in the line (<0.6 m/s self-cleaning).` });
  }
  return issues;
}
