/**
 * Flat-water surface transform utilities (Prompt 3.4 items 11–16).
 *
 * ROOT CAUSE of the historical "vertical white poles in the river" bug:
 * water quads were baked FLAT into the XZ plane once (`geo.rotateX(-π/2)`),
 * but every instance then received a SECOND −90° X rotation via
 * `new THREE.Euler(-Math.PI/2, …)`. The double rotation stood the quads up
 * vertically, and the old tick() even round-tripped that wrong rotation by
 * decomposing the previous frame's matrix — preserving the error forever.
 *
 * THE RULE enforced here:
 *   • Geometry is baked horizontal EXACTLY ONCE at creation.
 *   • From then on, instance orientation is WORLD-Y YAW ONLY — Euler(0, yaw, 0).
 *   • Animation state is derived from IMMUTABLE BASE VALUES + time. The
 *     previous frame's instance matrix is never read back, so no cumulative
 *     drift is possible by construction.
 *
 * Everything here is PURE (deterministic, side-effect-free apart from writing
 * into the caller-supplied target objects) so it can be regression-tested
 * headlessly without WebGL.
 */
import * as THREE from 'three';

// Scratch objects — module-local, reused; safe because every exported entry
// point fully overwrites them before use and never leaks references.
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

/** Immutable per-particle foam description (item 13). Never mutated at runtime. */
export interface FoamParticle {
  /** Resting centre X (world). */
  baseX: number;
  /** Resting centre Z (world). */
  baseZ: number;
  /** World-Y yaw aligned with the LOCAL river tangent (item 14). */
  baseYaw: number;
  /** Instance X-scale (across the river). */
  baseWidth: number;
  /** Instance Z-scale (along the flow). */
  baseLength: number;
  /** Per-particle animation phase offset (radians). */
  phase: number;
  /** Longitudinal drift amplitude in world units (bounded oscillation). */
  driftAmplitude: number;
}

/** Flow-streak animation state: scalar progress along the river + lateral lane. */
export interface FlowStreak {
  /** Progress t∈[0,1) along the sampled river span (advanced + wrapped). */
  t: number;
  /** Signed lateral offset from the river centreline (world units). */
  u: number;
  /** Forward speed in progress-units per second baseline. */
  speed: number;
  /** Uniform size multiplier. */
  scale: number;
}

/** Tuning constants shared by builder and animator (kept in ONE place). */
export const FOAM_DRIFT_FREQUENCY = 0.7;   // rad/s of the drift wave
export const FOAM_PULSE_FREQUENCY = 1.9;   // rad/s of the width shimmer
export const FLOW_BOB_FREQUENCY = 3.0;     // rad/s vertical bobbing
export const FLOW_PULSE_FREQUENCY = 2.5;   // rad/s length shimmer
export const FLOW_BOB_AMPLITUDE = 0.03;    // world units
export const FLOW_PULSE_AMPLITUDE = 0.18;  // relative length modulation

/**
 * Compose an instance matrix that is GUARANTEED to lie flat on the water:
 *   • world-space normal of the instance stays (0, 1, 0)
 *   • rotation happens around world Y only
 *   • `width` scales X, `length` scales Z (the baked-flat geometry's long axis)
 *
 * This is the ONLY sanctioned way to orient a water-surface instance.
 */
export function composeFlatWaterMatrix(
  out: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  yaw: number,
  width: number,
  length: number
): THREE.Matrix4 {
  _euler.set(0, yaw, 0);
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  _scale.set(width, 1, length);
  return out.compose(_pos, _quat, _scale);
}

/**
 * Local river-flow yaw at height `z` (item 14):
 *   yaw = atan2(centerX(z+Δ) − centerX(z−Δ), 2Δ)
 * A straight river ⇒ 0; a rightward-meandering stretch ⇒ positive yaw.
 */
export function riverYawAt(
  riverCenterX: (z: number) => number,
  z: number,
  delta: number = 0.6
): number {
  const dx = riverCenterX(z + delta) - riverCenterX(z - delta);
  return Math.atan2(dx, 2 * delta);
}

/**
 * Full animated foam transform for one particle at simulation time `simTime`.
 *
 * PURE function of (particle, time): identical inputs always produce identical
 * outputs regardless of evaluation history — mathematically incapable of the
 * cumulative drift the old getMatrixAt/decompose architecture suffered.
 *
 * Drift moves the particle ALONG the local river tangent (baseYaw), so bank
 * foam breathes with the current instead of sliding sideways.
 */
export function foamTransform(
  p: FoamParticle,
  simTime: number
): { x: number; z: number; yaw: number; width: number; length: number } {
  const drift =
    Math.sin(simTime * FOAM_DRIFT_FREQUENCY + p.phase) * p.driftAmplitude;
  const pulse =
    1 + Math.sin(simTime * FOAM_PULSE_FREQUENCY + p.phase * 0.5) * 0.12;
  return {
    x: p.baseX + drift * Math.sin(p.baseYaw),
    z: p.baseZ + drift * Math.cos(p.baseYaw),
    yaw: p.baseYaw,
    width: p.baseWidth * pulse,
    length: p.baseLength,
  };
}

/**
 * Full animated transform for one flow streak.
 * `zMin`/`span` describe the sampled river reach; `centerX` is the meander.
 * The streak's progress `f.t` is advanced+wrapped by the caller (bounded
 * state, wrapped — never integrated into the matrix itself).
 */
export function flowStreakTransform(
  f: FlowStreak,
  simTime: number,
  zMin: number,
  span: number,
  centerX: (z: number) => number,
  waterY: number
): { x: number; y: number; z: number; yaw: number; sx: number; sz: number } {
  const z = zMin + f.t * span;
  // Yaw follows the local meander tangent so streaks align with the flow.
  const yaw = riverYawAt(centerX, z, 0.6);
  const bob = Math.sin(simTime * FLOW_BOB_FREQUENCY + f.u * 1.7) * FLOW_BOB_AMPLITUDE;
  const pulse = 1 + Math.sin(simTime * FLOW_PULSE_FREQUENCY + f.u * 2.1) * FLOW_PULSE_AMPLITUDE;
  return {
    x: centerX(z) + f.u,
    y: waterY + 0.04 + bob,
    z,
    yaw,
    sx: f.scale,
    sz: f.scale * pulse * (1.6 + f.scale),
  };
}
