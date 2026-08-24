import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { SceneManager } from './graphics/SceneManager';
import { GameManager, GameState } from './gameplay/GameManager';
import { ToolMode } from './types/graphics';
import { PipeConnection, PlacedUnit, UnitTypeId } from './types/simulation';
import { UNIT_DEFINITIONS } from './sim/UnitProcessModels';
import { generatePipePath, getPortWorldPosition, isConnectionExisting } from './sim/PipeNetwork';
import { SoundManager } from './audio/SoundManager';
import { CAMPAIGN_LEVELS } from './gameplay/LevelsData';
import { TUTORIAL_STEPS, TUTORIAL_PIPE_CHAIN } from './gameplay/TutorialSteps';

// UI Components
import { HeaderHUD } from './ui/HeaderHUD';
import { BuildToolbar } from './ui/BuildToolbar';
import { UnitInspector } from './ui/UnitInspector';
import { PlantFlowDiagram } from './ui/PlantFlowDiagram';
import { LevelModal } from './ui/LevelModal';
import { TechTreeModal } from './ui/TechTreeModal';
import { SandboxControls } from './ui/SandboxControls';
import { TutorialPromptModal, TutorialCoach } from './ui/TutorialUI';
import { VictoryModal } from './ui/VictoryModal';
import { OperatorConsole } from './ui/OperatorConsole';
import { FixAction, findFreeSpot } from './sim/AdvisoryEngine';

