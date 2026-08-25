/**
 * Road-corridor terrain clearance (Prompt 3.4.1 item C).
 *
 * PURE helper so the rule is enforced consistently everywhere terrain height
 * is shaped AND can be regression-tested headlessly.
 *
 * Problem it solves: terrainHeight() layers hills → road flatten → river
 * channel. The channel carve runs LAST, so where the river's bank-top plateau
 * (+0.25) crosses the road corridor it overrode the flatten and produced raised
 * soil lips overlapping the asphalt at both bridge approaches.
 *
 * Rule: inside the paved corridor plus shoulder, terrain may never exceed the
 * road support grade; across a blend band it eases smoothly back to natural
 * terrain (no harsh trench).
 */

/** Asphalt half-width in world units (road plane is 6.4 wide → 3.2 each side). */
export const ROAD_HALF_WIDTH = 3.2;
/** Clear verge kept flat beyond the asphalt edge (shoulder strips live here). */
export const ROAD_SHOULDER_WIDTH = 1.0;
/** Width of the smooth outward transition back to natural terrain. */
export const ROAD_BLEND_BAND = 2.8;
/** Maximum terrain height allowed inside the cleared corridor. The asphalt
 *  plane tops out at y=0.09, so anything at/below this never pokes through. */
export const ROAD_SUPPORT_GRADE = 0.05;

/** Distance from the road centreline at which the clearance fully releases. */
export const ROAD_CLEAR_END =
  ROAD_HALF_WIDTH + ROAD_SHOULDER_WIDTH + ROAD_BLEND_BAND;

function smoothstep(edgeA: number, edgeB: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edgeA) / (edgeB - edgeA)));
  return t * t * (3 - 2 * t);
}

/**
 * Clamp a candidate terrain height against the road corridor.
 *
 * @param h          Candidate height from hills/river shaping.
 * @param roadDist   Absolute distance from the road centreline (|z − zRoad|).
 * @returns Height guaranteed ≤ ROAD_SUPPORT_GRADE inside the corridor,
 *          blending smoothly to `h` by ROAD_CLEAR_END.
 */
export function roadCorridorHeight(h: number, roadDist: number): number {
  // clearance ∈ [0,1]: 1 deep inside the corridor, 0 beyond the blend band.
  const clearance =
    1 - smoothstep(ROAD_HALF_WIDTH + ROAD_SHOULDER_WIDTH, ROAD_CLEAR_END, roadDist);
  if (clearance <= 0) return h;
  const clamped = Math.min(h, ROAD_SUPPORT_GRADE);
  return h * (1 - clearance) + clamped * clearance;
}
