import { PipeConnection, PlacedUnit, UnitTypeId } from '../types/simulation';

/**
 * Active-liquid-train topology analysis.
 *
 * The "active liquid treatment path" is the set of units reachable from an
 * influent_inlet by following pipes that actually CARRY water:
 *   · gas lines are ignored
 *   · zero-flow pipes are ignored (a disconnected decorative tank is not on
 *     the train even if a pipe stub exists)
 *   · sludge/RAS/recycle pipes ARE traversed (they are part of the operating
 *     plant) — but RAS loops terminate because traversal is a visited-set BFS
 *   · junction branches are followed safely (each branch visited once)
 */

export interface TopologyAnalysis {
  /** Units carrying liquid right now, keyed by instanceId */
  activeUnitIds: Set<string>;
  /** True when some influent inlet connects to some outfall through flowing liquid */
  influentToOutfall: boolean;
}

export function analyzeActiveLiquidPath(
  units: PlacedUnit[],
  pipes: PipeConnection[]
): TopologyAnalysis {
  const unitById = new Map(units.map(u => [u.instanceId, u]));
  const adjacency = new Map<string, { to: string; pipe: PipeConnection }[]>();
  for (const p of pipes) {
    // Gas never forms the liquid train; dead pipes carry no water.
    if (p.pipeType === 'gas') continue;
    const flowing = p.flowRate > 0.01;
    if (!flowing) continue;
    const list = adjacency.get(p.fromUnitId) ?? [];
    list.push({ to: p.toUnitId, pipe: p });
    adjacency.set(p.fromUnitId, list);
  }

  const activeUnitIds = new Set<string>();
  let influentToOutfall = false;
  const queue: string[] = [];

  for (const u of units) {
    if (u.typeId === 'influent_inlet') {
      queue.push(u.instanceId);
      activeUnitIds.add(u.instanceId);
    }
  }

  // BFS with a visited set — RAS loops and junction branches cannot loop forever.
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const edge of adjacency.get(cur) ?? []) {
      const target = unitById.get(edge.to);
      if (!target) continue; // dangling pipe into a demolished unit
      if (activeUnitIds.has(edge.to)) continue;
      activeUnitIds.add(edge.to);
      if (target.typeId === 'effluent_outfall') influentToOutfall = true;
      queue.push(edge.to);
    }
  }

  return { activeUnitIds, influentToOutfall };
}

/** Is `unitId` on the currently-flowing liquid treatment path? */
export function isUnitOnActiveLiquidPath(
  unitId: string,
  units: PlacedUnit[],
  pipes: PipeConnection[],
  precomputed?: TopologyAnalysis
): boolean {
  const analysis = precomputed ?? analyzeActiveLiquidPath(units, pipes);
  return analysis.activeUnitIds.has(unitId);
}

/**
 * Does ANY unit of type `typeId` sit on the active path AND receive real flow?
 * "Receiving flow" means it is reachable from the influent and its own inlet
 * quality carries a positive flow rate.
 */
export function hasActiveProcessTypeOnPath(
  typeId: UnitTypeId,
  units: PlacedUnit[],
  pipes: PipeConnection[],
  minInletFlow = 1,
  precomputed?: TopologyAnalysis
): boolean {
  const analysis = precomputed ?? analyzeActiveLiquidPath(units, pipes);
  return units.some(
    u =>
      u.typeId === typeId &&
      analysis.activeUnitIds.has(u.instanceId) &&
      u.lastInletQuality.flowRate >= minInletFlow
  );
}
