import React from 'react';
import { ProcessBadge } from '../design/ProcessRecognition';
import { Layers, Wind, Droplets, ShieldCheck, Hexagon, Activity, Columns3, AlertTriangle, Recycle, Gauge, FlaskConical, Beaker, Filter, Cylinder } from 'lucide-react';

const TONE_CLASSES: Record<ProcessBadge['tone'], string> = {
  emerald: 'text-emerald-200 border-emerald-500/30 bg-emerald-950/40',
  sky: 'text-sky-200 border-sky-500/30 bg-sky-950/30',
  cyan: 'text-cyan-200 border-cyan-500/30 bg-cyan-950/30',
  violet: 'text-violet-200 border-violet-500/30 bg-violet-950/30',
  amber: 'text-amber-200 border-amber-500/40 bg-amber-950/30',
  slate: 'text-slate-300 border-slate-600 bg-slate-900',
  lime: 'text-lime-200 border-lime-500/30 bg-lime-950/30',
};

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  compartment: Columns3,
  aerated: Wind,
  mixed: Recycle,
  activated: Activity,
  'anoxic-aerobic': Layers,
  membrane: ShieldCheck,
  biofilm: Hexagon,
  'biofilm-dormant': Hexagon,
  ifas: Droplets,
  septic: AlertTriangle,
  instrumented: Gauge,
  chemical: FlaskConical,
  'chemical-dormant': Beaker,
  tertiary: Filter,
  'tertiary-ready': Filter,
  'tertiary-dormant': Cylinder,
};

interface Props {
  badges: ProcessBadge[];
}

export const ProcessBadgeStrip: React.FC<Props> = ({ badges }) => {
  if (badges.length === 0) return null;
  return (
    <div className="absolute top-[92px] left-3 z-20 pointer-events-none flex flex-wrap gap-1.5 max-w-[min(72vw,44rem)]">
      {badges.map(b => {
        const Icon = ICONS[b.id] ?? Layers;
        return (
          <span
            key={b.id}
            title={`${b.label}: ${b.detail}`}
            className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${TONE_CLASSES[b.tone]}`}
          >
            <Icon size={12} className="shrink-0 opacity-80" />
            <span className="font-bold">{b.label}</span>
            <span className="opacity-75 hidden sm:inline">· {b.detail}</span>
          </span>
        );
      })}
    </div>
  );
};
