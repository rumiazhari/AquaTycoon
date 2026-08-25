import { PipeConnection, PlacedUnit, UnitDefinition, UnitPort } from '../types/simulation';
import { UNIT_DEFINITIONS } from './UnitProcessModels';
import { localPortOffset } from '../design/Geometry';

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative rotated-footprint / port-position geometry.
// SceneManager.syncUnits(), placement collision and pipe endpoints ALL derive
// from these helpers so a port can never drift off its rendered unit.
// ─────────────────────────────────────────────────────────────────────────────

/** Footprint dimensions AFTER the unit's rotation is applied: [width, length]. */
export function getRotatedFootprint(def: UnitDefinition, rotation: 0 | 90 | 180 | 270): [number, number] {
  return (rotation === 90 || rotation === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [def.footprint[0], def.footprint[1]];
}

/** World-space center of the unit's occupied (rotated) footprint. */
export function getUnitWorldCenter(unit: PlacedUnit): [number, number, number] {
  const def = UNIT_DEFINITIONS[unit.typeId];
  const [fw, fl] = def ? getRotatedFootprint(def, unit.rotation) : [1, 1];
  return [unit.gridX + fw / 2, 0.5, unit.gridY + fl / 2];
}

/**
 * Absolute world coordinates of one of a unit's ports, honoring grid position
 * AND rotation against the ROTATED footprint center (matches mesh placement).
 */
export function getPortWorldPosition(
  unit: PlacedUnit,
  portId: string
): [number, number, number] {
  const def = UNIT_DEFINITIONS[unit.typeId];
  if (!def) return [unit.gridX + 0.5, 0.5, unit.gridY + 0.5];

  const port = def.ports.find((p: UnitPort) => p.id === portId);
  if (!port) return getUnitWorldCenter(unit);

  // Engineered units (those carrying a blueprint) derive the port LOCAL
  // offset from their real geometry (so a 30×15 m basin has its inlet/outlet
  // at the actual wall), overriding the template's default relativePosition.
  // Units without a blueprint keep their template port positions untouched.
  const local = unit.blueprint ? localPortOffset(unit.blueprint.design.geometry, portId) : null;

  const [relX, relY, relZ] = local
    ? local
    : (port.relativePosition as [number, number, number]);
  const rotRad = (unit.rotation * Math.PI) / 180;
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);

  const rotX = relX * cos - relZ * sin;
  const rotZ = relX * sin + relZ * cos;

  // Unit center in world coords — from the ROTATED footprint so that a 90°
  // rotated 4×3 unit spins around its true rendered center.
  const centerX = unit.gridX + getRotatedFootprint(def, unit.rotation)[0] / 2;
  const centerZ = unit.gridY + getRotatedFootprint(def, unit.rotation)[1] / 2;

  return [centerX + rotX, relY, centerZ + rotZ];
}

/** Finds a port definition by id on a unit type. */
export function findPort(unit: PlacedUnit, portId: string | null | undefined): UnitPort | null {
  if (!portId) return null;
  const def = UNIT_DEFINITIONS[unit.typeId];
  return def?.ports.find(p => p.id === portId) ?? null;
}

export function getSourcePorts(unit: PlacedUnit): UnitPort[] {
  return UNIT_DEFINITIONS[unit.typeId]?.ports.filter(
    p => p.type === 'outlet' || p.type === 'sludge_outlet' ||
         p.type === 'recycle_outlet' || p.type === 'gas_outlet'
  ) ?? [];
}

