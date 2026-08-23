import { PipeConnection, PlacedUnit, UnitPort } from '../types/simulation';
import { UNIT_DEFINITIONS } from './UnitProcessModels';

/**
 * Calculates absolute world coordinates for a given unit's port taking into account
 * unit grid position and rotation.
 */
export function getPortWorldPosition(
  unit: PlacedUnit,
  portId: string
): [number, number, number] {
  const def = UNIT_DEFINITIONS[unit.typeId];
  if (!def) return [unit.gridX, 0.5, unit.gridY];

  const port = def.ports.find((p: UnitPort) => p.id === portId);
  if (!port) return [unit.gridX, 0.5, unit.gridY];

  const [relX, relY, relZ] = port.relativePosition;
  const rotRad = (unit.rotation * Math.PI) / 180;
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);

  const rotX = relX * cos - relZ * sin;
  const rotZ = relX * sin + relZ * cos;

  // Unit center in world coords
  const centerX = unit.gridX + def.footprint[0] / 2;
  const centerZ = unit.gridY + def.footprint[1] / 2;

  return [centerX + rotX, relY, centerZ + rotZ];
}

/**
 * Generates an orthogonal 3D pipe routing path between two ports
 */
export function generatePipePath(
  fromPos: [number, number, number],
  toPos: [number, number, number]
): [number, number, number][] {
  const [fx, fy, fz] = fromPos;
  const [tx, ty, tz] = toPos;
  const pipeElevation = Math.max(fy, ty, 0.4);

  // Simple clean orthogonal routing
  const midX = (fx + tx) / 2;

  return [
    [fx, fy, fz],
    [fx, pipeElevation, fz],
    [midX, pipeElevation, fz],
    [midX, pipeElevation, tz],
    [tx, pipeElevation, tz],
    [tx, ty, tz]
  ];
}

/**
 * Checks if a pipe connection already exists between two ports
 */
export function isConnectionExisting(
  pipes: PipeConnection[],
  fromUnitId: string,
  fromPortId: string,
  toUnitId: string,
  toPortId: string
): boolean {
  return pipes.some(
    p =>
      p.fromUnitId === fromUnitId &&
      p.fromPortId === fromPortId &&
      p.toUnitId === toUnitId &&
      p.toPortId === toPortId
  );
}
