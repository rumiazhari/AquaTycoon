/**
 * Hydraulics (Prompts §K/L/M) — lumped steady-state engineering models.
 *
 * Pipe flow: Darcy-Weisbach with Colebrook-White friction (Swamee-Jain form).
 * Pumps: Hsystem = Hstatic + KQ² intersected with Hpump = H0 − kQ².
 *
 * Units: Q in m³/h internally for curve math; conversions documented inline.
 */

import { PIPE_MATERIALS } from '../../design/catalogs/Equipment';
import type { PumpModel } from '../../design/catalogs/Equipment';

const G = 9.81;

// ── Pipe hydraulics ──────────────────────────────────────────────────────────

/** 3D path length in world cells → meters (1 cell = 6 m). */
export function pathLengthM(pathPoints: Array<[number, number, number]>): number {
  if (pathPoints.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < pathPoints.length; i++) {
    const dx = pathPoints[i][0] - pathPoints[i - 1][0];
    const dy = pathPoints[i][1] - pathPoints[i - 1][1];
    const dz = pathPoints[i][2] - pathPoints[i - 1][2];
    sum += Math.hypot(dx, dy, dz);
  }
  return sum * 6;
}

/** Swamee-Jain explicit Colebrook-White friction factor. */
export function frictionFactor(
  Re: number,
  roughnessM: number,
  diameterM: number
): number {
  if (Re < 2300) return 64 / Math.max(1e-6, Re); // laminar
  return (
    0.25 /
    Math.log10(
      roughnessM / (3.7 * diameterM) + 5.74 / Math.pow(Re, 0.9)
    ) ** 2
  );
}

export interface PipeHydraulicResult {
  lengthM: number;
  areaM2: number;
  velocityMs: number;
  velocityHeadM: number;
  frictionHeadlossM: number;
  minorHeadlossM: number;
  totalHeadlossM: number;
  reynolds: number;
}

/**
 * Steady-state pipe evaluation. Q_m3day is the daily volume; the model uses
 * mean velocity over 24 h (gameplay lumping — peaks handled at design level).
 */
export function evaluatePipeHydraulics(
  diameterM: number,
  materialId: string | undefined,
  lengthM: number,
  qM3Day: number,
  minorLossK: number = 2.5
): PipeHydraulicResult {
  const mat = PIPE_MATERIALS[materialId ?? 'pvc'] ?? PIPE_MATERIALS.pvc;
  const D = Math.max(0.02, diameterM);
  const A = (Math.PI * D * D) / 4;
  // m³/day → m³/s
  const Q = qM3Day / 86400;
  const v = Q / A;
  const nu = 1.31e-6; // kinematic viscosity of water @10°C, m²/s
  const Re = (v * D) / nu;
  const f = frictionFactor(Re, mat.roughnessM, D);
  const vHead = (v * v) / (2 * G);
  const hf = (f * (lengthM / D)) * vHead;
  const hm = minorLossK * vHead;
  return {
    lengthM,
    areaM2: A,
    velocityMs: v,
    velocityHeadM: vHead,
    frictionHeadlossM: hf,
    minorHeadlossM: hm,
    totalHeadlossM: hf + hm,
    reynolds: Re,
  };
}

// ── Pump / system duty point (Prompt §M) ─────────────────────────────────────

export interface PumpDutyPoint {
  /** Found operating point. Null when pump cannot deliver any useful flow. */
  ok: boolean;
  flowM3h: number;
  headM: number;
  /** Hydraulic power ρgQH/η_pump/η_motor → electrical kW. */
  electricalPowerKw: number;
  reason?: string;
}

/**
 * Intersect Hpump(Q) = H0 − k·Q² with Hsystem(Q) = Hstatic + K·Q².
 * Analytic solution: Q* = sqrt((H0 − Hstatic)/(k + K)).
 */
export function findPumpDutyPoint(
  pump: PumpModel,
  staticLiftM: number,
  systemKM2perM3h2: number,
  speedFraction: number = 1.0
): PumpDutyPoint {
  const s = Math.max(pump.minSpeedFraction, Math.min(1, speedFraction));
  // Affinity laws for reduced speed.
  const H0 = pump.shutoffHeadM * s * s;
  const k = pump.curveKM2perM3h2; // k scales as 1/s² at reduced speed...
  const kEff = pump.curveKM2perM3h2;
  void k;

  const denom = kEff + systemKM2perM3h2;
  const rise = H0 - staticLiftM;
  if (rise <= 0) {
    // Shutoff head below static lift even at full speed → no delivery.
    if (s >= 0.999) {
      return { ok: false, flowM3h: 0, headM: staticLiftM, electricalPowerKw: pump.capex > 0 ? 0.5 : 0, reason: 'no_valid_operating_point' };
    }
    return { ok: false, flowM3h: 0, headM: staticLiftM, electricalPowerKw: 0.4, reason: 'speed_too_low' };
  }
  const flow = Math.sqrt(rise / denom);
  const head = staticLiftM + systemKM2perM3h2 * flow * flow;
  // Hydraulic power: ρ g Q H (Q in m³/s), divided by efficiencies.
  const Qm3s = flow / 3600;
  const hydraulicKw = (1000 * G * Qm3s * head) / 1000;
  const wireKw = hydraulicKw / (pump.pumpEfficiency * pump.motorEfficiency);
  return { ok: true, flowM3h: flow, headM: head, electricalPowerKw: wireKw };
}

/** System-curve coefficient for a pipe run: H = Hstatic + K·Q² (Q in m³/h). */
export function systemCurveK(headlossAtRefM: number, refFlowM3h: number): number {
  if (refFlowM3h <= 0) return 0;
  return headlossAtRefM / (refFlowM3h * refFlowM3h);
}

// ── Gravity check (Prompt §L) ───────────────────────────────────────────────

export interface GravityResult {
  canFlowByGravity: boolean;
  availableHeadM: number; // start invert − end invert − headloss
}

export function evaluateGravityFlow(
  startInvertM: number,
  endInvertM: number,
  totalHeadlossM: number
): GravityResult {
  const availableHeadM = startInvertM - endInvertM - totalHeadlossM;
  return { canFlowByGravity: availableHeadM >= 0, availableHeadM };
}
