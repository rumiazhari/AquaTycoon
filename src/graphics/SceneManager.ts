import * as THREE from 'three';
import { CameraController } from './CameraController';
import { TerrainGrid } from './TerrainGrid';
import { UnitMeshBuilder } from './UnitMeshes';
import { PipeRenderer } from './PipeRenderer';
import { PipeConnection, PlacedUnit, UnitTypeId } from '../types/simulation';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

interface DayNightPalette {
  bg: THREE.Color;
  fog: THREE.Color;
  dirColor: THREE.Color;
  dirIntensity: number;
  ambientIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  sunEmissive: number;
  starOpacity: number;
  sunY: number;
}

const DAY: DayNightPalette = {
  bg: new THREE.Color(0x87b8e4),
  fog: new THREE.Color(0x9fc3e0),
  dirColor: new THREE.Color(0xfff2d8),
  dirIntensity: 2.1,
  ambientIntensity: 0.55,
  hemiSky: new THREE.Color(0x9ec8ef),
  hemiGround: new THREE.Color(0x51683a),
  sunEmissive: 0xffdf8a,
  starOpacity: 0,
  sunY: 120,
};

const NIGHT: DayNightPalette = {
  bg: new THREE.Color(0x060d1c),
  fog: new THREE.Color(0x0a1526),
  dirColor: new THREE.Color(0x5f7fd8),
  dirIntensity: 0.35,
  ambientIntensity: 0.22,
  hemiSky: new THREE.Color(0x182347),
  hemiGround: new THREE.Color(0x0c1410),
  sunEmissive: 0xdfe7ff,
  starOpacity: 0.9,
  sunY: -40,
};

export class SceneManager {
  public scene: THREE.Scene;
  public cameraController: CameraController;
  public renderer: THREE.WebGLRenderer;
  public terrainGrid: TerrainGrid;
  public pipeRenderer: PipeRenderer;
  public container: HTMLDivElement;

  public get canvas(): HTMLCanvasElement { return this.renderer.domElement; }

  private unitGroup: THREE.Group;
  private unitMeshMap: Map<string, THREE.Group> = new Map();
  private ghostSuggestGroup: THREE.Group;
  private pipeSelectRingMap: Map<string, THREE.Mesh> = new Map();
  private dirLight: THREE.DirectionalLight;
  private ambientLight: THREE.AmbientLight;
  private hemiLight: THREE.HemisphereLight;
  private raycaster: THREE.Raycaster;
  private groundPlane: THREE.Plane;

  // Sky / celestial bodies
  private skyDome!: THREE.Mesh;
  private skyMatDay!: THREE.ShaderMaterial;
  private sunMesh!: THREE.Mesh;
  private stars!: THREE.Points;
  private starsMat!: THREE.PointsMaterial;

  // Smooth day/night blending
  private nightTarget = 0;
  private nightFactor = 0;

  private animationFrameId: number | null = null;
  private clock: THREE.Clock;
  private lastFrameTime: number = 0;

  constructor(container: HTMLDivElement, mapWidth: number = 24, mapDepth: number = 20) {
    this.container = container;
    this.clock = new THREE.Clock();

    this.scene = new THREE.Scene();
    this.scene.background = DAY.bg.clone();
    this.scene.fog = new THREE.FogExp2(DAY.fog.getHex(), 0.0045);

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.cameraController = new CameraController(w / h);
    this.cameraController.resetView(mapWidth, mapDepth);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    const canvas = this.renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);

    // Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, DAY.ambientIntensity);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(DAY.hemiSky.getHex(), DAY.hemiGround.getHex(), 0.55);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(DAY.dirColor.getHex(), DAY.dirIntensity);
    this.dirLight.position.set(45, DAY.sunY, 30);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 400;
    const sd = Math.max(mapWidth, mapDepth) * 0.85 + 22;
    this.dirLight.shadow.camera.left   = -sd;
    this.dirLight.shadow.camera.right  =  sd;
    this.dirLight.shadow.camera.top    =  sd;
    this.dirLight.shadow.camera.bottom = -sd;
    this.dirLight.shadow.bias = -0.00035;
    this.dirLight.target.position.set(mapWidth / 2, 0, mapDepth / 2);
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    // Sky dome (gradient shader), sun disc & stars
    this._buildSky();

    // Terrain & full environment
    this.terrainGrid = new TerrainGrid(mapWidth, mapDepth);
    this.scene.add(this.terrainGrid.group);

    // Units group
    this.unitGroup = new THREE.Group();
    this.scene.add(this.unitGroup);

    // Ghost suggestion group
    this.ghostSuggestGroup = new THREE.Group();
    this.scene.add(this.ghostSuggestGroup);

    // Pipes
    this.pipeRenderer = new PipeRenderer();
    this.scene.add(this.pipeRenderer.group);

