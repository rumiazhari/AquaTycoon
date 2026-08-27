/**
 * ConstructionLibrary — CONSTRUCTION-BUILDER Template Library v1
 * (iter 61 — "Build the process, don't select the process").
 *
 * The player Shift-selects basins/baffles/machines and saves the grouping
 * as a named skid TEMPLATE (in-memory). Templates are stamped elsewhere on
 * the site in one click — the whole train (basins + baffles + equipment)
 * is placed atomically with fresh ids and cost/salvage semantics.
 *
 * Pure, headless-testable. No three.js, no React.
 * Utilities are NOT templated in v1 (they're wiring, not skid structure).
 */

import { estimateBasinCAPEX, BasinRect } from './CustomBasin';
import { EQUIPMENT_TYPES, estimateEquipmentCAPEX } from './ProcessEquipment';
import { estimateBaffleCAPEX } from './BasinZone';
import type { CustomBasin } from './CustomBasin';
import type { ProcessEquipmentItem } from './ProcessEquipment';
import type { BaffleWall } from './BasinZone';
import type { ConstructionSelection } from './ConstructionSelection';

export interface ConstructionTemplate {
  id: string;
  name: string;
  createdAtDay: number;
  // relative geometry — anchor is minX/minY of the selection
  anchorX: number;
  anchorY: number;
  basins: { w: number; h: number; depthM: number; dx: number; dy: number }[];
  // baffles refer to basins by index in `basins`
  baffles: { orientation: 'vertical' | 'horizontal'; offsetTiles: number; basinIndex: number }[];
  equipment: { typeId: string; dx: number; dy: number; rotation?: 0|90|180|270 }[];
}

export interface TemplateCreationResult {
  ok: boolean;
  reason?: string;
  template?: ConstructionTemplate;
}

let tplCounter = 0;
function nextTplId(): string {
  tplCounter++;
  return `tpl_${Date.now().toString(36)}_${tplCounter}`;
}

export function resetTemplateCounterForTests(): void { tplCounter = 0; }

/**
 * Build a template from the current multi-selection.
 * Returns null reasoning when selection empty or contains only utilities.
 */
export function createTemplateFromSelection(
  selection: ConstructionSelection,
  basins: CustomBasin[],
  equipment: ProcessEquipmentItem[],
  baffles: BaffleWall[],
  name?: string,
  createdAtDay: number = 0,
  forcedId?: string,
): TemplateCreationResult {
  const selBasinIds = new Set(selection.basins ?? []);
  const selEquipIds = new Set(selection.equipment ?? []);
  const selBaffleIds = new Set(selection.baffles ?? []);

  const selBasins = basins.filter(b => selBasinIds.has(b.id));
  const selEquipment = equipment.filter(e => selEquipIds.has(e.id));
  const selBaffles = baffles.filter(b => selBaffleIds.has(b.id));

  // Need at least one basin or one machine — utilities alone not enough
  if (selBasins.length === 0 && selEquipment.length === 0) {
    // allow baffle-only? baffle implies basin; without basin it's meaningless
    if (selBaffles.length === 0) return { ok: false, reason: 'Select at least one basin or machine to save as template' };
    return { ok: false, reason: 'Select the basin for those baffles' };
  }

  // Collect all positions to find anchor (minX/minY)
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of selBasins) { xs.push(b.x); ys.push(b.y); }
  for (const e of selEquipment) { xs.push(e.x); ys.push(e.y); }
  // baffles have no tile; anchor from basins/equipment
  if (xs.length === 0) return { ok: false, reason: 'Select at least one basin or machine' };
  const anchorX = Math.min(...xs);
  const anchorY = Math.min(...ys);

  // Map basin id -> index in selBasins for baffle reference
  const basinIdToIndex = new Map<string, number>();
  selBasins.forEach((b, idx) => basinIdToIndex.set(b.id, idx));

  // Keep only baffles whose basin is in the selection
  const tplBaffles: ConstructionTemplate['baffles'] = [];
  for (const bf of selBaffles) {
    const idx = basinIdToIndex.get(bf.basinId);
    if (idx === undefined) continue; // orphan — skip
    tplBaffles.push({ orientation: bf.orientation, offsetTiles: bf.offsetTiles, basinIndex: idx });
  }

  const tplBasins: ConstructionTemplate['basins'] = selBasins.map(b => ({
    w: b.w, h: b.h, depthM: b.depthM,
    dx: b.x - anchorX, dy: b.y - anchorY,
  }));
  const tplEquipment: ConstructionTemplate['equipment'] = selEquipment.map(e => ({
    typeId: e.typeId, dx: e.x - anchorX, dy: e.y - anchorY, rotation: e.rotation,
  }));

  const id = forcedId ?? nextTplId();
  const tplName = (name && name.trim().length > 0) ? name.trim() : `Skid ${id.slice(0,6)}`;
  const tpl: ConstructionTemplate = {
    id, name: tplName, createdAtDay,
    anchorX, anchorY,
    basins: tplBasins,
    baffles: tplBaffles,
    equipment: tplEquipment,
  };
  return { ok: true, template: tpl };
}

