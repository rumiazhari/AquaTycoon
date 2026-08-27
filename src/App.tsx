import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { SceneManager } from './graphics/SceneManager';
import { GameManager, GameState } from './gameplay/GameManager';
import { ToolMode } from './types/graphics';
import {
  PipeConnection, PlacedUnit, UnitPort, UnitTypeId
} from './types/simulation';
import { UNIT_DEFINITIONS } from './sim/UnitProcessModels';
import {
  generatePipePath,
  getPortWorldPosition,
  getTargetPorts,
  getSourcePorts,
  findPort,
  isConnectionExisting,
  validateConnection,
  inferMainTrainPipes,
} from './sim/PipeNetwork';
import { emptyWater } from './sim/WaterStream';
import { SoundManager } from './audio/SoundManager';
import { CAMPAIGN_LEVELS } from './gameplay/LevelsData';
import { TUTORIAL_STEPS, TUTORIAL_PIPE_CHAIN } from './gameplay/TutorialSteps';
import { BASIN_DEFAULT_DEPTH_M, validateBasinPlacement, validateBasinEdit, basinHandleDirForTile, basinRectForHandleDrag } from './design/CustomBasin';
import type { BasinHandleDir } from './design/CustomBasin';
import { EQUIPMENT_TYPES, validateEquipmentPlacement } from './design/ProcessEquipment';
import { UTILITY_TYPES, UtilityConnectionType, validateUtilityConnection, utilityRectFor } from './design/UtilityConnection';
import { poweredEquipmentIds, aeratedDiffuserIds } from './design/ConstructionNetwork';
import { filtrationLiveSets, chemicalLiveSets } from './design/ConstructionAdapter';
import { validateBafflePlacement, baffleRectFor } from './design/BasinZone';
import { emptySelection, selectionCount, toggleSelection, basinIdsSet, equipmentIdsSet, baffleIdsSet, utilityIdsSet, selectionSummaryLine } from './design/ConstructionSelection';
import type { ConstructionSelection } from './design/ConstructionSelection';

// UI Components
import { HeaderHUD } from './ui/HeaderHUD';
import { BuildToolbar } from './ui/BuildToolbar';
import { UnitInspector } from './ui/UnitInspector';
import { BasinInspector } from './ui/BasinInspector';
import { EquipmentInspector } from './ui/EquipmentInspector';
import { BaffleInspector } from './ui/BaffleInspector';
import { ConstructionStatusChip } from './ui/ConstructionStatusChip';
import { ProcessBadgeStrip } from './ui/ProcessBadgeStrip';
import { BulkActionBar } from './ui/BulkActionBar';
import { recognizeProcess } from './design/ProcessRecognition';
import { PlantFlowDiagram } from './ui/PlantFlowDiagram';
import { defaultMaterialForPipeType } from './design/PipeSizing';
import { UnitDesigner } from './ui/UnitDesigner';
import { LevelModal } from './ui/LevelModal';
import { TechTreeModal } from './ui/TechTreeModal';
import { SandboxControls } from './ui/SandboxControls';
import { TutorialPromptModal, TutorialCoach } from './ui/TutorialUI';
import { VictoryModal } from './ui/VictoryModal';
import { OperatorConsole } from './ui/OperatorConsole';
import { PortSelector } from './ui/PortSelector';
import { FixAction, findFreeSpot } from './sim/AdvisoryEngine';
import {
  reduceToolSelection,
  ToolInteractionState,
} from './ui/ToolStateLogic';

import {
  Info
} from 'lucide-react';

/** Contextual port-picker state (explicit source/target port selection) */
interface PortPickerState {
  mode: 'source' | 'target';
  unitId: string;
  anchor: { x: number; y: number };
  choices: import('./ui/PortSelector').PortChoice[];
}

/** Maps a source port type (+ target port) to the pipe's semantic visual class */
function resolvePipeType(fp: UnitPort, tp: UnitPort | null): PipeConnection['pipeType'] {
  if (fp.type === 'gas_outlet') return 'gas';
  if (fp.type === 'recycle_outlet') return 'recycle';
  if (fp.type === 'sludge_outlet') return tp?.type === 'ras_inlet' ? 'ras' : 'sludge';
  return 'liquid';
}

/** Ordinary outlet ports feed ONE line; only modeled splitters may branch. */
function maxPipesPerSourcePort(typeId: UnitTypeId): number {
  return typeId === 'pipe_junction' ? 2 : 1;
}

function countSourcePipes(pipes: PipeConnection[], unitId: string, portId: string): number {
  return pipes.filter(p => p.fromUnitId === unitId && p.fromPortId === portId).length;
}

function unitName(u: PlacedUnit | undefined): string {
  return u ? UNIT_DEFINITIONS[u.typeId]?.name ?? u.typeId : '?';
}

/**
 * P4 slice 3 — bracket rects for multi-select grouping visuals.
 * Basins get exact footprint; equipment is 1x1 tiles; baffles are thin
 * 0.8 m strips via baffleRectFor; utilities are bounding boxes via utilityRectFor.
 * Returns null when selectionCount<=1 (grouping cue only for >=2).
 */
function bracketRectsForSelection(
  sel: ConstructionSelection,
  basins: { id: string; x: number; y: number; w: number; h: number }[],
  baffles: { id: string; basinId: string; orientation: string; offsetTiles: number }[],
  utilities: { id: string; ax: number; ay: number; bx: number; by: number }[],
  equipment: { id: string; x: number; y: number }[],
): { x: number; y: number; w: number; h: number }[] | null {
  if (selectionCount(sel) <= 1) return null;
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const id of sel.basins) {
    const b = basins.find(x => x.id === id);
    if (b) out.push({ x: b.x, y: b.y, w: b.w, h: b.h });
  }
  for (const id of sel.equipment) {
    const e = equipment.find(x => x.id === id);
    if (e) out.push({ x: e.x, y: e.y, w: 1, h: 1 });
  }
  for (const id of sel.baffles) {
    const bf = baffles.find(x => x.id === id);
    if (!bf) continue;
    const basin = basins.find(b => b.id === bf.basinId);
    if (!basin) continue;
    const r = baffleRectFor(bf as any, basin as any);
    if (r) out.push(r);
  }
  for (const id of sel.utilities) {
    const u = utilities.find(x => x.id === id);
    if (u) out.push(utilityRectFor(u));
  }
  return out.length ? out : null;
}

