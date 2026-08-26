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

// UI Components
import { HeaderHUD } from './ui/HeaderHUD';
import { BuildToolbar } from './ui/BuildToolbar';
import { UnitInspector } from './ui/UnitInspector';
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

  const [currentRotation, setCurrentRotation]       = useState<0|90|180|270>(0);
  const rotationRef = useRef<0|90|180|270>(0);
  rotationRef.current = currentRotation;

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
    const sm = sceneRef.current;
    if (sm) {
      sm.syncUnits(state.units);
      sm.syncPipes(state.pipes);
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
    };

    const onPointerMove = (e: PointerEvent) => {
      e.preventDefault();
      const sm = sceneRef.current;
      if (!sm) return;

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
        } else {
          sm.terrainGrid.setGhostPreview(0, 0, 1, 1, true, false);
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

      const wasDrag = pointerDist.current > 6;
      const button = e.button;
      pointerDown.current = false;

      if (wasDrag) return; // drags orbit/pan — never a click

      if (button === 2) {
        // RIGHT CLICK: cancel the pending pipe selection (control scheme)
        if (toolModeRef.current === 'connect_pipe' && pipeSourceRef.current) {
          cancelPipeSelection();
        }
        return;
      }
      if (button === 0) {
        // LEFT CLICK: primary action
        handleCanvasClick(e.clientX, e.clientY);
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

  const handleCanvasClick = (clientX: number, clientY: number) => {
    try {
      handleCanvasClickInner(clientX, clientY);
    } catch (err) {
      // Never let a click die silently — surface it so nothing feels "broken"
      console.error('Canvas click error:', err);
      setToast('Something went wrong handling that click — please try again.');
    }
  };

  const handleCanvasClickInner = (clientX: number, clientY: number) => {
    const sm = sceneRef.current;
    if (!sm) return;

    const mode     = toolModeRef.current;
    const gs       = gsRef.current;
    const typeId   = selUnitTypeRef.current;
    const rotation = rotationRef.current;
    const srcId    = pipeSourceRef.current;

    const tile        = sm.getGridTileFromScreen(clientX, clientY);
    const clickedUnit = sm.getUnitAtScreen(clientX, clientY, gs.units);

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

    if (mode === 'select') {
      if (clickedUnit) {
        SoundManager.playClick();
        setGameState(prev => ({ ...prev, selectedUnitId: clickedUnit.instanceId }));
        const def = UNIT_DEFINITIONS[clickedUnit.typeId];
        setToast(`Inspecting: ${def?.name ?? clickedUnit.typeId}`);
      } else {
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
    } else if (mode === 'demolish' && clickedUnit) {
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
          if (toolModeRef.current === 'connect_pipe' && pipeSourceRef.current) {
            cancelPipeSelection();
          } else {
            setToolState(prev => reduceToolSelection(prev, { type: 'cancel_placement' }));
            cancelPipeSelection(true);
            sceneRef.current?.setPipeSourceHighlight(null, gsRef.current.units);
            setGameState(prev => ({ ...prev, selectedUnitId: null }));
            setToast('Select mode — click a unit to inspect.');
          }
          break;
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
  const handleSelectLevel = useCallback((levelIndex: number, isSandbox: boolean) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
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

      {/* ── Piping control legend (visible in Pipes mode) — wraps on narrow
              screens instead of overflowing ───────────────────────────────── */}
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
          if (mode === 'select')       setToast('Inspect Mode: Click any tank to configure parameters.');
          if (mode === 'connect_pipe') setToast('Pipes: LEFT-CLICK a unit → click the destination. Click the SAME unit to switch its output port. RIGHT-CLICK to cancel. Ctrl+Z undo / Ctrl+Y redo.');
          if (mode === 'demolish')     setToast('Demolish Mode: Click any unit to remove for 70% cash refund.');
          if (mode === 'place_unit')   setToast('Choose a unit type below, then click on the grid to place.');
        }}
        selectedUnitTypeId={selectedUnitTypeId}
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
            onUpdateFouling={(id, next) => {
              // Operational membrane cleaning: write the fouling state back to
              // the placed unit's runtime record (no CAPEX — maintenance action).
              setGameState(prev => ({
                ...prev,
                units: prev.units.map(un =>
                  un.instanceId === id && next ? { ...un, mbrFouling: next } : un
                ),
              }));
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
