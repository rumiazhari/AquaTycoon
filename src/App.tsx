import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SceneManager } from './graphics/SceneManager';
import { GameManager, GameState } from './gameplay/GameManager';
import { ToolMode } from './types/graphics';
import { PipeConnection, UnitTypeId } from './types/simulation';
import { UNIT_DEFINITIONS } from './sim/UnitProcessModels';
import { generatePipePath, getPortWorldPosition, isConnectionExisting } from './sim/PipeNetwork';
import { SoundManager } from './audio/SoundManager';
import { CAMPAIGN_LEVELS } from './gameplay/LevelsData';

// UI Components
import { HeaderHUD } from './ui/HeaderHUD';
import { BuildToolbar } from './ui/BuildToolbar';
import { UnitInspector } from './ui/UnitInspector';
import { PlantFlowDiagram } from './ui/PlantFlowDiagram';
import { LevelModal } from './ui/LevelModal';
import { TechTreeModal } from './ui/TechTreeModal';
import { SandboxControls } from './ui/SandboxControls';
import { TutorialGuideModal } from './ui/TutorialGuideModal';
import { VictoryModal } from './ui/VictoryModal';
import { NextStepGuide } from './ui/NextStepGuide';

import {
  ZoomIn, ZoomOut, RotateCcw, RotateCw,
  ChevronUp, ChevronDown, Compass, Wand2, Info
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
  const pipeSourceRef = useRef<string | null>(null);
  pipeSourceRef.current = pipeSourceId;

  // ── UI State ──────────────────────────────────────────────────────────────────
  const [toast, setToast]                     = useState('Welcome to AquaTycoon 3D! Follow the guide on the top-left or pick a unit below.');
  const [isTopDown, setIsTopDown]             = useState(false);
  const [levelModal, setLevelModal]           = useState(false);
  const [techModal, setTechModal]             = useState(false);
  const [pfdModal, setPfdModal]               = useState(false);
  const [guideModal, setGuideModal]           = useState(false);
  const [sandboxModal, setSandboxModal]       = useState(false);

  // ── Pointer tracking ─────────────────────────────────────────────────────────
  const pointerDown    = useRef(false);
  const pointerButton  = useRef(0);
  const pointerStart   = useRef({ x: 0, y: 0 });
  const pointerLast    = useRef({ x: 0, y: 0 });
  const pointerDist    = useRef(0);

  // ── Simulation interval ───────────────────────────────────────────────────────
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
          const inBounds = tile.x >= 0 && tile.y >= 0 && tile.x + fw <= mapW && tile.y + fl <= mapH;
          const overlaps = gsRef.current.units.some(u => {
            const ud = UNIT_DEFINITIONS[u.typeId];
            if (!ud) return false;
            const [uw, ul] = (u.rotation === 90 || u.rotation === 270) ? [ud.footprint[1], ud.footprint[0]] : ud.footprint;
            return tile.x < u.gridX + uw && tile.x + fw > u.gridX && tile.y < u.gridY + ul && tile.y + fl > u.gridY;
          });
          sm.terrainGrid.setGhostPreview(tile.x, tile.y, fw, fl, inBounds && !overlaps, true);
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
      pointerDown.current = false;

      // Only fire click action if user didn't drag
      if (!wasDrag) {
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
    const sm = sceneRef.current;
    if (!sm) return;

    const mode     = toolModeRef.current;
    const gs       = gsRef.current;
    const typeId   = selUnitTypeRef.current;
    const rotation = rotationRef.current;
    const srcId    = pipeSourceRef.current;

    const tile        = sm.getGridTileFromScreen(clientX, clientY);
    const clickedUnit = sm.getUnitAtScreen(clientX, clientY, gs.units);

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
      const result = GameManager.placeUnit(gs, typeId, tile.x, tile.y, rotation);
      if (result.success) {
        SoundManager.playPlace();
        setGameState(result.newState);
        sm.syncUnits(result.newState.units);
        if (result.newState.suggestion) {
          sm.showNextStepGhost(result.newState.suggestion.unitTypeId, result.newState.suggestion.gridX, result.newState.suggestion.gridY);
        } else {
          sm.showNextStepGhost(null, 0, 0);
        }
        const def = UNIT_DEFINITIONS[typeId];
        setToast(`Placed ${def.name}! Now connect pipes or continue adding units.`);
      } else {
        SoundManager.playWarning();
        setToast(result.reason ?? 'Cannot place here.');
      }

    } else if (mode === 'connect_pipe' && clickedUnit) {
      if (!srcId) {
        setPipeSourceId(clickedUnit.instanceId);
        sm.setPipeSourceHighlight(clickedUnit.instanceId, gs.units);
        SoundManager.playClick();
        setToast(`Selected ${UNIT_DEFINITIONS[clickedUnit.typeId]?.name}. Now click the target unit to link.`);
      } else if (srcId !== clickedUnit.instanceId) {
        const fromUnit = gs.units.find(u => u.instanceId === srcId);
        const toUnit   = clickedUnit;
        if (fromUnit && toUnit) {
          const fd = UNIT_DEFINITIONS[fromUnit.typeId];
          const td = UNIT_DEFINITIONS[toUnit.typeId];
          // BUG FIX: only source from genuine OUT ports — never fall back to an
          // inlet port (e.g. anaerobic digester has no plain outlet).
          const fp = fd.ports.find(p => p.type === 'outlet' || p.type === 'sludge_outlet' || p.type === 'gas_outlet' || p.type === 'recycle_outlet');
          const tp = td.ports.find(p => p.type === 'inlet'  || p.type === 'ras_inlet')  ?? td.ports[0];
          if (!fp || !tp) {
            SoundManager.playWarning();
            setToast(`${fd.name} has no output port to pipe from.`);
          } else if (!isConnectionExisting(gs.pipes, fromUnit.instanceId, fp.id, toUnit.instanceId, tp.id)) {
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
            SoundManager.playConnect();
            const updatedPipes = [...gs.pipes, newPipe];
            setGameState(prev => ({ ...prev, pipes: updatedPipes }));
            sm.syncPipes(updatedPipes);
            setToast(`Connected: ${fd.name} ➔ ${td.name}`);
          }
        }
        setPipeSourceId(null);
        sm.setPipeSourceHighlight(null, gs.units);
      } else {
        // Deselect if clicked same unit
        setPipeSourceId(null);
        sm.setPipeSourceHighlight(null, gs.units);
      }

    } else if (mode === 'connect_pipe' && !clickedUnit && srcId) {
      // UX FIX: clicking empty ground cancels the pending pipe source selection
      setPipeSourceId(null);
      sm.setPipeSourceHighlight(null, gs.units);
      setToast('Pipe link cancelled.');
    } else if (mode === 'demolish' && clickedUnit) {
      if (clickedUnit.typeId === 'influent_inlet' || clickedUnit.typeId === 'effluent_outfall') {
        SoundManager.playWarning();
        setToast('Inlet and Outfall cannot be removed.');
      } else {
        SoundManager.playDemolish();
        const next = GameManager.demolishUnit(gs, clickedUnit.instanceId);
        setGameState(next);
        sm.syncUnits(next.units);
        sm.syncPipes(next.pipes);
        if (next.suggestion) {
          sm.showNextStepGhost(next.suggestion.unitTypeId, next.suggestion.gridX, next.suggestion.gridY);
        }
        setToast('Unit demolished — 70% refund applied.');
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
  // KEYBOARD SHORTCUTS
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      const cam = sceneRef.current?.cameraController;
      switch (e.key) {
        case 'r': case 'R':
          setCurrentRotation(r => ((r + 90) % 360) as 0|90|180|270);
          SoundManager.playClick();
          setToast('Rotated placement direction.');
          break;
        case 'Escape':
          setToolMode('select');
          setSelectedUnitTypeId(null);
          setPipeSourceId(null);
          sceneRef.current?.setPipeSourceHighlight(null, gsRef.current.units);
          setGameState(prev => ({ ...prev, selectedUnitId: null }));
          setToast('Select mode — click a unit to inspect.');
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
  // AUTO-PIPING HELPER
  // ─────────────────────────────────────────────────────────────────────────────
  const handleAutoPipe = useCallback(() => {
    const gs = gsRef.current;
    if (gs.units.length < 2) return;
    const sorted = [...gs.units].sort((a, b) => a.gridX - b.gridX || a.gridY - b.gridY);
    const newPipes = [...gs.pipes];
    let count = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      const da = UNIT_DEFINITIONS[a.typeId], db = UNIT_DEFINITIONS[b.typeId];
      // BUG FIX: never auto-pipe FROM an inlet port; skip units without a real out port.
      const pa = da.ports.find(p => p.type === 'outlet' || p.type === 'sludge_outlet' || p.type === 'gas_outlet' || p.type === 'recycle_outlet');
      const pb = db.ports.find(p => p.type === 'inlet')  ?? db.ports[0];

      if (pa && pb && !isConnectionExisting(newPipes, a.instanceId, pa.id, b.instanceId, pb.id)) {
        const path = generatePipePath(getPortWorldPosition(a, pa.id), getPortWorldPosition(b, pb.id));
        newPipes.push({
          id: `pipe_auto_${Date.now()}_${i}`,
          fromUnitId: a.instanceId, fromPortId: pa.id,
          toUnitId:   b.instanceId, toPortId:   pb.id,
          pathPoints: path,
          flowRate: a.lastOutletQuality?.flowRate ?? 0,
          quality:  a.lastOutletQuality ?? a.lastInletQuality,
          pipeType: 'liquid',
        });
        count++;
      }
    }

    if (count > 0) {
      SoundManager.playConnect();
      setGameState(prev => ({ ...prev, pipes: newPipes }));
      sceneRef.current?.syncPipes(newPipes);
      setToast(`Auto-piping linked ${count} process stages!`);
    } else {
      setToast('All sequential treatment units are already piped.');
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // SELECT SUGGESTION HANDLER
  // ─────────────────────────────────────────────────────────────────────────────
  const handleSelectSuggestion = (typeId: UnitTypeId, gridX: number, gridY: number) => {
    setSelectedUnitTypeId(typeId);
    setToolMode('place_unit');
    sceneRef.current?.cameraController.focusOn(gridX, gridY);
    const def = UNIT_DEFINITIONS[typeId];
    setToast(`Selected: ${def.name} ($${def.capex.toLocaleString()}) — Click on the green lot to build!`);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL CHANGE
  // ─────────────────────────────────────────────────────────────────────────────
  const handleSelectLevel = useCallback((levelIndex: number, isSandbox: boolean) => {
    const next = GameManager.createInitialState(levelIndex, isSandbox);
    setGameState(next);
    if (sceneRef.current) {
      const [w, d] = next.currentLevel.mapSize;
      sceneRef.current.terrainGrid.updateSize(w, d);
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

      {/* ── Next Step Guide (Top-Left) ────────────────────────────────────── */}
      <NextStepGuide
        suggestion={gameState.suggestion}
        onSelectSuggestion={handleSelectSuggestion}
        onAutoPipe={handleAutoPipe}
        unitsCount={gameState.units.length}
        pipesCount={gameState.pipes.length}
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

        {/* Auto-pipe */}
        <button onClick={handleAutoPipe}
          className="w-full mt-0.5 py-1.5 rounded-xl text-[10px] font-mono font-bold
                     bg-gradient-to-r from-teal-600/20 to-cyan-600/20 hover:from-teal-600/40 hover:to-cyan-600/40
                     border border-cyan-500/30 text-cyan-300 flex items-center justify-center gap-1 transition-colors">
          <Wand2 size={11} />
          Auto-Pipe
        </button>
      </div>

      {/* ── Header HUD ──────────────────────────────────────────────────────── */}
      <HeaderHUD
        gameState={gameState}
        onSetSpeed={s => setGameState(prev => ({ ...prev, simSpeed: s }))}
        onOpenLevelModal={() => setLevelModal(true)}
        onOpenTechTree={() => setTechModal(true)}
        onOpenPFD={() => setPfdModal(true)}
        onOpenGuide={() => setGuideModal(true)}
        onOpenSandboxControls={() => setSandboxModal(true)}
        onToggleTopDown={handleToggleTopDown}
        isTopDown={isTopDown}
      />

      {/* ── Build Toolbar ────────────────────────────────────────────────────── */}
      <BuildToolbar
        toolMode={toolMode}
        onSetToolMode={mode => {
          setToolMode(mode);
          setPipeSourceId(null);
          sceneRef.current?.setPipeSourceHighlight(null, gameState.units);
          if (mode === 'select')       setToast('Inspect Mode: Click any tank to configure parameters.');
          if (mode === 'connect_pipe') setToast('Pipe Mode: Click unit A then unit B to connect pipe.');
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
      {guideModal && <TutorialGuideModal onClose={() => setGuideModal(false)} />}
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
    </div>
  );
};
