import type { ToolMode } from '../types/graphics';
import type { UnitTypeId } from '../types/simulation';

/**
 * ToolStateLogic — pure, testable tool-mode / unit-selection transition logic.
 *
 * INVARIANT (enforced HERE at the state level, not by callback ordering):
 *   toolMode === 'place_unit'  ⇒  selectedUnitTypeId !== null
 * The state 'place_unit' with a null unit type is structurally unreachable —
 * any action that would create it resolves cleanly to 'select' instead.
 */

export interface ToolInteractionState {
  toolMode: ToolMode;
  selectedUnitTypeId: UnitTypeId | null;
}

/** The invariant itself — exported so tests and dev assertions share it. */
export function toolStateInvariantValid(s: ToolInteractionState): boolean {
  return s.toolMode !== 'place_unit' || s.selectedUnitTypeId !== null;
}

/** Defensive normalizer: repairs any legacy/violating state on load. */
export function normalizeToolState(s: ToolInteractionState): ToolInteractionState {
  return toolStateInvariantValid(s) ? s : { toolMode: 'select', selectedUnitTypeId: null };
}

/**
 * The ONE authoritative reducer for tool-mode + build-unit transitions.
 * Both values are decided TOGETHER — callers apply both setState calls from
 * this single result, so no call ordering can ever split them apart.
 */
export function reduceToolSelection(
  prev: ToolInteractionState,
  action:
    | { type: 'set_tool_mode'; mode: ToolMode }
    | { type: 'select_unit_type'; typeId: UnitTypeId | null }
    | { type: 'cancel_placement' }
): ToolInteractionState {
  const next: ToolInteractionState = (() => {
    switch (action.type) {
      case 'set_tool_mode': {
        // Any explicit global-tool choice clears a stale placement unit so the
        // toolbar highlight, cursor, and canvas behavior all agree.
        return { toolMode: action.mode, selectedUnitTypeId: null };
      }

      case 'select_unit_type': {
        if (action.typeId === null) {
          // Clearing the build unit while placing leaves placement entirely
          // (to 'select') — the invalid place_unit∧null combination is
          // resolved here rather than ever existing.
          return prev.toolMode === 'place_unit'
            ? { toolMode: 'select', selectedUnitTypeId: null }
            : prev;
        }
        // A real unit selection always means "I intend to place this".
        return { toolMode: 'place_unit', selectedUnitTypeId: action.typeId };
      }

      case 'cancel_placement':
        return { toolMode: 'select', selectedUnitTypeId: null };
    }
  })();

  // Belt-and-braces: the invariant holds for EVERY reachable state.
  if (!toolStateInvariantValid(next)) {
    return { toolMode: 'select', selectedUnitTypeId: null };
  }
  return next;
}
