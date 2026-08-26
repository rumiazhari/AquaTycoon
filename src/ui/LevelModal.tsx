import React from 'react';
import { X, Map, ChevronRight, Play, Waves, Leaf, Factory, Trees, Sun } from 'lucide-react';
import { CAMPAIGN_LEVELS } from '../gameplay/LevelsData';
import { SoundManager } from '../audio/SoundManager';
import type { LevelBiome } from '../types/game';

interface LevelModalProps {
  currentLevelId: number;
  onSelectLevel: (levelIndex: number, isSandbox: boolean) => void;
  onClose: () => void;
}

type BiomeTheme = {
  gradient: string;
  border: string;
  ring: string;
  accent: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  envLabel: string;
  tag: string;
};

const BIOME_THEMES: Record<LevelBiome, BiomeTheme> = {
  coastal: {
    gradient: 'from-sky-600 via-cyan-500 to-teal-600',
    border: 'border-sky-500/30',
    ring: 'ring-sky-400/40',
    accent: 'text-sky-200 bg-sky-500/20 border-sky-400/40',
    icon: Waves,
    envLabel: 'Coastal bay  ·  Sandy beaches  ·  Tourist waterfront',
    tag: 'COASTAL',
  },
  farmland: {
    gradient: 'from-emerald-700 via-lime-600 to-amber-600',
    border: 'border-lime-500/30',
    ring: 'ring-lime-400/40',
    accent: 'text-lime-100 bg-lime-500/20 border-lime-400/40',
    icon: Leaf,
    envLabel: 'Rural farmland  ·  Brewery & dairy  ·  Crop belts & barns',
    tag: 'FARMLAND',
  },
  industrial: {
    gradient: 'from-zinc-700 via-slate-600 to-stone-700',
    border: 'border-amber-500/25',
    ring: 'ring-amber-400/30',
    accent: 'text-amber-100 bg-amber-500/15 border-amber-400/30',
    icon: Factory,
    envLabel: 'Chemical park  ·  Textile dyes  ·  Smokestacks & haze',
    tag: 'INDUSTRIAL',
  },
  lake_forest: {
    gradient: 'from-emerald-800 via-teal-600 to-cyan-700',
    border: 'border-emerald-500/30',
    ring: 'ring-emerald-400/40',
    accent: 'text-emerald-100 bg-emerald-500/20 border-emerald-400/40',
    icon: Trees,
    envLabel: 'Protected watershed  ·  Pine forest  ·  Emerald lake',
    tag: 'ECO-CITY',
  },
  desert: {
    gradient: 'from-amber-600 via-orange-500 to-yellow-600',
    border: 'border-amber-400/40',
    ring: 'ring-amber-400/40',
    accent: 'text-amber-950 bg-amber-300/90 border-amber-200',
    icon: Sun,
    envLabel: 'Arid megapolis  ·  Desert dunes  ·  No natural freshwater',
    tag: 'DESERT',
  },
};

const DIFFICULTY_STYLE: Record<string, string> = {
  Beginner: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  Intermediate: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  Advanced: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  Master: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  Extreme: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
};

