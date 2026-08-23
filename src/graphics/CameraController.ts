import * as THREE from 'three';

/**
 * Smooth orbital camera with proper game-like controls:
 * - Left drag  → PAN
 * - Right drag → ORBIT
 * - Scroll     → ZOOM
 */
export class CameraController {
  public camera: THREE.PerspectiveCamera;
  public target: THREE.Vector3;

  private distance: number = 28;
  private azimuth: number = Math.PI / 4.2;
  private elevation: number = Math.PI / 3.6;
  private isTopDown: boolean = false;

  // Smooth-damp targets
  private _targetDistance: number = 28;
  private _targetAzimuth: number = Math.PI / 4.2;
  private _targetElevation: number = Math.PI / 3.6;
  private _targetPos: THREE.Vector3 = new THREE.Vector3();

  // Canvas size reference for correct pan scaling
  private _canvasH: number = 800;

  constructor(aspectRatio: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspectRatio, 0.1, 2000);
    this.target = new THREE.Vector3(12, 0, 10);
    this._targetPos.copy(this.target);
    this._applyCamera();
  }

  private _applyCamera() {
    if (this.isTopDown) {
      this.camera.position.set(this.target.x, this.distance * 1.6, this.target.z + 0.001);
    } else {
      const sinEl = Math.sin(this.elevation);
      const cosEl = Math.cos(this.elevation);
      this.camera.position.set(
        this.target.x + this.distance * sinEl * Math.sin(this.azimuth),
        this.target.y + this.distance * cosEl,
        this.target.z + this.distance * sinEl * Math.cos(this.azimuth)
      );
    }
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Call every frame with dt in seconds to apply smooth damping */
  public update(dt: number) {
    const alpha = Math.min(1.0, dt * 14);
    this.distance  += (this._targetDistance  - this.distance)  * alpha;
    this.azimuth   += (this._targetAzimuth   - this.azimuth)   * alpha;
    this.elevation += (this._targetElevation - this.elevation) * alpha;
    this.target.lerp(this._targetPos, alpha);
    this._applyCamera();
  }

  /**
   * Pan in screen-pixel delta space.
   * BUG FIX: scale by (distance / canvasH) so a full-height drag moves ~distance worth of world units.
   */
  public pan(screenDx: number, screenDy: number) {
    const scale = this.distance / Math.max(1, this._canvasH) * 1.4;
    const az = this.azimuth;
    const right   = new THREE.Vector3( Math.cos(az), 0, -Math.sin(az));
    const forward = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az));
    this._targetPos.addScaledVector(right,   -screenDx * scale);
    this._targetPos.addScaledVector(forward,  screenDy * scale);
  }

  /** Orbit (rotate) around the look-at target */
  public orbit(deltaAzimuth: number, deltaElevation: number) {
    if (this.isTopDown) return;
    this._targetAzimuth += deltaAzimuth;
    this._targetElevation = THREE.MathUtils.clamp(
      this._targetElevation + deltaElevation,
      0.12,
      Math.PI / 2.05
    );
  }

  public zoom(delta: number) {
    this._targetDistance = THREE.MathUtils.clamp(this._targetDistance + delta, 4, 130);
  }

  public zoomIn(amount = 4)  { this.zoom(-amount); }
  public zoomOut(amount = 4) { this.zoom(amount); }

  public rotateLeft(amount = Math.PI / 8)  { this.orbit(-amount, 0); }
  public rotateRight(amount = Math.PI / 8) { this.orbit(amount, 0); }
  public tiltUp(amount = Math.PI / 16)     { this.orbit(0, -amount); }
  public tiltDown(amount = Math.PI / 16)   { this.orbit(0, amount); }

  public resetView(mapW = 24, mapD = 20) {
    const cx = mapW / 2, cz = mapD / 2;
    this._targetPos.set(cx, 0, cz);
    this.target.set(cx, 0, cz);
    this._targetDistance = Math.max(20, Math.max(mapW, mapD) * 1.15);
    this._targetAzimuth  = Math.PI / 4.2;
    this._targetElevation = Math.PI / 3.6;
    this.isTopDown = false;
    // Snap immediately
    this.distance  = this._targetDistance;
    this.azimuth   = this._targetAzimuth;
    this.elevation = this._targetElevation;
    this._applyCamera();
  }

  public setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Update canvas height for correct pan scaling */
  public setCanvasSize(_w: number, h: number) {
    this._canvasH = h;
  }

  public focusOn(x: number, z: number) {
    this._targetPos.set(x, 0, z);
  }

  public toggleTopDown(): boolean {
    this.isTopDown = !this.isTopDown;
    this._applyCamera();
    return this.isTopDown;
  }

  public get currentAzimuth()  { return this.azimuth; }
  public get currentDistance() { return this.distance; }
}
