/**
 * OvertakeController — PURE reservation logic for the two-lane river road.
 *
 * Extracted from TerrainGrid so it can be unit-tested without WebGL.
 *
 * Road topology note
 * ------------------
 * The road is a SINGLE two-lane (one-lane-each-direction) strip with a
 * meandering centre. Because the whole road is a shared two-lane conflict
 * zone, only ONE vehicle — from EITHER direction — may occupy the opposing
 * lane at a time. We therefore keep ONE road-wide reservation, NOT one lock
 * per direction.
 *
 * Lifecycle (per vehicle):
 *   cruise  → prepare  (acquire reservation)
 *   prepare → overtake (retain  reservation)
 *   overtake→ return   (retain  reservation)
 *   return  → cooldown  (retain  reservation)
 *   cooldown → cruise   (release reservation — vehicle back in home lane)
 *
 * A reservation is released safely when its owner:
 *  - reaches cooldown (back in home lane), or
 *  - is reset / wraps the road boundary, or
 *  - is no longer in the active vehicle list (stale-id guard).
 */

/** Over-the-road manoeuvre state for one vehicle. */
export type OvertakeState = 'cruise' | 'prepare' | 'overtake' | 'return' | 'cooldown';

export interface OvertakeVehicle {
  /** Stable stable id — never an array index (the list may reorder). */
  id: number;
  /** Travel direction: +1 (downstream) or −1 (upstream). */
  dir: 1 | -1;
  /** Forward progress state of the manoeuvre. */
  state: OvertakeState;
  /** Seconds spent in the opposing lane (forces abort if it grows too large). */
  overtakeTime: number;
  /** Seconds of cooldown remaining before another pass may be attempted. */
  cooldown: number;
  /** True once the vehicle has fully re-entered its home lane. */
  inHomeLane: boolean;
}

/**
 * Pure, side-effect-free reservation controller.
 *
 * Holds a single road-wide reservation id (or `null`). The controller does
 * NOT own TrafficVehicle objects — it only owns the reservation token and
 * validates holders against the live vehicle list the caller provides.
 */
export class OvertakeController {
  /** id of the vehicle currently holding the road-wide overtake reservation */
  private reservation: number | null = null;

  /** id of the vehicle currently holding the reservation, or null. */
  get activeId(): number | null {
    return this.reservation;
  }

  /** True when `vehicleId` is the current reservation holder. */
  isHeldBy(vehicleId: number): boolean {
    return this.reservation === vehicleId;
  }
  /** Alias of {@link isHeldBy} — clearer name for TerrainGrid call-sites. */
  isReservationHeldBy(vehicleId: number): boolean {
    return this.isHeldBy(vehicleId);
  }

  /** True when ANY vehicle holds the reservation. */
  get isOccupied(): boolean {
    return this.reservation !== null;
  }

  /**
   * Can `vehicle` begin/follow an overtake manoeuvre right now?
   *
   * Returns `false` when the road-wide reservation is already held by a
   * DIFFERENT vehicle — this blocks both same-direction followers (no
   * "overtaking the overtaker") and opposite-direction vehicles (no
   * simultaneous opposing-lane overtake).
   */
  canBeginOvertake(vehicle: OvertakeVehicle): boolean {
    if (vehicle.state !== 'cruise' && vehicle.state !== 'cooldown') {
      return false; // already manoeuvring
    }
    if (vehicle.cooldown > 0) {
      return false; // still cooling down from a previous pass
    }
    if (this.reservation !== null && this.reservation !== vehicle.id) {
      return false; // road-wide reservation occupied by another vehicle
    }
    return true;
  }

  /**
   * Acquire the road-wide reservation for `vehicle`.
   *
   * @returns true if acquired (or already held by this vehicle), false if
   *   another vehicle currently holds it.
   */
  acquireOvertakeReservation(vehicle: OvertakeVehicle): boolean {
    if (this.reservation === vehicle.id) {
      return true; // already the holder
    }
    if (this.reservation !== null) {
      return false; // held by another vehicle — denied
    }
    this.reservation = vehicle.id;
    return true;
  }

  /**
   * Release the reservation. Only meaningful when `vehicleId` is the holder;
   * this guards against releasing a slot we never owned.
   */
  releaseOvertakeReservation(vehicleId: number | null = this.reservation): boolean {
    if (vehicleId !== null && this.reservation !== vehicleId) {
      return false; // not the holder — refuse to release someone else's slot
    }
    this.reservation = null;
    return true;
  }

  /**
   * Reconcile the reservation against the live vehicle list.
   *
   * Releases the reservation when its holder has:
   *  - reached cooldown (back in the home lane), or
   *  - dropped out of the active list (wrap-around respawn / reset).
   *
   * This is the safety net that prevents stale locks from persisting across
   * frames / respawns when tick() is the only caller.
   */
  reconcile(vehicles: OvertakeVehicle[]): void {
    if (this.reservation === null) return;

    const holder = vehicles.find(v => v.id === this.reservation);

    // Holder no longer present in the active list → release (stale lock guard).
    if (!holder) {
      this.reservation = null;
      return;
    }

    // Once the vehicle is back in its home lane and cooling down, the
    // manoeuvre is complete → release so others may pass.
    if (holder.state === 'cooldown' && holder.inHomeLane) {
      this.reservation = null;
      return;
    }

    // If the holder has somehow been reset (cruise with no cooldown pending
    // while holding the reservation) release defensively.
    if (holder.state === 'cruise' && holder.inHomeLane) {
      this.reservation = null;
      return;
    }

    // Otherwise keep the reservation held through prepare / overtake / return /
    // early cooldown — exactly the spec'd lifecycle.
  }

  /** Drop everything (level change / map resize / disposal). */
  reset(): void {
    this.reservation = null;
  }
}