export function getTargetPorts(unit: PlacedUnit): UnitPort[] {
  return UNIT_DEFINITIONS[unit.typeId]?.ports.filter(
    p => p.type === 'inlet' || p.type === 'ras_inlet'
  ) ?? [];
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

// ─────────────────────────────────────────────────────────────────────────────
// Connection validation — explicit port semantics, never silent fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_PORT_TYPES = new Set(['outlet', 'sludge_outlet', 'recycle_outlet', 'gas_outlet']);
const TARGET_PORT_TYPES = new Set(['inlet', 'ras_inlet']);

/** Which target port types can physically accept this source stream? */
function compatibleTargetTypes(fromType: string): string[] {
  switch (fromType) {
    case 'gas_outlet':      return []; // no current unit process consumes gas
    case 'sludge_outlet':   return ['inlet', 'ras_inlet']; // sludge feeds OR the RAS return loop
    case 'recycle_outlet':  return ['inlet', 'ras_inlet'];       // splitter branch or recycle return
    case 'outlet':
    default:                return ['inlet', 'ras_inlet'];       // mixed liquor may legitimately feed RAS-style returns
  }
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Full semantic validation for a prospective pipe between exact ports.
 * Rejects rather than falls back: gas never feeds liquid inlets, sludge lines
 * only land on real inlets, duplicates are blocked, single-feed inlet ports
 * accept exactly one pipe, ordinary outlet ports are single-out unless the
 * source unit explicitly models a splitter/manifold (pipe_junction).
 */
export function validateConnection(
  pipes: PipeConnection[],
  units: PlacedUnit[],
  fromUnitId: string,
  fromPortId: string,
  toUnitId: string,
  toPortId: string
): ValidationResult {
  const fromUnit = units.find(u => u.instanceId === fromUnitId);
  const toUnit = units.find(u => u.instanceId === toUnitId);
  if (!fromUnit) return { ok: false, reason: 'Source unit not found.' };
  if (!toUnit) return { ok: false, reason: 'Destination unit not found.' };

  const fd = UNIT_DEFINITIONS[fromUnit.typeId];
  const td = UNIT_DEFINITIONS[toUnit.typeId];
  if (!fd || !td) return { ok: false, reason: 'Unknown unit definition.' };

  const fp = fd.ports.find(p => p.id === fromPortId);
  const tp = td.ports.find(p => p.id === toPortId);
  if (!fp) return { ok: false, reason: `${fd.name}: unknown source port "${fromPortId}".` };
  if (!tp) return { ok: false, reason: `${td.name}: unknown destination port "${toPortId}".` };

  if (!SOURCE_PORT_TYPES.has(fp.type)) {
    return { ok: false, reason: `${fp.name} on ${fd.name} is not an output port.` };
  }
  if (!TARGET_PORT_TYPES.has(tp.type)) {
    return { ok: false, reason: `${tp.name} on ${td.name} is not an input port.` };
  }

  // Stream-class compatibility (gas vs liquid vs sludge)
  if (fp.type === 'gas_outlet') {
    return {
      ok: false,
      reason:
        `Biogas cannot enter ${tp.name} on ${td.name}: no installed process accepts a gas stream. ` +
        `Gas is sent to the CHP generator inside the digester itself.`
    };
  }
  const allowedTargets = compatibleTargetTypes(fp.type);
  if (!allowedTargets.includes(tp.type)) {
    return {
      ok: false,
      reason: `${fd.name} [${fp.name}] produces a stream ${td.name}'s ${tp.name} cannot accept.`
    };
  }

  // A unit can never be hydraulically fed by itself through the same port pair
  if (fromUnitId === toUnitId && fp.id === tp.id) {
    return { ok: false, reason: 'A port cannot connect to itself.' };
  }

  // Duplicate connections to the same target port are rejected
  if (isConnectionExisting(pipes, fromUnitId, fromPortId, toUnitId, toPortId)) {
    return { ok: false, reason: 'This exact connection already exists.' };
  }

  // Single-feed rule on destination ports: one pipe per inlet port.
  if (pipes.some(p => p.toUnitId === toUnitId && p.toPortId === toPortId)) {
    return {
      ok: false,
      reason: `${tp.name} on ${td.name} already has a feed line. Remove it first or use a Flow Splitter/Junction to combine streams.`
    };
  }

  // Single-out rule on source ports: every outlet port feeds exactly ONE
  // downstream pipe — flow cannot be duplicated by branching. Units modeled
  // as splitters/manifolds expose SEPARATE branch ports instead (the junction's
  // Outflow 1 / Outflow 2), so per-port single-out still conserves flow.
  if (pipes.some(p => p.fromUnitId === fromUnitId && p.fromPortId === fromPortId)) {
    return {
      ok: false,
      reason: `${fp.name} on ${fd.name} already feeds one line — flow cannot be duplicated by branching. Use a Flow Splitter / Junction Box to divide the stream.`
    };
  }

  return { ok: true };
}

/** Convenience: does any valid target port exist on the destination unit? */
export function hasAnyCompatibleTarget(
  pipes: PipeConnection[],
  units: PlacedUnit[],
  fromUnitId: string,
  fromPortId: string,
  toUnitId: string
): boolean {
  const toUnit = units.find(u => u.instanceId === toUnitId);
  if (!toUnit) return false;
  return getTargetPorts(toUnit).some(tp =>
    validateConnection(pipes, units, fromUnitId, fromPortId, toUnitId, tp.id).ok
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-train inference — topology-driven, NOT X-coordinate sorting.
// Builds only the main LIQUID treatment train using category semantics.
// Sludge handling, gas lines and recycles are never auto-connected.
// ─────────────────────────────────────────────────────────────────────────────

/** Categories whose units belong to the main forward treatment train. */
const MAIN_TRAIN_CATEGORIES = new Set([
  'preliminary', 'primary', 'secondary', 'tertiary', 'hydraulics'
]);

function isTrainCandidate(u: PlacedUnit): boolean {
  if (u.typeId === 'effluent_outfall') return true; // terminal node
  const def = UNIT_DEFINITIONS[u.typeId];
  if (!def) return false;
  if (!MAIN_TRAIN_CATEGORIES.has(def.category)) return false;
  // Utility branches with no liquid path don't join the train
  if (u.typeId === 'solar_array' || u.typeId === 'wind_turbine') return false;
  // The junction's second branch is a parallel train head, still fine to include;
  // but power/decoration/sludge categories are excluded above.
  return true;
}

/**
 * Infers the main liquid treatment train and connects it inlet→outlet using
 * explicit port semantics. Chain order follows each unit's dominant flow
 * direction (outlet-port vector), which equals X-order only for straight
 * left-to-right layouts — vertical/serpentine trains connect correctly too.
 *
 * Never creates sludge/gas/recycle pipes. Refuses to guess when a candidate's
 * ports don't match semantically (validation rules apply to every hop).
 *
 * @returns newly created pipes (caller merges into state & syncs scene).
 */
export function inferMainTrainPipes(units: PlacedUnit[]): PipeConnection[] {
  const created: PipeConnection[] = [];
  const pipes: PipeConnection[] = []; // local working set so validation sees prior hops

  const trainUnits = units.filter(isTrainCandidate);
  if (trainUnits.length < 2) return created;

  const influent = trainUnits.find(u => u.typeId === 'influent_inlet');
  if (!influent) return created;

  let cursor: PlacedUnit = influent;
  const fed = new Set<string>([influent.instanceId]); // units already receiving feed

  while (cursor.typeId !== 'effluent_outfall') {
    const srcPorts = getSourcePorts(cursor).filter(
      p => p.type === 'outlet' || p.type === 'recycle_outlet'
    );
    if (srcPorts.length === 0) break;

    const candidates = trainUnits.filter(u => !fed.has(u.instanceId));
    if (candidates.length === 0) break;

    // Dominant flow direction of the cursor's first outlet port
    const outPort = srcPorts[0];
    const portPos = getPortWorldPosition(cursor, outPort.id);
    const center = getUnitWorldCenter(cursor);
    const dirX = portPos[0] - center[0];
    const dirZ = portPos[2] - center[2];

    let best: { unit: PlacedUnit; fromPort: UnitPort; toPort: UnitPort; score: number } | null = null;

    for (const cand of candidates) {
      for (const tp of getTargetPorts(cand)) {
        for (const sp of srcPorts) {
          const v = validateConnection(pipes, trainUnits, cursor.instanceId, sp.id, cand.instanceId, tp.id);
          if (!v.ok) continue;
          const pos = getPortWorldPosition(cand, tp.id);
          const dx = pos[0] - portPos[0];
          const dz = pos[2] - portPos[2];
          const dist = Math.hypot(dx, dz);
          if (dist < 0.75) continue; // same physical spot
          // Prefer candidates lying along the outlet flow direction; nearer wins ties
          const alignment = dist > 0.01 ? (dx * dirX + dz * dirZ) / dist : 0;
          const score = alignment * 10 - Math.log10(1 + dist);
          if (!best || score > best.score) best = { unit: cand, fromPort: sp, toPort: tp, score };
        }
      }
    }

    if (!best) break; // nothing semantically reachable — stop cleanly

    const newPipe: PipeConnection = {
      id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromUnitId: cursor.instanceId,
      fromPortId: best.fromPort.id,
      toUnitId: best.unit.instanceId,
      toPortId: best.toPort.id,
      pathPoints: generatePipePath(
        getPortWorldPosition(cursor, best.fromPort.id),
        getPortWorldPosition(best.unit, best.toPort.id)
      ),
      flowRate: 0,
      quality: emptyWaterLike(),
      pipeType: 'liquid'
    };
    created.push(newPipe);
    pipes.push(newPipe);
    fed.add(best.unit.instanceId);
    cursor = best.unit;
  }

  return created;
}

function emptyWaterLike(): import('../types/simulation').WaterQuality {
  return {
    flowRate: 0, bod: 0, cod: 0, tss: 0, tn: 0, nh4: 0, no3: 0,
    tp: 0, pathogens: 0, do: 0, ph: 7.0, temp: 20, toxicIndex: 0, turbidity: 0
  };
}
