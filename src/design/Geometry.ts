import type { UnitTypeId } from '../types/simulation';

/**
 * Geometry — freeform physical sizing of engineered assets (Prompt §D).
 *
 * World scale: 1 grid cell = 6 m (matches the legacy implicit convention
 * volume = (w*6)*(l*6)*4). All engineering dimensions are METERS with fine
 * resolution; the world footprint is DERIVED, never hand-stored.
 */

export const METERS_PER_CELL = 6;

export interface RectBasinGeometry {
  shape: 'rect';
  lengthM: number;
  widthM: number;
  waterDepthM: number;
  freeboardM: number;
  wallThicknessM: number;
  floorThicknessM: number;
  numberOfParallelTrains: number;
}

export interface CircularBasinGeometry {
  shape: 'circular';
  diameterM: number;
  sideWaterDepthM: number;
  freeboardM: number;
  wallThicknessM: number;
  floorThicknessM: number;
  numberOfParallelTrains: number;
}

export type BasinGeometry = RectBasinGeometry | CircularBasinGeometry;

// ── Derived quantities (never store what can be computed) ────────────────────

export function planAreaM2(g: BasinGeometry): number {
  return g.shape === 'rect'
    ? g.lengthM * g.widthM
    : (Math.PI * g.diameterM * g.diameterM) / 4;
}

/** Total working volume across all parallel trains (m³). */
export function workingVolumeM3(g: BasinGeometry): number {
  const waterDepth = g.shape === 'rect' ? g.waterDepthM : g.sideWaterDepthM;
  return planAreaM2(g) * waterDepth * Math.max(1, g.numberOfParallelTrains);
}

/** Structural (water + freeboard) depth used for wall/concrete quantities. */
export function structuralDepthM(g: BasinGeometry): number {
  const waterDepth = g.shape === 'rect' ? g.waterDepthM : g.sideWaterDepthM;
  return waterDepth + g.freeboardM;
}

/**
 * World-grid footprint (cells) occupied by the structure INCLUDING its trains
 * laid side by side, rounded UP so placement never overlaps neighbors.
 */
export function footprintCells(
  g: BasinGeometry,
  rotation: 0 | 90 | 180 | 270
): [number, number] {
  const perTrain =
    g.shape === 'rect'
      ? { l: g.lengthM / METERS_PER_CELL, w: g.widthM / METERS_PER_CELL }
      : { l: g.diameterM / METERS_PER_CELL, w: g.diameterM / METERS_PER_CELL };
  const n = Math.max(1, g.numberOfParallelTrains);
  // Trains stack along width; total envelope keeps train count visible.
  const rawW = perTrain.w * n;
  let cw = Math.ceil(Math.max(1, rawW));
  let cl = Math.ceil(Math.max(1, perTrain.l));
  if (rotation === 90 || rotation === 270) [cw, cl] = [cl, cw];
  return [cw, cl];
}

// ── Concrete / civil quantities (Prompt §T) ──────────────────────────────────

export interface CivilQuantities {
  floorAreaM2: number;
  wallAreaM2: number;
  concreteVolumeM3: number;
  excavationVolumeM3: number;
}

export function civilQuantities(g: BasinGeometry): CivilQuantities {
  const depth = structuralDepthM(g);
  const n = Math.max(1, g.numberOfParallelTrains);
  if (g.shape === 'rect') {
    const floorArea = planAreaM2(g);
    const wallArea = 2 * (g.lengthM + g.widthM * n) * depth + 2 * (n - 1) * g.lengthM * depth;
    const concrete =
      floorArea * g.floorThicknessM +
      wallArea * g.wallThicknessM;
    const excavation = floorArea * (depth + 0.3); // 0.3 m working allowance
    return { floorAreaM2: floorArea, wallAreaM2: wallArea, concreteVolumeM3: concrete, excavationVolumeM3: excavation };
  }
  const r = g.diameterM / 2;
  const circumference = 2 * Math.PI * r;
  const floorArea = planAreaM2(g);
  const wallArea = circumference * depth;
  const concrete = floorArea * g.floorThicknessM + wallArea * g.wallThicknessM;
  const excavation = floorArea * (depth + 0.3);
  return { floorAreaM2: floorArea, wallAreaM2: wallArea, concreteVolumeM3: concrete, excavationVolumeM3: excavation };
}

// ── Port positioning from REAL geometry ──────────────────────────────────────

/** Fractional offsets (of local length/width) for standard basin ports. */
export type PortFraction = { fx: number; fz: number; yFracOfDepth: number };

const RECT_PORT_FRACTIONS: Record<string, PortFraction> = {
  inlet:         { fx: 0.02, fz: 0.5,  yFracOfDepth: 0.55 },
  outlet:        { fx: 0.98, fz: 0.5,  yFracOfDepth: 0.35 },
  sludge_outlet: { fx: 0.95, fz: 0.5,  yFracOfDepth: 0.06 },
  ras_inlet:     { fx: 0.05, fz: 0.08, yFracOfDepth: 0.45 },
};