import {
  ZoomIn, ZoomOut, RotateCcw, RotateCw,
  ChevronUp, ChevronDown, Compass, Info
} from 'lucide-react';

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
  const [toolMode, setToolMode]                     = useState<ToolMode>('select');
  const toolModeRef = useRef<ToolMode>('select');
  toolModeRef.current = toolMode;

  const [selectedUnitTypeId, setSelectedUnitTypeId] = useState<UnitTypeId | null>(null);
  const selUnitTypeRef = useRef<UnitTypeId | null>(null);
  selUnitTypeRef.current = selectedUnitTypeId;

  const [currentRotation, setCurrentRotation]       = useState<0|90|180|270>(0);
  const rotationRef = useRef<0|90|180|270>(0);
  rotationRef.current = currentRotation;

  const [pipeSourceId, setPipeSourceId]             = useState<string | null>(null);
  const pipeSourcePortRef = useRef<string | null>(null);
  const pipeSourcePosRef = useRef<[number, number, number] | null>(null);
  const pipeSourceRef = useRef<string | null>(null);
  pipeSourceRef.current = pipeSourceId;

  // ── UI State ──────────────────────────────────────────────────────────────────
  const [toast, setToast]                     = useState('Welcome to AquaTycoon 3D! Follow the guide on the top-left or pick a unit below.');
  const [isTopDown, setIsTopDown]             = useState(false);
  const [levelModal, setLevelModal]           = useState(false);
  const [techModal, setTechModal]             = useState(false);
  const [pfdModal, setPfdModal]               = useState(false);
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
    setSelectedUnitTypeId(null);
    setToolMode('select');
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
    setToolMode(m => (m === 'connect_pipe' ? 'select' : m));
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

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sceneRef.current?.cameraController.zoom(e.deltaY * 0.025);
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown',  onPointerDown,  { passive: false });
    canvas.addEventListener('pointermove',  onPointerMove,  { passive: false });
    canvas.addEventListener('pointerup',    onPointerUp,    { passive: false });
    canvas.addEventListener('pointercancel', onPointerUp,   { passive: false });
    canvas.addEventListener('wheel',        onWheel,        { passive: false });
    canvas.addEventListener('contextmenu',  onContextMenu,  { passive: false });

    return () => {
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown',  onPointerDown);
      canvas.removeEventListener('pointermove',  onPointerMove);
      canvas.removeEventListener('pointerup',    onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel',        onWheel);
      canvas.removeEventListener('contextmenu',  onContextMenu);
      sm.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // CLICK ACTION (using gsRef for 100% fresh state)
  // ─────────────────────────────────────────────────────────────────────────────
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
      const result = GameManager.placeUnit(gs, typeId, tile.x, tile.y, rotation);
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
          setToast(`Placed ${def.name}! Now connect pipes or continue adding units.`);
        }
      } else {
        SoundManager.playWarning();
        setToast(result.reason ?? 'Cannot place here.');
      }

    } else if (mode === 'connect_pipe' && clickedUnit) {
      const OUT_TYPES = ['outlet', 'sludge_outlet', 'gas_outlet', 'recycle_outlet'];

      // Helper: cycle through a unit's output ports (real plants have several:
      // main outlet, sludge underflow, gas line, recycle…)
      const pickOutPort = (unit: PlacedUnit, preferId?: string | null) => {
        const fd = UNIT_DEFINITIONS[unit.typeId];
        const outs = fd.ports.filter(p => OUT_TYPES.includes(p.type));
        if (outs.length === 0) return null;
        if (preferId) {
          const idx = outs.findIndex(p => p.id === preferId);
          if (idx >= 0 && idx < outs.length - 1) return outs[idx + 1]; // cycle forward
        }
        return outs[0];
      };

      if (!srcId) {
        const fp = pickOutPort(clickedUnit);
        if (!fp) {
          SoundManager.playWarning();
          setToast(`${UNIT_DEFINITIONS[clickedUnit.typeId]?.name ?? clickedUnit.typeId} has no output port — it cannot feed other units.`);
          return;
        }
        setPipeSourceId(clickedUnit.instanceId);
        pipeSourcePortRef.current = fp.id;
        pipeSourcePosRef.current = getPortWorldPosition(clickedUnit, fp.id);
        sm.setPipeSourceHighlight(clickedUnit.instanceId, gs.units);
        SoundManager.playClick();
        setToast(`Piping FROM ${UNIT_DEFINITIONS[clickedUnit.typeId]?.name} [${fp.name}]. Click another unit to connect — click the SAME unit to switch its output port.`);
      } else if (srcId !== clickedUnit.instanceId) {
        const fromUnit = gs.units.find(u => u.instanceId === srcId);
        const toUnit   = clickedUnit;
        if (fromUnit && toUnit) {
          const fd = UNIT_DEFINITIONS[fromUnit.typeId];
          const td = UNIT_DEFINITIONS[toUnit.typeId];
          const fp = fd.ports.find(p => p.id === (pipeSourcePortRef.current ?? '')) ?? pickOutPort(fromUnit);
          // Target port: sludge lines look for any inlet; RAS prefers ras_inlet
          const tp = td.ports.find(p => p.type === 'inlet' || p.type === 'ras_inlet');
          if (!fp || !tp) {
            SoundManager.playWarning();
            setToast(!fp ? `${fd.name} has no output port to pipe from.` : `${td.name} has no inlet port.`);
          } else if (isConnectionExisting(gs.pipes, fromUnit.instanceId, fp.id, toUnit.instanceId, tp.id)) {
            // TOGGLE: reconnecting the exact same ports removes the pipe —
            // the player's full manual control over routing mistakes.
            const remaining = gs.pipes.filter(p =>
              !(p.fromUnitId === fromUnit.instanceId && p.fromPortId === fp.id &&
                p.toUnitId === toUnit.instanceId && p.toPortId === tp.id)
            );
            pushHistory(gs);
            SoundManager.playDemolish();
            setGameState(prev => ({ ...prev, pipes: remaining }));
            sm.syncPipes(remaining);
            setToast(`Pipe removed: ${fd.name} [${fp.name}] ➔ ${td.name}. Re-route as needed. (Ctrl+Z to undo)`);
            setPipeSourceId(null);
            pipeSourcePortRef.current = null;
            pipeSourcePosRef.current = null;
            sm.setPipeSourceHighlight(null, gs.units);
            sm.setPipePreview(null, null);
          } else {
            const path = generatePipePath(getPortWorldPosition(fromUnit, fp.id), getPortWorldPosition(toUnit, tp.id));
            const newPipe: PipeConnection = {
              id: `pipe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              fromUnitId: fromUnit.instanceId, fromPortId: fp.id,
              toUnitId:   toUnit.instanceId,   toPortId:   tp.id,
              pathPoints: path,
              flowRate: fromUnit.lastOutletQuality?.flowRate ?? 0,
              quality:  fromUnit.lastOutletQuality ?? fromUnit.lastInletQuality,
              pipeType: fp.type === 'sludge_outlet' ? 'sludge' : (fp.type === 'gas_outlet' ? 'gas' : 'liquid'),
            };
            pushHistory(gs);
            SoundManager.playConnect();
            const updatedPipes = [...gs.pipes, newPipe];
            setGameState(prev => ({ ...prev, pipes: updatedPipes }));
            sm.syncPipes(updatedPipes);
            setToast(`Connected: ${fd.name} [${fp.name}] ➔ ${td.name}.  (Ctrl+Z to undo)`);
            // Fresh selection for the next connection — no surprising chaining
            setPipeSourceId(null);
            pipeSourcePortRef.current = null;
            pipeSourcePosRef.current = null;
            sm.setPipeSourceHighlight(null, gs.units);
            sm.setPipePreview(null, null);
          }
        }
      } else {
        // Same unit clicked → cycle its output port
        const fp = pickOutPort(clickedUnit, pipeSourcePortRef.current);
        if (fp) {
          pipeSourcePortRef.current = fp.id;
          SoundManager.playClick();
          setToast(`Output switched to [${fp.name}]. Click a target unit to connect.`);
        }
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
          sceneRef.current.setDayNight(next.isNight);
        }
        return next;
      });
    }, TICK_MS);
    return () => {
      if (simIntervalRef.current) clearInterval(simIntervalRef.current);
    };
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
          setToolMode(m => (m === 'connect_pipe' ? 'select' : 'connect_pipe'));
          setSelectedUnitTypeId(null);
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
            setToolMode('select');
            setSelectedUnitTypeId(null);
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
      // Fallback: hand placement mode
      setSelectedUnitTypeId(typeId);
      setToolMode('place_unit');
      setOperatorOpen(false);
      setToast(`${def.name} selected ($${def.capex.toLocaleString()}) — click a free spot on the grid.`);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL CHANGE
  // ─────────────────────────────────────────────────────────────────────────────
  const handleSelectLevel = useCallback((levelIndex: number, isSandbox: boolean) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    const next = GameManager.createInitialState(levelIndex, isSandbox);
    setGameState(next);
    if (sceneRef.current) {
      const [w, d] = next.currentLevel.mapSize;
      sceneRef.current.setEnvironment(next.currentLevel.biome);
      sceneRef.current.terrainGrid.updateSize(w, d, next.currentLevel.biome);
      sceneRef.current.updateShadowBounds(w, d);
      sceneRef.current.cameraController.resetView(w, d);
      sceneRef.current.syncUnits(next.units);
      sceneRef.current.syncPipes(next.pipes);
      if (next.suggestion) {
        sceneRef.current.showNextStepGhost(next.suggestion.unitTypeId, next.suggestion.gridX, next.suggestion.gridY);
      }
    }
    setIsTopDown(false);
    setToast(`Stage loaded: ${next.currentLevel.title}`);
  }, []);

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

      {/* ── Toast Banner ──────────────────────────────────────────────────── */}
      {toast && (
        <div className="absolute top-[60px] left-1/2 -translate-x-1/2 z-30 pointer-events-none
                        px-4 py-2 rounded-xl bg-slate-900/95 backdrop-blur border border-cyan-500/40
                        text-cyan-300 text-xs font-mono shadow-2xl flex items-center gap-2 max-w-[90vw] animate-in fade-in slide-in-from-top-2 duration-150">
          <Info size={14} className="text-cyan-400 shrink-0" />
          <span>{toast}</span>
          {toolMode === 'place_unit' && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold border border-amber-500/30">
              R = rotate
            </span>
          )}
        </div>
      )}

      {/* ── Piping control legend (visible in Pipes mode) ──────────────────── */}
      {toolMode === 'connect_pipe' && (
        <div className="absolute bottom-[152px] left-1/2 -translate-x-1/2 z-30 pointer-events-none
                        px-4 py-1.5 rounded-xl bg-slate-900/95 backdrop-blur border border-cyan-500/40
                        shadow-2xl flex items-center gap-3 text-[10px] font-mono text-slate-300 whitespace-nowrap">
          <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-bold border border-sky-500/30">PIPES</span>
          <span><b className="text-slate-100">LMB</b> unit A → unit B: connect</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-slate-100">LMB same unit</b>: switch output port</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-slate-100">LMB again</b>: remove pipe</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-rose-300">RMB</b>: cancel</span>
          <span className="text-slate-600">|</span>
          <span><b className="text-slate-100">Ctrl+Z</b> undo · <b className="text-slate-100">Ctrl+Y</b> redo</span>
        </div>
      )}

      {/* ── Camera Controls Widget (bottom-right) ─────────────────────────── */}
      <div className="absolute bottom-28 right-3 z-30 flex flex-col items-center gap-1
                      bg-slate-900/90 backdrop-blur border border-slate-700 rounded-2xl p-2 shadow-2xl
                      text-slate-300 text-xs select-none">
        <span className="text-[9px] font-mono uppercase text-slate-400 font-bold tracking-widest">Camera</span>
        
        {/* Orbit/Tilt grid */}
        <div className="grid grid-cols-3 gap-0.5 mt-0.5">
          <div />
          <button onClick={() => sceneRef.current?.cameraController.tiltUp()}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 hover:text-white transition-colors" title="Tilt up">
            <ChevronUp size={13} />
          </button>
          <div />
          <button onClick={() => sceneRef.current?.cameraController.rotateLeft()}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 hover:text-white transition-colors" title="Orbit left">
            <RotateCcw size={13} />
          </button>
          <button onClick={() => {
            const [w, d] = gameState.currentLevel.mapSize;
            sceneRef.current?.cameraController.resetView(w, d);
            setIsTopDown(false);
          }}
            className="p-2 rounded-lg bg-sky-600/30 text-sky-300 hover:bg-sky-600/50 transition-colors" title="Reset view">
            <Compass size={13} />
          </button>
          <button onClick={() => sceneRef.current?.cameraController.rotateRight()}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 hover:text-white transition-colors" title="Orbit right">
            <RotateCw size={13} />
          </button>
          <div />
          <button onClick={() => sceneRef.current?.cameraController.tiltDown()}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 hover:text-white transition-colors" title="Tilt down">
            <ChevronDown size={13} />
          </button>
          <div />
        </div>

        {/* Zoom */}
        <div className="flex gap-1 w-full pt-1 border-t border-slate-800">
          <button onClick={() => sceneRef.current?.cameraController.zoomIn()}
            className="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors flex items-center justify-center" title="Zoom in">
            <ZoomIn size={13} />
          </button>
          <button onClick={() => sceneRef.current?.cameraController.zoomOut()}
            className="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors flex items-center justify-center" title="Zoom out">
            <ZoomOut size={13} />
          </button>
        </div>
      </div>

      {/* ── Header HUD ──────────────────────────────────────────────────────── */}
      <HeaderHUD
        gameState={gameState}
        onSetSpeed={s => setGameState(prev => ({ ...prev, simSpeed: s }))}
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
          setToolMode(mode);
          setPipeSourceId(null);
          pipeSourcePortRef.current = null;
          sceneRef.current?.setPipeSourceHighlight(null, gameState.units);
          if (mode === 'select')       setToast('Inspect Mode: Click any tank to configure parameters.');
          if (mode === 'connect_pipe') setToast('Pipes: LEFT-CLICK a unit → click the destination. Click the SAME unit to switch its output port. RIGHT-CLICK to cancel. Ctrl+Z undo / Ctrl+Y redo.');
          if (mode === 'demolish')     setToast('Demolish Mode: Click any unit to remove for 70% cash refund.');
          if (mode === 'place_unit')   setToast('Choose a unit type below, then click on the grid to place.');
        }}
        selectedUnitTypeId={selectedUnitTypeId}
        onSelectUnitTypeId={id => {
          setSelectedUnitTypeId(id);
          setToolMode('place_unit');
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
        />
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {pfdModal && (
        <PlantFlowDiagram gameState={gameState} onClose={() => setPfdModal(false)} />
      )}
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
          onUnlockTech={id => setGameState(prev => GameManager.unlockTech(prev, id))}
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
          onNextLevel={() => {
            const idx = (CAMPAIGN_LEVELS.findIndex(l => l.id === gameState.currentLevel.id) + 1) % CAMPAIGN_LEVELS.length;
            handleSelectLevel(idx, false);
            setGameState(prev => ({ ...prev, levelVictoryModalOpen: false }));
          }}
          onContinuePlaying={() => setGameState(prev => ({ ...prev, levelVictoryModalOpen: false }))}
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
            setSelectedUnitTypeId(typeId);
            setToolMode('place_unit');
            const sug = gsRef.current.suggestion;
            if (sug) sceneRef.current?.cameraController.focusOn(sug.gridX, sug.gridY);
            setToast(`${UNIT_DEFINITIONS[typeId].name} selected — click the glowing green lot!`);
          }}
        />
      )}
    </div>
  );
};