export const LevelModal: React.FC<LevelModalProps> = ({ currentLevelId, onSelectLevel, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-slate-950 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400">
              <Map size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Campaign Stages & Scenarios</h2>
              <p className="text-xs text-slate-400 font-mono">
                Each stage is a distinct environment — story, terrain & treatment challenge
              </p>
            </div>
          </div>
          <button
            onClick={() => { SoundManager.playClick(); onClose(); }}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Level List */}
        <div className="p-6 flex flex-col gap-4 overflow-y-auto scrollbar-thin">
          {/* Sandbox Mode Card */}
          <div className="rounded-xl bg-gradient-to-r from-cyan-950/60 via-sky-900/40 to-slate-900 border border-cyan-500/40 flex items-center justify-between p-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-400 text-slate-950 font-mono uppercase">
                  Sandbox
                </span>
                <h3 className="text-sm font-bold text-slate-100">Free Engineering Sandbox</h3>
              </div>
              <p className="text-xs text-slate-300 max-w-xl">
                Infinite budget ($9,999,999), all units unlocked, custom influent generator, weather storms & chemical spills — build without constraints.
              </p>
            </div>
            <button
              onClick={() => {
                SoundManager.playClick();
                onSelectLevel(0, true);
                onClose();
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold text-xs shadow-lg transition shrink-0 ml-4"
            >
              <Play size={14} />
              <span>Launch Sandbox</span>
            </button>
          </div>

          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono mt-1">
            Campaign Levels — five distinct worlds
          </h3>

          {CAMPAIGN_LEVELS.map((lvl, index) => {
            const isCurrent = lvl.id === currentLevelId;
            const theme = BIOME_THEMES[lvl.biome] ?? BIOME_THEMES.coastal;
            const BiomeIcon = theme.icon;
            return (
              <div
                key={lvl.id}
                className={`rounded-xl border overflow-hidden transition flex flex-col ${
                  isCurrent
                    ? `bg-slate-800/90 ${theme.border} ring-1 ${theme.ring} shadow-lg`
                    : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/50'
                }`}
              >
                {/* Biome-dressed header — distinct per stage (V2-B) */}
                <div className={`relative h-[88px] bg-gradient-to-br ${theme.gradient} flex items-end p-4 overflow-hidden`}>
                  {/* Watermark icon */}
                  <BiomeIcon size={88} className="absolute -right-2 -top-1 text-white/10 pointer-events-none" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/5 to-transparent pointer-events-none" />
                  {/* Top row pills */}
                  <div className="absolute top-3 left-4 right-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-10 h-10 rounded-xl bg-slate-950/85 border border-white/20 flex items-center justify-center font-mono font-bold text-sky-300 text-sm shadow-md">
                        {lvl.code}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono tracking-wider border backdrop-blur ${theme.accent}`}>
                        {theme.tag} · {lvl.biome.replace('_', ' ').toUpperCase()}
                      </span>
                    </div>
                    <span className={`hidden sm:inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold font-mono border ${DIFFICULTY_STYLE[lvl.difficulty] ?? 'bg-slate-800 text-slate-300 border-slate-700'}`}>
                      {lvl.difficulty}
                    </span>
                  </div>
                  {/* Title row */}
                  <div className="relative z-10 min-w-0">
                    <h4 className="text-[15px] font-extrabold text-white leading-none drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
                      {lvl.title}
                    </h4>
                    <p className="text-xs text-white/85 font-mono leading-none mt-1 drop-shadow">
                      {lvl.subtitle} — {lvl.district}
                    </p>
                  </div>
                </div>

                {/* Body */}
                <div className="p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-300 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/60">
                        {lvl.briefing}
                      </p>
                      <p className="mt-2 text-[11px] leading-relaxed text-slate-400 italic border-l-2 border-slate-700 pl-2.5">
                        {lvl.backgroundStory}
                      </p>
                      <div className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-slate-500">
                        <BiomeIcon size={12} className="shrink-0 opacity-60" />
                        <span>{theme.envLabel}</span>
                        <span className="mx-1 text-slate-600">·</span>
                        <span>Map {lvl.mapSize[0]}×{lvl.mapSize[1]} tiles</span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        SoundManager.playClick();
                        onSelectLevel(index, false);
                        onClose();
                      }}
                      className={`shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-xl font-bold text-xs shadow-md transition ${
                        isCurrent
                          ? 'bg-sky-400 hover:bg-sky-300 text-slate-950'
                          : 'bg-sky-500 hover:bg-sky-400 text-slate-950'
                      }`}
                    >
                      <span>{isCurrent ? 'Replay Stage' : 'Play Stage'}</span>
                      <ChevronRight size={14} />
                    </button>
                  </div>

                  {/* Objectives preview + economy strip */}
                  <div className="flex flex-col gap-2 pt-2 border-t border-slate-800/60">
                    <div className="flex flex-wrap gap-1.5">
                      {lvl.objectives.slice(0, 4).map(obj => (
                        <span
                          key={obj.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[10px] font-mono text-slate-300"
                          title={obj.description}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-sky-400/70 shrink-0" />
                          {obj.description.replace(/^[^:]*:\s*/, '').slice(0, 42)}
                        </span>
                      ))}
                      {lvl.objectives.length > 4 && (
                        <span className="text-[10px] font-mono text-slate-500 px-1 py-0.5">
                          +{lvl.objectives.length - 4} more
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
                      <span className="text-emerald-400">Budget: ${lvl.startingBudget.toLocaleString()}</span>
                      <span className="text-cyan-400">Tariff: ${lvl.tariffPerM3}/m³</span>
                      <span className="text-amber-300">Reward: +${lvl.bonusReward.toLocaleString()}</span>
                      <span className={`sm:hidden px-2 py-0.5 rounded-full text-[10px] font-bold border ${DIFFICULTY_STYLE[lvl.difficulty]}`}>{lvl.difficulty}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
