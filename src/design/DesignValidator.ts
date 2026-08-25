/**
 * DesignValidator (Prompt §AE) — engineering warnings classified
 * INFO / WARNING / CRITICAL. Warnings never hard-block construction: failure
 * is allowed to teach, but the player must see it coming.
 */

import type { PlacedUnit } from '../types/simulation';
import { planAreaM2 } from './Geometry';
import { casDesignPoint } from '../sim/processes/ActivatedSludge';
import { evaluateClarifierLoad } from '../sim/processes/Clarifier';
import { evaluatePipeHydraulics } from '../sim/hydraulics/PipeHydraulics';

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
      issues.push({
        severity: 'info', code: 'check_duty_point',
        message: 'Verify the pump duty point against your piping headloss in DIAGNOSTICS.',
      });
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
