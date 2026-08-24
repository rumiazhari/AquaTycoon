import React from 'react';
import { X, Cable, CheckCircle2, GraduationCap, ChevronRight, Hammer } from 'lucide-react';
import { SoundManager } from '../audio/SoundManager';
import { EngineerMood, TutorialStep } from '../gameplay/TutorialSteps';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';

// ─────────────────────────────────────────────────────────────────────────────
// DR. RIO CLEARWATER — procedurally drawn cartoon site-engineer avatar.
// A hand-tuned SVG face (hard hat, safety vest, expressive moods) so the
// tutorial feels like a comical conversation with a real person.
// ─────────────────────────────────────────────────────────────────────────────
export const EngineerAvatar: React.FC<{ mood: EngineerMood; size?: number }> = ({ mood, size = 84 }) => (
  <svg width={size} height={size} viewBox="0 0 120 120" style={{ flexShrink: 0 }}>
    {/* backdrop */}
    <circle cx="60" cy="60" r="56" fill="#0c2340" />
    <circle cx="60" cy="60" r="56" fill="none" stroke="#164e63" strokeWidth="3" />

    {/* safety vest collar */}
    <path d="M30 120 L38 92 Q60 102 82 92 L90 120 Z" fill="#f97316" stroke="#c2410c" strokeWidth="2" />
    <path d="M34 106 Q60 116 86 106" fill="none" stroke="#facc15" strokeWidth="6" strokeLinecap="round" />

    {/* neck */}
    <rect x="52" y="80" width="16" height="14" rx="5" fill="#f0b98d" />

    {/* ears */}
    <circle cx="31" cy="58" r="5.5" fill="#ffd9b8" stroke="#caa27e" strokeWidth="1.5" />
    <circle cx="89" cy="58" r="5.5" fill="#ffd9b8" stroke="#caa27e" strokeWidth="1.5" />

    {/* face */}
    <circle cx="60" cy="58" r="29" fill="#ffd9b8" stroke="#caa27e" strokeWidth="2" />

    {/* blush */}
    <circle cx="43" cy="65" r="4.5" fill="#fb7185" opacity="0.45" />
    <circle cx="77" cy="65" r="4.5" fill="#fb7185" opacity="0.45" />

    {/* hard hat */}
    <path d="M33 44 Q36 20 60 19 Q84 20 87 44 Z" fill="#fbbf24" stroke="#b45309" strokeWidth="2.5" />
    <path d="M58 19 L62 19 L62 40 L58 40 Z" fill="#f59e0b" stroke="#b45309" strokeWidth="1.5" />
    <rect x="24" y="42" width="72" height="9" rx="4.5" fill="#f59e0b" stroke="#b45309" strokeWidth="2.5" />
    <path d="M40 26 Q50 21 60 21" fill="none" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" opacity="0.8" />

    {/* eyebrows */}
    {mood === 'thinking' ? (
      <>
        <path d="M41 46 q7 -5 13 -2" fill="none" stroke="#6b4423" strokeWidth="3" strokeLinecap="round" />
        <path d="M67 47 q7 -1 12 2" fill="none" stroke="#6b4423" strokeWidth="3" strokeLinecap="round" />
      </>
    ) : (
      <>
        <path d="M42 46 q6 -3 12 -1" fill="none" stroke="#6b4423" strokeWidth="3" strokeLinecap="round" />
        <path d="M66 45 q6 -2 12 1" fill="none" stroke="#6b4423" strokeWidth="3" strokeLinecap="round" />
      </>
    )}

    {/* eyes */}
    {mood === 'excited' ? (
      <>
        <path d="M48 53 l2 4 4 .5 -3 3 1 4 -4 -2 -4 2 1 -4 -3 -3 4 -.5 Z" fill="#facc15" stroke="#a16207" strokeWidth="1" />
        <path d="M72 53 l2 4 4 .5 -3 3 1 4 -4 -2 -4 2 1 -4 -3 -3 4 -.5 Z" fill="#facc15" stroke="#a16207" strokeWidth="1" />
      </>
    ) : mood === 'wink' ? (
      <>
        <circle cx="48" cy="55" r="3.4" fill="#1f2937" />
        <circle cx="49.2" cy="53.8" r="1.1" fill="#ffffff" />
        <path d="M66 56 q6 -5 12 0" fill="none" stroke="#1f2937" strokeWidth="3" strokeLinecap="round" />
      </>
    ) : mood === 'thinking' ? (
      <>
        <circle cx="48" cy="55" r="3.4" fill="#1f2937" />
        <circle cx="49.2" cy="53.8" r="1.1" fill="#ffffff" />
        <path d="M66 56 q6 3 12 0" fill="none" stroke="#1f2937" strokeWidth="3" strokeLinecap="round" />
        {/* sweat drop */}
        <path d="M92 44 q4 6 0 9 q-4 -3 0 -9" fill="#7dd3fc" stroke="#38bdf8" strokeWidth="1" />
      </>
    ) : (
      <>
        <circle cx="48" cy="55" r="3.4" fill="#1f2937" />
        <circle cx="49.2" cy="53.8" r="1.1" fill="#ffffff" />
        <circle cx="72" cy="55" r="3.4" fill="#1f2937" />
        <circle cx="73.2" cy="53.8" r="1.1" fill="#ffffff" />
      </>
    )}

    {/* nose */}
    <path d="M60 58 q3.5 4 -0.5 6.5" fill="none" stroke="#caa27e" strokeWidth="2.2" strokeLinecap="round" />

    {/* comical mustache */}
    <path d="M47 69 Q60 64.5 73 69 Q60 75 47 69 Z" fill="#8a5a3b" stroke="#6b4423" strokeWidth="1.2" />

    {/* mouth */}
    {mood === 'excited' ? (
      <>
        <ellipse cx="60" cy="77" rx="8" ry="5.5" fill="#7c2d12" />
        <ellipse cx="60" cy="79.5" rx="4" ry="2.2" fill="#f87171" />
      </>
    ) : mood === 'thinking' ? (
      <circle cx="63" cy="76" r="2.6" fill="#7c2d12" />
    ) : mood === 'wink' ? (
      <path d="M50 74.5 Q60 81 71 72.5" fill="none" stroke="#7c2d12" strokeWidth="3" strokeLinecap="round" />
    ) : (
      <path d="M49 73.5 Q60 83 71 73.5" fill="none" stroke="#7c2d12" strokeWidth="3" strokeLinecap="round" />
    )}
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP PROMPT — "Do you want the tutorial?"
// ─────────────────────────────────────────────────────────────────────────────
export const TutorialPromptModal: React.FC<{
  onAccept: () => void;
  onDecline: () => void;
}> = ({ onAccept, onDecline }) => (
  <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md animate-in fade-in duration-200">
    <div className="relative w-full max-w-lg bg-gradient-to-b from-slate-900 to-slate-950 border border-cyan-500/40 rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
      <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400" />
      <div className="p-6 flex flex-col items-center gap-4 text-center">
        <EngineerAvatar mood="happy" size={110} />
        <div>
          <h2 className="text-xl font-black text-slate-100">Welcome to AquaTycoon 3D!</h2>
          <p className="text-xs font-mono text-cyan-400 mt-1">DR. RIO CLEARWATER · SITE ENGINEER</p>
        </div>
        <p className="text-sm text-slate-300 leading-relaxed max-w-md">
          "Howdy, new hire! Want me to walk you through your very first treatment train —
          bar screen, grit chamber, clarifier and all the plumbing? It takes about three
          minutes, and the <span className="text-emerald-400 font-bold">training budget covers every build</span>."
        </p>
        <div className="flex flex-col sm:flex-row gap-2 w-full mt-1">
          <button
            onClick={() => { SoundManager.playClick(); onAccept(); }}
            className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition"
          >
            <GraduationCap size={17} />
            Yes — teach me, Doc!
          </button>
          <button
            onClick={() => { SoundManager.playClick(); onDecline(); }}
            className="flex-1 py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 font-semibold text-sm transition"
          >
            No thanks — I know everything!
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// IN-GAME COACH — speech-bubble overlay with cancel / skip controls
// ─────────────────────────────────────────────────────────────────────────────
export const TutorialCoach: React.FC<{
  step: TutorialStep;
  index: number;
  total: number;
  onCancel: () => void;
  onOpenPipes: () => void;
  onAdvance: () => void;
  onSelectUnit: (typeId: NonNullable<TutorialStep['unitTypeId']>) => void;
}> = ({ step, index, total, onCancel, onOpenPipes, onAdvance, onSelectUnit }) => (
  <div className="absolute left-3 bottom-[190px] z-40 max-w-sm pointer-events-auto animate-in fade-in slide-in-from-left-2 duration-200">
    <div className="flex items-end gap-2">
      <div className="animate-pulse">
        <EngineerAvatar mood={step.mood} size={78} />
      </div>
      <div className="flex-1 bg-slate-900/95 backdrop-blur-md border border-emerald-500/50 rounded-2xl rounded-bl-none p-3 shadow-2xl flex flex-col gap-2">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-black text-emerald-400 uppercase tracking-wider truncate">
              Dr. Rio Clearwater
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30 whitespace-nowrap">
              Step {index + 1}/{total}
            </span>
          </div>
          <button
            onClick={() => { SoundManager.playClick(); onCancel(); }}
            title="Cancel tutorial"
            className="p-1 rounded-lg bg-slate-800 hover:bg-rose-500/30 text-slate-400 hover:text-rose-300 transition shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* Speech */}
        <div>
          <div className="text-[11px] font-bold text-sky-300 font-mono mb-0.5">{step.title}</div>
          <p className="text-xs text-slate-200 leading-snug italic">"{step.line}"</p>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2">
          {/* Build steps: one-click select of the guided unit */}
          {step.unitTypeId && UNIT_DEFINITIONS[step.unitTypeId] && (
            <button
              onClick={() => { SoundManager.playClick(); onSelectUnit(step.unitTypeId!); }}
              className="flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500/30 to-teal-500/30 hover:from-emerald-500/50 hover:to-teal-500/50 border border-emerald-500/50 text-[11px] font-mono text-emerald-200 font-bold flex items-center justify-center gap-1.5 transition"
            >
              <Hammer size={12} />
              Build {UNIT_DEFINITIONS[step.unitTypeId].name}
            </button>
          )}
          {/* Info-only steps (welcome) advance with an explicit Next button */}
          {!step.unitTypeId && !step.requiresPipes && step.id !== 'graduation' && (
            <button
              onClick={() => { SoundManager.playClick(); onAdvance(); }}
              className="flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500/30 to-teal-500/30 hover:from-emerald-500/50 hover:to-teal-500/50 border border-emerald-500/50 text-[11px] font-mono text-emerald-200 font-bold flex items-center justify-center gap-1.5 transition"
            >
              Got it — next!
              <ChevronRight size={12} />
            </button>
          )}
          {step.requiresPipes && (
            <button
              onClick={() => { SoundManager.playClick(); onOpenPipes(); }}
              className="flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-teal-500/25 to-cyan-500/25 hover:from-teal-500/40 hover:to-cyan-500/40 border border-cyan-500/40 text-[11px] font-mono text-cyan-200 font-bold flex items-center justify-center gap-1.5 transition"
            >
              <Cable size={12} />
              Open Pipes Tool
            </button>
          )}
          {step.id === 'graduation' && (
            <button
              onClick={() => { SoundManager.playClick(); onCancel(); }}
              className="flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-[11px] font-bold text-slate-950 flex items-center justify-center gap-1.5 transition"
            >
              <CheckCircle2 size={12} />
              Finish Tutorial
            </button>
          )}
          {step.id !== 'graduation' && (
            <button
              onClick={() => { SoundManager.playClick(); onCancel(); }}
              className="py-1.5 px-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-slate-600/60 text-[10px] font-mono text-slate-400 hover:text-slate-200 whitespace-nowrap transition"
              title="Cancel tutorial"
            >
              Skip — I know everything!
            </button>
          )}
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1">
          {Array.from({ length: total }).map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= index ? 'bg-emerald-400' : 'bg-slate-700'}`}
            />
          ))}
        </div>
      </div>
    </div>
  </div>
);