export function estimateTemplateCAPEX(tpl: ConstructionTemplate): number {
  let sum = 0;
  for (const b of tpl.basins) {
    // estimateBasinCAPEX expects BasinRect & {depthM}
    sum += estimateBasinCAPEX({ x: 0, y: 0, w: b.w, h: b.h, depthM: b.depthM } as any);
  }
  for (const bf of tpl.baffles) {
    // need a dummy basin for estimateBaffleCAPEX — use the referenced basin dims
    const host = tpl.basins[bf.basinIndex];
    if (!host) continue;
    const dummy: any = { x:0,y:0, w:host.w, h:host.h, depthM:host.depthM, id:'dummy', createdAtDay:0 };
    sum += estimateBaffleCAPEX(dummy, bf.orientation);
  }
  for (const e of tpl.equipment) {
    sum += estimateEquipmentCAPEX(e.typeId);
  }
  return sum;
}

export function templateSummaryLine(tpl: ConstructionTemplate): string {
  const parts: string[] = [];
  if (tpl.basins.length > 0) parts.push(`${tpl.basins.length} basin${tpl.basins.length>1?'s':''}`);
  if (tpl.baffles.length > 0) parts.push(`${tpl.baffles.length} baffle${tpl.baffles.length>1?'s':''}`);
  if (tpl.equipment.length > 0) parts.push(`${tpl.equipment.length} machine${tpl.equipment.length>1?'s':''}`);
  const cost = estimateTemplateCAPEX(tpl);
  return `${tpl.name} · ${parts.join(' · ')} · $${cost.toLocaleString()}`;
}

/**
 * Validate that stamping tpl at anchorTile would be legal.
 * Checks: map bounds, overlaps with existing basins/unitRects,
 * tile-exclusive equipment, in_basin mounting inside stamped basins,
 * baffle offset validity (always valid due to same dims).
 */
