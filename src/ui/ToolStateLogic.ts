import type { ToolMode } from '../types/graphics';
import type { UnitTypeId } from '../types/simulation';

/**
 * ToolStateLogic — pure, testable tool-mode / unit-selection transition logic.
 *
 * THE BUG THIS ENFORCES AWAY: BuildToolbar called onSetToolMode('select') and
 * then onSelectUnitTypeId(null), but App's onSelectUnitTypeId handler
 * unconditionally ran setToolMode('place_unit') — so React batching left the
 * canvas in `toolMode='place_unit'` with `selectedUnitTypeId=null`: the Pipes/
 * Inspect/Demolish button LOOKED selected while every click did nothing.
 *
 * Rule set (Prompt 3.4.2 P0):
 *  - onSelectUnitTypeId(null) must NEVER switch into 'place_unit'.
 *  - Only a NON-null type selection enters 'place_unit'.
 *  - Tool buttons atomically leave placement AND clear the stale build unit.
 */

export interface ToolInteractionState {
  toolMode: ToolMode;
  selectedUnitTypeId: UnitTypeId | null;
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
  switch (action.type) {
    case 'set_tool_mode': {
      // Any explicit global-tool choice clears a stale placement unit so the
      // toolbar highlight, cursor, and canvas behavior all agree.
      return { toolMode: action.mode, selectedUnitTypeId: null };
    }

    case 'select_unit_type': {
      if (action.typeId === null) {
        // Clearing the build unit NEVER forces place_unit: it simply leaves
        // placement. If we weren't placing, nothing changes at all.
        return prev.toolMode === 'place_unit'
          ? { ...prev, selectedUnitTypeId: null }
          : prev;
      }
      // A real unit selection always means "I intend to place this".
      return { toolMode: 'place_unit', selectedUnitTypeId: action.typeId };
    }

    case 'cancel_placement':
      return { toolMode: 'select', selectedUnitTypeId: null };
  }
}