export const App: React.FC = () => {
  // ── Container & Scene ────────────────────────────────────────────────────────
  const containerRef    = useRef<HTMLDivElement>(null);
  const sceneRef        = useRef<SceneManager | null>(null);

  // ── Game State ───────────────────────────────────────────────────────────────
  const [gameState, setGameState] = useState<GameState>(() =>
    GameManager.createInitialState(0, false)
  );
  const gsRef = useRef<GameState>(gameState);
  gsRef.current = gameState;

  // ── Tool / Interaction State ─────────────────────────────────────────────────
  // ONE authoritative reducer decides toolMode AND selectedUnitTypeId together
  // (ToolStateLogic.ts). Both always change via the same dispatched action, so
  // React batching can never strand `toolMode='place_unit'` with a cleared unit
  // type — the old bug that left Inspect/Pipes/Demolish visually selected while
  // canvas clicks did nothing.
  const [toolState, setToolState] = useState<ToolInteractionState>({
    toolMode: 'select',
    selectedUnitTypeId: null,
  });
  const { toolMode, selectedUnitTypeId } = toolState;
  const toolModeRef = useRef<ToolMode>('select');
  toolModeRef.current = toolMode;
  const selUnitTypeRef = useRef<UnitTypeId | null>(null);
  selUnitTypeRef.current = selectedUnitTypeId;

  /** Atomic global-tool change — also clears any stale placement unit. */
  const setToolMode = useCallback((mode: ToolMode) => {
    setToolState(prev => reduceToolSelection(prev, { type: 'set_tool_mode', mode }));
  }, []);

  /**
   * Atomic build-unit selection. `null` clears the placement unit WITHOUT ever
   * forcing place_unit; a non-null id enters place_unit WITH that unit in one
   * indivisible state transition.
   */
  const applyUnitTypeSelection = useCallback((typeId: UnitTypeId | null) => {
    setToolState(prev => reduceToolSelection(prev, { type: 'select_unit_type', typeId }));
  }, []);

  // ── CONSTRUCTION-BUILDER Phase 1: direct-manipulation basin drawing ──────────
  // Draw state: drag from first corner to opposite corner; footprint previewed
  // live on the grid. All validation lives in GameManager.placeCustomBasin.
  const drawStartTileRef = useRef<{ x: number; y: number } | null>(null);
  const [drawPreview, setDrawPreview] = useState<{
    x: number; y: number; w: number; h: number; valid: boolean;
  } | null>(null);
  const drawPreviewRef = useRef<typeof drawPreview>(null);
  drawPreviewRef.current = drawPreview;

  const [currentRotation, setCurrentRotation]       = useState<0|90|180|270>(0);
  const rotationRef = useRef<0|90|180|270>(0);
  rotationRef.current = currentRotation;

  // CONSTRUCTION-BUILDER Phase 1: selected player-drawn basin (inspect/demolish).
  const [selectedBasinId, setSelectedBasinId] = useState<string | null>(null);
  const selectedBasinIdRef = useRef<string | null>(null);
  selectedBasinIdRef.current = selectedBasinId;

  // P4 slice 2: in-world basin wall drag-handles — direct grip-resize state
  const basinHandleDragRef = useRef<{ basinId: string; dir: BasinHandleDir; startRect: { x:number;y:number;w:number;h:number;depthM:number } } | null>(null);
  const cancelBasinHandleDrag = useCallback((silent:boolean=false) => {
    basinHandleDragRef.current = null;
    sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
    if (!silent) setToast('Wall drag cancelled — basin unchanged.');
  }, []);

  // P5: in-world equipment drag-handle — grab amber handle to move machine(s) with live ghost
  // Slice 2: group handle — Shift-selected block moves as one, preserving offsets
  const equipHandleDragRef = useRef<{ anchorId: string; groupIds: string[]; anchorStart: { x:number; y:number }; typeId: string } | null>(null);
  const cancelEquipHandleDrag = useCallback((silent:boolean=false) => {
    equipHandleDragRef.current = null;
    sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
    if (!silent) setToast('Equipment drag cancelled — machines stay.');
  }, []);
  const syncEquipHandleVisual = useCallback(() => {
    const sm = sceneRef.current;
    if (!sm) return;
    const sel = constructionSelectionRef.current;
    if (sel.equipment.length >= 1) {
      // Show handle at the first selected equipment (anchor for group drag when Shift-selected)
      const anchorId = sel.equipment[0];
      const eq = gsRef.current.processEquipment?.find(e => e.id === anchorId) ?? null;
      sm.syncEquipmentDragHandle(eq ? { x: eq.x, y: eq.y, typeId: eq.typeId } : null, gsRef.current.customBasins ?? []);
    } else {
      sm.syncEquipmentDragHandle(null);
    }
  }, []);

  // ── CONSTRUCTION-BUILDER Phase 2: physical equipment placement ──────────────
  // Armed machine type (toolbar) + selected installed machine (inspect).
  const [selectedEquipmentTypeId, setSelectedEquipmentTypeId] = useState<string | null>(null);
  const selEquipTypeRef = useRef<string | null>(null);
  selEquipTypeRef.current = selectedEquipmentTypeId;
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string | null>(null);
  const selectedEquipmentIdRef = useRef<string | null>(null);
  selectedEquipmentIdRef.current = selectedEquipmentId;

  // ── CONSTRUCTION-BUILDER P2: equipment direct manipulation — move/rotate ────
  // Armed move: after clicking Move in the inspector, the next tile click
  // relocates the machine (free, same validation as placement, self-excluded).
  // Ghost preview follows the cursor while armed; Esc / right-click cancels.
  const [movingEquipmentId, setMovingEquipmentId] = useState<string | null>(null);
  const movingEquipmentIdRef = useRef<string | null>(null);
  movingEquipmentIdRef.current = movingEquipmentId;

  const cancelEquipmentMove = useCallback((silent: boolean = false) => {
    setMovingEquipmentId(null);
    sceneRef.current?.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
    if (!silent) setToast('Move cancelled — click the equipment again to re-arm.');
  }, []);

  // P3 — hover affordance: contextual hint for what's under the cursor in Inspect mode
  const [hoverHint, setHoverHint] = useState<string | null>(null);

  // ── CONSTRUCTION-BUILDER Phase 3: utility connections (water/air/power) ───
  const [selectedUtilityTypeId, setSelectedUtilityTypeId] = useState<UtilityConnectionType | null>('water_pipe');
  const selUtilityTypeRef = useRef<UtilityConnectionType | null>('water_pipe');
  selUtilityTypeRef.current = selectedUtilityTypeId;
  const [selectedUtilityId, setSelectedUtilityId] = useState<string | null>(null);
  const selectedUtilityIdRef = useRef<string | null>(null);
  selectedUtilityIdRef.current = selectedUtilityId;
  const utilitySourceRef = useRef<{ x: number; y: number } | null>(null);

  // ── CONSTRUCTION-BUILDER Phase 5: baffle walls (basin compartments) ────────
  const [selectedBaffleOrientation, setSelectedBaffleOrientation] = useState<'vertical' | 'horizontal' | null>('vertical');
  const selBaffleOrientRef = useRef<'vertical' | 'horizontal' | null>('vertical');
  selBaffleOrientRef.current = selectedBaffleOrientation;
  const [selectedBaffleId, setSelectedBaffleId] = useState<string | null>(null);
  const selectedBaffleIdRef = useRef<string | null>(null);
  selectedBaffleIdRef.current = selectedBaffleId;

  // ── CONSTRUCTION-BUILDER P4: shift multi-select + bulk demolish ──────────
  const [constructionSelection, setConstructionSelection] = useState<ConstructionSelection>(() => emptySelection());
  const constructionSelectionRef = useRef<ConstructionSelection>(emptySelection());
  constructionSelectionRef.current = constructionSelection;
  const clearConstructionSelection = useCallback(() => {
    setConstructionSelection(emptySelection());
    setSelectedBasinId(null);
    setSelectedEquipmentId(null);
    setSelectedBaffleId(null);
    setSelectedUtilityId(null);
    const sm = sceneRef.current;
    if (sm) {
      const gs = gsRef.current;
      sm.syncBasins(gs.customBasins ?? [], null);
      sm.syncSelectionBrackets(null);
      sm.syncDimensionLabels(gs.customBasins ?? [], null);
      sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], null);
      sm.syncUtilityConnections(gs.utilityConnections ?? [], null);
      sm.syncEquipment(
        gs.processEquipment ?? [], gs.customBasins ?? [], null,
        poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
        aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
        filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
      );
      sm.syncEquipmentDragHandle(null);
    }
  }, []);

  // Placement-time seed choice (backlog #1 follow-up): ON (default) hands over
  // a contractor-seeded reactor at full def.capex; OFF starts UNSEEDED at
  // def.capex − seed haul-in credit and lets the culture ramp over ~2 weeks.
  const [placeSeeded, setPlaceSeeded] = useState<boolean>(true);
  const placeSeededRef = useRef<boolean>(true);
  placeSeededRef.current = placeSeeded;

  const [pipeSourceId, setPipeSourceId]             = useState<string | null>(null);
  const pipeSourcePortRef = useRef<string | null>(null);
  const pipeSourcePosRef = useRef<[number, number, number] | null>(null);
  const pipeSourceRef = useRef<string | null>(null);
  pipeSourceRef.current = pipeSourceId;

  /** Explicit port selection: contextual picker near the unit/cursor */
  const [portPicker, setPortPicker] = useState<PortPickerState | null>(null);
  // Pending target unit while its port picker is open
  const pendingTargetRef = useRef<string | null>(null);

  // ── UI State ────────────────────────────────────────────────────────────────
  const [toast, setToast]                     = useState('Welcome to AquaTycoon 3D! Follow the guide on the top-left or pick a unit below.');
  const [isTopDown, setIsTopDown]             = useState(false);
  const [levelModal, setLevelModal]           = useState(false);
  const [techModal, setTechModal]             = useState(false);
  const [pfdModal, setPfdModal]               = useState(false);
  const [designerModalId, setDesignerModalId] = useState<string | null>(null);
  const [sandboxModal, setSandboxModal]       = useState(false);
  const [operatorOpen, setOperatorOpen]       = useState(false);
  const [askTutorial, setAskTutorial]         = useState(true);

  // ── Tutorial state (derived) ──────────────────────────────────────────────
  const tutorialActive = gameState.tutorialActive;
  const tutStep = TUTORIAL_STEPS[gameState.tutorialStep] ?? null;
  // During the tutorial only the current step's unit is buildable ('none' = no building)
  const tutorialAllowedUnitId: UnitTypeId | 'none' | undefined =
    tutorialActive ? (tutStep?.unitTypeId ?? 'none') : undefined;

  const startTutorial = useCallback(() => {
    setAskTutorial(false);
    setGameState(prev => ({ ...prev, tutorialActive: true, tutorialStep: 0 }));
    // Leave any placement/pipe interaction atomically before the guided run.
    setToolState(prev => reduceToolSelection(prev, { type: 'cancel_placement' }));
    SoundManager.playClick();
    setToast('Tutorial started — Dr. Rio Clearwater is waiting bottom-left!');
  }, []);

  const declineTutorial = useCallback(() => {
    setAskTutorial(false);
    setToast('Free building unlocked — you veteran, you.');
  }, []);

  const cancelTutorial = useCallback(() => {
    setGameState(prev => ({ ...prev, tutorialActive: false }));
    sceneRef.current?.terrainGrid.setBuildRestriction(null);
    // Atomic exit from any placement/pipe interaction back to Inspect.
    setToolState(prev => reduceToolSelection(prev, { type: 'cancel_placement' }));
    setToast('Tutorial cancelled — full freedom unlocked!');
    SoundManager.playClick();
  }, []);

  // ── Pointer tracking ─────────────────────────────────────────────────────────
  const pointerDown    = useRef(false);
  const pointerButton  = useRef(0);
  const pointerStart   = useRef({ x: 0, y: 0 });
  const pointerLast    = useRef({ x: 0, y: 0 });
  const pointerDist    = useRef(0);

  // ── Simulation interval ───────────────────────────────────────────────────────
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Undo / Redo history (pipes, placement, demolition) ───────────────────────
  const undoStackRef = useRef<GameState[]>([]);
  const redoStackRef = useRef<GameState[]>([]);

  const pushHistory = useCallback((snapshot: GameState) => {
    undoStackRef.current.push(structuredClone(snapshot));
    if (undoStackRef.current.length > 60) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  const applyHistoryState = useCallback((state: GameState) => {
    setGameState(state);
    setMovingEquipmentId(null);
    basinHandleDragRef.current = null;
    equipHandleDragRef.current = null;
    setConstructionSelection(emptySelection());
    sceneRef.current?.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
    const sm = sceneRef.current;
    if (sm) {
      sm.syncUnits(state.units);
      sm.syncPipes(state.pipes);
      sm.syncBasins(state.customBasins ?? [], null);
      sm.syncEquipment(
        state.processEquipment ?? [], state.customBasins ?? [], null,
        poweredEquipmentIds(state.processEquipment ?? [], state.utilityConnections ?? []),
        aeratedDiffuserIds(state.processEquipment ?? [], state.utilityConnections ?? []),
        filtrationLiveSets(state.customBasins ?? [], state.processEquipment ?? [], state.utilityConnections ?? [], state.customBaffles ?? [])
      );
      sm.syncUtilityConnections(state.utilityConnections ?? [], null);
      sm.syncBaffles(state.customBaffles ?? [], state.customBasins ?? [], null);
      sm.syncEquipmentDragHandle(null);
      sm.syncSelectionBrackets(null);
      sm.syncDimensionLabels(state.customBasins ?? [], null);
      if (state.suggestion) {
        sm.showNextStepGhost(state.suggestion.unitTypeId, state.suggestion.gridX, state.suggestion.gridY);
      } else {
        sm.showNextStepGhost(null, 0, 0);
      }
    }
  }, []);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) { setToast('Nothing to undo.'); return; }
    redoStackRef.current.push(structuredClone(gsRef.current));
    applyHistoryState(prev);
    SoundManager.playClick();
    setToast('Undone.');
  }, [applyHistoryState]);

  const handleRedo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) { setToast('Nothing to redo.'); return; }
    undoStackRef.current.push(structuredClone(gsRef.current));
    applyHistoryState(next);
    SoundManager.playClick();
    setToast('Redone.');
  }, [applyHistoryState]);

  /** Cancels an in-progress pipe source selection */
  const cancelPipeSelection = useCallback((silent: boolean = false) => {
    setPipeSourceId(null);
    pipeSourcePortRef.current = null;
    pipeSourcePosRef.current = null;
    pendingTargetRef.current = null;
    setPortPicker(null);
    sceneRef.current?.setPipeSourceHighlight(null, gsRef.current.units);
    sceneRef.current?.setPipePreview(null, null);
    if (!silent) setToast('Pipe selection cancelled.');
  }, []);

  const cancelUtilitySelection = useCallback((silent: boolean = false) => {
    utilitySourceRef.current = null;
    sceneRef.current?.setUtilityPreview(null, null);
    sceneRef.current?.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
    if (!silent) setToast('Utility selection cancelled.');
  }, []);

  const cancelBafflePreview = useCallback(() => {
    sceneRef.current?.setBafflePreview(null, null, null);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // INITIALIZE THREE.JS SCENE (once)
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const initState = gsRef.current;
    const [mapW, mapD] = initState.currentLevel.mapSize;
    const sm = new SceneManager(container, mapW, mapD);
    sceneRef.current = sm;
    // Scene-clock sync (Prompt 3.4 item 17): push the authoritative clock and
    // speed BEFORE the first render so the world never boots at a false
    // midnight/1× state before the first 500 ms React tick.
    sm.setGameClock(initState.gameTimeDays);
    sm.setSimulationSpeed(initState.simSpeed);
    sm.setEnvironment(initState.currentLevel.biome);

    sm.cameraController.setCanvasSize(container.clientWidth, container.clientHeight);
    sm.syncUnits(initState.units);
    sm.syncPipes(initState.pipes);
    sm.syncBasins(initState.customBasins ?? [], selectedBasinId);
    sm.syncDimensionLabels(initState.customBasins ?? [], selectedBasinId);
    sm.syncEquipment(
      initState.processEquipment ?? [], initState.customBasins ?? [], null,
      poweredEquipmentIds(initState.processEquipment ?? [], initState.utilityConnections ?? []),
      aeratedDiffuserIds(initState.processEquipment ?? [], initState.utilityConnections ?? []),
      filtrationLiveSets(initState.customBasins ?? [], initState.processEquipment ?? [], initState.utilityConnections ?? [], initState.customBaffles ?? [])
    );
    sm.syncUtilityConnections(initState.utilityConnections ?? [], null);
    sm.syncBaffles(initState.customBaffles ?? [], initState.customBasins ?? [], null);

    if (initState.suggestion) {
      sm.showNextStepGhost(initState.suggestion.unitTypeId, initState.suggestion.gridX, initState.suggestion.gridY);
    }

    // Resize
    const onResize = () => {
      if (!container) return;
      sm.handleResize(container.clientWidth, container.clientHeight);
      sm.cameraController.setCanvasSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', onResize, { passive: true });

    // ── Attach ALL pointer/wheel events directly to the CANVAS ───────────────
    const canvas = sm.canvas;

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      pointerDown.current   = true;
      pointerButton.current = e.button;
      pointerStart.current  = { x: e.clientX, y: e.clientY };
      pointerLast.current   = { x: e.clientX, y: e.clientY };
      pointerDist.current   = 0;
      // P5: detect grab of equipment drag-handle when equipment is selected.
      // Slice 2: group handle — any selected equipment tile is a grab point;
      // the whole Shift-selected block moves as one, preserving offsets.
      // Lone machine (selectionCount 1) keeps forgiving handle; multi also grabs.
      if (e.button === 0 && toolModeRef.current === 'select' && !movingEquipmentIdRef.current && !basinHandleDragRef.current && !equipHandleDragRef.current && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const sm2 = sceneRef.current;
        const tile2 = sm2?.getGridTileFromScreen(e.clientX, e.clientY) ?? null;
        const sel = constructionSelectionRef.current;
        if (tile2 && sel.equipment.length >= 1) {
          const hitId = sel.equipment.find(id => {
            const eq = gsRef.current.processEquipment?.find(en => en.id === id);
            return eq ? (eq.x === tile2.x && eq.y === tile2.y) : false;
          }) ?? null;
          if (hitId) {
            const hit = gsRef.current.processEquipment?.find(en => en.id === hitId)!;
            equipHandleDragRef.current = { anchorId: hit.id, groupIds: [...sel.equipment], anchorStart: { x: hit.x, y: hit.y }, typeId: hit.typeId };
          }
        }
      }
      // P4 slice 2: detect grab of a basin wall/corner handle when a single basin is selected.
      // Any perimeter tile becomes a drag handle — forgiving grip on the wall itself.
      if (e.button === 0 && toolModeRef.current === 'select' && !movingEquipmentIdRef.current && !basinHandleDragRef.current && !equipHandleDragRef.current) {
        const sm2 = sceneRef.current;
        const tile2 = sm2?.getGridTileFromScreen(e.clientX, e.clientY) ?? null;
        const selId = selectedBasinIdRef.current;
        const sel = constructionSelectionRef.current;
        if (tile2 && selId && sel.basins.length === 1 && sel.basins[0] === selId && selectionCount(sel) === 1) {
          const basin = gsRef.current.customBasins?.find(b => b.id === selId) ?? null;
          if (basin) {
            const dir = basinHandleDirForTile(basin, tile2);
            if (dir) {
              // Don't steal clicks that should toggle multi-select (Shift) or that hit equipment/baffle first
              const equipHit = GameManager.equipmentAtTile(gsRef.current, tile2.x, tile2.y);
              const groundPt = sm2!.getGroundPointFromScreen(e.clientX, e.clientY);
              const baffleHit = groundPt ? GameManager.baffleAtPoint(gsRef.current, groundPt.x, groundPt.z) : null;
              if (!equipHit && !baffleHit) {
                basinHandleDragRef.current = { basinId: basin.id, dir, startRect: { x: basin.x, y: basin.y, w: basin.w, h: basin.h, depthM: basin.depthM } };
              }
            }
          }
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      e.preventDefault();
      const sm = sceneRef.current;
      if (!sm) return;

      // P5: active equipment drag — live green/red ghost, utility-gated, mount-aware, blocks pan
      // Slice 2: group drag — Shift-selected block moves preserving offsets; ghost shows collective validity
      if (equipHandleDragRef.current && pointerDown.current) {
        const tile = sm.getGridTileFromScreen(e.clientX, e.clientY);
        const dxP = e.clientX - pointerLast.current.x;
        const dyP = e.clientY - pointerLast.current.y;
        pointerLast.current = { x: e.clientX, y: e.clientY };
        pointerDist.current += Math.hypot(dxP, dyP);
        const drag = equipHandleDragRef.current;
        const anchor = gsRef.current.processEquipment?.find(en => en.id === drag.anchorId);
        if (!anchor) { sm.terrainGrid.setGhostPreview(drag.anchorStart.x, drag.anchorStart.y, 1, 1, false, true); return; }
        if (!tile) {
          sm.terrainGrid.setGhostPreview(drag.anchorStart.x, drag.anchorStart.y, 1, 1, false, true);
          return;
        }
        const groupIds: string[] = (drag as any).groupIds ?? [drag.anchorId];
        const isGroup = groupIds.length > 1;
        // Same-tile = valid (no-op preview)
        if (tile.x === anchor.x && tile.y === anchor.y) {
          sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, true, true);
          const n = groupIds.length;
          const nm = isGroup ? `${n} machines` : (EQUIPMENT_TYPES[anchor.typeId]?.name ?? 'equipment');
          setHoverHint(`↔ Dragging ${nm} — release same tile to cancel · Esc cancels`);
          return;
        }
        // Utility still attached on ANY member -> blocked (must cut cable first)
        const attachedGroup = groupIds.filter(id => {
          const m = gsRef.current.processEquipment?.find(en => en.id === id);
          if (!m) return false;
          return (gsRef.current.utilityConnections ?? []).some(c => (c.ax === m.x && c.ay === m.y) || (c.bx === m.x && c.by === m.y));
        });
        if (attachedGroup.length > 0) {
          sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, false, true);
          setHoverHint(`⛔ Move blocked — ${attachedGroup.length} machine${attachedGroup.length>1?'s':''} still have utility lines attached (cut pipes/cables first) · Esc cancels`);
          return;
        }
        // Group-aware validation — all members vacate simultaneously
        const ddx = tile.x - anchor.x;
        const ddy = tile.y - anchor.y;
        const groupSet = new Set(groupIds);
        const [mapW2, mapH2] = gsRef.current.currentLevel.mapSize;
        const unitRects2 = gsRef.current.units.map(u => {
          const d = (UNIT_DEFINITIONS as any)[u.typeId];
          const [uw, ul] = d ? d.footprint : [1, 1];
          return { x: u.gridX, y: u.gridY, w: uw, h: ul };
        });
        for (const o of gsRef.current.processEquipment ?? []) {
          if (!groupSet.has(o.id) && (EQUIPMENT_TYPES as any)[o.typeId]?.mounting === 'ground') unitRects2.push({ x: o.x, y: o.y, w: 1, h: 1 });
        }
        const remainingEquip = (gsRef.current.processEquipment ?? []).filter(e => !groupSet.has(e.id));
        let firstReason: string | null = null;
        let allOk = true;
        for (const id of groupIds) {
          const m = gsRef.current.processEquipment?.find(en => en.id === id)!;
          const tx = m.x + ddx;
          const ty = m.y + ddy;
          const vr = validateEquipmentPlacement(m.typeId, tx, ty, [mapW2, mapH2], gsRef.current.customBasins ?? [], remainingEquip, unitRects2);
          if (!vr.ok) { allOk = false; firstReason = vr.reason ?? 'Blocked'; break; }
        }
        // inter-target duplicate check (defensive)
        if (allOk && isGroup) {
          const seen = new Set<string>();
          for (const id of groupIds) {
            const m = gsRef.current.processEquipment?.find(en => en.id === id)!;
            const key = `${m.x + ddx},${m.y + ddy}`;
            if (seen.has(key)) { allOk = false; firstReason = 'Group would overlap — two machines same tile'; break; }
            seen.add(key);
          }
        }
        sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, allOk, true);
        if (allOk) {
          const nm = isGroup ? `${groupIds.length} machines` : (EQUIPMENT_TYPES[anchor.typeId]?.name ?? 'equipment');
          const costAgg = isGroup ? (() => {
            let c=0, p=0; for (const id of groupIds){ const mm = gsRef.current.processEquipment?.find(e=>e.id===id); if(mm){ const d=EQUIPMENT_TYPES[mm.typeId]; if(d){ c+=d.capexUsd; p+=d.powerKw; } } } return ` · $${c.toLocaleString()} · ${p} kW`;
          })() : '';
          setHoverHint(`↔ Dragging ${nm}${costAgg} → (${tile.x},${tile.y}) · green = valid · red = blocked · Esc cancels`);
        } else {
          setHoverHint(`⛔ ${firstReason} · Esc cancels`);
        }
        return;
      }

      // P4 slice 2: active wall drag — show ghost of the resized basin while held
      if (basinHandleDragRef.current && pointerDown.current) {
        const tile = sm.getGridTileFromScreen(e.clientX, e.clientY);
        const dx = e.clientX - pointerLast.current.x;
        const dy = e.clientY - pointerLast.current.y;
        pointerLast.current = { x: e.clientX, y: e.clientY };
        pointerDist.current += Math.hypot(dx, dy);
        if (!tile) {
          sm.terrainGrid.setGhostPreview(basinHandleDragRef.current.startRect.x, basinHandleDragRef.current.startRect.y, basinHandleDragRef.current.startRect.w, basinHandleDragRef.current.startRect.h, false, true);
          return;
        }
        const drag = basinHandleDragRef.current;
        const cand = basinRectForHandleDrag(drag.startRect as any, drag.dir, tile);
        const gs = gsRef.current;
        const unitRects = gs.units.map(u => {
          const d = (UNIT_DEFINITIONS as any)[u.typeId];
          const [uw, ul] = d ? d.footprint : [1, 1];
          return { x: u.gridX, y: u.gridY, w: uw, h: ul };
        });
        for (const eq of gs.processEquipment ?? []) {
          if ((EQUIPMENT_TYPES as any)[eq.typeId]?.mounting === 'ground') unitRects.push({ x: eq.x, y: eq.y, w: 1, h: 1 });
        }
        const equipTiles = (gs.processEquipment ?? []).filter(eq => eq.x >= drag.startRect.x && eq.x < drag.startRect.x + drag.startRect.w && eq.y >= drag.startRect.y && eq.y < drag.startRect.y + drag.startRect.h).map(eq=>({x:eq.x,y:eq.y}));
        const baffleOffsets = (gs.customBaffles ?? []).map(bf=>({ basinId: bf.basinId, orientation: bf.orientation as any, offsetTiles: bf.offsetTiles }));
        const vr = validateBasinEdit(drag.basinId, cand as any, drag.startRect.depthM, gs.currentLevel.mapSize, gs.customBasins ?? [], unitRects, equipTiles, baffleOffsets);
        sm.terrainGrid.setGhostPreview(cand.x, cand.y, cand.w, cand.h, vr.ok, true);
        return;
      }

      if (pointerDown.current) {
        const dx = e.clientX - pointerLast.current.x;
        const dy = e.clientY - pointerLast.current.y;
        pointerLast.current = { x: e.clientX, y: e.clientY };
        pointerDist.current += Math.hypot(dx, dy);

        if (pointerButton.current === 2 || e.buttons === 2 || e.buttons === 4) {
          // Right-drag OR middle-drag → ORBIT CAMERA
          sm.cameraController.orbit(dx * 0.007, dy * 0.007);
        } else {
          // Left-drag → PAN CAMERA
          sm.cameraController.pan(dx, dy);
        }
      } else {
        // ── Hover ghost preview ─────────────────────────────────────────────
        const tile = sm.getGridTileFromScreen(e.clientX, e.clientY);

        // Live pipe-connection preview while a source is armed
        if (toolModeRef.current === 'connect_pipe' && pipeSourceRef.current && pipeSourcePosRef.current) {
          const hit = sm.getGroundPointFromScreen(e.clientX, e.clientY);
          if (hit) {
            sm.setPipePreview(
              new THREE.Vector3(...pipeSourcePosRef.current),
              hit
            );
          }
        } else if (toolModeRef.current === 'connect_pipe') {
          sm.setPipePreview(null, null);
        }
        // Utility preview (Phase 3): source tile → hover tile
        if (toolModeRef.current === 'connect_utility' && utilitySourceRef.current) {
          if (tile) {
            sm.setUtilityPreview(utilitySourceRef.current, tile, selUtilityTypeRef.current ?? 'water_pipe');
          } else {
            sm.setUtilityPreview(null, null);
          }
        } else if (toolModeRef.current !== 'connect_utility') {
          sm.setUtilityPreview(null, null);
        }
        // Baffle preview clear when not in draw_baffle (ghost handled per-tile below)
        if (toolModeRef.current !== 'draw_baffle') {
          sm.setBafflePreview(null, null, null);
        }

        if (!tile) {
          sm.terrainGrid.setHoverTile(0, 0, false);
          sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
          return;
        }
        sm.terrainGrid.setHoverTile(tile.x, tile.y, true);

        if (toolModeRef.current === 'place_unit' && selUnitTypeRef.current) {
          const def = UNIT_DEFINITIONS[selUnitTypeRef.current];
          const rot = rotationRef.current;
          const [fw, fl] = (rot === 90 || rot === 270) ? [def.footprint[1], def.footprint[0]] : def.footprint;
          const [mapW, mapH] = gsRef.current.currentLevel.mapSize;
          const gs = gsRef.current;
          let valid = tile.x >= 0 && tile.y >= 0 && tile.x + fw <= mapW && tile.y + fl <= mapH;
          if (valid) {
            valid = !gs.units.some(u => {
              const ud = UNIT_DEFINITIONS[u.typeId];
              if (!ud) return false;
              const [uw, ul] = (u.rotation === 90 || u.rotation === 270) ? [ud.footprint[1], ud.footprint[0]] : ud.footprint;
              return tile.x < u.gridX + uw && tile.x + fw > u.gridX && tile.y < u.gridY + ul && tile.y + fl > u.gridY;
            });
          }
          // Tutorial: red ghost when hovering outside the guided lot
          if (valid && gs.tutorialActive) {
            const step = TUTORIAL_STEPS[gs.tutorialStep];
            const sug = gs.suggestion;
            if (step?.unitTypeId && sug &&
                !(tile.x >= sug.gridX && tile.x < sug.gridX + def.footprint[0] &&
                  tile.y >= sug.gridY && tile.y < sug.gridY + def.footprint[1])) {
              valid = false;
            }
          }
          sm.terrainGrid.setGhostPreview(tile.x, tile.y, fw, fl, valid, true);
        } else if (toolModeRef.current === 'draw_basin') {
          // Live rectangular footprint preview from the anchored first corner.
          const start = drawStartTileRef.current;
          if (start) {
            const rect = {
              x: Math.min(start.x, tile.x),
              y: Math.min(start.y, tile.y),
              w: Math.abs(tile.x - start.x) + 1,
              h: Math.abs(tile.y - start.y) + 1,
            };
            const [mapW, mapH] = gsRef.current.currentLevel.mapSize;
            const unitRects = gsRef.current.units.map(u => {
              const ud = UNIT_DEFINITIONS[u.typeId];
              const [uw, ul] = ud ? ud.footprint : [1, 1];
              return { x: u.gridX, y: u.gridY, w: uw, h: ul };
            });
            const v = validateBasinPlacement(rect, BASIN_DEFAULT_DEPTH_M, [mapW, mapH], gsRef.current.customBasins ?? [], unitRects);
            sm.terrainGrid.setGhostPreview(rect.x, rect.y, rect.w, rect.h, v.ok, true);
          } else {
            sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, true, false);
          }
        } else if (toolModeRef.current === 'place_equipment' && selEquipTypeRef.current) {
          // Phase 2: single-tile ghost colored by mounting-rule validity.
          const [mapW, mapH] = gsRef.current.currentLevel.mapSize;
          const unitRects = gsRef.current.units.map(u => {
            const ud = UNIT_DEFINITIONS[u.typeId];
            const [uw, ul] = ud ? ud.footprint : [1, 1];
            return { x: u.gridX, y: u.gridY, w: uw, h: ul };
          });
          const v = validateEquipmentPlacement(
            selEquipTypeRef.current, tile.x, tile.y,
            [mapW, mapH],
            gsRef.current.customBasins ?? [],
            gsRef.current.processEquipment ?? [],
            unitRects
          );
          sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, v.ok, true);
        } else if (toolModeRef.current === 'connect_utility') {
          // Phase 3: utility endpoint ghost + line validity
          const src = utilitySourceRef.current;
          const utype = (selUtilityTypeRef.current ?? 'water_pipe') as UtilityConnectionType;
          if (!src) {
            // First click: eligible only if tile hosts equipment or basin
            const gs = gsRef.current;
            const e = gs.processEquipment?.find(eq => eq.x === tile.x && eq.y === tile.y);
            const inB = gs.customBasins?.some(b => tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h);
            const valid = !!e || !!inB;
            sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, valid, true);
          } else {
            // Second click: validate the full connection
            const v = validateUtilityConnection(
              utype, src.x, src.y, tile.x, tile.y,
              gsRef.current.currentLevel.mapSize,
              gsRef.current.customBasins ?? [],
              gsRef.current.processEquipment ?? [],
              gsRef.current.utilityConnections ?? []
            );
            sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, v.ok, true);
          }
        } else if (toolModeRef.current === 'draw_baffle') {
          // Phase 5: baffle ghost — dashed wall line + tile validity inside a basin
          const basin = gsRef.current.customBasins?.find(b => tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h) ?? null;
          const orient = (selBaffleOrientRef.current ?? 'vertical') as 'vertical' | 'horizontal';
          if (basin) {
            const offset = orient === 'vertical' ? (tile.x - basin.x + 1) : (tile.y - basin.y + 1);
            const v = validateBafflePlacement(basin, gsRef.current.customBaffles ?? [], orient, offset);
            sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, v.ok, true);
            if (v.ok) sm.setBafflePreview(basin, orient, offset);
            else sm.setBafflePreview(null, null, null);
          } else {
            sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, false, true);
            sm.setBafflePreview(null, null, null);
          }
        } else if (movingEquipmentIdRef.current) {
          // P2 move mode: ghost follows hover tile showing validity for the moving machine
          const movingItem = gsRef.current.processEquipment?.find(e => e.id === movingEquipmentIdRef.current);
          if (movingItem && tile) {
            const attached = (gsRef.current.utilityConnections ?? []).filter(c =>
              (c.ax === movingItem.x && c.ay === movingItem.y) || (c.bx === movingItem.x && c.by === movingItem.y)
            );
            if (attached.length > 0) {
              sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, false, true);
            } else if (tile.x === movingItem.x && tile.y === movingItem.y) {
              sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, true, true);
            } else {
              const [mapW, mapH] = gsRef.current.currentLevel.mapSize;
              const unitRects = gsRef.current.units.map(u => {
                const ud = UNIT_DEFINITIONS[u.typeId];
                const [uw, ul] = ud ? ud.footprint : [1, 1];
                return { x: u.gridX, y: u.gridY, w: uw, h: ul };
              });
              for (const e of gsRef.current.processEquipment ?? []) {
                if (e.id !== movingItem.id && EQUIPMENT_TYPES[e.typeId]?.mounting === 'ground') {
                  unitRects.push({ x: e.x, y: e.y, w: 1, h: 1 });
                }
              }
              const v = validateEquipmentPlacement(
                movingItem.typeId, tile.x, tile.y,
                [mapW, mapH],
                gsRef.current.customBasins ?? [],
                gsRef.current.processEquipment ?? [],
                unitRects,
                movingItem.id
              );
              sm.terrainGrid.setGhostPreview(tile.x, tile.y, 1, 1, v.ok, true);
            }
          } else {
            sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
          }
        } else {
          sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
        }
        // P3 — hover affordance for Inspect mode: show what's under cursor (equipment > baffle > utility > basin > legacy)
        if (toolModeRef.current === 'select' && !movingEquipmentIdRef.current && !pointerDown.current) {
          if (!tile) {
            setHoverHint(null);
          } else {
            const hUnit = sm.getUnitAtScreen(e.clientX, e.clientY, gsRef.current.units);
            const hGround = sm.getGroundPointFromScreen(e.clientX, e.clientY);
            const hBasin = (gsRef.current.customBasins ?? []).find(b => tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h) ?? null;
            const hEquip = GameManager.equipmentAtTile(gsRef.current, tile.x, tile.y);
            const hUtil = hGround ? GameManager.utilityAtPoint(gsRef.current, hGround.x, hGround.z) : null;
            const hBaffle = hGround ? GameManager.baffleAtPoint(gsRef.current, hGround.x, hGround.z) : null;
            let hint: string | null = null;
            // P4 slice 2: drag handle hint has priority when hovering a wall of the lone selected basin
            const selId = selectedBasinIdRef.current;
            const sel = constructionSelectionRef.current;
            const loneBasin = selId && sel.basins.length===1 && sel.basins[0]===selId && selectionCount(sel)===1 ? (gsRef.current.customBasins ?? []).find(b=>b.id===selId) ?? null : null;
            const handleDir = loneBasin ? basinHandleDirForTile(loneBasin, tile) : null;
            // P5: equipment drag handle has priority when hovering any selected machine's tile
            // Slice 2: group handle — Shift block drag preserves offsets
            const equipSel = sel.equipment;
            const onSelectedEquipTile = equipSel.length >= 1 && equipSel.some(id => {
              const eq = gsRef.current.processEquipment?.find(e=>e.id===id);
              return eq ? (eq.x === tile.x && eq.y === tile.y) : false;
            });
            const loneEquipIdForHint = equipSel.length===1 && selectionCount(sel)===1 ? equipSel[0] : null;
            const loneEquip = loneEquipIdForHint ? gsRef.current.processEquipment?.find(e=>e.id===loneEquipIdForHint) ?? null : null;
            if (onSelectedEquipTile) {
              if (equipSel.length > 1) {
                let aggC=0, aggP=0; for (const id of equipSel){ const mm=gsRef.current.processEquipment?.find(e=>e.id===id); if(mm){ const d=EQUIPMENT_TYPES[mm.typeId]; if(d){ aggC+=d.capexUsd; aggP+=d.powerKw; } } }
                hint = `▸ Drag ${equipSel.length} machines · $${aggC.toLocaleString()} · ${aggP} kW — hold amber handle and drag as block (green = valid)`;
              } else {
                const eqN = EQUIPMENT_TYPES[loneEquip!.typeId]?.name ?? loneEquip!.typeId;
                hint = `▸ Drag ${eqN} — hold amber handle and drag to new tile (green = valid · red = blocked · Shift+Click to add)`;
              }
            } else if (handleDir && !hEquip && !hBaffle) {
              const dirLabel = ({n:'North wall',s:'South wall',e:'East wall',w:'West wall',nw:'NW corner',ne:'NE corner',sw:'SW corner',se:'SE corner'} as any)[handleDir] ?? handleDir;
              hint = `▸ Drag ${dirLabel} to resize — hold and drag wall/corner (Shift+Click to add to selection)`;
            } else if (hEquip) {
              const eqName = EQUIPMENT_TYPES[hEquip.typeId]?.name ?? hEquip.typeId;
              const eqCost = EQUIPMENT_TYPES[hEquip.typeId]?.capexUsd ? ` · $${EQUIPMENT_TYPES[hEquip.typeId]!.capexUsd.toLocaleString()}` : '';
              const eqPower = EQUIPMENT_TYPES[hEquip.typeId] ? ` · ${EQUIPMENT_TYPES[hEquip.typeId]!.powerKw} kW` : '';
              hint = `▸ ${eqName}${eqCost}${eqPower} — Click to inspect · Drag handle when selected · Move/Rotate`;
            } else if (hBaffle) {
              hint = `▸ ${hBaffle.orientation === 'vertical' ? 'Vertical' : 'Horizontal'} baffle · Click to inspect`;
            } else if (hUtil) {
              hint = `▸ ${UTILITY_TYPES[hUtil.type]?.name ?? hUtil.type} · Click to inspect`;
            } else if (hBasin) {
              // When this basin is the lone selected one, hint drag vs inspect
              if (loneBasin && hBasin.id === loneBasin.id) {
                hint = `▸ Basin ${hBasin.w}×${hBasin.h} · ${hBasin.w * hBasin.h * hBasin.depthM} m³ — Drag wall/corner to resize · Click interior to re-select`;
              } else {
                hint = `▸ Basin ${hBasin.w}×${hBasin.h} · ${hBasin.w * hBasin.h * hBasin.depthM} m³ — Click to edit · Drag handles when selected`;
              }
            } else if (hUnit) {
              hint = `▸ ${UNIT_DEFINITIONS[hUnit.typeId]?.name ?? hUnit.typeId} (legacy) — Click to inspect`;
            }
            setHoverHint(hint);
          }
        } else {
          // During an active drag, keep the hint pinned to the drag
          if (equipHandleDragRef.current) {
            const d = equipHandleDragRef.current;
            const eqt = gsRef.current.processEquipment?.find(e=>e.id===d.anchorId);
            const n = eqt ? (EQUIPMENT_TYPES[eqt.typeId]?.name ?? 'equipment') : 'equipment';
            const grp = (d as any).groupIds?.length > 1 ? ` · ${ (d as any).groupIds.length } machines as block` : '';
            setHoverHint(`↔ Dragging ${n}${grp} — release on target tile · green = valid · red = blocked (Esc cancels)`);
          } else if (basinHandleDragRef.current) {
            const d = basinHandleDragRef.current;
            const dirLabel = ({n:'North',s:'South',e:'East',w:'West',nw:'NW',ne:'NE',sw:'SW',se:'SE'} as any)[d.dir] ?? d.dir;
            setHoverHint(`↔ Dragging ${dirLabel} wall — release on target tile · green = valid · red = blocked (Esc cancels)`);
          } else {
            setHoverHint(null);
          }
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture already released
      }

      // P5: equipment drag-handle commit (direct in-world move with live ghost, free, undoable)
      // Slice 2: group handle — Shift block moves preserving offsets
      // Has priority alongside basin wall drag — both swallow pan and wasDrag >6.
      if (equipHandleDragRef.current) {
        const drag = equipHandleDragRef.current;
        equipHandleDragRef.current = null;
        pointerDown.current = false;
        const sm = sceneRef.current;
        const gs = gsRef.current;
        const tile = sm ? sm.getGridTileFromScreen(e.clientX, e.clientY) : null;
        if (!tile) {
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          setToast('Equipment drag cancelled — release over a tile.');
          return;
        }
        const groupIds: string[] = (drag as any).groupIds ?? [drag.anchorId];
        const anchor = gs.processEquipment?.find(en => en.id === drag.anchorId) ?? null;
        if (!anchor) { sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false); return; }
        if (tile.x === anchor.x && tile.y === anchor.y) {
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          return; // same-tile no-op (suppress wasDrag click)
        }
        // utility gate already checked in ghost, re-check quickly
        const attachedAny = groupIds.some(id => {
          const m = gs.processEquipment?.find(en => en.id === id);
          return m ? (gs.utilityConnections ?? []).some(c => (c.ax === m.x && c.ay === m.y) || (c.bx === m.x && c.by === m.y)) : false;
        });
        if (attachedAny) {
          SoundManager.playWarning();
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          setToast(`⛔ Move blocked — utility lines still attached (cut pipes/cables first).`);
          return;
        }
        pushHistory(gs);
        let res: { newState: typeof gs; success: boolean; reason?: string };
        if (groupIds.length > 1) {
          res = GameManager.moveEquipmentGroup(gs, groupIds, drag.anchorId, tile.x, tile.y);
        } else {
          res = GameManager.moveProcessEquipment(gs, drag.anchorId, tile.x, tile.y);
        }
        if (!res.success) {
          undoStackRef.current.pop();
          SoundManager.playWarning();
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          setToast(res.reason ?? 'Cannot move — blocked.');
          return;
        }
        setGameState(res.newState);
        // keep same equipment selected (group preserved) at new tiles, refresh handle position
        const anchorIdsSet = new Set(groupIds);
        sceneRef.current?.syncEquipment(
          res.newState.processEquipment ?? [], res.newState.customBasins ?? [], anchorIdsSet,
          poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
          aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
          filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? []),
          chemicalLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
        );
        sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
        sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
        sceneRef.current?.syncBasins(res.newState.customBasins ?? [], null);
        // refresh handle at new anchor position
        const moved = res.newState.processEquipment?.find(en => en.id === drag.anchorId) ?? null;
        sceneRef.current?.syncEquipmentDragHandle(moved ? { x: moved.x, y: moved.y, typeId: moved.typeId } : null, res.newState.customBasins ?? []);
        sceneRef.current?.syncSelectionBrackets(bracketRectsForSelection(constructionSelectionRef.current, res.newState.customBasins ?? [], res.newState.customBaffles ?? [], res.newState.utilityConnections ?? [], res.newState.processEquipment ?? []));
        sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
        SoundManager.playPlace();
        if (groupIds.length > 1) {
          let aggC=0, aggP=0; for (const id of groupIds){ const mm=res.newState.processEquipment?.find(e=>e.id===id); if(mm){ const d=EQUIPMENT_TYPES[mm.typeId]; if(d){ aggC+=d.capexUsd; aggP+=d.powerKw; } } }
          setToast(`${groupIds.length} machines dragged as block to (${tile.x},${tile.y}) · $${aggC.toLocaleString()} · ${aggP} kW — free reposition (Ctrl+Z to undo).`);
        } else {
          setToast(`${EQUIPMENT_TYPES[anchor.typeId]?.name ?? 'Equipment'} dragged to (${tile.x},${tile.y}) — free reposition (Ctrl+Z to undo).`);
        }
        return;
      }

      // P4 slice 2: wall drag commit has priority even over the wasDrag gate.
      // The PointerMove swallows the pan while the handle is held, so wasDrag
      // will be >6 even for a tiny handle nudge — we must commit before that early return.
      if (basinHandleDragRef.current) {
        const drag = basinHandleDragRef.current;
        basinHandleDragRef.current = null;
        pointerDown.current = false;
        const sm = sceneRef.current;
        const gs = gsRef.current;
        const tile = sm ? sm.getGridTileFromScreen(e.clientX, e.clientY) : null;
        if (!tile) {
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          setToast('Wall drag cancelled — release over a tile.');
          return;
        }
        const cand = basinRectForHandleDrag(drag.startRect as any, drag.dir, tile);
        // no-op if tile didn't move the wall
        if (cand.x === drag.startRect.x && cand.y === drag.startRect.y && cand.w === drag.startRect.w && cand.h === drag.startRect.h) {
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          return;
        }
        pushHistory(gs);
        const res = GameManager.updateBasinRect(gs, drag.basinId, cand);
        if (!res.success) {
          undoStackRef.current.pop();
          SoundManager.playWarning();
          sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
          setToast(res.reason ?? 'Cannot resize — wall blocked.');
          return;
        }
        setGameState(res.newState);
        // keep the same basin selected with its new footprint
        sceneRef.current?.syncBasins(res.newState.customBasins ?? [], new Set([drag.basinId]));
        sceneRef.current?.syncDimensionLabels(res.newState.customBasins ?? [], new Set([drag.basinId]));
        sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
        sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
        sceneRef.current?.syncEquipment(
          res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
          poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
          aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
          filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
        );
        sceneRef.current?.terrainGrid.setGhostPreview(0,0,1,1,true,false);
        SoundManager.playPlace();
        if (res.charged) setToast(`Wall dragged to ${cand.w}×${cand.h} — charged $${res.charged.toLocaleString()} extra concrete.`);
        else if (res.refunded) setToast(`Wall dragged to ${cand.w}×${cand.h} — refund +$${res.refunded.toLocaleString()} (50% salvage).`);
        else setToast(`Wall dragged to ${cand.w}×${cand.h}.`);
        return;
      }

      const wasDrag = pointerDist.current > 6;
      const button = e.button;
      pointerDown.current = false;

      if (wasDrag) return; // drags orbit/pan — never a click

      if (button === 2) {
        // RIGHT CLICK: cancel the pending pipe/utility/move selection (control scheme)
        if (movingEquipmentIdRef.current) {
          cancelEquipmentMove();
          return;
        }
        if (equipHandleDragRef.current) {
          cancelEquipHandleDrag();
          return;
        }
        if (toolModeRef.current === 'connect_pipe' && pipeSourceRef.current) {
          cancelPipeSelection();
        }
        if (toolModeRef.current === 'connect_utility' && utilitySourceRef.current) {
          cancelUtilitySelection();
        }
        if (basinHandleDragRef.current) {
          cancelBasinHandleDrag();
        }
        return;
      }
      if (button === 0) {
        // LEFT CLICK: primary action
        handleCanvasClick(e.clientX, e.clientY, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
      }
    };

    // CANCELLED pointer sequences (palm rejection, OS gestures, second touch,
    // alt-tab) must NEVER be converted into a game action. Reset transient
    // pointer state only — no placement, selection, piping or demolition.
    const onPointerCancel = (e: PointerEvent) => {
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be gone — irrelevant for cancellation.
      }
      pointerDown.current = false;
      pointerDist.current = 0;
      if (equipHandleDragRef.current) cancelEquipHandleDrag(true);
      if (basinHandleDragRef.current) cancelBasinHandleDrag(true);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sceneRef.current?.cameraController.zoom(e.deltaY * 0.025);
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown',  onPointerDown,  { passive: false });
    canvas.addEventListener('pointermove',  onPointerMove,  { passive: false });
    canvas.addEventListener('pointerup',    onPointerUp,    { passive: false });
    canvas.addEventListener('pointercancel', onPointerCancel, { passive: false });
    canvas.addEventListener('wheel',        onWheel,        { passive: false });
    canvas.addEventListener('contextmenu',  onContextMenu,  { passive: false });

    return () => {
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown',  onPointerDown);
      canvas.removeEventListener('pointermove',  onPointerMove);
      canvas.removeEventListener('pointerup',    onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('wheel',        onWheel);
      canvas.removeEventListener('contextmenu',  onContextMenu);
      sm.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // CLICK ACTION (using gsRef for 100% fresh state)
  // ─────────────────────────────────────────────────────────────────────────────
  /** Arms a unit + explicit source port as the active pipe origin */
  const armPipeSource = useCallback((unit: PlacedUnit, port: UnitPort) => {
    setPipeSourceId(unit.instanceId);
    pipeSourcePortRef.current = port.id;
    pipeSourcePosRef.current = getPortWorldPosition(unit, port.id);
    pendingTargetRef.current = null;
    setPortPicker(null);
    sceneRef.current?.setPipeSourceHighlight(unit.instanceId, gsRef.current.units, {
      chosenPortId: port.id,
      showPorts: true
    });
  }, []);

  /** Handles a choice inside the contextual port selector */
  const handlePortSelect = useCallback((port: UnitPort) => {
    const gs = gsRef.current;
    const sm = sceneRef.current;
    if (!sm || !portPicker) return;
    const unit = gs.units.find(u => u.instanceId === portPicker.unitId);
    if (!unit) { setPortPicker(null); return; }

    if (portPicker.mode === 'source') {
      armPipeSource(unit, port);
      SoundManager.playClick();
      setToast(`Piping FROM ${unitName(unit)} [${port.name}]. Click a destination unit — RMB/Esc cancels.`);
      return;
    }

    // Target mode: commit the connection from the armed source
    const srcId = pipeSourceRef.current;
    const fromUnit = srcId ? gs.units.find(u => u.instanceId === srcId) : undefined;
    if (!fromUnit) { cancelPipeSelection(); return; }
    const fromPort = findPort(fromUnit, pipeSourcePortRef.current);
    if (!fromPort) { cancelPipeSelection(); return; }

    const fpDef = findPort(fromUnit, fromPort.id)!;
    const tpDef = port;

    const v = validateConnection(gs.pipes, gs.units, fromUnit.instanceId, fpDef.id, unit.instanceId, tpDef.id);
    if (!v.ok) {
      SoundManager.playWarning();
      setToast(`⛔ ${v.reason}`);
      setPortPicker(null);
      pendingTargetRef.current = null;
      return;
    }

    const newPipeType = resolvePipeType(fpDef, tpDef);
    const newPipe: PipeConnection = {
      id: `pipe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromUnitId: fromUnit.instanceId, fromPortId: fpDef.id,
      toUnitId:   unit.instanceId,     toPortId:   tpDef.id,
      pathPoints: generatePipePath(
        getPortWorldPosition(fromUnit, fpDef.id),
        getPortWorldPosition(unit, tpDef.id)
      ),
      flowRate: 0,
      quality: emptyWater(),
      ...(newPipeType === 'gas' ? { gasFlowRate: 0 } : {}),
      materialId: defaultMaterialForPipeType(newPipeType),
      autoSized: true,
      pipeType: newPipeType
    };
    // §AK item 11: piping is billed on quantity (material × DN × length).
    const purchase = GameManager.purchasePipes(gs, [newPipe]);
    if (!purchase.success) {
      SoundManager.playWarning();
      setToast(`⛔ ${purchase.reason}`);
      setPortPicker(null);
      pendingTargetRef.current = null;
      cancelPipeSelection(false);
      return;
    }
    SoundManager.playConnect();
    pushHistory(gs);
    setGameState(purchase.newState);
    sm.syncPipes(purchase.newState.pipes);
    setToast(`Connected: ${unitName(fromUnit)} [${fpDef.name}] ➔ ${unitName(unit)} [${tpDef.name}].` +
      (purchase.charged ? ` Piping: $${purchase.charged.toLocaleString()} (Ctrl+Z to undo)` : '  (Ctrl+Z to undo)'));
    setPortPicker(null);
    pendingTargetRef.current = null;
    cancelPipeSelection(true);
  }, [portPicker, armPipeSource, cancelPipeSelection, pushHistory]);

  /** Player edit of one pipe's engineering (DN / material) from the PFD panel.
   *  Explicit DN choices set autoSized=false so the sim never overrides them.
   *  Upsizes are billed as a change order (delta vs capexPaid, §AK item 11). */
  const handleUpdatePipe = useCallback((pipeId: string, patch: Partial<PipeConnection>) => {
    const gs = gsRef.current;
    const result = GameManager.updatePipeEngineering(gs, pipeId, patch);
    if (!result.success) {
      SoundManager.playWarning();
      setToast(`⛔ ${result.reason}`);
      return;
    }
    pushHistory(gs);
    setGameState(result.newState);
    sceneRef.current?.syncPipes(result.newState.pipes);
    if (result.charged) setToast(`Pipe change order: +$${result.charged.toLocaleString()}.`);
  }, [pushHistory]);

  const handleCanvasClick = (clientX: number, clientY: number, opts?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
    try {
      handleCanvasClickInner(clientX, clientY, opts);
    } catch (err) {
      // Never let a click die silently — surface it so nothing feels "broken"
      console.error('Canvas click error:', err);
      setToast('Something went wrong handling that click — please try again.');
    }
  };

  const handleCanvasClickInner = (clientX: number, clientY: number, opts?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
    const sm = sceneRef.current;
    if (!sm) return;
    const isMulti = !!(opts?.shiftKey || opts?.ctrlKey || opts?.metaKey);

    const mode     = toolModeRef.current;
    const gs       = gsRef.current;
    const typeId   = selUnitTypeRef.current;
    const rotation = rotationRef.current;
    const srcId    = pipeSourceRef.current;

    const tile        = sm.getGridTileFromScreen(clientX, clientY);
    const clickedUnit = sm.getUnitAtScreen(clientX, clientY, gs.units);

    // CONSTRUCTION-BUILDER Phase 1: which player-drawn basin (if any) is under the cursor?
    const clickedBasin = tile ? (gs.customBasins ?? []).find(b =>
      tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h
    ) ?? null : null;

    // Phase 2: which installed machine (if any) stands on this tile?
    const clickedEquipment = tile ? GameManager.equipmentAtTile(gs, tile.x, tile.y) : null;

    // Phase 3: which utility line is near the cursor ground point (for inspect/demolish)?
    const groundPt = sm.getGroundPointFromScreen(clientX, clientY);
    const clickedUtility = groundPt ? GameManager.utilityAtPoint(gs, groundPt.x, groundPt.z) : null;
    // Phase 5: interior baffle wall near cursor (for inspect/demolish)
    const clickedBaffle = groundPt ? GameManager.baffleAtPoint(gs, groundPt.x, groundPt.z) : null;

    // Piping guidance: never leave a click in Pipes mode as a silent no-op
    if (mode === 'connect_pipe') {
      if (!clickedUnit && !srcId) {
        setToast('Pipes: click directly ON a unit to choose it as the pipe source (a cyan ring marks it).');
        return;
      }
      if (!clickedUnit && srcId) {
        cancelPipeSelection();
        return;
      }
    }

    // P2: armed equipment move — highest priority over select/demolish/place
    if (movingEquipmentIdRef.current) {
      const movingId = movingEquipmentIdRef.current;
      const movingItem = gs.processEquipment?.find(e => e.id === movingId);
      if (!movingItem) { cancelEquipmentMove(true); return; }
      if (!tile) { cancelEquipmentMove(); return; }
      // Same tile = cancel without history (no-op)
      if (tile.x === movingItem.x && tile.y === movingItem.y) {
        cancelEquipmentMove(true);
        setToast('Move cancelled — machine stays where it was.');
        return;
      }
      const res = GameManager.moveProcessEquipment(gs, movingId, tile.x, tile.y);
      if (!res.success) {
        SoundManager.playWarning();
        setToast(`⛔ Move blocked: ${res.reason}`);
        return;
      }
      pushHistory(gs);
      setGameState(res.newState);
      setMovingEquipmentId(null);
      sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
      sm.syncEquipment(
        res.newState.processEquipment ?? [], res.newState.customBasins ?? [], movingId,
        poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
        aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
        filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? []),
        chemicalLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
      );
      sm.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
      sm.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
      setSelectedEquipmentId(movingId);
      SoundManager.playPlace();
      setToast(`${EQUIPMENT_TYPES[movingItem.typeId]?.name ?? 'Equipment'} moved to (${tile.x},${tile.y}) — free reposition (Ctrl+Z to undo).`);
      return;
    }

    if (mode === 'select') {
      // P3 — construction-first pick priority: most specific (1-tile machine) wins over
      // area (basin) and legacy (unit). Order: equipment > baffle > utility > basin > unit.
      // P4 — Shift/Ctrl/Cmd toggles multi-select; bare click replaces; empty click clears.
      const pickedKind: keyof ConstructionSelection | null =
        clickedEquipment ? 'equipment' :
        clickedBaffle ? 'baffles' :
        clickedUtility ? 'utilities' :
        clickedBasin ? 'basins' : null;
      const pickedId: string | null =
        clickedEquipment ? clickedEquipment.id :
        clickedBaffle ? clickedBaffle.id :
        clickedUtility ? clickedUtility.id :
        clickedBasin ? clickedBasin.id : null;

      // Multi-select toggle path
      if (isMulti && pickedKind && pickedId) {
        const cur = constructionSelectionRef.current;
        const already = (cur[pickedKind] as string[]).includes(pickedId);
        const next = toggleSelection(cur, pickedKind, pickedId, already ? 'toggle' : 'add');
        // Legacy unit picks remain single; shift on legacy just selects legacy alone
        setConstructionSelection(next);
        // Mirror singles to first entry of each kind for inspector compat
        setSelectedEquipmentId(next.equipment[0] ?? null);
        setSelectedBaffleId(next.baffles[0] ?? null);
        setSelectedUtilityId(next.utilities[0] ?? null);
        setSelectedBasinId(next.basins[0] ?? null);
        setGameState(prev => ({ ...prev, selectedUnitId: null }));
        SoundManager.playClick();
        // Sync highlights for the whole selection
        sm.syncBasins(gs.customBasins ?? [], basinIdsSet(next));
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], baffleIdsSet(next));
        sm.syncUtilityConnections(gs.utilityConnections ?? [], utilityIdsSet(next));
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], equipmentIdsSet(next),
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncSelectionBrackets(bracketRectsForSelection(next, gs.customBasins ?? [], gs.customBaffles ?? [], gs.utilityConnections ?? [], gs.processEquipment ?? []));
        sm.syncDimensionLabels(gs.customBasins ?? [], basinIdsSet(next));
        const cnt = selectionCount(next);
        if (cnt > 1) setToast(`${cnt} selected — ${selectionSummaryLine(next)} — Bulk Demolish in top bar or press Delete.`);
        else if (clickedEquipment) setToast(`${EQUIPMENT_TYPES[clickedEquipment.typeId]?.name ?? 'Equipment'} — Shift+Click to add more.`);
        else if (clickedBaffle) setToast(`${clickedBaffle.orientation} baffle — Shift+Click to add more.`);
        else if (clickedUtility) setToast(`${UTILITY_TYPES[clickedUtility.type]?.name ?? 'Utility'} — Shift+Click to add more.`);
        else if (clickedBasin) setToast(`Basin ${clickedBasin.w}×${clickedBasin.h} — Shift+Click to add more.`);
        return;
      }
      if (isMulti && !pickedKind && !clickedUnit) {
        // Shift+click on empty ground does not clear — keeps current multi selection
        return;
      }

      if (clickedEquipment) {
        // Phase 2: installed machines are inspectable too — highest priority.
        const next: ConstructionSelection = { ...emptySelection(), equipment: [clickedEquipment.id] };
        setConstructionSelection(next);
        SoundManager.playClick();
        setSelectedBasinId(null);
        setSelectedUtilityId(null);
        setSelectedBaffleId(null);
        setSelectedEquipmentId(clickedEquipment.id);
        setGameState(prev => ({ ...prev, selectedUnitId: null }));
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], new Set([clickedEquipment.id]),
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncUtilityConnections(gs.utilityConnections ?? [], null);
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], null);
        sm.syncBasins(gs.customBasins ?? [], null);
        sm.syncSelectionBrackets(bracketRectsForSelection(next, gs.customBasins ?? [], gs.customBaffles ?? [], gs.utilityConnections ?? [], gs.processEquipment ?? []));
        sm.syncDimensionLabels(gs.customBasins ?? [], basinIdsSet(next));
        const eq = EQUIPMENT_TYPES[clickedEquipment.typeId];
        if (eq) {
          // Phase 4: include live status in the toast
          const isDiffuser = clickedEquipment.typeId === 'fine_bubble_diffuser';
          const live = isDiffuser
            ? aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []).has(clickedEquipment.id)
            : poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []).has(clickedEquipment.id);
          const status = isDiffuser ? (live ? 'aerated ✓' : 'not aerated — needs air pipe from powered blower') : (eq.powerKw === 0 ? 'passive' : (live ? 'powered ✓' : 'UNPOWERED — needs Power cable'));
          setToast(`${eq.name} — ${status} — $${eq.capexUsd.toLocaleString()} · ${eq.powerKw} kW · ${eq.blurb} Shift+Click to multi-select · Move/Rotate in panel.`);
        } else {
          setToast('Installed equipment. Shift+Click to add to selection.');
        }
      } else if (clickedBaffle) {
        // Phase 5: baffle walls are inspectable (above utility but below equipment)
        const next: ConstructionSelection = { ...emptySelection(), baffles: [clickedBaffle.id] };
        setConstructionSelection(next);
        SoundManager.playClick();
        setSelectedBasinId(null);
        setSelectedEquipmentId(null);
        setSelectedUtilityId(null);
        setSelectedBaffleId(clickedBaffle.id);
        setGameState(prev => ({ ...prev, selectedUnitId: null }));
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], new Set([clickedBaffle.id]));
        sm.syncBasins(gs.customBasins ?? [], null);
        sm.syncSelectionBrackets(bracketRectsForSelection(next, gs.customBasins ?? [], gs.customBaffles ?? [], gs.utilityConnections ?? [], gs.processEquipment ?? []));
        sm.syncDimensionLabels(gs.customBasins ?? [], basinIdsSet(next));
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], null,
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncUtilityConnections(gs.utilityConnections ?? [], null);
        const basinOf = gs.customBasins?.find(b => b.id === clickedBaffle.basinId);
        const len = basinOf ? (clickedBaffle.orientation === 'vertical' ? basinOf.h : basinOf.w) * 6 : 0;
        setToast(`${clickedBaffle.orientation === 'vertical' ? 'Vertical' : 'Horizontal'} baffle · ${len} m wall in ${basinOf ? `${basinOf.w}×${basinOf.h}` : 'basin'} · offset ${clickedBaffle.offsetTiles}. Shift+Click to add more.`);
      } else if (clickedUtility) {
        const next: ConstructionSelection = { ...emptySelection(), utilities: [clickedUtility.id] };
        setConstructionSelection(next);
        SoundManager.playClick();
        setSelectedBasinId(null);
        setSelectedEquipmentId(null);
        setSelectedBaffleId(null);
        setSelectedUtilityId(clickedUtility.id);
        setGameState(prev => ({ ...prev, selectedUnitId: null }));
        sm.syncBasins(gs.customBasins ?? [], null);
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], null);
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], null,
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncUtilityConnections(gs.utilityConnections ?? [], new Set([clickedUtility.id]));
        sm.syncSelectionBrackets(bracketRectsForSelection(next, gs.customBasins ?? [], gs.customBaffles ?? [], gs.utilityConnections ?? [], gs.processEquipment ?? []));
        sm.syncDimensionLabels(gs.customBasins ?? [], basinIdsSet(next));
        const util = UTILITY_TYPES[clickedUtility.type];
        setToast(`${util.name}: (${clickedUtility.ax},${clickedUtility.ay}) → (${clickedUtility.bx},${clickedUtility.by}) · ${util.blurb} Shift+Click to add more.`);
      } else if (clickedBasin) {
        const next: ConstructionSelection = { ...emptySelection(), basins: [clickedBasin.id] };
        setConstructionSelection(next);
        SoundManager.playClick();
        setSelectedEquipmentId(null);
        setSelectedUtilityId(null);
        setSelectedBaffleId(null);
        setSelectedBasinId(clickedBasin.id);
        setGameState(prev => ({ ...prev, selectedUnitId: null }));
        sm.syncBasins(gs.customBasins ?? [], new Set([clickedBasin.id]));
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], null);
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], null,
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncUtilityConnections(gs.utilityConnections ?? [], null);
        sm.syncSelectionBrackets(bracketRectsForSelection(next, gs.customBasins ?? [], gs.customBaffles ?? [], gs.utilityConnections ?? [], gs.processEquipment ?? []));
        sm.syncDimensionLabels(gs.customBasins ?? [], basinIdsSet(next));
        const area = clickedBasin.w * clickedBasin.h;
        const vol = area * clickedBasin.depthM;
        const zones = GameManager.zonesForBasin(gs, clickedBasin.id);
        // Phase 5 slice 2: show zone mixing health (each zone needs a powered mixer)
        let zoneHealth = '';
        if (zones.length > 1) {
          const poweredMixers = poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []);
          const septicZones = zones.filter(z => !gs.processEquipment?.some((e:any) => e.typeId==='submersible_mixer' && poweredMixers.has(e.id) && e.x >= z.x && e.x < z.x+z.w && e.y >= z.y && e.y < z.y+z.h)).length;
          const healthy = zones.length - septicZones;
          zoneHealth = septicZones>0 ? ` — ${healthy}/${zones.length} zones mixed, ${septicZones} septic` : ` — ${zones.length} zones, all mixed`;
        }
        setToast(`Custom Basin: ${clickedBasin.w}×${clickedBasin.h} (${area}m², ${vol.toLocaleString()}m³, depth ${clickedBasin.depthM}m) · ${zones.length} zone${zones.length>1?'s':''}${zoneHealth}. Shift+Click to add to selection.`);
      } else if (clickedUnit) {
        SoundManager.playClick();
        setConstructionSelection(emptySelection());
        setSelectedBasinId(null);
        setSelectedEquipmentId(null);
        setSelectedUtilityId(null);
        setSelectedBaffleId(null);
        setGameState(prev => ({ ...prev, selectedUnitId: clickedUnit.instanceId }));
        const def = UNIT_DEFINITIONS[clickedUnit.typeId];
        setToast(`Inspecting (legacy): ${def?.name ?? clickedUnit.typeId} — prefab, Inspect-only heritage`);
        // Clear construction highlights when inspecting legacy
        sm.syncBasins(gs.customBasins ?? [], null);
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], null);
        sm.syncUtilityConnections(gs.utilityConnections ?? [], null);
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], null,
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncSelectionBrackets(null);
        sm.syncDimensionLabels(gs.customBasins ?? [], null);
      } else {
        setConstructionSelection(emptySelection());
        setSelectedBasinId(null);
        setSelectedEquipmentId(null);
        setSelectedUtilityId(null);
        setSelectedBaffleId(null);
        sm.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], null);
        sm.syncBasins(gs.customBasins ?? [], null);
        sm.syncEquipment(
          gs.processEquipment ?? [], gs.customBasins ?? [], null,
          poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
          filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? [])
        );
        sm.syncUtilityConnections(gs.utilityConnections ?? [], null);
        setGameState(prev => ({ ...prev, selectedUnitId: null }));
      }

    } else if (mode === 'place_unit' && typeId && tile) {
      const tutStepNow = TUTORIAL_STEPS[gs.tutorialStep];
      // Tutorial enforcement: only the guided unit, only on the guided lot
      if (gs.tutorialActive) {
        if (!tutStepNow?.unitTypeId || tutStepNow.unitTypeId !== typeId) {
          SoundManager.playWarning();
          setToast(tutStepNow
            ? `Dr. Rio: "Not yet! ${tutStepNow.title} — follow my lead!"`
            : 'Dr. Rio: "Stay the course, rookie!"');
          return;
        }
        const sDef = UNIT_DEFINITIONS[typeId];
        const sug = gs.suggestion;
        if (sug && !(tile.x >= sug.gridX && tile.x < sug.gridX + sDef.footprint[0] &&
                     tile.y >= sug.gridY && tile.y < sug.gridY + sDef.footprint[1])) {
          SoundManager.playWarning();
          setToast('Dr. Rio: "Only on the glowing green lot, rookie!"');
          return;
        }
      }
      const result = GameManager.placeUnit(gs, typeId, tile.x, tile.y, rotation, {
        seededWithSludge: placeSeededRef.current,
      });
      if (result.success) {
        SoundManager.playPlace();
        pushHistory(gs);
        sm.syncUnits(result.newState.units);
        if (result.newState.suggestion) {
          sm.showNextStepGhost(result.newState.suggestion.unitTypeId, result.newState.suggestion.gridX, result.newState.suggestion.gridY);
        } else {
          sm.showNextStepGhost(null, 0, 0);
        }
        const def = UNIT_DEFINITIONS[typeId];
        const tutorialAdvance = gs.tutorialActive && tutStepNow?.unitTypeId === typeId;
        if (tutorialAdvance) {
          setGameState({ ...result.newState, tutorialStep: result.newState.tutorialStep + 1 });
          setToast(`${def.name} built — covered by the training grant ($0)!`);
        } else {
          setGameState(result.newState);
          const unseededNote = !placeSeededRef.current && typeId === 'activated_sludge_cas'
            ? ' UNSEEDED start — give the culture ~2 weeks to ramp.'
            : '';
          setToast(`Placed ${def.name}!${unseededNote} Now connect pipes or continue adding units.`);
        }
      } else {
        SoundManager.playWarning();
        setToast(result.reason ?? 'Cannot place here.');
      }

    } else if (mode === 'connect_pipe' && clickedUnit) {
      // ── EXPLICIT PORT SELECTION ─────────────────────────────────────────
      // No silent first-port fallback. Source unit → source port (auto only
      // when exactly one valid port) → target unit → target port.

      const openSourcePicker = (unit: PlacedUnit, screenX: number, screenY: number) => {
        const ports = getSourcePorts(unit);
        setPortPicker({
          mode: 'source',
          unitId: unit.instanceId,
          anchor: { x: screenX, y: screenY },
          choices: ports.map(port => ({
            port,
            connected:
              maxPipesPerSourcePort(unit.typeId) === 1 &&
              countSourcePipes(gs.pipes, unit.instanceId, port.id) > 0
          }))
        });
        SoundManager.playClick();
      };

      const commitConnection = (
        fromUnit: PlacedUnit,
        fromPortId: string,
        toUnit: PlacedUnit,
        toPortId: string
      ) => {
        const fp = findPort(fromUnit, fromPortId);
        const tp = findPort(toUnit, toPortId);
        if (!fp || !tp) return;

        // TOGGLE FIRST: reconnecting the exact same existing pipe removes it.
        // This check MUST precede validateConnection, which rejects duplicate
        // connections and would otherwise make removal unreachable.
        if (isConnectionExisting(gs.pipes, fromUnit.instanceId, fp.id, toUnit.instanceId, tp.id)) {
          const removedIds = new Set(
            gs.pipes
              .filter(p =>
                p.fromUnitId === fromUnit.instanceId && p.fromPortId === fp.id &&
                p.toUnitId === toUnit.instanceId && p.toPortId === tp.id)
              .map(p => p.id)
          );
          // §AK item 11: removing billed pipe pays out salvage (legacy = $0).
          const removal = GameManager.removePipes(gs, removedIds);
          pushHistory(gs);
          SoundManager.playDemolish();
          setGameState(removal.newState);
          sm.syncPipes(removal.newState.pipes);
          setToast(`Pipe removed: ${unitName(fromUnit)} [${fp.name}] ➔ ${unitName(toUnit)}.` +
            (removal.refunded > 0 ? ` Salvage: $${removal.refunded.toLocaleString()}.` : '') +
            ' Re-route as needed. (Ctrl+Z to undo)');
          cancelPipeSelection(true);
          return;
        }

        const v = validateConnection(gs.pipes, gs.units, fromUnit.instanceId, fp.id, toUnit.instanceId, tp.id);
        if (!v.ok) {
          SoundManager.playWarning();
          setToast(`⛔ ${v.reason}`);
          return;
        }

        const path = generatePipePath(
          getPortWorldPosition(fromUnit, fp.id),
          getPortWorldPosition(toUnit, tp.id)
        );
        const pipeType = resolvePipeType(fp, tp);
        const newPipe: PipeConnection = {
          id: `pipe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          fromUnitId: fromUnit.instanceId, fromPortId: fp.id,
          toUnitId:   toUnit.instanceId,   toPortId:   tp.id,
          pathPoints: path,
          flowRate: 0,
          quality: emptyWater(),
          ...(pipeType === 'gas' ? { gasFlowRate: 0 } : {}),
          materialId: defaultMaterialForPipeType(pipeType),
          autoSized: true,
          pipeType,
        };
        // §AK item 11: piping is billed on quantity (material × DN × length).
        const purchase = GameManager.purchasePipes(gs, [newPipe]);
        if (!purchase.success) {
          SoundManager.playWarning();
          setToast(`⛔ ${purchase.reason}`);
          cancelPipeSelection(false);
          return;
        }
        pushHistory(gs);
        SoundManager.playConnect();
        setGameState(purchase.newState);
        sm.syncPipes(purchase.newState.pipes);
        setToast(`Connected: ${unitName(fromUnit)} [${fp.name}] ➔ ${unitName(toUnit)} [${tp.name}].` +
          (purchase.charged ? ` Piping: $${purchase.charged.toLocaleString()} (Ctrl+Z to undo)` : '  (Ctrl+Z to undo)'));
        cancelPipeSelection(true);
      };

      if (!srcId && !portPicker) {
        // ── Stage 1: choose SOURCE unit ──
        const srcPorts = getSourcePorts(clickedUnit);
        if (srcPorts.length === 0) {
          SoundManager.playWarning();
          setToast(`${unitName(clickedUnit)} has no output port — it cannot feed other units.`);
          return;
        }
        if (srcPorts.length === 1) {
          // Single valid source port: select automatically (spec rule).
          armPipeSource(clickedUnit, srcPorts[0]);
          setToast(`Piping FROM ${unitName(clickedUnit)} [${srcPorts[0].name}]. Click a destination unit.`);
        } else {
          openSourcePicker(clickedUnit, clientX, clientY);
        }
        return;
      }

      if (srcId && !pendingTargetRef.current && clickedUnit.instanceId !== srcId) {
        // ── Stage 3: choose TARGET unit → resolve its compatible ports ──
        const fromUnit = gs.units.find(u => u.instanceId === srcId);
        if (!fromUnit) { cancelPipeSelection(); return; }
        const fromPort = findPort(fromUnit, pipeSourcePortRef.current);
        if (!fromPort) { cancelPipeSelection(); return; }

        const compatible = getTargetPorts(clickedUnit).filter(tp =>
          validateConnection(gs.pipes, gs.units, srcId, fromPort.id, clickedUnit.instanceId, tp.id).ok
        );
        // Self-recycle special case: same unit may loop back via its own ports
        const selfRecycle =
          clickedUnit.instanceId === srcId &&
          getSourcePorts(clickedUnit).some(fp =>
            getTargetPorts(clickedUnit).some(tp =>
              validateConnection(gs.pipes, gs.units, srcId, fp.id, srcId, tp.id).ok
            )
          );

        if (compatible.length === 0 && !selfRecycle) {
          SoundManager.playWarning();
          const anyInlet = getTargetPorts(clickedUnit).length > 0;
          setToast(anyInlet
            ? `No compatible inlet on ${unitName(clickedUnit)} for ${unitName(fromUnit)} [${fromPort.name}] — its inlets are already fed or the stream class doesn't match.`
            : `${unitName(clickedUnit)} has no inlet port — nothing can be piped into it.`);
          return;
        }
        if (compatible.length === 1) {
          // Single compatible target port: connect immediately.
          commitConnection(fromUnit, fromPort.id, clickedUnit, compatible[0].id);
        } else {
          pendingTargetRef.current = clickedUnit.instanceId;
          setPortPicker({
            mode: 'target',
            unitId: clickedUnit.instanceId,
            anchor: { x: clientX, y: clientY },
            choices: compatible.map(port => ({
              port,
              connected: false,
            }))
          });
        }
        return;
      }
    } else if (mode === 'draw_basin' && tile) {
      // ── Two-click basin drawing (drag-free to avoid camera-pan conflict) ──
      // Click 1 = first corner (anchor). Click 2 = opposite corner → construct.
      if (!drawStartTileRef.current) {
        drawStartTileRef.current = { x: tile.x, y: tile.y };
        SoundManager.playClick();
        setToast('Basin: first corner set — click the opposite corner to finish. (Esc cancels.)');
        return;
      }
      const a = drawStartTileRef.current;
      const rect = {
        x: Math.min(a.x, tile.x),
        y: Math.min(a.y, tile.y),
        w: Math.abs(tile.x - a.x) + 1,
        h: Math.abs(tile.y - a.y) + 1,
      };
      const result = GameManager.placeCustomBasin(gs, rect);
      drawStartTileRef.current = null;
      setDrawPreview(null);
      sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
      if (result.success) {
        SoundManager.playPlace();
        pushHistory(gs);
        sm.syncBasins(result.newState.customBasins, selectedBasinId);
        sm.syncDimensionLabels(result.newState.customBasins, selectedBasinId);
        const b = result.newState.customBasins[result.newState.customBasins.length - 1];
        const area = b.w * b.h;
        const vol = area * b.depthM;
        const cost = result.charged ?? 0;
        setToast(
          `Basin drawn: ${b.w} m × ${b.h} m (${area} m², ${vol.toLocaleString()} m³, depth ${b.depthM} m)` +
          (cost > 0 ? ` — $${cost.toLocaleString()}` : ' — $0 (sandbox)')
        );
        setGameState(result.newState);
      } else {
        SoundManager.playWarning();
        setToast(result.reason ?? 'Cannot build basin here.');
      }

    } else if (mode === 'place_equipment' && tile && selEquipTypeRef.current) {
      // ── CONSTRUCTION-BUILDER Phase 2: install one machine ──
      const result = GameManager.placeProcessEquipment(gs, selEquipTypeRef.current, tile.x, tile.y);
      if (result.success) {
        SoundManager.playPlace();
        pushHistory(gs);
        setGameState(result.newState);
        sm.syncEquipment(
          result.newState.processEquipment ?? [], result.newState.customBasins ?? [], selectedEquipmentIdRef.current,
          poweredEquipmentIds(result.newState.processEquipment ?? [], result.newState.utilityConnections ?? []),
          aeratedDiffuserIds(result.newState.processEquipment ?? [], result.newState.utilityConnections ?? []),
          filtrationLiveSets(result.newState.customBasins ?? [], result.newState.processEquipment ?? [], result.newState.utilityConnections ?? [], result.newState.customBaffles ?? [])
        );
        const eq = EQUIPMENT_TYPES[selEquipTypeRef.current];
        const cost = result.charged ?? 0;
        setToast(
          `${eq.name} installed${eq.mounting === 'in_basin' ? ' in basin' : ' on open ground'}` +
          (cost > 0 ? ` — $${cost.toLocaleString()}` : ' — $0 (sandbox)')
        );
      } else {
        SoundManager.playWarning();
        setToast(result.reason ?? 'Cannot install equipment here.');
      }

    } else if (mode === 'connect_utility' && tile) {
      // ── CONSTRUCTION-BUILDER Phase 3: utility line (two-click) ───────
      const utype = (selUtilityTypeRef.current ?? 'water_pipe') as UtilityConnectionType;
      const src = utilitySourceRef.current;
      if (!src) {
        // First click: anchor source (must be on equipment or basin)
        const onHost = tile ? (gs.processEquipment?.some(eq => eq.x === tile.x && eq.y === tile.y) ||
          gs.customBasins?.some(b => tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h)) : false;
        if (!onHost) {
          SoundManager.playWarning();
          setToast('Utility: click ON installed equipment or inside a basin to start the line. Endpoints must be on host tiles.');
          return;
        }
        utilitySourceRef.current = { x: tile.x, y: tile.y };
        SoundManager.playClick();
        const util = UTILITY_TYPES[utype];
        setToast(`${util.name}: source (${tile.x},${tile.y}) anchored — click the destination host tile. (Esc cancels)`);
        return;
      }
      // Second click: complete the line
      if (src.x === tile.x && src.y === tile.y) {
        utilitySourceRef.current = null;
        sm.setUtilityPreview(null, null);
        sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
        SoundManager.playClick();
        setToast('Utility: cancelled (same tile).');
        return;
      }
      const result = GameManager.placeUtilityConnection(gs, utype, src.x, src.y, tile.x, tile.y);
      utilitySourceRef.current = null;
      sm.setUtilityPreview(null, null);
      sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
      if (result.success) {
        SoundManager.playPlace();
        pushHistory(gs);
        setGameState(result.newState);
        sm.syncUtilityConnections(result.newState.utilityConnections ?? [], result.newState.selectedUtilityId ?? null);
        // Phase 4: wiring a utility may light up equipment
        sm.syncEquipment(
          result.newState.processEquipment ?? [], result.newState.customBasins ?? [], selectedEquipmentIdRef.current,
          poweredEquipmentIds(result.newState.processEquipment ?? [], result.newState.utilityConnections ?? []),
          aeratedDiffuserIds(result.newState.processEquipment ?? [], result.newState.utilityConnections ?? []),
          filtrationLiveSets(result.newState.customBasins ?? [], result.newState.processEquipment ?? [], result.newState.utilityConnections ?? [], result.newState.customBaffles ?? [])
        );
        const util = UTILITY_TYPES[utype];
        const cost = result.charged ?? 0;
        setToast(`${util.name} connected (${src.x},${src.y}) → (${tile.x},${tile.y})${cost > 0 ? ` — $${cost.toLocaleString()}` : ' — $0 (sandbox)'}`);
      } else {
        SoundManager.playWarning();
        setToast(result.reason ?? 'Cannot connect utility here.');
      }

    } else if (mode === 'draw_baffle' && tile) {
      // ── CONSTRUCTION-BUILDER Phase 5: interior baffle wall (one-click inside a basin)
      const basin = gs.customBasins?.find(b => tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h) ?? null;
      if (!basin) {
        SoundManager.playWarning();
        setToast('Baffle: click INSIDE a drawn basin to place an interior wall. Draw a basin first.');
      } else {
        const orient = (selBaffleOrientRef.current ?? 'vertical') as 'vertical' | 'horizontal';
        const offset = orient === 'vertical' ? (tile.x - basin.x + 1) : (tile.y - basin.y + 1);
        const result = GameManager.placeBaffle(gs, basin.id, orient, offset);
        if (result.success) {
          SoundManager.playPlace();
          pushHistory(gs);
          setGameState(result.newState);
          sm.syncBaffles(result.newState.customBaffles ?? [], result.newState.customBasins ?? [], result.newState.selectedBaffleId ?? null);
          const cost = result.charged ?? 0;
          const zones = GameManager.zonesForBasin(result.newState, basin.id);
          setToast(`${orient === 'vertical' ? 'Vertical' : 'Horizontal'} baffle placed at offset ${offset} · basin now ${zones.length} zones${cost > 0 ? ` — $${cost.toLocaleString()}` : ' — $0 (sandbox)'}`);
          sm.setBafflePreview(null, null, null);
        } else {
          SoundManager.playWarning();
          setToast(result.reason ?? 'Cannot place baffle here.');
        }
      }

    } else if (mode === 'demolish' && (clickedUnit || clickedBasin || clickedEquipment || clickedUtility || clickedBaffle)) {
      if (clickedBaffle) {
        // Phase 5: remove interior baffle (60% salvage, zones re-derive)
        SoundManager.playDemolish();
        const res = GameManager.demolishBaffle(gs, clickedBaffle.id);
        if (res.success) {
          pushHistory(gs);
          setSelectedBaffleId(null);
          setGameState(res.newState);
          sm.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
          setToast(res.refunded && res.refunded > 0
            ? `Baffle removed — salvage refund $${res.refunded.toLocaleString()}.`
            : 'Baffle removed.');
        } else {
          SoundManager.playWarning();
          setToast('Cannot remove baffle.');
        }
      } else if (clickedUnit) {
        if (clickedUnit.typeId === 'influent_inlet' || clickedUnit.typeId === 'effluent_outfall') {
          SoundManager.playWarning();
          setToast('Inlet and Outfall cannot be removed.');
        } else {
          SoundManager.playDemolish();
          const next = GameManager.demolishUnit(gs, clickedUnit.instanceId);
          pushHistory(gs);
          setGameState(next);
          sm.syncUnits(next.units);
          sm.syncPipes(next.pipes);
          if (next.suggestion) {
            sm.showNextStepGhost(next.suggestion.unitTypeId, next.suggestion.gridX, next.suggestion.gridY);
          }
          setToast(gs.tutorialActive
            ? 'Unit demolished. (No refund during tutorial — training grant units.)'
            : 'Unit demolished — 70% refund applied.');
        }
      } else if (clickedUtility) {
        // Phase 3: cut a utility line (60% salvage).
        SoundManager.playDemolish();
        const res = GameManager.demolishUtilityConnection(gs, clickedUtility.id);
        if (res.success) {
          pushHistory(gs);
          setSelectedUtilityId(null);
          setGameState(res.newState);
          sm.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
          sm.syncEquipment(
            res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
            poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
            aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
            filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
          );
          setToast(res.refunded && res.refunded > 0
            ? `${UTILITY_TYPES[clickedUtility.type]?.name ?? 'Utility'} removed — salvage refund $${res.refunded.toLocaleString()}.`
            : `${UTILITY_TYPES[clickedUtility.type]?.name ?? 'Utility'} removed.`);
        } else {
          SoundManager.playWarning();
          setToast('Cannot remove utility.');
        }
      } else if (clickedBasin) {
        // CONSTRUCTION-BUILDER Phase 1: demolish a player-drawn basin (50% salvage).
        SoundManager.playDemolish();
        const res = GameManager.demolishCustomBasin(gs, clickedBasin.id);
        if (res.success) {
          pushHistory(gs);
          setSelectedBasinId(null);
          setGameState(res.newState);
          sm.syncBasins(res.newState.customBasins, selectedBasinId);
          sm.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
          sm.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
          sm.syncEquipment(
            res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
            poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
            aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
            filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
          );
          setToast(res.refunded && res.refunded > 0
            ? `Basin demolished — salvage refund $${res.refunded.toLocaleString()}.`
            : 'Basin demolished.');
        } else {
          SoundManager.playWarning();
          setToast(res.reason ?? 'Cannot demolish basin.');
        }
      } else if (clickedEquipment) {
        // Phase 2: un-bolt and remove an installed machine (70% kit salvage).
        SoundManager.playDemolish();
        const res = GameManager.demolishProcessEquipment(gs, clickedEquipment.id);
        if (res.success) {
          pushHistory(gs);
          setSelectedEquipmentId(null);
          setGameState(res.newState);
          sm.syncEquipment(
            res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
            poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
            aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
            filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
          );
          sm.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
          setToast(res.refunded && res.refunded > 0
            ? `${EQUIPMENT_TYPES[clickedEquipment.typeId]?.name ?? 'Equipment'} removed — salvage refund $${res.refunded.toLocaleString()}.`
            : `${EQUIPMENT_TYPES[clickedEquipment.typeId]?.name ?? 'Equipment'} removed.`);
        } else {
          SoundManager.playWarning();
          setToast('Cannot remove equipment.');
        }
      }
    }
  };

  /** Auto-connects the inferred MAIN liquid treatment train (never sludge/gas/recycle) */
  const handleAutoTrain = useCallback(() => {
    const gs = gsRef.current;
    const sm = sceneRef.current;
    if (!sm) return;
    cancelPipeSelection(true);
    const created = inferMainTrainPipes(gs.units);
    if (created.length === 0) {
      setToast('Auto-train: no unconnected main-line units found (sludge/gas/recycle lines are always manual).');
      return;
    }
    // §AK item 11: the whole bundle is one atomic purchase — all links or none.
    const purchase = GameManager.purchasePipes(gs, created);
    if (!purchase.success) {
      SoundManager.playWarning();
      setToast(`⛔ Auto-train aborted — ${purchase.reason}`);
      return;
    }
    pushHistory(gs);
    setGameState(purchase.newState);
    sm.syncPipes(purchase.newState.pipes);
    SoundManager.playConnect();
    setToast(`Auto-connected ${created.length} main liquid treatment link${created.length > 1 ? 's' : ''}` +
      (purchase.charged ? ` for $${purchase.charged.toLocaleString()}` : '') +
      '. Sludge, RAS & gas lines stay manual — pipe them by port.');
  }, [cancelPipeSelection, pushHistory]);

  // ─────────────────────────────────────────────────────────────────────────────
  // SIMULATION TICK (Interval 500ms)
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const TICK_MS = 500;
    simIntervalRef.current = setInterval(() => {
      setGameState(prev => {
        const next = GameManager.tick(prev, TICK_MS / 1000);
        if (sceneRef.current) {
          sceneRef.current.syncUnits(next.units);
          sceneRef.current.syncPipes(next.pipes);
          // Push the AUTHORITATIVE simulated clock into the renderer — the
          // day/night lighting derives from it (item 15). No boolean lerp.
          sceneRef.current.setGameClock(next.gameTimeDays);
        }
        return next;
      });
    }, TICK_MS);
    return () => {
      if (simIntervalRef.current) clearInterval(simIntervalRef.current);
    };
  }, []);

  // ── DEV-ONLY FPS TELEMETRY (Prompt 3.3 item 19) ───────────────────────────
  // Opt-in via ?fps=1 or localStorage['aquateycoon.devFps']='1'. Logs one line
  // per second to the console (day vs night frame-time comparison). No HUD
  // clutter, no production cost.
  useEffect(() => {
    const urlFlag = typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('fps') === '1';
    const lsFlag = (() => {
      try { return window.localStorage.getItem('aquateycoon.devFps') === '1'; }
      catch { return false; }
    })();
    sceneRef.current?.setTelemetryEnabled(urlFlag || lsFlag);
    // Re-apply after HMR/scene rebuilds
    return () => { sceneRef.current?.setTelemetryEnabled(false); };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // TUTORIAL — build-zone lock + pipe-chain progression
  // ─────────────────────────────────────────────────────────────────────────────
  const suggKey = gameState.suggestion
    ? `${gameState.suggestion.unitTypeId}:${gameState.suggestion.gridX}:${gameState.suggestion.gridY}`
    : '';

  // Dim every lot outside the tutorial's allowed rectangle during build steps
  useEffect(() => {
    const sm = sceneRef.current;
    if (!sm) return;
    const gs = gsRef.current;
    const step = TUTORIAL_STEPS[gs.tutorialStep];
    if (gs.tutorialActive && step?.unitTypeId) {
      const def = UNIT_DEFINITIONS[step.unitTypeId];
      sm.terrainGrid.setBuildRestriction({
        x: gs.suggestion?.gridX ?? 0,
        y: gs.suggestion?.gridY ?? 0,
        w: def.footprint[0],
        h: def.footprint[1],
      });
    } else {
      sm.terrainGrid.setBuildRestriction(null);
    }
  }, [tutorialActive, gameState.tutorialStep, suggKey]);

  // Advance the piping step once the guided chain is fully connected
  useEffect(() => {
    const gs = gsRef.current;
    if (!gs.tutorialActive) return;
    const step = TUTORIAL_STEPS[gs.tutorialStep];
    if (!step?.requiresPipes) return;
    const typeById = new Map(gs.units.map(u => [u.instanceId, u.typeId] as const));
    const linked = (fromType: string, toType: string) =>
      gs.pipes.some(p => typeById.get(p.fromUnitId) === fromType && typeById.get(p.toUnitId) === toType);
    if (TUTORIAL_PIPE_CHAIN.every(([a, b]) => linked(a, b))) {
      setGameState(prev => ({ ...prev, tutorialStep: prev.tutorialStep + 1 }));
      setToolMode('select');
      setToast('Pipes connected — Dr. Rio is proud!');
    }
  }, [gameState.pipes, gameState.tutorialStep, tutorialActive]);

  // ─────────────────────────────────────────────────────────────────────────────
  // KEYBOARD SHORTCUTS
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      const cam = sceneRef.current?.cameraController;

      // ── Undo / Redo (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) ──
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); return; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); handleRedo(); return; }
        if (k === 'a' && toolModeRef.current === 'select') {
          e.preventDefault();
          const gs = gsRef.current;
          const all: ConstructionSelection = {
            basins: (gs.customBasins ?? []).map(b => b.id),
            equipment: (gs.processEquipment ?? []).map(e => e.id),
            baffles: (gs.customBaffles ?? []).map(b => b.id),
            utilities: (gs.utilityConnections ?? []).map(c => c.id),
          };
          if (selectionCount(all) === 0) { setToast('Nothing to select — build a basin first.'); return; }
          setConstructionSelection(all);
          setSelectedBasinId(all.basins[0] ?? null);
          setSelectedEquipmentId(all.equipment[0] ?? null);
          setSelectedBaffleId(all.baffles[0] ?? null);
          setSelectedUtilityId(all.utilities[0] ?? null);
          setGameState(prev => ({ ...prev, selectedUnitId: null }));
          sceneRef.current?.syncBasins(gs.customBasins ?? [], basinIdsSet(all));
          sceneRef.current?.syncBaffles(gs.customBaffles ?? [], gs.customBasins ?? [], baffleIdsSet(all));
          sceneRef.current?.syncUtilityConnections(gs.utilityConnections ?? [], utilityIdsSet(all));
          sceneRef.current?.syncSelectionBrackets(bracketRectsForSelection(all, gs.customBasins ?? [], gs.customBaffles ?? [], gs.utilityConnections ?? [], gs.processEquipment ?? []));
          sceneRef.current?.syncDimensionLabels(gs.customBasins ?? [], basinIdsSet(all));
          sceneRef.current?.syncEquipment(gs.processEquipment ?? [], gs.customBasins ?? [], equipmentIdsSet(all),
            poweredEquipmentIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
            aeratedDiffuserIds(gs.processEquipment ?? [], gs.utilityConnections ?? []),
            filtrationLiveSets(gs.customBasins ?? [], gs.processEquipment ?? [], gs.utilityConnections ?? [], gs.customBaffles ?? []));
          SoundManager.playClick();
          setToast(`${selectionCount(all)} selected — ${selectionSummaryLine(all)} — press Delete to bulk demolish.`);
          return;
        }
      }

      switch (e.key) {
        case 'p': case 'P':
          // Toggle Pipes mode atomically (also clears any placement unit).
          setToolMode(toolModeRef.current === 'connect_pipe' ? 'select' : 'connect_pipe');
          cancelPipeSelection(true);
          SoundManager.playClick();
          setToast(toolModeRef.current === 'connect_pipe' ? 'Inspect mode.' : 'Pipes mode: LMB connect • click same unit to switch port • RMB cancel • Ctrl+Z undo.');
          break;
        case 'r': case 'R':
          setCurrentRotation(r => ((r + 90) % 360) as 0|90|180|270);
          SoundManager.playClick();
          setToast('Rotated placement direction.');
          break;
        case 'Escape':
          if (equipHandleDragRef.current) {
            cancelEquipHandleDrag();
            break;
          }
          if (basinHandleDragRef.current) {
            cancelBasinHandleDrag();
            break;
          }
          if (selectionCount(constructionSelectionRef.current) > 1) {
            clearConstructionSelection();
            setToast('Selection cleared.');
            break;
          }
          if (movingEquipmentIdRef.current) {
            cancelEquipmentMove();
          } else if (toolModeRef.current === 'connect_pipe' && pipeSourceRef.current) {
            cancelPipeSelection();
          } else if (toolModeRef.current === 'connect_utility' && utilitySourceRef.current) {
            cancelUtilitySelection();
          } else if (toolModeRef.current === 'draw_baffle') {
            cancelBafflePreview();
            sceneRef.current?.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
            setToolState(prev => reduceToolSelection(prev, { type: 'cancel_placement' }));
            setToast('Baffle placement cancelled — click BAFFLE again to arm.');
          } else if (toolModeRef.current === 'draw_basin' && drawStartTileRef.current) {
            // Cancel an in-progress basin draw (anchor reset, no construction).
            drawStartTileRef.current = null;
            setDrawPreview(null);
            sceneRef.current?.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
            setToast('Basin drawing cancelled. Click BASIN again to start fresh.');
          } else {
            setToolState(prev => reduceToolSelection(prev, { type: 'cancel_placement' }));
            cancelPipeSelection(true);
            cancelUtilitySelection(true);
            cancelBafflePreview();
            sceneRef.current?.setPipeSourceHighlight(null, gsRef.current.units);
            setGameState(prev => ({ ...prev, selectedUnitId: null }));
            setSelectedEquipmentId(null);
            setSelectedBasinId(null);
            setSelectedUtilityId(null);
            setSelectedBaffleId(null);
            setConstructionSelection(emptySelection());
            // clear construction selection hl with Phase 4 powered status
            sceneRef.current?.syncBasins(gsRef.current.customBasins ?? [], null);
            sceneRef.current?.syncBaffles(gsRef.current.customBaffles ?? [], gsRef.current.customBasins ?? [], null);
            sceneRef.current?.syncUtilityConnections(gsRef.current.utilityConnections ?? [], null);
            sceneRef.current?.syncEquipment(
              gsRef.current.processEquipment ?? [], gsRef.current.customBasins ?? [], null,
              poweredEquipmentIds(gsRef.current.processEquipment ?? [], gsRef.current.utilityConnections ?? []),
              aeratedDiffuserIds(gsRef.current.processEquipment ?? [], gsRef.current.utilityConnections ?? []),
              filtrationLiveSets(gsRef.current.customBasins ?? [], gsRef.current.processEquipment ?? [], gsRef.current.utilityConnections ?? [], gsRef.current.customBaffles ?? [])
            );
            sceneRef.current?.syncEquipmentDragHandle(null);
            setToast('Select mode — click a unit to inspect.');
          }
          break;
        case 'Delete':
        case 'Backspace': {
          const sel = constructionSelectionRef.current;
          if (selectionCount(sel) > 0 && toolModeRef.current === 'select') {
            e.preventDefault();
            const gs = gsRef.current;
            pushHistory(gs);
            const res = GameManager.bulkDemolish(gs, sel);
            if (!res.success) {
              SoundManager.playWarning();
              undoStackRef.current.pop();
              setToast(res.reason ?? 'Cannot bulk demolish.');
              break;
            }
            setConstructionSelection(emptySelection());
            setSelectedBasinId(null);
            setSelectedEquipmentId(null);
            setSelectedBaffleId(null);
            setSelectedUtilityId(null);
            setGameState(prev => ({ ...prev, selectedUnitId: null }));
            setGameState(res.newState);
            sceneRef.current?.syncBasins(res.newState.customBasins ?? [], null);
            sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
            sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
            sceneRef.current?.syncSelectionBrackets(null);
            sceneRef.current?.syncDimensionLabels(res.newState.customBasins ?? [], null);
            sceneRef.current?.syncEquipmentDragHandle(null);
            sceneRef.current?.syncEquipment(
              res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
              poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
              aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
              filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
            );
            SoundManager.playDemolish();
            const r = res.removed!;
            const refund = res.refunded ?? 0;
            setToast(`Bulk demolished: ${r.basins} basins · ${r.equipment} machines · ${r.baffles} baffles · ${r.utilities} utilities` + (refund ? ` — salvage $${refund.toLocaleString()}` : '') + ' (Ctrl+Z to undo)');
          }
          break;
        }
        case 'w': case 'ArrowUp':    cam?.pan(0, -90);  break;
        case 's': case 'ArrowDown':  cam?.pan(0,  90);  break;
        case 'a': case 'ArrowLeft':  cam?.pan(-90, 0);  break;
        case 'd': case 'ArrowRight': cam?.pan( 90, 0);  break;
        case '+': case '=':          cam?.zoomIn();      break;
        case '-': case '_':          cam?.zoomOut();     break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // OPERATOR CONSOLE — APPLY FIX (the systematic tuning loop)
  // ─────────────────────────────────────────────────────────────────────────────
  const handleApplyFix = useCallback((fix: FixAction) => {
    const gs = gsRef.current;

    if (fix.kind === 'start_piping') {
      setToolMode('connect_pipe');
      setOperatorOpen(false);
      SoundManager.playClick();
      setToast('Pipes mode: click a unit to choose its output port, then click the target unit. Click the same unit to switch ports.');
      return;
    }

    if (fix.kind === 'auto_train') {
      setOperatorOpen(false);
      handleAutoTrain();
      return;
    }

    if (fix.kind === 'clean_mbr' && fix.instanceId) {
      const res = GameManager.cleanMbrMembranes(gs, fix.instanceId);
      if (!res.success) {
        if (res.reason) setToast(`🔒 ${res.reason}`);
        return;
      }
      setGameState(res.newState);
      SoundManager.playClick();
      setToast(res.cipCostCharged
        ? `CIP clean complete — $${Math.round(res.cipCostCharged).toLocaleString()} chemicals & labor. Resistance reset.`
        : 'CIP clean complete — membrane resistance reset.');
      return;
    }

    if (fix.kind === 'replace_mbr' && fix.instanceId) {
      const res = GameManager.replaceMbrMembranes(gs, fix.instanceId);
      if (!res.success) {
        if (res.reason) setToast(`🔒 ${res.reason}`);
        return;
      }
      setGameState(res.newState);
      SoundManager.playPlace();
      setToast(res.replacementCapexCharged
        ? `Membrane cassettes replaced — $${Math.round(res.replacementCapexCharged).toLocaleString()} CAPEX. Brand-new membranes installed.`
        : 'Membrane cassettes replaced — brand-new membranes installed.');
      return;
    }

    if (fix.kind === 'adjust_param' && fix.instanceId && fix.paramKey) {
      const unit = gs.units.find(u => u.instanceId === fix.instanceId);
      if (!unit) return;
      const def = UNIT_DEFINITIONS[unit.typeId];
      const pd = def.paramDefinitions.find(p => p.key === fix.paramKey);
      if (!pd) return;
      const cur = unit.customParams[fix.paramKey] ?? pd.defaultValue;
      const next = Math.min(pd.max, Math.max(pd.min, cur + (fix.delta ?? 0)));
      setGameState(prev => ({
        ...prev,
        units: prev.units.map(u =>
          u.instanceId === unit.instanceId ? { ...u, customParams: { ...u.customParams, [fix.paramKey as string]: next } } : u
        ),
        selectedUnitId: null,
      }));
      SoundManager.playPlace();
      setToast(`Adjusted ${pd.label} → ${next} ${pd.unit}. Watch the water quality chip update!`);
      return;
    }

    if (fix.kind === 'build_unit' && fix.unitTypeId) {
      const typeId = fix.unitTypeId;
      const def = UNIT_DEFINITIONS[typeId];
      const spot = findFreeSpot(gs.units, gs.currentLevel.mapSize, def.footprint);
      if (spot && (gs.gameMode === 'sandbox' || gs.financials.cash >= def.capex)) {
        const result = GameManager.placeUnit(gs, typeId, spot.x, spot.y, 0);
        if (result.success) {
          setGameState(result.newState);
          sceneRef.current?.syncUnits(result.newState.units);
          sceneRef.current?.cameraController.focusOn(spot.x + def.footprint[0] / 2, spot.y + def.footprint[1] / 2);
          SoundManager.playPlace();
          setToast(`${def.name} built for $${def.capex.toLocaleString()}! Now pipe it in with the Pipes tool — order matters.`);
          return;
        }
      }
      // Fallback: hand placement mode (atomic select+place transition)
      setOperatorOpen(false);
      applyUnitTypeSelection(typeId);
      setToast(`${def.name} selected ($${def.capex.toLocaleString()}) — click a free spot on the grid.`);
    }
  }, [applyUnitTypeSelection]);

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL CHANGE
  // ─────────────────────────────────────────────────────────────────────────────
  const handleBulkDemolish = useCallback(() => {
    const gs = gsRef.current;
    const sel = constructionSelectionRef.current;
    if (selectionCount(sel) === 0) { setToast('Nothing selected — Shift+Click basins, machines, baffles or utilities.'); return; }
    pushHistory(gs);
    const res = GameManager.bulkDemolish(gs, sel);
    if (!res.success) {
      SoundManager.playWarning();
      undoStackRef.current.pop();
      setToast(res.reason ?? 'Cannot bulk demolish.');
      return;
    }
    setConstructionSelection(emptySelection());
    setSelectedBasinId(null);
    setSelectedEquipmentId(null);
    setSelectedBaffleId(null);
    setSelectedUtilityId(null);
    setGameState(prev => ({ ...prev, selectedUnitId: null }));
    setGameState(res.newState);
    sceneRef.current?.syncBasins(res.newState.customBasins ?? [], null);
    sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
    sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
    sceneRef.current?.syncEquipment(
      res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
      poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
      aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
      filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
    );
    sceneRef.current?.syncEquipmentDragHandle(null);
    SoundManager.playDemolish();
    const r = res.removed!;
    const refund = res.refunded ?? 0;
    setToast(`Bulk demolished: ${r.basins} basins · ${r.equipment} machines · ${r.baffles} baffles · ${r.utilities} utilities` + (refund ? ` — salvage $${refund.toLocaleString()}` : '') + ' (Ctrl+Z to undo)');
  }, [pushHistory]);

  const handleSelectLevel = useCallback((levelIndex: number, isSandbox: boolean) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setMovingEquipmentId(null);
    basinHandleDragRef.current = null;
    equipHandleDragRef.current = null;
    setConstructionSelection(emptySelection());
    setSelectedBasinId(null);
    setSelectedEquipmentId(null);
    setSelectedBaffleId(null);
    setSelectedUtilityId(null);
    sceneRef.current?.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
    const next = GameManager.createInitialState(levelIndex, isSandbox);
    setGameState(next);

    // ── FULL interaction-state reset (Prompt 3.4.2 P1) ──
    // Transient player state must never survive a level/stage change: refs and
    // UI atoms pointing at previous-level units would leave ghost highlights,
    // an armed pipe source from a deleted unit, or a dangling port picker.
    setToolState(prev => reduceToolSelection(prev, { type: 'cancel_placement' }));
    setCurrentRotation(0);
    cancelPipeSelection(true);          // pipe source + port + position +
                                        // pending target + picker + preview +
                                        // source highlight (all scene-synced)
    setGameState(prev => ({ ...prev, selectedUnitId: null })); // close inspector

    if (sceneRef.current) {
      const [w, d] = next.currentLevel.mapSize;
      // Scene-clock sync (Prompt 3.4 item 17): a new level must not inherit the
      // previous one's visual speed (e.g. 5×) or paused visual world.
      sceneRef.current.setGameClock(next.gameTimeDays);
      sceneRef.current.setSimulationSpeed(next.simSpeed);
      sceneRef.current.setEnvironment(next.currentLevel.biome);
      sceneRef.current.terrainGrid.updateSize(w, d, next.currentLevel.biome);
      sceneRef.current.updateShadowBounds(w, d);
      sceneRef.current.cameraController.resetView(w, d);
      sceneRef.current.syncUnits(next.units);
      sceneRef.current.syncPipes(next.pipes);
      sceneRef.current.syncBasins(next.customBasins ?? [], null);
      sceneRef.current.syncEquipment(
        next.processEquipment ?? [], next.customBasins ?? [], null,
        poweredEquipmentIds(next.processEquipment ?? [], next.utilityConnections ?? []),
        aeratedDiffuserIds(next.processEquipment ?? [], next.utilityConnections ?? []),
        filtrationLiveSets(next.customBasins ?? [], next.processEquipment ?? [], next.utilityConnections ?? [], next.customBaffles ?? [])
      );
      sceneRef.current.syncUtilityConnections(next.utilityConnections ?? [], null);
      sceneRef.current.syncBaffles(next.customBaffles ?? [], next.customBasins ?? [], null);
      sceneRef.current.syncSelectionBrackets(null);
      sceneRef.current.syncDimensionLabels(next.customBasins ?? [], null);
      sceneRef.current.syncEquipmentDragHandle(null);
      // Clear any stale hover/ghost placement preview from the old level.
      sceneRef.current.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
      sceneRef.current.terrainGrid.setHoverTile(0, 0, false);
      if (next.suggestion) {
        sceneRef.current.showNextStepGhost(next.suggestion.unitTypeId, next.suggestion.gridX, next.suggestion.gridY);
      } else {
        sceneRef.current.showNextStepGhost(null, 0, 0);
      }
    }
    setIsTopDown(false);
    setToast(`Stage loaded: ${next.currentLevel.title}`);
  }, [cancelPipeSelection]);

  // P5: keep amber equipment drag handle synced with lone-selection (in-world grab hint)
  useEffect(() => {
    syncEquipHandleVisual();
  }, [constructionSelection, gameState.processEquipment, gameState.customBasins, syncEquipHandleVisual]);

  const handleToggleTopDown = () => {
    const sm = sceneRef.current;
    if (!sm) return;
    const td = sm.cameraController.toggleTopDown();
    setIsTopDown(td);
    setToast(td ? '2D Blueprint schematic view' : '3D Isometric view');
  };

  const selectedUnit = gameState.units.find(u => u.instanceId === gameState.selectedUnitId) ?? null;

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0a1628] select-none font-sans">

      {/* ── 3D Canvas Mount ────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: 'grab' }}
      />

      {/* ── Contextual port selector (Pipe Mode, multi-port units) ─────────── */}
      {portPicker && toolMode === 'connect_pipe' && (
        <PortSelector
          title={(() => {
            const u = gameState.units.find(x => x.instanceId === portPicker.unitId);
            return u ? unitName(u) : 'Select port';
          })()}
          subtitle={portPicker.mode === 'source'
            ? 'Choose an output port to pipe FROM'
            : 'Choose a compatible inlet'}
          choices={portPicker.choices}
          highlightId={portPicker.mode === 'source' ? pipeSourcePortRef.current : null}
          anchor={portPicker.anchor}
          onSelect={handlePortSelect}
          onCancel={() => {
            setPortPicker(null);
            pendingTargetRef.current = null;
            SoundManager.playClick();
          }}
        />
      )}

      {/* ── Toast Banner — sits below the HUD bar; never overlaps it ───────── */}
      {toast && (
        <div className="absolute top-[60px] left-1/2 -translate-x-1/2 z-30 pointer-events-none
                        px-4 py-2 rounded-xl bg-slate-900 border border-cyan-500/40
                        text-cyan-300 text-xs font-mono shadow-2xl flex items-center gap-2 max-w-[min(90vw,42rem)] animate-in fade-in slide-in-from-top-2 duration-150">
          <Info size={14} className="text-cyan-400 shrink-0" />
          <span className="truncate" title={toast}>{toast}</span>
          {toolMode === 'place_unit' && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold border border-amber-500/30">
              R = rotate
            </span>
          )}
        </div>
      )}

      {/* P3 hover hint — Inspect mode contextual affordance (equipment > baffle > utility > basin > legacy) */}
      {hoverHint && toolMode === 'select' && !movingEquipmentId && (
        <div className="absolute top-[92px] left-1/2 -translate-x-1/2 z-20 pointer-events-none
                        px-3 py-1 rounded-full bg-slate-800/90 border border-slate-600/50
                        text-slate-200 text-[11px] font-mono shadow-lg backdrop-blur-sm">
          {hoverHint}
        </div>
      )}

      {/* ── Piping control legend (visible in Pipes mode) ── */}
      {toolMode === 'connect_pipe' && (
        <div className="absolute bottom-[152px] left-1/2 -translate-x-1/2 z-30 pointer-events-none
                        px-4 py-1.5 rounded-xl bg-slate-900 border border-cyan-500/40
                        shadow-2xl flex flex-wrap justify-center items-center gap-x-3 gap-y-1 text-[10px] font-mono text-slate-300 max-w-[min(94vw,64rem)]">
          <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-bold border border-sky-500/30">PIPES</span>
          <span><b className="text-slate-100">LMB</b> source unit → pick its port → target unit → pick inlet</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-slate-100">LMB again</b>: remove pipe</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-rose-300">RMB</b>: cancel</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-slate-100">Ctrl+Z</b> undo · <b className="text-slate-100">Ctrl+Y</b> redo</span>
          <span className="text-slate-600">|</span>
          <button
            onClick={handleAutoTrain}
            className="pointer-events-auto px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40 hover:bg-emerald-500/30 transition"
            title="Connect the main liquid treatment train only (never sludge/gas/recycle lines)"
          >
            ⚡ Auto-train
          </button>
          <span className="text-slate-600">|</span>
          <span className="flex items-center gap-1.5">
            <i className="inline-block w-2 h-2 rounded-full bg-cyan-400" />liquid
            <i className="inline-block w-2 h-2 rounded-full bg-[#3b1c04]" />sludge
            <i className="inline-block w-2 h-2 rounded-full bg-[#7c4a12]" />RAS
            <i className="inline-block w-2 h-2 rounded-full bg-violet-500" />recycle
            <i className="inline-block w-2 h-2 rounded-full bg-yellow-400" />gas
          </span>
        </div>
      )}

      {/* ── Header HUD ──────────────────────────────────────────────────────── */}
      <HeaderHUD
        gameState={gameState}
        onSetSpeed={s => {
          // Explicit speed sync (item 14): the React sim and the Three.js world
          // always share one multiplier — no implicit state reads.
          setGameState(prev => ({ ...prev, simSpeed: s }));
          sceneRef.current?.setSimulationSpeed(s);
        }}
        onOpenLevelModal={() => setLevelModal(true)}
        onOpenTechTree={() => setTechModal(true)}
        onOpenPFD={() => setPfdModal(true)}
        onOpenSandboxControls={() => setSandboxModal(true)}
        onOpenOperator={() => setOperatorOpen(true)}
        onToggleTopDown={handleToggleTopDown}
        isTopDown={isTopDown}
      />

      {/* ── Build Toolbar ────────────────────────────────────────────────────── */}
      <BuildToolbar
        toolMode={toolMode}
        onSetToolMode={mode => {
          // Atomic tool switch (ToolStateLogic): leaves placement AND clears
          // the stale build unit in the same state transition. No batching
          // hazard can leave 'place_unit' active after clicking Inspect/Pipes/
          // Demolish.
          setToolMode(mode);
          if (mode !== 'place_unit') cancelPipeSelection(true);
          if (mode !== 'connect_utility') cancelUtilitySelection(true);
          if (mode !== 'draw_baffle') cancelBafflePreview();
          if (mode === 'select')       setToast('Inspect Mode: Click any tank to configure parameters.');
          if (mode === 'connect_pipe') setToast('Pipes: LEFT-CLICK a unit → click the destination. Click the SAME unit to switch its output port. RIGHT-CLICK to cancel. Ctrl+Z undo / Ctrl+Y redo.');
          if (mode === 'demolish')     setToast('Demolish Mode: Click any unit/baffle/utility to remove for salvage. Baffles refund 60%.');
          if (mode === 'place_unit')   setToast('Choose a unit type below, then click on the grid to place.');
          if (mode === 'draw_basin')   setToast('STRUCTURES → Basin: click the FIRST corner, then the opposite corner. Esc cancels. Cost is shown as you draw.');
          if (mode === 'place_equipment') setToast('EQUIPMENT: pick a machine in the toolbar, then click a valid tile — diffusers/mixers mount INSIDE drawn basins, pumps/blowers on open ground. Esc cancels.');
          if (mode === 'connect_utility') {
            const util = UTILITY_TYPES[selectedUtilityTypeId ?? 'water_pipe'];
            setToast(`UTILITY: ${util.name} — ${util.blurb} Two clicks: source host tile → destination host tile. Cost shown after. Esc cancels.`);
          }
          if (mode === 'draw_baffle') {
            const orient = selectedBaffleOrientation ?? 'vertical';
            setToast(`BAFFLE (${orient}): click INSIDE a basin to place an interior wall at that tile · splits basin into zones. Esc cancels.`);
          }
          if (mode !== 'place_equipment') setSelectedEquipmentTypeId(null);
          if (mode !== 'connect_utility') {
            setSelectedUtilityId(null);
            utilitySourceRef.current = null;
            sceneRef.current?.setUtilityPreview(null, null);
          }
          if (mode !== 'draw_baffle') {
            setSelectedBaffleId(null);
            sceneRef.current?.syncBaffles(gsRef.current.customBaffles ?? [], gsRef.current.customBasins ?? [], null);
          }
        }}
        selectedUnitTypeId={selectedUnitTypeId}
        selectedEquipmentTypeId={selectedEquipmentTypeId}
        onSelectEquipmentTypeId={id => {
          setSelectedEquipmentTypeId(id);
          setSelectedEquipmentId(null);
          if (id) {
            const eq = EQUIPMENT_TYPES[id];
            setToast(`${eq.name} ($${eq.capexUsd.toLocaleString()}) — ${eq.mounting === 'in_basin' ? 'click INSIDE a drawn basin to install.' : 'click open ground to install.'}`);
          }
        }}
        selectedUtilityTypeId={selectedUtilityTypeId}
        onSelectUtilityTypeId={id => {
          setSelectedUtilityTypeId(id ?? 'water_pipe');
          setSelectedUtilityId(null);
          utilitySourceRef.current = null;
          sceneRef.current?.setUtilityPreview(null, null);
          if (id) {
            const util = UTILITY_TYPES[id];
            setToast(`${util.name} armed — $${util.perMeterUsd}/m + $${util.fixedUsd} tie-in. Click source host tile, then destination host tile.`);
          }
        }}
        selectedBaffleOrientation={selectedBaffleOrientation}
        onSelectBaffleOrientation={o => {
          setSelectedBaffleOrientation(o ?? 'vertical');
          setSelectedBaffleId(null);
          sceneRef.current?.syncBaffles(gameState.customBaffles ?? [], gameState.customBasins ?? [], null);
          if (o) setToast(`${o === 'vertical' ? 'Vertical' : 'Horizontal'} baffle armed — click INSIDE a basin. Splits it into compartments.`);
        }}
        onSelectUnitTypeId={id => {
          // ATOMIC: a non-null id enters place_unit WITH that unit; null merely
          // clears placement and NEVER forces place_unit (the old handler
          // unconditionally ran setToolMode('place_unit') here, clobbering the
          // Inspect/Pipes/Demolish mode the player had just requested).
          applyUnitTypeSelection(id);
          if (id) {
            const def = UNIT_DEFINITIONS[id];
            setToast(`${def.name} ($${def.capex.toLocaleString()}) — Click on grid to place. Press R to rotate.`);
          }
        }}
        currentRotation={currentRotation}
        onRotate={() => setCurrentRotation(r => ((r + 90) % 360) as 0|90|180|270)}
        techTree={gameState.techTree}
        playerCash={gameState.financials.cash}
        isSandbox={gameState.gameMode === 'sandbox'}
        availableUnitIds={gameState.currentLevel.availableUnits}
        suggestedUnitTypeId={gameState.suggestion?.unitTypeId}
        tutorialAllowedUnitId={tutorialAllowedUnitId}
        showRecommendationUi={tutorialActive}
        placeSeeded={placeSeeded}
        onTogglePlaceSeeded={() => {
          const next = !placeSeededRef.current;
          setPlaceSeeded(next);
          setToast(next
            ? 'Seed sludge ON — next CAS basin ships contractor-seeded (day-one performance).'
            : 'Seed sludge OFF — next CAS basin starts unseeded and saves the haul-in fee.');
        }}
      />

      {/* ── Phase 4: construction status HUD (live power & aeration at a glance) ── */}
      <ConstructionStatusChip stats={GameManager.constructionStats(gameState)} zoneStats={GameManager.basinZoneStats(gameState)} />
      {/* ── Phase 7: emergent process recognition badges (descriptive, read-only) ── */}
      <ProcessBadgeStrip badges={recognizeProcess(gameState.customBasins ?? [], gameState.customBaffles ?? [], gameState.processEquipment ?? [], gameState.utilityConnections ?? [])} />
      {/* ── P4: multi-select bulk action bar (grouping cues + bulk demolish) ── */}
      <BulkActionBar
        selection={constructionSelection}
        refundEstimate={(() => {
          if (selectionCount(constructionSelection) <= 1) return 0;
          const r = GameManager.bulkDemolish(gameState, constructionSelection);
          return r.refunded ?? 0;
        })()}
        onBulkDemolish={handleBulkDemolish}
        onClear={clearConstructionSelection}
      />

      {/* ── Unit Inspector ──────────────────────────────────────────────────── */}
      {selectedUnit && (
        <UnitInspector
          unit={selectedUnit}
          onClose={() => setGameState(prev => ({ ...prev, selectedUnitId: null }))}
          onUpdateParams={(id, key, val) =>
            setGameState(prev => ({
              ...prev,
              units: prev.units.map(u =>
                u.instanceId === id ? { ...u, customParams: { ...u.customParams, [key]: val } } : u
              ),
            }))
          }
          onDemolish={id => {
            pushHistory(gsRef.current);
            const next = GameManager.demolishUnit(gsRef.current, id);
            setGameState(next);
            sceneRef.current?.syncUnits(next.units);
            sceneRef.current?.syncPipes(next.pipes);
            setToast('Unit demolished.');
          }}
          onOpenDesigner={id => setDesignerModalId(id)}
        />
      )}

      {/* ── P1: Basin Inspector — direct depth + footprint editing + in-world dimensions ── */}
      {selectedBasinId && selectionCount(constructionSelection) <= 1 && (() => {
        const basin = gameState.customBasins?.find(b => b.id === selectedBasinId);
        if (!basin) return null;
        const zoneCount = GameManager.zonesForBasin(gameState, basin.id).length || 1;
        const equipmentInside = (gameState.processEquipment ?? []).filter(e => e.x >= basin.x && e.x < basin.x + basin.w && e.y >= basin.y && e.y < basin.y + basin.h).length;
        return (
          <BasinInspector
            basin={basin}
            zoneCount={zoneCount}
            equipmentInside={equipmentInside}
            onClose={() => {
              setSelectedBasinId(null);
              sceneRef.current?.syncBasins(gameState.customBasins ?? [], null);
            }}
            onDemolish={id => {
              pushHistory(gsRef.current);
              const res = GameManager.demolishCustomBasin(gsRef.current, id);
              if (res.success) {
                setSelectedBasinId(null);
                setGameState(res.newState);
                sceneRef.current?.syncBasins(res.newState.customBasins ?? [], null);
                sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
                sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
                sceneRef.current?.syncEquipment(
                  res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
                  poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                  aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                  filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
                );
                setToast(res.refunded && res.refunded > 0 ? `Basin demolished — salvage refund $${res.refunded.toLocaleString()}.` : 'Basin demolished.');
              } else {
                SoundManager.playWarning();
                setToast(res.reason ?? 'Cannot demolish basin.');
              }
            }}
            onUpdateDepth={(id, depth) => {
              pushHistory(gsRef.current);
              const res = GameManager.updateBasinDepth(gsRef.current, id, depth);
              if (!res.success) {
                SoundManager.playWarning();
                setToast(res.reason ?? 'Cannot update depth.');
                undoStackRef.current.pop();
                return;
              }
              setGameState(res.newState);
              sceneRef.current?.syncBasins(res.newState.customBasins ?? [], id);
              sceneRef.current?.syncDimensionLabels(res.newState.customBasins ?? [], id);
              sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
              sceneRef.current?.syncEquipment(
                res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
                poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
              );
              if (res.charged) setToast(`Basin deepened to ${depth.toFixed(1)} m — charged $${res.charged.toLocaleString()} extra concrete.`);
              else if (res.refunded) setToast(`Basin shallowed to ${depth.toFixed(1)} m — refund +$${res.refunded.toLocaleString()} (50% salvage).`);
              else setToast(`Basin depth set to ${depth.toFixed(1)} m.`);
            }}
            onResize={(id, rect) => {
              pushHistory(gsRef.current);
              const res = GameManager.updateBasinRect(gsRef.current, id, rect);
              if (!res.success) {
                SoundManager.playWarning();
                setToast(res.reason ?? 'Cannot resize basin.');
                undoStackRef.current.pop();
                return;
              }
              setGameState(res.newState);
              sceneRef.current?.syncBasins(res.newState.customBasins ?? [], id);
              sceneRef.current?.syncDimensionLabels(res.newState.customBasins ?? [], id);
              sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
              sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
              sceneRef.current?.syncEquipment(
                res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
                poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
              );
              if (res.charged) setToast(`Basin resized to ${rect.w}×${rect.h} — charged $${res.charged.toLocaleString()}.`);
              else if (res.refunded) setToast(`Basin shrunk to ${rect.w}×${rect.h} — refund +$${res.refunded.toLocaleString()}.`);
              else setToast(`Basin resized to ${rect.w}×${rect.h}.`);
            }}
          />
        );
      })()}

      {/* ── Phase 4: installed equipment inspector (power + aeration live status) ── */}
      {selectedEquipmentId && selectionCount(constructionSelection) <= 1 && (() => {
        const item = gameState.processEquipment?.find(e => e.id === selectedEquipmentId);
        if (!item) return null;
        const powered = poweredEquipmentIds(gameState.processEquipment ?? [], gameState.utilityConnections ?? []).has(item.id);
        const aerated = item.typeId === 'fine_bubble_diffuser'
          ? aeratedDiffuserIds(gameState.processEquipment ?? [], gameState.utilityConnections ?? []).has(item.id)
          : null;
        const zone = GameManager.zoneForEquipmentItem(gameState, item.id);
        const filt = filtrationLiveSets(gameState.customBasins ?? [], gameState.processEquipment ?? [], gameState.utilityConnections ?? [], gameState.customBaffles ?? []);
        const chem = chemicalLiveSets(gameState.customBasins ?? [], gameState.processEquipment ?? [], gameState.utilityConnections ?? [], gameState.customBaffles ?? []);
        return (
          <EquipmentInspector
            item={item}
            powered={powered}
            aerated={aerated}
            zone={zone}
            filtrationLive={filt.liveMembraneIds.has(item.id)}
            filtrationDegraded={filt.degradedMembraneIds.has(item.id)}
            carrierActive={filt.activeCarrierIds.has(item.id)}
            carrierAerated={filt.aeratedCarrierIds.has(item.id)}
            dosingActive={chem.activeDosingIds.has(item.id)}
            dosingPowered={chem.poweredDosingIds.has(item.id)}
            storagePowered={chem.poweredStorageIds.has(item.id)}
            flowM3d={gameState.finalEffluent.flowRate}
            moving={movingEquipmentId === item.id}
            onClose={() => {
              if (movingEquipmentId === item.id) cancelEquipmentMove(true);
              setSelectedEquipmentId(null);
              sceneRef.current?.syncEquipment(
                gameState.processEquipment ?? [], gameState.customBasins ?? [], null,
                poweredEquipmentIds(gameState.processEquipment ?? [], gameState.utilityConnections ?? []),
                aeratedDiffuserIds(gameState.processEquipment ?? [], gameState.utilityConnections ?? []),
                filtrationLiveSets(gameState.customBasins ?? [], gameState.processEquipment ?? [], gameState.utilityConnections ?? [], gameState.customBaffles ?? []),
                chemicalLiveSets(gameState.customBasins ?? [], gameState.processEquipment ?? [], gameState.utilityConnections ?? [], gameState.customBaffles ?? [])
              );
            }}
            onMove={id => {
              if (movingEquipmentId === id) {
                cancelEquipmentMove(true);
                setToast('Move cancelled — machine stays where it was.');
                return;
              }
              const it = gsRef.current.processEquipment?.find(e => e.id === id);
              if (!it) return;
              const attached = (gsRef.current.utilityConnections ?? []).filter(c =>
                (c.ax === it.x && c.ay === it.y) || (c.bx === it.x && c.by === it.y)
              );
              if (attached.length > 0) {
                SoundManager.playWarning();
                setToast(`⛔ Can't move — remove its ${attached.length} pipe/cable(s) first (utility blocks relocation).`);
                return;
              }
              setMovingEquipmentId(id);
              setToast(`Moving ${EQUIPMENT_TYPES[it.typeId]?.name ?? 'equipment'} — click a green destination tile. Esc or right-click cancels.`);
            }}
            onRotate={id => {
              const it = gsRef.current.processEquipment?.find(e => e.id === id);
              if (!it) return;
              pushHistory(gsRef.current);
              const res = GameManager.rotateProcessEquipment(gsRef.current, id);
              if (!res.success) {
                SoundManager.playWarning();
                undoStackRef.current.pop();
                setToast(res.reason ?? 'Cannot rotate.');
                return;
              }
              setGameState(res.newState);
              sceneRef.current?.syncEquipment(
                res.newState.processEquipment ?? [], res.newState.customBasins ?? [], id,
                poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? []),
                chemicalLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
              );
              const rot = res.newState.processEquipment?.find(e => e.id === id)?.rotation ?? 0;
              SoundManager.playClick();
              setToast(`Rotated to ${rot}° — visual orientation updated (Ctrl+Z to undo).`);
            }}
            onDemolish={id => {
              pushHistory(gsRef.current);
              const res = GameManager.demolishProcessEquipment(gsRef.current, id);
              if (res.success) {
                setSelectedEquipmentId(null);
                setGameState(res.newState);
                sceneRef.current?.syncEquipment(
                  res.newState.processEquipment ?? [], res.newState.customBasins ?? [], null,
                  poweredEquipmentIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                  aeratedDiffuserIds(res.newState.processEquipment ?? [], res.newState.utilityConnections ?? []),
                  filtrationLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? []),
                  chemicalLiveSets(res.newState.customBasins ?? [], res.newState.processEquipment ?? [], res.newState.utilityConnections ?? [], res.newState.customBaffles ?? [])
                );
                sceneRef.current?.syncUtilityConnections(res.newState.utilityConnections ?? [], null);
                setToast(res.refunded && res.refunded > 0
                  ? `${EQUIPMENT_TYPES[item.typeId]?.name ?? 'Equipment'} removed — salvage refund $${res.refunded.toLocaleString()}.`
                  : `${EQUIPMENT_TYPES[item.typeId]?.name ?? 'Equipment'} removed.`);
              }
            }}
          />
        );
      })()}

      {/* ── Phase 5: baffle inspector (interior compartment wall) ── */}
      {selectedBaffleId && selectionCount(constructionSelection) <= 1 && (() => {
        const baffle = gameState.customBaffles?.find(b => b.id === selectedBaffleId);
        if (!baffle) return null;
        const basin = gameState.customBasins?.find(b => b.id === baffle.basinId);
        if (!basin) return null;
        return (
          <BaffleInspector
            baffle={baffle}
            basin={basin}
            onClose={() => {
              setSelectedBaffleId(null);
              sceneRef.current?.syncBaffles(gameState.customBaffles ?? [], gameState.customBasins ?? [], null);
            }}
            onDemolish={id => {
              pushHistory(gsRef.current);
              const res = GameManager.demolishBaffle(gsRef.current, id);
              if (res.success) {
                setSelectedBaffleId(null);
                setGameState(res.newState);
                sceneRef.current?.syncBaffles(res.newState.customBaffles ?? [], res.newState.customBasins ?? [], null);
                setToast(res.refunded && res.refunded > 0
                  ? `Baffle removed — salvage refund $${res.refunded.toLocaleString()}.`
                  : 'Baffle removed.');
              }
            }}
          />
        );
      })()}

      {/* ── Unit Designer (engineered assets) ─────────────────────────────── */}
      {pfdModal && (
        <PlantFlowDiagram gameState={gameState} onUpdatePipe={handleUpdatePipe} onClose={() => setPfdModal(false)} />
      )}
      {designerModalId && (() => {
        const u = gameState.units.find(x => x.instanceId === designerModalId);
        if (!u) return null;
        return (
          <UnitDesigner
            unit={u}
            playerCash={gameState.financials.cash}
            onClose={() => setDesignerModalId(null)}
            onUpdateBlueprint={(id, next) => {
              setGameState(prev => ({
                ...prev,
                units: prev.units.map(un =>
                  un.instanceId === id && next ? { ...un, blueprint: next } : un
                ),
              }));
              const ng = gameState.units.map(un =>
                un.instanceId === id && next ? { ...un, blueprint: next } : un
              );
              sceneRef.current?.syncUnits(ng);
            }}
            onUpdateCommissioning={(id, next) => {
              // Domain-layer write so the seed-sludge haul-in economics are
              // enforced even if a future UI path calls this directly.
              const res = GameManager.setUnitCommissioning(gsRef.current, id, next);
              if (!res.success) {
                if (res.reason) setToast(`🔒 ${res.reason}`);
                return;
              }
              setGameState(res.newState);
              if (res.seedCapexCharged) {
                setToast(`Seed sludge haul-in purchased — $${Math.round(res.seedCapexCharged).toLocaleString()}.`);
              }
            }}
            onUpdateFouling={(id) => {
              // Operational membrane cleaning goes through the domain layer so
              // the CIP charge is enforced no matter which UI path fires it.
              const res = GameManager.cleanMbrMembranes(gsRef.current, id);
              if (!res.success) {
                if (res.reason) setToast(`🔒 ${res.reason}`);
                return;
              }
              setGameState(res.newState);
              if (res.cipCostCharged) {
                setToast(`CIP clean complete — $${Math.round(res.cipCostCharged).toLocaleString()} chemicals & labor. Train offline ~6 h for the soak.`);
              }
            }}
            onReplaceMembranes={(id) => {
              // Cassette replacement goes through the domain layer so the
              // end-of-life CAPEX is enforced no matter which UI path fires it.
              const res = GameManager.replaceMbrMembranes(gsRef.current, id);
              if (!res.success) {
                if (res.reason) setToast(`🔒 ${res.reason}`);
                return;
              }
              setGameState(res.newState);
              SoundManager.playPlace();
              setToast(res.replacementCapexCharged
                ? `Membrane cassettes replaced — $${Math.round(res.replacementCapexCharged).toLocaleString()} CAPEX. Brand-new membranes installed.`
                : 'Membrane cassettes replaced — brand-new membranes installed.');
            }}
          />
        );
      })()}
      {levelModal && (
        <LevelModal
          currentLevelId={gameState.currentLevel.id}
          onSelectLevel={handleSelectLevel}
          onClose={() => setLevelModal(false)}
        />
      )}
      {techModal && (
        <TechTreeModal
          techTree={gameState.techTree}
          playerCash={gameState.financials.cash}
          isSandbox={gameState.gameMode === 'sandbox'}
          onUnlockTech={id => {
            const res = GameManager.unlockTech(gameState, id);
            if (!res.success && res.reason) setToast(`🔒 ${res.reason}`);
            return res.newState;
          }}
          onClose={() => setTechModal(false)}
        />
      )}
      {sandboxModal && (
        <SandboxControls
          influent={gameState.sandboxCustomInfluent}
          onUpdateInfluent={inf => setGameState(prev => ({ ...prev, sandboxCustomInfluent: inf }))}
          onClose={() => setSandboxModal(false)}
        />
      )}
      {operatorOpen && (
        <OperatorConsole
          gameState={gameState}
          onClose={() => setOperatorOpen(false)}
          onApplyFix={handleApplyFix}
        />
      )}
      {gameState.levelVictoryModalOpen && (
        <VictoryModal
          level={gameState.currentLevel}
          isCampaignComplete={gameState.currentLevel.id >= CAMPAIGN_LEVELS.length}
          onNextLevel={() => {
            // NEVER wrap: only advance when a next level exists.
            const idx = CAMPAIGN_LEVELS.findIndex(l => l.id === gameState.currentLevel.id);
            if (idx < CAMPAIGN_LEVELS.length - 1) {
              handleSelectLevel(idx + 1, false);
            }
            setGameState(prev => ({ ...prev, levelVictoryModalOpen: false }));
          }}
          onContinuePlaying={() => setGameState(prev => ({ ...prev, levelVictoryModalOpen: false }))}
          onOpenLevelSelect={() => {
            setGameState(prev => ({ ...prev, levelVictoryModalOpen: false }));
            setLevelModal(true);
          }}
          onRestartCampaign={() => {
            setGameState(GameManager.createInitialState(0, false));
          }}
        />
      )}

      {/* ── Tutorial: startup prompt + in-game coach ─────────────────────────── */}
      {askTutorial && !tutorialActive && (
        <TutorialPromptModal onAccept={startTutorial} onDecline={declineTutorial} />
      )}
      {tutorialActive && tutStep && (
        <TutorialCoach
          step={tutStep}
          index={gameState.tutorialStep}
          total={TUTORIAL_STEPS.length}
          onCancel={cancelTutorial}
          onOpenPipes={() => { setToolMode('connect_pipe'); setOperatorOpen(false); }}
          onAdvance={() => setGameState(prev => ({ ...prev, tutorialStep: prev.tutorialStep + 1 }))}
          onSelectUnit={typeId => {
            applyUnitTypeSelection(typeId);
            const sug = gsRef.current.suggestion;
            if (sug) sceneRef.current?.cameraController.focusOn(sug.gridX, sug.gridY);
            setToast(`${UNIT_DEFINITIONS[typeId].name} selected — click the glowing green lot!`);
          }}
        />
      )}
    </div>
  );
};