export function validateTemplateStamp(
  tpl: ConstructionTemplate,
  anchorTile: { x:number, y:number },
  mapSize: [number, number],
  existingBasins: BasinRect[],
  existingEquipment: { x:number, y:number }[],
  placedUnitRects: BasinRect[],
): { ok:boolean; reason?:string } {
  const [mapW, mapH] = mapSize;
  // Check basins
  for (const b of tpl.basins) {
    const rx = anchorTile.x + b.dx;
    const ry = anchorTile.y + b.dy;
    const rect: BasinRect = { x: rx, y: ry, w: b.w, h: b.h };
    if (rx < 0 || ry < 0 || rx + b.w > mapW || ry + b.h > mapH) {
      return { ok: false, reason: 'Template would extend beyond site boundary' };
    }
    for (const eb of existingBasins) {
      if (rectsOverlap(rect, eb as any)) return { ok: false, reason: 'Template basin overlaps an existing basin' };
    }
    for (const u of placedUnitRects) {
      if (rectsOverlap(rect, u)) return { ok: false, reason: 'Template basin overlaps a unit lot' };
    }
    // intra-template basins should not overlap each other (they didn't before, relative offsets preserve separation, but check at new anchor too)
  }
  // intra-template basin overlap check
  for (let i=0;i<tpl.basins.length;i++) for(let j=i+1;j<tpl.basins.length;j++) {
    const a = { x: anchorTile.x + tpl.basins[i].dx, y: anchorTile.y + tpl.basins[i].dy, w: tpl.basins[i].w, h: tpl.basins[i].h };
    const b = { x: anchorTile.x + tpl.basins[j].dx, y: anchorTile.y + tpl.basins[j].dy, w: tpl.basins[j].w, h: tpl.basins[j].h };
    if (rectsOverlap(a,b)) return { ok: false, reason: 'Template internally overlaps (bug)' };
  }
  // Check equipment tile collisions & mounting
  // Build set of stamped basin rects for mounting check
  const stampedBasinRects: BasinRect[] = tpl.basins.map(b => ({ x: anchorTile.x + b.dx, y: anchorTile.y + b.dy, w: b.w, h: b.h }));
  const existingEquipSet = new Set(existingEquipment.map(e => `${e.x},${e.y}`));
  const stampedEquipTiles = new Set<string>();
  for (const e of tpl.equipment) {
    const tx = anchorTile.x + e.dx;
    const ty = anchorTile.y + e.dy;
    if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) return { ok: false, reason: 'Template machine would be out of bounds' };
    const key = `${tx},${ty}`;
    if (existingEquipSet.has(key)) return { ok: false, reason: 'Template machine collides with existing equipment' };
    if (stampedEquipTiles.has(key)) return { ok: false, reason: 'Template machines would stack on one tile' };
    stampedEquipTiles.add(key);
    // mounting rule
    const def = EQUIPMENT_TYPES[e.typeId];
    if (!def) return { ok: false, reason: `Unknown equipment type ${e.typeId}` };
    if (def.mounting === 'in_basin') {
      const inside = stampedBasinRects.some(r => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h);
      // also allow inside existing basins? For stamping, in_basin kit must be inside the STAMPED basins, not random existing ones — but if template was basins+equipment together, checking stamped basins suffices. If template is equipment-only (no basins), then in_basin equipment would be invalid unless placed inside an existing basin — allow that fallback.
      const insideExisting = existingBasins.some(r => tx >= (r as any).x && tx < (r as any).x + (r as any).w && ty >= (r as any).y && ty < (r as any).y + (r as any).h);
      const okInside = inside || (tpl.basins.length === 0 && insideExisting);
      if (!okInside) return { ok: false, reason: `${def.name} must sit inside a stamped basin` };
    } else {
      // ground must NOT be inside any basin (stamped or existing) nor over unit lot
      const insideAnyBasin = stampedBasinRects.some(r => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) || existingBasins.some(r => tx >= (r as any).x && tx < (r as any).x + (r as any).w && ty >= (r as any).y && ty < (r as any).y + (r as any).h);
      if (insideAnyBasin) return { ok: false, reason: `${def.name} mounts on open ground — cannot sit inside a basin` };
      for (const u of placedUnitRects) {
        if (tx >= u.x && tx < u.x+u.w && ty >= u.y && ty < u.y+u.h) return { ok: false, reason: 'Template ground machine overlaps a unit lot' };
      }
    }
  }
  // baffles: offset validity (1..dim-1) — dims unchanged, so valid if it was valid before; just check
  for (const bf of tpl.baffles) {
    const host = tpl.basins[bf.basinIndex];
    if (!host) return { ok: false, reason: 'Template baffle references missing basin' };
    const dim = bf.orientation === 'vertical' ? host.w : host.h;
    if (bf.offsetTiles < 1 || bf.offsetTiles >= dim) return { ok: false, reason: 'Template baffle offset invalid for host basin' };
  }
  return { ok: true };
}

function rectsOverlap(a: BasinRect, b: BasinRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Produce fresh placed objects for a stamp at anchorTile.
 * Caller must have validated via validateTemplateStamp.
 * Basins/equipment/baffles get new ids: tplId_b{idx}_{anchor} etc.
 */
export function stampTemplate(
  tpl: ConstructionTemplate,
  anchorTile: { x:number, y:number },
  createdAtDay: number = 0,
): { basins: CustomBasin[]; baffles: BaffleWall[]; equipment: ProcessEquipmentItem[] } {
  const newBasinIds: string[] = tpl.basins.map((_, i) => `${tpl.id}_b${i}_${anchorTile.x}_${anchorTile.y}_${Date.now().toString(36)}`);
  const basins: CustomBasin[] = tpl.basins.map((b, i) => ({
    id: newBasinIds[i],
    x: anchorTile.x + b.dx,
    y: anchorTile.y + b.dy,
    w: b.w, h: b.h,
    depthM: b.depthM,
    createdAtDay,
  }));
  const baffles: BaffleWall[] = tpl.baffles.map((bf, i) => ({
    id: `${tpl.id}_bf${i}_${anchorTile.x}_${anchorTile.y}_${Date.now().toString(36)}`,
    basinId: newBasinIds[bf.basinIndex],
    orientation: bf.orientation,
    offsetTiles: bf.offsetTiles,
    createdAtDay,
  }));
  const equipment: ProcessEquipmentItem[] = tpl.equipment.map((e, i) => ({
    id: `${tpl.id}_eq${i}_${anchorTile.x}_${anchorTile.y}_${Date.now().toString(36)}`,
    typeId: e.typeId,
    x: anchorTile.x + e.dx,
    y: anchorTile.y + e.dy,
    rotation: e.rotation,
    createdAtDay,
  }));
  return { basins, baffles, equipment };
}