    // Raycaster on Y=0 ground plane
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this._startLoop();
  }

  private _buildSky() {
    const geo = new THREE.SphereGeometry(500, 24, 16);
    this.skyMatDay = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor:     { value: new THREE.Color(0x2f6fb8) },
        midColor:     { value: new THREE.Color(0x9cc4ea) },
        bottomColor:  { value: new THREE.Color(0xd8e6ee) },
        nightTop:     { value: new THREE.Color(0x020617) },
        nightMid:     { value: new THREE.Color(0x0b1530) },
        nightBottom:  { value: new THREE.Color(0x16233f) },
        offset:       { value: 60 },
        exponent:     { value: 0.75 },
        nightFactor:  { value: 0 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor; uniform vec3 midColor; uniform vec3 bottomColor;
        uniform vec3 nightTop; uniform vec3 nightMid; uniform vec3 nightBottom;
        uniform float offset; uniform float exponent; uniform float nightFactor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          vec3 dayCol   = mix(mix(bottomColor, midColor, smoothstep(0.0, 0.35, t)), topColor, smoothstep(0.3, 1.0, t));
          vec3 nightCol = mix(mix(nightBottom, nightMid, smoothstep(0.0, 0.35, t)), nightTop, smoothstep(0.3, 1.0, t));
          gl_FragColor = vec4(mix(dayCol, nightCol, nightFactor), 1.0);
        }`,
    });
    this.skyDome = new THREE.Mesh(geo, this.skyMatDay);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    // Sun disc
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(14, 16, 12),
      new THREE.MeshBasicMaterial({ color: DAY.sunEmissive, fog: false })
    );
    this.sunMesh.position.set(180, DAY.sunY, 90);
    this.scene.add(this.sunMesh);

    // Stars (visible at night)
    const starCount = 700;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.85);
      const r = 430;
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 15;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  private _startLoop() {
    const animate = (timestamp: number) => {
      this.animationFrameId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, (timestamp - this.lastFrameTime) / 1000);
      this.lastFrameTime = timestamp;
      const elapsed = this.clock.getElapsedTime();

      this.cameraController.update(dt);

      // Smooth day/night blend
      this.nightFactor += (this.nightTarget - this.nightFactor) * Math.min(1, dt * 1.6);
      const nf = this.nightFactor;
      if (Math.abs(this.nightTarget - this.nightFactor) > 0.001 || this.nightTarget === 1) {
        const bg = DAY.bg.clone().lerp(NIGHT.bg, nf);
        const fg = DAY.fog.clone().lerp(NIGHT.fog, nf);
        this.scene.background = bg;
        (this.scene.fog as THREE.FogExp2).color.copy(fg);
        this.dirLight.color.copy(DAY.dirColor).lerp(NIGHT.dirColor, nf);
        this.dirLight.intensity = lerpN(DAY.dirIntensity, NIGHT.dirIntensity, nf);
        this.ambientLight.intensity = lerpN(DAY.ambientIntensity, NIGHT.ambientIntensity, nf);
        this.hemiLight.color.copy(DAY.hemiSky).lerp(NIGHT.hemiSky, nf);
        this.hemiLight.groundColor.copy(DAY.hemiGround).lerp(NIGHT.hemiGround, nf);
        this.skyMatDay.uniforms.nightFactor.value = nf;
        (this.sunMesh.material as THREE.MeshBasicMaterial).color.setHex(nf > 0.5 ? NIGHT.sunEmissive : DAY.sunEmissive);
        this.starsMat.opacity = lerpN(DAY.starOpacity, NIGHT.starOpacity, nf);
        this.sunMesh.position.y = lerpN(DAY.sunY, NIGHT.sunY, nf);
        this.sunMesh.visible = this.sunMesh.position.y > -25 || nf < 0.5;
      }

      this.terrainGrid.tick(dt, elapsed, nf);

      for (const mesh of this.unitMeshMap.values()) {
        UnitMeshBuilder.updateUnitAnimation(mesh, elapsed);
      }
      this._animateGhostSuggest(elapsed);

      this.renderer.render(this.scene, this.cameraController.camera);
    };
    this.lastFrameTime = performance.now();
    animate(this.lastFrameTime);
  }

  private _animateGhostSuggest(t: number) {
    for (const child of this.ghostSuggestGroup.children) {
      const m = child as THREE.Mesh;
      if (m.material && (m.material as THREE.MeshBasicMaterial).opacity !== undefined) {
        (m.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(t * 3) * 0.15;
      }
    }
  }

  /** Sync unit meshes; add missing, remove stale, always refresh transforms */
  public syncUnits(units: PlacedUnit[]) {
    const activeIds = new Set(units.map(u => u.instanceId));

    for (const [id, mesh] of this.unitMeshMap.entries()) {
      if (!activeIds.has(id)) {
        this.unitGroup.remove(mesh);
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.geometry) mm.geometry.dispose();
        });
        this.unitMeshMap.delete(id);
      }
    }

    for (const unit of units) {
      const def = UNIT_DEFINITIONS[unit.typeId];
      if (!def) continue;
      const [fw, fl] = unit.rotation === 90 || unit.rotation === 270
        ? [def.footprint[1], def.footprint[0]]
        : def.footprint;

      let mesh = this.unitMeshMap.get(unit.instanceId);
      if (!mesh) {
        mesh = UnitMeshBuilder.buildUnitMesh(unit);
        // Realism: enable shadows on opaque parts
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.isMesh && mm.material) {
            const mat = Array.isArray(mm.material) ? mm.material[0] : mm.material;
            const transparent = (mat as THREE.MeshStandardMaterial).transparent === true;
            const basicGlow = mat instanceof THREE.MeshBasicMaterial;
            mm.castShadow = !transparent && !basicGlow;
            mm.receiveShadow = true;
          }
        });
        this.unitMeshMap.set(unit.instanceId, mesh);
        this.unitGroup.add(mesh);
      }
      mesh.position.set(unit.gridX + fw / 2, 0, unit.gridY + fl / 2);
      mesh.rotation.y = (unit.rotation * Math.PI) / 180;
    }
  }

  public syncPipes(pipes: PipeConnection[]) {
    this.pipeRenderer.updatePipes(pipes, this.clock.getElapsedTime());
  }

  /** Smoothly transitions the whole environment to day or night */
  public setDayNight(isNight: boolean) {
    this.nightTarget = isNight ? 1 : 0;
  }

  /**
   * Shows a pulsing green ghost at the suggested next build position.
   */
  public showNextStepGhost(
    unitTypeId: UnitTypeId | null,
    gridX: number,
    gridY: number
  ) {
    while (this.ghostSuggestGroup.children.length > 0) {
      const c = this.ghostSuggestGroup.children[0];
      this.ghostSuggestGroup.remove(c);
    }
    if (!unitTypeId) return;

    const def = UNIT_DEFINITIONS[unitTypeId];
    if (!def) return;
    const [fw, fl] = def.footprint;

    const boxGeo = new THREE.BoxGeometry(fw - 0.1, 1.0, fl - 0.1);
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0x22c55e,
      transparent: true,
      opacity: 0.3,
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.set(gridX + fw / 2, 0.6, gridY + fl / 2);
    this.ghostSuggestGroup.add(box);

    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
    });
    const wire = new THREE.Mesh(new THREE.BoxGeometry(fw - 0.1, 1.0, fl - 0.1), wireMat);
    wire.position.copy(box.position);
    this.ghostSuggestGroup.add(wire);

    const coneGeo = new THREE.ConeGeometry(0.35, 0.7, 8);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.85 });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(gridX + fw / 2, 2.5, gridY + fl / 2);
    cone.rotation.x = Math.PI;
    this.ghostSuggestGroup.add(cone);
  }

  /**
   * Highlights the selected pipe source unit with a glowing ring.
   */
  public setPipeSourceHighlight(unitInstanceId: string | null, units: PlacedUnit[]) {
    for (const ring of this.pipeSelectRingMap.values()) {
      this.unitGroup.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    }
    this.pipeSelectRingMap.clear();

    if (!unitInstanceId) return;
    const unit = units.find(u => u.instanceId === unitInstanceId);
    if (!unit) return;
    const def = UNIT_DEFINITIONS[unit.typeId];
    if (!def) return;

    const [fw, fl] = def.footprint;
    const radius = Math.max(fw, fl) * 0.65;
    const ringGeo = new THREE.TorusGeometry(radius, 0.06, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(unit.gridX + fw / 2, 0.15, unit.gridY + fl / 2);
    this.unitGroup.add(ring);
    this.pipeSelectRingMap.set(unitInstanceId, ring);
  }

  /** Raycasts screen coords to grid tile using the canvas rect */
  public getGridTileFromScreen(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const ndcX =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((clientY - rect.top)  / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.cameraController.camera);
    const hit = new THREE.Vector3();
    const intersected = this.raycaster.ray.intersectPlane(this.groundPlane, hit);
    if (!intersected) return null;
    return { x: Math.floor(hit.x), y: Math.floor(hit.z) };
  }

  public getUnitAtScreen(clientX: number, clientY: number, units: PlacedUnit[]): PlacedUnit | null {
    const tile = this.getGridTileFromScreen(clientX, clientY);
    if (!tile) return null;
    return units.find(u => {
      const def = UNIT_DEFINITIONS[u.typeId];
      if (!def) return false;
      const [fw, fl] = (u.rotation === 90 || u.rotation === 270)
        ? [def.footprint[1], def.footprint[0]]
        : def.footprint;
      return tile.x >= u.gridX && tile.x < u.gridX + fw &&
             tile.y >= u.gridY && tile.y < u.gridY + fl;
    }) ?? null;
  }

  public handleResize(width: number, height: number) {
    this.renderer.setSize(width, height);
    this.cameraController.setAspect(width / height);
  }

  public dispose() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // BUG FIX: fully release GPU resources (was leaking on unmount/HMR)
    this.scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach(m => {
          const std = m as THREE.MeshStandardMaterial;
          if (std.map) std.map.dispose();
          if (std.emissiveMap && std.emissiveMap !== std.map) std.emissiveMap.dispose();
          m.dispose();
        });
      }
    });
    this.scene.clear();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