const CIRC_PORT_FRACTIONS: Record<string, PortFraction> = {
  inlet:         { fx: 0.5, fz: 0.04, yFracOfDepth: 0.5 },
  outlet:        { fx: 0.5, fz: 0.96, yFracOfDepth: 0.35 },
  sludge_outlet: { fx: 0.5, fz: 0.5,  yFracOfDepth: 0.05 },
  ras_inlet:     { fx: 0.15, fz: 0.15, yFracOfDepth: 0.45 },
};

/**
 * Local-space port offset (world units relative to the unit CENTER) derived
 * from the ACTUAL designed dimensions — replaces static def.port positions for
 * customizable units. Returns null when the unit has no custom geometry.
 */
export function localPortOffset(
  g: BasinGeometry,
  portId: string
): [number, number, number] | null {
  const table = g.shape === 'rect' ? RECT_PORT_FRACTIONS : CIRC_PORT_FRACTIONS;
  const f = table[portId];
  if (!f) return null; // fall back to definition ports (junctions, etc.)
  const depth = g.shape === 'rect' ? g.waterDepthM : g.sideWaterDepthM;

  if (g.shape === 'circular') {
    // fx/fz on circles map to a point on the diameter ring.
    const r = g.diameterM / 2;
    const ang = Math.atan2(f.fz - 0.5, f.fx - 0.5);
    const rad = r * Math.min(0.98, Math.hypot((f.fx - 0.5) * 2, (f.fz - 0.5) * 2));
    return [
      rad * Math.cos(ang) / METERS_PER_CELL,
      (depth * f.yFracOfDepth) / METERS_PER_CELL,
      rad * Math.sin(ang) / METERS_PER_CELL,
    ];
  }

  const halfL = (g.lengthM / METERS_PER_CELL) / 2;
  const halfW = ((g.widthM * Math.max(1, g.numberOfParallelTrains)) / METERS_PER_CELL) / 2;
  return [
    (f.fx - 0.5) * 2 * halfL,
    (depth * f.yFracOfDepth) / METERS_PER_CELL,
    (f.fz - 0.5) * 2 * halfW,
  ];
}

/** True when a placed unit carries freeform engineered geometry. */
export function isEngineerable(typeId: string): boolean {
  return ENGINEERABLE_TYPES.has(typeId as UnitTypeId);
}

/** Phase-1 vertical-slice engineerable process families (Prompt §AK). */
export const ENGINEERABLE_TYPES = new Set<string>([
  'activated_sludge_cas',
  'secondary_clarifier',
  'equalization_basin',
  'pump_station',
]);

/** Sensible starting designs used as "template defaults" (Prompt §C). */
export function defaultGeometryFor(typeId: string): BasinGeometry | null {
  switch (typeId) {
    case 'activated_sludge_cas':
      // Sized to reproduce the legacy nominal working volume (1728 m³ =
      // footprint 6×2 cells × 6 m × 4 m depth) so Level-1 HRT/economics stay
      // balanced under the blueprint architecture.
      return {
        shape: 'rect', lengthM: 36, widthM: 12, waterDepthM: 4,
        freeboardM: 0.6, wallThicknessM: 0.3, floorThicknessM: 0.25,
        numberOfParallelTrains: 1,
      };
    case 'secondary_clarifier':
      // Two Ø18 m trains at 4.5 m SWD ≈ 2290 m³ ≈ legacy nominal 2304 m³
      // (footprint 4×4 cells) — keeps surface overflow rate in a realistic
      // band AND preserves Level-1 treatment performance.
      return {
        shape: 'circular', diameterM: 18, sideWaterDepthM: 4.5,
        freeboardM: 0.5, wallThicknessM: 0.25, floorThicknessM: 0.2,
        numberOfParallelTrains: 2,
      };
    case 'equalization_basin':
      return {
        shape: 'rect', lengthM: 18, widthM: 9, waterDepthM: 4,
        freeboardM: 0.6, wallThicknessM: 0.3, floorThicknessM: 0.25,
        numberOfParallelTrains: 1,
      };
    case 'pump_station':
      return {
        shape: 'circular', diameterM: 4, sideWaterDepthM: 4,
        freeboardM: 0.5, wallThicknessM: 0.25, floorThicknessM: 0.25,
        numberOfParallelTrains: 1,
      };
    case 'mbr_membrane':
      // Legacy template footprint (4×3 cells) at 4 m SWD ≈ 1728 m³ working
      // volume — same nominal volume as the CAS default so Level economics
      // and HRT checks stay balanced under the blueprint architecture.
      return {
        shape: 'rect', lengthM: 24, widthM: 18, waterDepthM: 4,
        freeboardM: 0.6, wallThicknessM: 0.3, floorThicknessM: 0.25,
        numberOfParallelTrains: 1,
      };
    default:
      return null;
  }
}
