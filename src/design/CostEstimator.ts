/**
 * CostEstimator (Prompts §T/U) — quantity-based CAPEX for engineered assets.
 * Fixed template prices are gone: cost derives from concrete volumes,
 * excavation, equipment selections, redundancy and pipework.
 */

import type { BasinGeometry } from './Geometry';
import { civilQuantities } from './Geometry';
import {
  CONSTRUCTION_MATERIALS,
  PIPE_MATERIALS,
  installedBlowerCapacity,
  PUMP_MODELS,
  REDUNDANCY_CONFIGS,
  DIFFUSER_MODELS,
} from './catalogs/Equipment';

export interface CapexBreakdown {
  civil: number;
  mechanical: number;
  electrical: number;
  instrumentation: number;
  pipework: number;
  sitework: number;
  contingency: number;
  total: number;
}

const CONTINGENCY_RATE = 0.12;
const ELECTRICAL_RATE = 0.18; // of mechanical
const INSTRUMENTATION_BASE = 9000;
const SITEWORK_PER_M2_FLOOR = 55;

function finish(b: Omit<CapexBreakdown, 'contingency' | 'total'>): CapexBreakdown {
  const subtotal =
    b.civil + b.mechanical + b.electrical + b.instrumentation + b.pipework + b.sitework;
  const contingency = Math.round(subtotal * CONTINGENCY_RATE);
  return { ...b, contingency, total: subtotal + contingency };
}

/** Structure CAPEX from geometry + construction material. */
export function estimateStructureCAPEX(
  geometry: BasinGeometry,
  materialId: string,
  opts: { diffuserModelId?: string; diffuserCount?: number } = {}
): CapexBreakdown {
  const mat = CONSTRUCTION_MATERIALS[materialId] ?? CONSTRUCTION_MATERIALS.reinforced_concrete;
  const q = civilQuantities(geometry);
  const civil = Math.round(
    q.concreteVolumeM3 * mat.concreteCostPerM3 * mat.shellCostFactor +
    q.excavationVolumeM3 * 22 // excavation $/m³
  );
  let mechanical = 0;
  if (opts.diffuserModelId && opts.diffuserCount) {
    const d = DIFFUSER_MODELS[opts.diffuserModelId];
    if (d) mechanical += d.capexPerUnit * opts.diffuserCount;
  }
  const electrical = Math.round(mechanical * ELECTRICAL_RATE);
  const instrumentation = INSTRUMENTATION_BASE;
  const sitework = Math.round(q.floorAreaM2 * SITEWORK_PER_M2_FLOOR);
  return finish({ civil, mechanical, electrical, instrumentation, pipework: 0, sitework });
}

/** Pipe CAPEX from diameter, material and length. */
export function estimatePipeCAPEX(
  diameterM: number,
  materialId: string | undefined,
  lengthM: number
): number {
  const mat = PIPE_MATERIALS[materialId ?? 'pvc'] ?? PIPE_MATERIALS.pvc;
  const dn100Equivalent = (diameterM / 0.1);
  return Math.round(mat.costPerM_per100mmDia * Math.max(1, dn100Equivalent) * Math.max(1, lengthM));
}

/** Blower bank CAPEX. */
export function estimateBlowerCAPEX(blowerModelId: string, redundancyId: string): number {
  return installedBlowerCapacity(blowerModelId, redundancyId)?.capex ?? 0;
}

/** Pump station CAPEX incl. wet well mechanics. */
export function estimatePumpCAPEX(pumpModelId: string, redundancyId: string): CapexBreakdown {
  const pump = PUMP_MODELS[pumpModelId];
  const red = REDUNDANCY_CONFIGS[redundancyId];
  const mechanical = pump && red ? Math.round(pump.capex * red.costFactor) : 0;
  return finish({
    civil: 28000, // wet well + valve chamber baseline
    mechanical,
    electrical: Math.round(mechanical * ELECTRICAL_RATE),
    instrumentation: 6500,
    pipework: 8000,
    sitework: 4000,
  });
}

/** Legacy fixed-price lookup for NOT-yet-engineered process families. */
export function legacyTemplateCapex(capex: number): CapexBreakdown {
  const civil = Math.round(capex * 0.42);
  const mechanical = Math.round(capex * 0.30);
  const rest = capex - civil - mechanical;
  const b = finish({
    civil,
    mechanical,
    electrical: Math.round(rest * 0.4),
    instrumentation: Math.round(rest * 0.25),
    pipework: Math.round(rest * 0.2),
    sitework: Math.round(rest * 0.15),
  });
  return b;
}
