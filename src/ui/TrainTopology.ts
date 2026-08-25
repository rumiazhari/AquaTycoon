import type { PipeConnection, PlacedUnit } from '../types/simulation';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';

/**
 * TrainTopology — pure helpers that resolve the REAL hydraulic topology from
 * pipe connections. The PFD previously rendered `units.map(...)` and called it
 * a "treatment train"; these functions separate the active main liquid path
 * (reachable from the influent inlet through outlet→inlet pipes) from
 * disconnected/auxiliary units, and classify branch semantics.
 */

export type TrainBranchKind = 'liquid' | 'sludge' | 'ras' | 'recycle' | 'gas';

export interface TrainLink {
  pipeId: string;
  fromUnitId: string;
  toUnitId: string;
  kind: TrainBranchKind;
}

export interface UnitFlowState {
  unit: PlacedUnit;
  /** Unit is reachable from the influent inlet via liquid pipes. */
  onActiveTrain: boolean;
  /** Unit has any liquid inlet connection at all. */
  hasLiquidInfeed: boolean;
  /** True when the unit is placed but has zero pipe connections. */
  fullyDisconnected: boolean;
  /** Liquid inflow actually arriving (m³/d) — 0 when dry/no data. */
  inflowM3d: number;
  /** Liquid outflow leaving the main liquid outlet (m³/d). */
  outflowM3d: number;
  /** true → the sim has computed a real outlet stream for this unit. */
  hasOutletData: boolean;
}

export interface TrainTopology {
  links: TrainLink[];
  byUnit: Map<string, UnitFlowState>;
  /** Ordered active main-liquid train walk (influent → … → outfall). */
  mainTrainOrder: string[];
  /** Units NOT on the active main train (disconnected or auxiliary). */
  offTrainIds: string[];
}

/** Inlet port types that carry the MAIN liquid stream forward. */
const LIQUID_INLET_TYPES = new Set(['inlet', 'ras_inlet']);

function portType(unit: PlacedUnit, portId: string): string | undefined {
  return UNIT_DEFINITIONS[unit.typeId]?.ports.find(p => p.id === portId)?.type;
}

function branchKind(pipe: PipeConnection, units: Map<string, PlacedUnit>): TrainBranchKind {
  const from = units.get(pipe.fromUnitId);
  const t = from ? portType(from, pipe.fromPortId) : undefined;
  if (t === 'gas_outlet') return 'gas';
  if (t === 'recycle_outlet') return 'recycle';
  if (t === 'sludge_outlet') {
    const to = units.get(pipe.toUnitId);
    const tt = to ? portType(to, pipe.toPortId) : undefined;
    return tt === 'ras_inlet' ? 'ras' : 'sludge';
  }
  return 'liquid';
}

/**
 * Resolve the full hydraulic topology for the PFD and related UI.
 *
 * Main-train edges: a pipe leaving an OUTLET-class port and entering a liquid
 * inlet ('inlet' or 'ras_inlet'). RAS inlets count as liquid so a train that
 * legitimately passes through a bioreactor's RAS inlet stays connected; pure
 * sludge/gas/recycle lines never extend the main path.
 */
export function resolveTrainTopology(
  units: PlacedUnit[],
  pipes: PipeConnection[]
): TrainTopology {
  const byId = new Map(units.map(u => [u.instanceId, u]));

  const links: TrainLink[] = pipes.map(pipe => ({
    pipeId: pipe.id,
    fromUnitId: pipe.fromUnitId,
    toUnitId: pipe.toUnitId,
    kind: branchKind(pipe, byId),
  }));

  // ── Adjacency over main-liquid edges only ────────────────────────────────
  const adj = new Map<string, string[]>();
  const isLiquidEdge = (p: PipeConnection): boolean => {
    const from = byId.get(p.fromUnitId);
    const to = byId.get(p.toUnitId);
    if (!from || !to) return false;
    return (
      portType(from, p.fromPortId) === 'outlet' &&
      LIQUID_INLET_TYPES.has(portType(to, p.toPortId) ?? '')
    );
  };
  for (const p of pipes) {
    if (!isLiquidEdge(p)) continue;
    if (!adj.has(p.fromUnitId)) adj.set(p.fromUnitId, []);
    adj.get(p.fromUnitId)!.push(p.toUnitId);
  }

  // ── Reachability BFS from the influent inlet ────────────────────────────
  const visited = new Set<string>();
  const influent = units.find(u => u.typeId === 'influent_inlet');
  if (influent) {
    const queue = [influent.instanceId];
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const nxt of adj.get(id) ?? []) if (!visited.has(nxt)) queue.push(nxt);
    }
  }

  // ── Per-unit flow state ─────────────────────────────────────────────────
  const byUnit = new Map<string, UnitFlowState>();
  for (const unit of units) {
    const connected = pipes.filter(
      p => p.fromUnitId === unit.instanceId || p.toUnitId === unit.instanceId
    );
    const inflowM3d = connected
      .filter(p => {
        if (p.toUnitId !== unit.instanceId) return false;
        // Count only pipes arriving on a liquid inlet of THIS unit.
        return LIQUID_INLET_TYPES.has(portType(unit, p.toPortId) ?? '');
      })
      .reduce((acc, p) => acc + Math.max(0, p.flowRate || 0), 0);
    const outPipe = connected.find(
      p => p.fromUnitId === unit.instanceId && portType(unit, p.fromPortId) === 'outlet'
    );
    const hasOutletData =
      !!unit.lastOutletQuality && typeof unit.lastOutletQuality.flowRate === 'number';

    byUnit.set(unit.instanceId, {
      unit,
      onActiveTrain: visited.has(unit.instanceId),
      hasLiquidInfeed: connected.some(
        p => p.toUnitId === unit.instanceId &&
             LIQUID_INLET_TYPES.has(portType(unit, p.toPortId) ?? '')
      ),
      fullyDisconnected: connected.length === 0,
      inflowM3d,
      outflowM3d: outPipe ? Math.max(0, outPipe.flowRate || 0) : 0,
      hasOutletData,
    });
  }

  // ── Linearized spine walk (first-successor order, side branches appended) ─
  const mainTrainOrder: string[] = [];
  const seen = new Set<string>();
  const branchQueue: string[] = [];
  const walkFrom = (start: string): void => {
    let cursor: string | undefined = start;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      mainTrainOrder.push(cursor);
      const nexts: string[] = (adj.get(cursor) ?? []).filter(n => !seen.has(n));
      cursor = nexts[0];
      // Deeper branches are walked after the current spine finishes.
      for (let i = 1; i < nexts.length; i++) branchQueue.push(nexts[i]);
    }
  };
  if (influent && visited.has(influent.instanceId)) {
    walkFrom(influent.instanceId);
    while (branchQueue.length) {
      const b = branchQueue.shift()!;
      if (!seen.has(b)) walkFrom(b);
    }
  }

  const offTrainIds = units.filter(u => !visited.has(u.instanceId)).map(u => u.instanceId);

  return { links, byUnit, mainTrainOrder, offTrainIds };
}
