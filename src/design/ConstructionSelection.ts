/**
 * ConstructionSelection — CONSTRUCTION-BUILDER P4 direct-manipulation polish.
 *
 * Multi-select state for player-drawn basins, equipment, baffles and utilities.
 * Pure domain: headless-testable, no three.js / React.
 *
 * The player Shift/Ctrl-clicks in Inspect mode to grow a selection; bulk
 * demolish then retires the whole group in one transaction with a single
 * refund total. Equipment grouping cues (color brackets) reuse the same sets.
 */

export interface ConstructionSelection {
  basins: string[];
  equipment: string[];
  baffles: string[];
  utilities: string[];
}

export function emptySelection(): ConstructionSelection {
  return { basins: [], equipment: [], baffles: [], utilities: [] };
}

export function selectionCount(s: ConstructionSelection): number {
  return s.basins.length + s.equipment.length + s.baffles.length + s.utilities.length;
}

export function hasSelection(s: ConstructionSelection): boolean {
  return selectionCount(s) > 0;
}

export function isSelected(s: ConstructionSelection, kind: keyof ConstructionSelection, id: string): boolean {
  return s[kind].includes(id);
}

export function clearSelection(): ConstructionSelection {
  return emptySelection();
}

export type ToggleMode = 'set' | 'add' | 'toggle';

/**
 * Returns a new selection after applying an id.
 *  set    → replaces the whole selection with just this one entity
 *  add    → adds it to the current multi-selection (no duplicate)
 *  toggle → adds if absent, removes if present
 */
export function toggleSelection(
  cur: ConstructionSelection,
  kind: keyof ConstructionSelection,
  id: string,
  mode: ToggleMode
): ConstructionSelection {
  if (mode === 'set') {
    const next = emptySelection();
    (next[kind] as string[]).push(id);
    return next;
  }
  if (mode === 'add') {
    if (cur[kind].includes(id)) return cur;
    return { ...cur, [kind]: [...cur[kind], id] };
  }
  // toggle
  if (cur[kind].includes(id)) {
    return { ...cur, [kind]: cur[kind].filter(x => x !== id) };
  }
  return { ...cur, [kind]: [...cur[kind], id] };
}

/**
 * Totally selected ids as a flat set (handy for SceneManager highlight).
 */
export function allSelectedIds(s: ConstructionSelection): Set<string> {
  return new Set([...s.basins, ...s.equipment, ...s.baffles, ...s.utilities]);
}

export function basinIdsSet(s: ConstructionSelection): Set<string> {
  return new Set(s.basins);
}
export function equipmentIdsSet(s: ConstructionSelection): Set<string> {
  return new Set(s.equipment);
}
export function baffleIdsSet(s: ConstructionSelection): Set<string> {
  return new Set(s.baffles);
}
export function utilityIdsSet(s: ConstructionSelection): Set<string> {
  return new Set(s.utilities);
}

/** Summary line for toasts / HUD — e.g. "3 basins · 2 machines · 1 baffle" */
export function selectionSummaryLine(s: ConstructionSelection): string {
  const parts: string[] = [];
  if (s.basins.length) parts.push(`${s.basins.length} basin${s.basins.length > 1 ? 's' : ''}`);
  if (s.equipment.length) parts.push(`${s.equipment.length} machine${s.equipment.length > 1 ? 's' : ''}`);
  if (s.baffles.length) parts.push(`${s.baffles.length} baffle${s.baffles.length > 1 ? 's' : ''}`);
  if (s.utilities.length) parts.push(`${s.utilities.length} utilit${s.utilities.length > 1 ? 'ies' : 'y'}`);
  return parts.join(' · ') || 'nothing';
}
