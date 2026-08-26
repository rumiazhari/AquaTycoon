import React, { useState } from 'react';
import {
  Play, Pause, FastForward, DollarSign, Zap,
  Map, Volume2, VolumeX,
  CheckCircle2, AlertTriangle, Menu, Gauge, GitBranch, Sliders
} from 'lucide-react';
import { GameState } from '../gameplay/GameManager';
import { SimulationSpeed } from '../types/game';
import { formatGameClock } from '../gameplay/GameTime';
import { SoundManager } from '../audio/SoundManager';
import { permitViolations, isPermitCompliant, PERMIT_LABEL } from '../sim/PermitEngine';

interface HeaderHUDProps {
  gameState: GameState;
  onSetSpeed: (speed: SimulationSpeed) => void;
  onOpenLevelModal: () => void;
  onOpenTechTree: () => void;
  onOpenPFD: () => void;
  onOpenSandboxControls: () => void;
  onOpenOperator: () => void;
  onToggleTopDown: () => void;
  isTopDown: boolean;
}

export const HeaderHUD: React.FC<HeaderHUDProps> = ({
  gameState,
  onSetSpeed,
  onOpenLevelModal,
  onOpenTechTree,
  onOpenPFD,
  onOpenSandboxControls,
  onOpenOperator,
  onToggleTopDown,
  isTopDown
}) => {
  const [isMuted, setIsMuted] = useState(false);
  const [showObjectives, setShowObjectives] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const { financials, overallStats, currentLevel, simSpeed, gameTimeDays, gameMode } = gameState;

  // Headline water-quality status — THE authoritative PermitEngine verdict
  // (same evaluator as the Operator Console, PFD table and victory logic).
  // Cheap: pure arithmetic over the already-computed final effluent.
  const hasOutfallFlow = gameState.finalEffluent.flowRate > 10;
  const violations = hasOutfallFlow
    ? permitViolations(gameState.finalEffluent, currentLevel.standards)
    : [];
  // No outfall flow means the permit is trivially un-met (nothing treated is
  // being discharged) — the chip must never show a false "WATER CLEAN ✓".
  const compliant =
    hasOutfallFlow &&
    isPermitCompliant(gameState.finalEffluent, currentLevel.standards) &&
    gameState.overallStats.complianceScore >= 80;

  const toggleMute = () => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    SoundManager.setMuted(nextMute);
    if (!nextMute) SoundManager.playClick();
  };

  const dayNumber = Math.floor(gameTimeDays) + 1;
  // True HH:MM from the simulated clock (item 16). React only re-renders at the
  // 500 ms simulation tick — never per animation frame.
  const clockText = formatGameClock(gameTimeDays);

  return (
    <header className="absolute top-0 left-0 right-0 z-20 flex flex-col items-center pointer-events-none">
      {/* Single simplified navbar */}
        <div className="w-full flex items-center justify-between px-4 py-2 bg-cyber-card/90 border-b border-slate-700/60 shadow-xl pointer-events-auto gap-x-3 gap-y-1 flex-wrap lg:flex-nowrap">

        {/* Left: Brand + money + day */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xl shrink-0">💧</span>
          <div className="hidden md:block shrink-0">
            <h1 className="text-sm font-extrabold tracking-wider bg-gradient-to-r from-sky-400 via-cyan-300 to-teal-400 bg-clip-text text-transparent leading-none">
              AQUATYCOON
            </h1>
            <div className="text-[9px] text-slate-400 font-mono">{currentLevel.code} • {currentLevel.title}</div>
          </div>

          <div
            className={`flex items-center gap-2 px-2.5 py-1 rounded-lg border ${financials.cash < 0 ? 'bg-rose-950/40 border-rose-500/50 animate-pulse' : 'bg-slate-900/80 border-slate-700/80'}`}
            title={
              financials.cash < 0
                ? `Overdraft $${Math.round(-financials.cash).toLocaleString()} debt — $${(financials.dailyFinancingCost ?? 0).toFixed(1)}/day interest at 18% APR. Restore positive cash to stop charges. Net $${Math.round(financials.netDailyProfit).toLocaleString()}/day.`
                : `Cash on hand — net $${Math.round(financials.netDailyProfit).toLocaleString()}/day (Revenue $${Math.round(financials.dailyRevenue).toLocaleString()} – OPEX $${Math.round(financials.dailyOpex).toLocaleString()}${(financials.dailyFinancingCost ?? 0) > 0 ? ` – Financing $${Math.round(financials.dailyFinancingCost).toLocaleString()}` : ''})`
            }
          >
            <DollarSign size={14} className={financials.cash < 0 ? 'text-rose-400 shrink-0' : 'text-emerald-400 shrink-0'} />
            <div className="leading-none">
              <div className={`text-xs font-bold font-mono ${financials.cash < 0 ? 'text-rose-300' : 'text-emerald-400'}`}>${Math.round(financials.cash).toLocaleString()}</div>
              {(financials.dailyFinancingCost ?? 0) > 0.5 ? (
                <div className="text-[9px] font-mono text-amber-400">
                  −${Math.round(financials.dailyFinancingCost).toLocaleString()}/d financing
                </div>
              ) : (
                <div className={`text-[9px] font-mono ${financials.netDailyProfit >= 0 ? 'text-emerald-300' : 'text-rose-400'}`}>
                  {financials.netDailyProfit >= 0 ? '+' : ''}${Math.round(financials.netDailyProfit).toLocaleString()}/day
                </div>
              )}
            </div>
          </div>

          <div className="hidden lg:block px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-700/80 font-mono">
            <div className="text-[11px] font-bold text-sky-300 leading-none">Day {dayNumber}</div>
            <div className="text-[9px] text-slate-400">{gameState.isNight ? '🌙 Night' : '☀️ Day'} {clockText}</div>
          </div>

          {/* Power system readout: demand vs on-site green generation */}
          <div
            className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-700/80"
            title={`Plant demand ${overallStats.totalPowerDemandKw.toFixed(0)} kW — green generation (biogas CHP + solar + wind) ${overallStats.totalGreenGenerationKw.toFixed(0)} kW — self-sufficiency ${overallStats.energySelfSufficiencyPercent.toFixed(0)}%`}
          >
            <Zap size={14} className={overallStats.totalGreenGenerationKw > 0 ? 'text-emerald-400 shrink-0' : 'text-amber-400 shrink-0'} />
            <div className="leading-none">
              <div className="text-[11px] font-bold font-mono text-amber-300">
                {overallStats.totalPowerDemandKw.toFixed(0)} kW
              </div>
              <div className={`text-[9px] font-mono ${overallStats.totalGreenGenerationKw > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                🌱 {overallStats.totalGreenGenerationKw.toFixed(0)} kW • {overallStats.energySelfSufficiencyPercent.toFixed(0)}% self
              </div>
            </div>
          </div>
        </div>

        {/* Center: WATER QUALITY — THE headline metric */}
        <button
          onClick={() => { SoundManager.playClick(); onOpenOperator(); }}
          title="Open Operator Console"
          className={`flex items-center gap-2 px-4 py-1.5 rounded-xl border shadow-lg transition-all hover:scale-[1.03] ${
            compliant
              ? 'bg-emerald-500/15 border-emerald-400/60 hover:bg-emerald-500/25'
              : 'bg-rose-500/15 border-rose-400/70 hover:bg-rose-500/25 animate-pulse'
          }`}
        >
          {compliant ? (
            <CheckCircle2 size={17} className="text-emerald-400" />
          ) : (
            <AlertTriangle size={17} className="text-rose-400" />
          )}
          <div className="text-left leading-tight">
            <div className={`text-xs font-extrabold font-mono ${compliant ? 'text-emerald-300' : 'text-rose-300'}`}>
              {compliant
                ? 'WATER CLEAN ✓'
                : !hasOutfallFlow
                ? 'NO OUTFALL FLOW'
                : `${violations.length} VIOLATION${violations.length > 1 ? 'S' : ''}`}
            </div>
            <div className="text-[9px] font-mono text-slate-400 hidden sm:block">
              {compliant
                ? 'All limits met'
                : !hasOutfallFlow
                ? 'No treated outfall flow'
                : `Exceeds: ${violations.slice(0, 3).map(v => PERMIT_LABEL[v.key]).join(', ')}${violations.length > 3 ? '…' : ''}`}
            </div>
          </div>
        </button>

        {/* Right: speed + more menu */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-700">
            <button onClick={() => onSetSpeed(0)}
              className={`p-1.5 rounded transition ${simSpeed === 0 ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'}`} title="Pause">
              <Pause size={13} />
            </button>
            <button onClick={() => onSetSpeed(1)}
              className={`p-1.5 rounded transition ${simSpeed === 1 ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'}`} title="Normal speed">
              <Play size={13} />
            </button>
            <button onClick={() => onSetSpeed(2)}
              className={`p-1.5 rounded transition ${simSpeed === 2 ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'}`} title="Fast forward">
              <FastForward size={13} />
            </button>
            <button onClick={() => onSetSpeed(5)}
              className={`px-1.5 py-1 text-xs font-mono rounded transition ${simSpeed === 5 ? 'bg-cyan-400 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'}`} title="Ultra speed">
              5x
            </button>
          </div>

          {/* Objectives quick pill */}
          <button
            onClick={() => setShowObjectives(!showObjectives)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-[11px] font-mono text-sky-300 hover:bg-slate-800 transition"
            title="Level objectives"
          >
            🎯 {currentLevel.objectives.filter(o => o.achieved).length}/{currentLevel.objectives.length}
          </button>

          {/* More menu */}
          <div className="relative">
            <button
              onClick={() => setMoreOpen(o => !o)}
              className={`p-2 rounded-lg border transition ${moreOpen ? 'bg-sky-600/30 border-sky-500/40 text-sky-200' : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'}`}
              title="More options"
            >
              <Menu size={15} />
            </button>

            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-52 z-50 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl p-1.5 flex flex-col pointer-events-auto">
                  {[
                    { icon: <Map size={14} />, label: 'Stages & Levels', action: onOpenLevelModal },
                    { icon: <GitBranch size={14} />, label: 'Flowsheet (PFD)', action: onOpenPFD },
                    { icon: <Gauge size={14} />, label: 'Tech Tree', action: onOpenTechTree },
                    ...(gameMode === 'sandbox'
                      ? [{ icon: <Sliders size={14} />, label: 'Sandbox Controls', action: onOpenSandboxControls }]
                      : []),
                  ].map(item => (
                    <button key={item.label}
                      onClick={() => { SoundManager.playClick(); setMoreOpen(false); item.action(); }}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 transition text-left">
                      <span className="text-slate-400">{item.icon}</span>{item.label}
                    </button>
                  ))}
                  <div className="my-1 border-t border-slate-800" />
                  <button
                    onClick={() => { SoundManager.playClick(); setMoreOpen(false); onToggleTopDown(); }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 transition text-left">
                    <span className="text-slate-400"><Gauge size={14} /></span>
                    Switch to {isTopDown ? '3D' : 'Blueprint'} View
                  </button>
                  <button
                    onClick={() => { toggleMute(); }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 transition text-left">
                    <span className="text-slate-400">{isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}</span>
                    Sound: {isMuted ? 'Off' : 'On'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Objectives dropdown */}
      {showObjectives && (
        <div className="mt-2 pointer-events-auto bg-slate-900 border border-slate-700/80 rounded-xl shadow-lg px-4 py-3 max-w-md mx-4">
          <div className="flex flex-col gap-1.5">
            {currentLevel.objectives.map(obj => (
              <div key={obj.id} className="flex items-center gap-2 text-xs font-mono">
                {obj.achieved
                  ? <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                  : <div className="w-3 h-3 rounded-full border border-slate-600 shrink-0" />}
                <span className={obj.achieved ? 'text-emerald-300 line-through' : 'text-slate-300'}>{obj.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  );
};
