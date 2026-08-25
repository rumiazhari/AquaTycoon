/**
 * UnitDimensions — single shared resolver that maps ANY placed unit to its
 * physical + grid dimensions, honoring the engineered `blueprint.geometry`
 * when present and falling back to the legacy `UNIT_DEFINITIONS.footprint`
 * otherwise.
 *
 * Meshes, placement collision, pipe ports and the PFD ALL call through here so
 * a custom 30×15 m basin is drawn, placed and plumbed as exactly that — never
 * as the template's 4×3 grid box.
 */

import type { PlacedUnit } from '../types/simulation';
import { UNIT_DEFINITIONS } from './UnitProcessModels';
import {
  BasinGeometry,
  footprintCells,
  METERS_PER_CELL,
} from '../design/Geometry';

export interface ResolvedDimensions {
  /** Occupied footprint in GRID CELLS [cols, rows]. */
  footprintCells: [number, number];
  /** World-space extent in METERS [x, z]. */
  extentM: [number, number];
  /** True when the unit carries freeform engineered geometry. */
  engineered: boolean;
  /** The live geometry (blueprint's, or a synthetic rect from the template). */
  geometry: BasinGeometry;
}

/** Returns the unit's geometry: the engineered blueprint geometry when
 *  present, otherwise NULL so callers fall back to template ports/footprint. */
export function unitGeometry(unit: PlacedUnit): BasinGeometry | null {
  return unit.blueprint ? unit.blueprint.design.geometry : null;
}

/** Resolve grid footprint honoring rotation, for collision/placement. */
export function resolveFootprint(
  unit: PlacedUnit,
  rotation?: 0 | 90 | 180 | 270
): [number, number] {
  const rot = rotation ?? unit.rotation;
  const geo = unitGeometry(unit);
  if (geo) return footprintCells(geo, rot);
  const def = UNIT_DEFINITIONS[unit.typeId];
  if (!def) return [1, 1];
  return rot === 90 || rot === 270 ? [def.footprint[1], def.footprint[0]] : def.footprint;
}

/** Full resolved dimensions for rendering and layout. */
export function resolveDimensions(unit: PlacedUnit): ResolvedDimensions {
  const geo = unitGeometry(unit);
  const engineered = !!unit.blueprint;
  if (geo) {
    const cells = footprintCells(geo, unit.rotation);
    const extentM: [number, number] =
      geo.shape === 'rect'
        ? [geo.widthM * geo.numberOfParallelTrains, geo.lengthM]
        : [geo.diameterM, geo.diameterM];
    return { footprintCells: cells, extentM, engineered, geometry: geo };
  }
  const def = UNIT_DEFINITIONS[unit.typeId];
  const [w, l] = def ? def.footprint : [1, 1];
  return {
    footprintCells: [w, l],
    extentM: [w * METERS_PER_CELL, l * METERS_PER_CELL],
    engineered: false,
    geometry: {
      shape: 'rect',
      lengthM: l * METERS_PER_CELL,
      widthM: w * METERS_PER_CELL,
      waterDepthM: 4,
      freeboardM: 0.5,
      wallThicknessM: 0.3,
      floorThicknessM: 0.25,
      numberOfParallelTrains: 1,
    },
  };
}
