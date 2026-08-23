import React, { useMemo } from 'react';
import {
  X, Activity, Wrench, Hammer, CheckCircle2, AlertTriangle,
  Sparkles, Droplets, ArrowRight
} from 'lucide-react';
import { GameState } from '../gameplay/GameManager';
import { Advisory, FixAction, generateAdvisories, getInfluent } from '../sim/AdvisoryEngine';
import { SoundManager } from '../audio/SoundManager';

interface OperatorConsoleProps {
  gameState: GameState;
  onClose: () => void;
  onApplyFix: (fix: FixAction) => void;
}

interface RowSpec {
  key: string;
  label: string;
  unit: string;
  value: number;
  limit: number | null;
  minLimit?: number | null;
  maxLimit?: number | null;
  influent: number;
  decimals: number;
  hint: string;
}

const fmt = (n: number, d: number) =>
  n >= 1_000_000 ? n.toExponential(1) : n.toLocaleString(undefined, { maximumFractionDigits: d });

export const OperatorConsole: React.FC<OperatorConsoleProps> = ({ gameState, onClose, onApplyFix }) => {
  const advisories = useMemo(() => generateAdvisories(gameState), [gameState]);
  const { finalEffluent: eff, currentLevel } = gameState;
  const inf = getInfluent(gameState);
  const std = currentLevel.standards;

  const rows: RowSpec[] = [
    { key: 'bod', label: 'BOD', unit: 'mg/L', value: eff.bod, limit: std.maxBod, influent: inf.bod, decimals: 1, hint: 'Organic pollution bacteria must digest' },
    { key: 'cod', label: 'COD', unit: 'mg/L', value: eff.cod, limit: std.maxCod, influent: inf.cod, decimals: 0, hint: 'Total organic chemistry load' },
    { key: 'tss', label: 'TSS', unit: 'mg/L', value: eff.tss, limit: std.maxTss, influent: inf.tss, decimals: 1, hint: 'Suspended particles — cloudiness' },
    { key: 'tn', label: 'Nitrogen', unit: 'mg/L', value: eff.tn, limit: std.maxTn, influent: inf.tn, decimals: 1, hint: 'Causes algae blooms & fish kills' },
    { key: 'nh4', label: 'Ammonia', unit: 'mg/L', value: eff.nh4, limit: std.maxNh4, influent: inf.nh4, decimals: 1, hint: 'Toxic to aquatic life' },
    { key: 'tp', label: 'Phosphorus', unit: 'mg/L', value: eff.tp, limit: std.maxTp, influent: inf.tp, decimals: 2, hint: 'Feeds algal blooms' },
    { key: 'pathogens', label: 'Pathogens', unit: 'CFU', value: eff.pathogens, limit: Math.max(1, std.maxPathogens), influent: inf.pathogens, decimals: 0, hint: 'Disease-causing microbes' },
    { key: 'do', label: 'Oxygen (DO)', unit: 'mg/L', value: eff.do, limit: std.minDo, influent: inf.do, decimals: 1, hint: 'River life needs oxygen — higher is better', },
    { key: 'ph', label: 'pH balance', unit: '', value: eff.ph, limit: null, minLimit: std.minPh, maxLimit: std.maxPh, influent: inf.ph, decimals: 1, hint: 'Acidity/alkalinity of the discharge' },
  ];

  const passCount = rows.filter(r => rowPass(r)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900/90 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${advisories.length === 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
              <Activity size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Operator Console</h2>
              <p className="text-xs text-slate-400 font-mono">
                {advisories.length === 0
                  ? 'All water quality targets met — plant running cleanly'
                  : `${passCount}/${rows.length} parameters passing • ${advisories.length} issue${advisories.length > 1 ? 's' : ''} to fix`}
              </p>
            </div>
          </div>
          <button onClick={() => { SoundManager.playClick(); onClose(); }}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5 overflow-y-auto scrollbar-thin">

          {/* ── Water Quality Report ────────────────────────────── */}
          <div className="rounded-xl border border-slate-800 overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-900/80 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono flex items-center gap-2">
                <Droplets size={13} className="text-cyan-400" /> Water Quality Report
              </span>
              <span className="text-[10px] text-slate-500 font-mono">measured at the outfall</span>
            </div>
            <div className="divide-y divide-slate-800/60">
              {rows.map(r => <ReportRow key={r.key} row={r} />)}
            </div>
          </div>

          {/* ── Advisories / Fixes ──────────────────────────────── */}
          {advisories.length > 0 ? (
            <div className="flex flex-col gap-3">
              <span className="text-xs font-bold uppercase tracking-wider text-amber-300 font-mono flex items-center gap-2 px-1">
                <Wrench size={13} /> Recommended Actions
              </span>
              {advisories.map(a => (
                <AdvisoryCard key={a.id} advisory={a} onApplyFix={onApplyFix} />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-950/40 border border-emerald-500/40">
              <CheckCircle2 size={22} className="text-emerald-400 shrink-0" />
              <div>
                <div className="text-sm font-bold text-emerald-300">Full Compliance!</div>
                <div className="text-xs text-slate-300">
                  Every parameter is inside its legal limit. Keep units maintained and watch for shock loads.
                </div>
              </div>
            </div>
          )}

          <p className="text-[11px] text-slate-500 font-mono text-center pt-1">
            Tip: click any tank with the Inspect tool to hand-tune every engineering parameter yourself.
          </p>
        </div>
      </div>
    </div>
  );
};

function rowPass(r: RowSpec): boolean {
  if (r.key === 'ph') {
    return r.value >= (r.minLimit ?? 0) && r.value <= (r.maxLimit ?? 14);
  }
  if (r.limit === null) return true;
  return r.key === 'do' ? r.value >= r.limit : r.value <= r.limit;
}

const ReportRow: React.FC<{ row: RowSpec }> = ({ row }) => {
  const pass = rowPass(row);
  const isMin = row.key === 'do';
  const isPh = row.key === 'ph';

  let pct: number;
  if (isPh) {
    const lo = row.minLimit ?? 6, hi = row.maxLimit ?? 9;
    pct = Math.min(100, Math.max(2, ((row.value - lo) / (hi - lo)) * 100));
  } else if (row.limit !== null && row.limit > 0) {
    pct = isMin
      ? Math.min(100, (row.value / row.limit) * 60)
      : Math.min(100, Math.max(3, (row.value / row.limit) * 70));
  } else {
    pct = 50;
  }

  const barColor = pass ? 'bg-emerald-400' : 'bg-rose-400';

  return (
    <div className="px-4 py-2.5 flex items-center gap-3 bg-slate-900/40 hover:bg-slate-900/70 transition">
      <div className="w-24 shrink-0">
        <div className="text-xs font-bold text-slate-200">{row.label}</div>
        <div className="text-[10px] text-slate-500 truncate" title={row.hint}>{row.hint}</div>
      </div>

      <div className="flex-1 h-2 rounded-full bg-slate-800 relative overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>

      <div className="w-36 text-right shrink-0 font-mono text-[11px] leading-tight">
        <span className={pass ? 'text-emerald-300 font-bold' : 'text-rose-300 font-bold'}>
          {fmt(row.value, row.decimals)}{row.unit ? ` ${row.unit}` : ''}
        </span>
        <span className="text-slate-500">
          {' / '}
          {isPh
            ? `${row.minLimit}–${row.maxLimit}`
            : `${isMin ? '≥' : '≤'} ${fmt(row.limit ?? 0, row.decimals)}`}
        </span>
      </div>

      <span className={`shrink-0 w-12 text-center text-[9px] font-bold py-0.5 rounded ${pass ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
        {pass ? 'PASS' : 'FAIL'}
      </span>
    </div>
  );
};

const AdvisoryCard: React.FC<{
  advisory: Advisory;
  onApplyFix: (fix: FixAction) => void;
}> = ({ advisory, onApplyFix }) => {
  const critical = advisory.severity === 'critical';
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-2.5 ${
      critical ? 'bg-rose-950/30 border-rose-500/40' : 'bg-amber-950/25 border-amber-500/35'
    }`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className={`${critical ? 'text-rose-400' : 'text-amber-400'} shrink-0 mt-0.5`} />
        <div>
          <div className="text-sm font-bold text-slate-100">{advisory.title}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{advisory.cause}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pl-6">
        {advisory.fixes.map((f, i) => (
          <button
            key={i}
            disabled={!f.affordable}
            onClick={() => { SoundManager.playClick(); onApplyFix(f); }}
            className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
              !f.affordable
                ? 'opacity-40 cursor-not-allowed bg-slate-900 border-slate-700 text-slate-500'
                : f.kind === 'build_unit'
                ? 'bg-purple-500/15 hover:bg-purple-500/30 border-purple-500/40 text-purple-200'
                : f.kind === 'auto_pipe'
                ? 'bg-cyan-500/15 hover:bg-cyan-500/30 border-cyan-500/40 text-cyan-200'
                : 'bg-sky-500/15 hover:bg-sky-500/30 border-sky-500/40 text-sky-200'
            }`}
            title={f.detail}
          >
            {f.kind === 'build_unit' ? <Hammer size={12} /> : f.kind === 'auto_pipe' ? <Sparkles size={12} /> : <Activity size={12} />}
            <span>{f.label}</span>
            {f.prediction && (
              <span className="font-mono text-[10px] opacity-80 group-hover:opacity-100 flex items-center gap-0.5">
                <ArrowRight size={9} /> {f.prediction}
              </span>
            )}
          </button>
        ))}
      </div>
      {advisory.fixes.some(f => !f.affordable) && (
        <div className="text-[10px] text-slate-500 font-mono pl-6">Greyed-out actions need more cash or unlocked tech.</div>
      )}
    </div>
  );
};
