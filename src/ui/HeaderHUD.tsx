import React, { useState } from 'react';
import { 
  Play, Pause, FastForward, DollarSign, Zap, Flame, 
  Award, ShieldAlert, BookOpen, GitBranch, Map, 
  Volume2, VolumeX, Sliders, CheckCircle2, ChevronDown, ChevronUp 
} from 'lucide-react';
import { GameState } from '../gameplay/GameManager';
import { SimulationSpeed } from '../types/game';
import { SoundManager } from '../audio/SoundManager';

interface HeaderHUDProps {
  gameState: GameState;
  onSetSpeed: (speed: SimulationSpeed) => void;
  onOpenLevelModal: () => void;
  onOpenTechTree: () => void;
  onOpenPFD: () => void;
  onOpenGuide: () => void;
  onOpenSandboxControls: () => void;
  onToggleTopDown: () => void;
  isTopDown: boolean;
}

export const HeaderHUD: React.FC<HeaderHUDProps> = ({
  gameState,
  onSetSpeed,
  onOpenLevelModal,
  onOpenTechTree,
  onOpenPFD,
  onOpenGuide,
  onOpenSandboxControls,
  onToggleTopDown,
  isTopDown
}) => {
  const [isMuted, setIsMuted] = useState(false);
  const [showObjectives, setShowObjectives] = useState(false);

  const { financials, overallStats, currentLevel, simSpeed, gameTimeDays, gameMode } = gameState;

  const toggleMute = () => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    SoundManager.setMuted(nextMute);
    if (!nextMute) SoundManager.playClick();
  };

  const dayNumber = Math.floor(gameTimeDays) + 1;
  const hourNumber = Math.floor((gameTimeDays % 1) * 24);

  return (
    <header className="absolute top-0 left-0 right-0 z-20 flex flex-col pointer-events-none">
      {/* Top Navbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-cyber-card/90 backdrop-blur-md border-b border-slate-700/60 shadow-xl pointer-events-auto">
        
        {/* Left: Brand & Level Badge */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl animate-pulse">💧</span>
            <div>
              <h1 className="text-base font-extrabold tracking-wider bg-gradient-to-r from-sky-400 via-cyan-300 to-teal-400 bg-clip-text text-transparent">
                AQUATYCOON 3D
              </h1>
              <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5">
                <span className="text-cyan-400 font-bold">{currentLevel.code}: {currentLevel.title}</span>
                <span className="text-slate-500">•</span>
                <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 text-[9px] uppercase tracking-wide">
                  {gameMode === 'sandbox' ? 'Sandbox Mode' : currentLevel.difficulty}
                </span>
              </div>
            </div>
          </div>

          <button
            onClick={() => { SoundManager.playClick(); onOpenLevelModal(); }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 hover:bg-sky-500/20 transition"
          >
            <Map size={13} />
            <span>Stages</span>
          </button>
        </div>

        {/* Center: Financials, Compliance & Energy */}
        <div className="flex items-center gap-5">
          {/* Cash & Daily Profit */}
          <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-slate-900/80 border border-slate-700/80">
            <div className="p-1 rounded bg-emerald-500/20 text-emerald-400">
              <DollarSign size={16} />
            </div>
            <div>
              <div className="text-xs font-bold font-mono text-emerald-400">
                ${Math.round(financials.cash).toLocaleString()}
              </div>
              <div className={`text-[10px] font-mono ${financials.netDailyProfit >= 0 ? 'text-emerald-300' : 'text-rose-400'}`}>
                {financials.netDailyProfit >= 0 ? '+' : ''}${Math.round(financials.netDailyProfit).toLocaleString()}/day
              </div>
            </div>
          </div>

          {/* Compliance Score */}
          <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-slate-900/80 border border-slate-700/80">
            <div className={`p-1 rounded ${overallStats.complianceScore >= 80 ? 'bg-cyan-500/20 text-cyan-400' : 'bg-rose-500/20 text-rose-400'}`}>
              <Award size={16} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold font-mono text-slate-100">
                  {overallStats.complianceScore}%
                </span>
                <span className={`text-[9px] px-1 rounded font-bold uppercase ${overallStats.complianceScore >= 80 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                  {overallStats.complianceScore >= 80 ? 'Compliant' : 'Violation'}
                </span>
              </div>
              <div className="text-[10px] text-slate-400 font-mono">EPA Regulatory</div>
            </div>
          </div>

          {/* Power Demand & Biogas Generation */}
          <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-slate-900/80 border border-slate-700/80">
            <div className="p-1 rounded bg-amber-500/20 text-amber-400">
              <Zap size={16} />
            </div>
            <div>
              <div className="text-xs font-bold font-mono text-amber-300 flex items-center gap-1">
                <span>{overallStats.totalPowerDemandKw.toFixed(0)} kW</span>
                {overallStats.totalBiogasGenerationKw > 0 && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-0.5">
                    <Flame size={10} /> +{overallStats.totalBiogasGenerationKw.toFixed(0)}kW
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 font-mono">
                {overallStats.energySelfSufficiencyPercent > 0 
                  ? `${overallStats.energySelfSufficiencyPercent.toFixed(0)}% Green Self-Power` 
                  : 'Grid Powered'}
              </div>
            </div>
          </div>

          {/* Time & Day Clock */}
          <div className="flex flex-col items-center px-2 py-0.5 font-mono text-slate-300">
            <div className="text-xs font-bold text-sky-400">
              Day {dayNumber} • {hourNumber.toString().padStart(2, '0')}:00
            </div>
            <div className="text-[9px] text-slate-400">
              {gameState.isNight ? '🌙 Night Shift' : '☀️ Day Shift'}
            </div>
          </div>
        </div>

        {/* Right: Controls & Navigation Tools */}
        <div className="flex items-center gap-2">
          {/* Speed Controls */}
          <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-700">
            <button
              onClick={() => onSetSpeed(0)}
              className={`p-1.5 rounded transition ${simSpeed === 0 ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'}`}
              title="Pause Simulation"
            >
              <Pause size={13} />
            </button>
            <button
              onClick={() => onSetSpeed(1)}
              className={`p-1.5 rounded transition ${simSpeed === 1 ? 'bg-sky-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'}`}
              title="1x Normal Speed"
            >
              <Play size={13} />
            </button>
            <button
              onClick={() => onSetSpeed(2)}
              className={`p-1.5 rounded transition ${simSpeed === 2 ? 'bg-sky-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'}`}
              title="2x Fast Forward"
            >
              <FastForward size={13} />
            </button>
            <button
              onClick={() => onSetSpeed(5)}
              className={`px-1.5 py-1 text-xs font-mono rounded transition ${simSpeed === 5 ? 'bg-cyan-400 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'}`}
              title="5x Ultra Speed"
            >
              5x
            </button>
          </div>

          {/* Action Modals */}
          <button
            onClick={() => { SoundManager.playClick(); onOpenPFD(); }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-300 hover:bg-teal-500/20 transition"
            title="Open Process Flow Diagram (PFD / P&ID)"
          >
            <GitBranch size={13} />
            <span>Flowsheet</span>
          </button>

          <button
            onClick={() => { SoundManager.playClick(); onOpenTechTree(); }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-300 hover:bg-purple-500/20 transition"
            title="Open Technology Research Tree"
          >
            <Zap size={13} />
            <span>Tech Tree</span>
          </button>

          {gameMode === 'sandbox' && (
            <button
              onClick={() => { SoundManager.playClick(); onOpenSandboxControls(); }}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 transition"
              title="Custom Influent & Weather Control"
            >
              <Sliders size={13} />
              <span>Sandbox</span>
            </button>
          )}

          <button
            onClick={() => { SoundManager.playClick(); onOpenGuide(); }}
            className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-sky-300 hover:bg-slate-700 transition"
            title="Engineering Handbook & Guide"
          >
            <BookOpen size={14} />
          </button>

          <button
            onClick={() => { SoundManager.playClick(); onToggleTopDown(); }}
            className={`px-2 py-1 text-xs font-bold rounded-lg border transition ${isTopDown ? 'bg-cyan-500 text-slate-950 border-cyan-400' : 'bg-slate-800 border-slate-700 text-slate-300'}`}
            title="Toggle 2D Blueprint Schematic View"
          >
            {isTopDown ? '2D View' : '3D View'}
          </button>

          <button
            onClick={toggleMute}
            className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-sky-300 hover:bg-slate-700 transition"
            title={isMuted ? 'Unmute Audio' : 'Mute Audio'}
          >
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        </div>
      </div>

      {/* Sub-bar: Level Objectives Dropdown Pill */}
      <div className="self-center mt-2 pointer-events-auto">
        <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-xl shadow-lg px-3 py-1.5 flex flex-col">
          <button
            onClick={() => setShowObjectives(!showObjectives)}
            className="flex items-center gap-2 text-xs font-semibold text-sky-300 hover:text-sky-200 transition"
          >
            <Award size={13} className="text-amber-400" />
            <span>
              Level Goals ({currentLevel.objectives.filter(o => o.achieved).length}/{currentLevel.objectives.length} Met)
            </span>
            {showObjectives ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          {showObjectives && (
            <div className="mt-2 pt-2 border-t border-slate-800 flex flex-col gap-1.5 max-w-md">
              {currentLevel.objectives.map(obj => (
                <div key={obj.id} className="flex items-center gap-2 text-xs font-mono">
                  {obj.achieved ? (
                    <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                  ) : (
                    <div className="w-3 h-3 rounded-full border border-slate-600 shrink-0" />
                  )}
                  <span className={obj.achieved ? 'text-emerald-300 line-through' : 'text-slate-300'}>
                    {obj.description}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active Warning Alerts Banner */}
      {overallStats.activeAlerts.length > 0 && (
        <div className="self-center mt-2 pointer-events-auto">
          {overallStats.activeAlerts.slice(0, 1).map(alert => (
            <div
              key={alert.id}
              className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono shadow-md border ${
                alert.type === 'error'
                  ? 'bg-rose-950/80 text-rose-300 border-rose-500/50'
                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
              }`}
            >
              <ShieldAlert size={14} className={alert.type === 'error' ? 'text-rose-400' : 'text-emerald-400'} />
              <span>{alert.message}</span>
            </div>
          ))}
        </div>
      )}
    </header>
  );
};
