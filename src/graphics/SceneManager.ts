import * as THREE from 'three';
// Post-processing (official three examples, shipped with the pinned 0.174 dep)
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CameraController } from './CameraController';
import { TerrainGrid } from './TerrainGrid';
import { UnitMeshBuilder } from './UnitMeshes';
import { PipeRenderer } from './PipeRenderer';
import { PipeConnection, PlacedUnit, UnitTypeId } from '../types/simulation';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { getPortWorldPosition, getRotatedFootprint } from '../sim/PipeNetwork';
import type { LevelBiome, SimulationSpeed } from '../types/game';
import { getDayNightFactor } from '../gameplay/GameTime';
import { terrainFactorForRect, foundationConditionTone, FOUNDATION_TONE_HEX } from '../design/TerrainFoundation';
import type { BasinRect } from '../design/CustomBasin';

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

// ── Performance budget (Prompt 3.4 items 3, 6, 9): ONE directional light with
// day/night shadow scaling + budgeted local lights (owned by TerrainGrid) ──
/** Day sun shadow map resolution. */
export const DAY_SHADOW_MAP_SIZE = 1024;
/** Night MOON shadow map — night keeps real depth at quarter the cost. */
export const NIGHT_SHADOW_MAP_SIZE = 512;
/**
 * Conservative pixel-ratio cap for integrated GPUs. High-DPI office displays
 * no longer pay a 2× fill-rate tax; 1.25 stays crisp for this art style.
 */
export const MAX_PIXEL_RATIO = 1.25;
/** Adaptive-resolution floor (never blurry beyond this). */
const MIN_PIXEL_RATIO = 0.75;
/** Adaptive resolution: seconds between quality adjustments (anti-oscillation). */
const ADAPT_INTERVAL_SEC = 2.5;
/** Seconds between light-pool reassignments to the nearest street lamps. */
const LIGHT_POOL_INTERVAL_SEC = 0.5;

// ── Quality tiers for automatic degradation (item 10). Ordered mildest →
// strongest reduction; we step DOWN one tier when FPS is poor and back UP only
// after a sustained healthy window, so quality never oscillates.
const QUALITY_TIERS = [
  { ao: true, aoHalfRes: false, bloom: true, bloomRes: 1.0, maxStreetLights: 8, localShadowLights: 2, dirShadowSize: DAY_SHADOW_MAP_SIZE },
  { ao: true, aoHalfRes: true, bloom: true, bloomRes: 0.75, maxStreetLights: 8, localShadowLights: 2, dirShadowSize: DAY_SHADOW_MAP_SIZE },
  { ao: true, aoHalfRes: true, bloom: true, bloomRes: 0.5, maxStreetLights: 6, localShadowLights: 2, dirShadowSize: DAY_SHADOW_MAP_SIZE },
  { ao: true, aoHalfRes: true, bloom: true, bloomRes: 0.5, maxStreetLights: 4, localShadowLights: 1, dirShadowSize: DAY_SHADOW_MAP_SIZE },
  { ao: false, aoHalfRes: true, bloom: true, bloomRes: 0.5, maxStreetLights: 3, localShadowLights: 1, dirShadowSize: NIGHT_SHADOW_MAP_SIZE },
] as const;
type QualityTier = (typeof QUALITY_TIERS)[number];

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

function makeDay(biome?: LevelBiome): DayNightPalette {
  const p: DayNightPalette = {
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
  if (biome === 'industrial') {
    p.bg.setHex(0x9fb0bd); p.fog.setHex(0xb3bec6);
    p.hemiSky.setHex(0xb4c2cc); p.hemiGround.setHex(0x5a5b46);
  } else if (biome === 'desert') {
    p.bg.setHex(0xbfe0ef); p.fog.setHex(0xecd9ae);
    p.dirColor.setHex(0xfff0c2); p.hemiSky.setHex(0xd8ecf5); p.hemiGround.setHex(0x8a6f42);
    p.dirIntensity = 2.5;
  } else if (biome === 'lake_forest') {
    p.bg.setHex(0x8ed0f0); p.fog.setHex(0xcfe8dc);
    p.hemiSky.setHex(0xaadff2); p.hemiGround.setHex(0x3d6a30);
  }
  return p;
}

const NIGHT_BASE = (): DayNightPalette => ({
  bg: new THREE.Color(0x060d1c),
  fog: new THREE.Color(0x0a1526),
  // Weak BLUE moonlight — bright enough to keep real 512² shadows with subtle
  // contrast (Prompt 3.4 item 6), dark enough to read unmistakably as night.
  dirColor: new THREE.Color(0x8fa8e8),
  dirIntensity: 0.85,
  ambientIntensity: 0.34,
  hemiSky: new THREE.Color(0x182347),
  hemiGround: new THREE.Color(0x141d18),
  sunEmissive: 0xdfe7ff,
  starOpacity: 0.9,
  sunY: -40,
});

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

  // Live pipe-connection preview (source port → cursor)
  private pipePreviewLine!: THREE.Line;
  private pipePreviewCursor!: THREE.Mesh;

  // Sky / celestial bodies
  private skyDome!: THREE.Mesh;
  private skyMatDay!: THREE.ShaderMaterial;
  private sunMesh!: THREE.Mesh;
  private stars!: THREE.Points;
  private starsMat!: THREE.PointsMaterial;

  // Unified simulation clock (Prompt 3.3 items 9–14): the visual world runs on
  // SIMULATED time — pause freezes everything, fast-forward speeds the whole
  // world up proportionally. Camera & UI stay on REAL time.
  private gameTimeDays = 0;        // authoritative clock, pushed from GameManager
  private worldTimeScale = 1;      // 0 = paused, 1 / 2 / 5
  private visualSimElapsed = 0;    // simulated seconds accumulator for animations
  /** Last day/night blend applied to the rig; -1 forces the first apply. */
  private lastAppliedDayFactor = -1;

  // Adaptive resolution state (item E): slow, stable, capped adjustments.
  private basePixelRatio: number;
  private currentPixelRatio: number;
  private adaptTimer = 0;
  private frameTimeAccum = 0;
  private frameCount = 0;

  // Dev-only FPS telemetry (item 19 of P3.3). Enabled with
  // setTelemetryEnabled(true) or ?fps=1 — never shown in normal play.
  private telemetryEnabled = false;
  private telemetryFrames = 0;
  private telemetryAccum = 0;

  // Dev-only post-FX bypass (?nopost=1): renders straight to the canvas so
  // composer-related regressions can be isolated visually. ?nopost=gtao /
  // ?nopost=bloom disable the individual passes for bisection.
  private postDisabled = false;
  private _devDisableGtao = false;
  private _devDisableBloom = false;

  // ── Post-processing: subtle AO + bloom (Prompt 3.4 items 7–8) ──
  private composer!: EffectComposer;
  private gtaoPass: GTAOPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private outputPass!: OutputPass;

  // Automatic quality scaling state (item 10)
  private qualityIndex = 0;
  private qualityCooldown = 0; // seconds since last tier change

  // Smooth day/night blending palettes (instance palettes so biomes can tint)
  private dayPal: DayNightPalette = makeDay();
  private nightPal: DayNightPalette = NIGHT_BASE();

  // Street-light pool: reassign the bounded real lights to the lamps
  // nearest the camera at a modest cadence (items 4–5).
  private lightPoolTimer = 0;

  private animationFrameId: number | null = null;
  // NOTE: no THREE.Clock anywhere — world animation runs on visualSimElapsed,
  // which accumulates simulated time only (pause freezes it, fast-forward
  // scales it). Real-time needs use the rAF timestamp directly.
  private lastFrameTime: number = 0;

  constructor(container: HTMLDivElement, mapWidth: number = 24, mapDepth: number = 20) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = this.dayPal.bg.clone();
    this.scene.fog = new THREE.FogExp2(this.dayPal.fog.getHex(), 0.0045);

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
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.currentPixelRatio = this.basePixelRatio;
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.ambientLight = new THREE.AmbientLight(0xffffff, this.dayPal.ambientIntensity);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(this.dayPal.hemiSky.getHex(), this.dayPal.hemiGround.getHex(), 0.55);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(this.dayPal.dirColor.getHex(), this.dayPal.dirIntensity);
    this.dirLight.position.set(45, this.dayPal.sunY, 30);
    // THE single shadow-casting light in the whole scene (day only — the moon
    // does not cast shadows at night; fake pools carry night readability).
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = DAY_SHADOW_MAP_SIZE;
    this.dirLight.shadow.mapSize.height = DAY_SHADOW_MAP_SIZE;
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

    // Post-processing chain: Render → GTAO (subtle, reduced res) → Bloom
    // (restrained) → OutputPass (tone mapping + sRGB). Official three addons.
    this._buildComposer(w, h);

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

    // Pipe connection preview: bright dashed-style line + cursor ring
    const previewGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
    ]);
    this.pipePreviewLine = new THREE.Line(
      previewGeo,
      new THREE.LineBasicMaterial({ color: 0x34e0ff, transparent: true, opacity: 0.95, depthTest: false })
    );
    this.pipePreviewLine.renderOrder = 999;
    this.pipePreviewLine.visible = false;
    this.pipePreviewLine.frustumCulled = false;
    this.scene.add(this.pipePreviewLine);

    this.pipePreviewCursor = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.07, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x34e0ff, transparent: true, opacity: 0.9, depthTest: false })
    );
    this.pipePreviewCursor.rotation.x = Math.PI / 2;
    this.pipePreviewCursor.renderOrder = 999;
    this.pipePreviewCursor.visible = false;
    this.scene.add(this.pipePreviewCursor);

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
      new THREE.MeshBasicMaterial({ color: this.dayPal.sunEmissive, fog: false })
    );
    this.sunMesh.position.set(180, this.dayPal.sunY, 90);
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

  /**
   * Builds the post-processing chain (items 7–8): subtle GTAO + restrained
   * bloom. AO runs at reduced resolution with a small radius; bloom uses a
   * high threshold and low strength so only lamp bulbs halo — never the scene.
   */
  private _buildComposer(w: number, h: number) {
    // Dev bypass: ?nopost=1 skips the whole chain; ?nopost=gtao / ?nopost=bloom
    // disable individual passes (composer-regression diagnostics).
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('nopost');
      this.postDisabled = q === '1';
      this._devDisableGtao = q === 'gtao';
      this._devDisableBloom = q === 'bloom';
    }
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.cameraController.camera));

    const tier = QUALITY_TIERS[this.qualityIndex];
    // Dev: ?gtaoOutput=<normal|depth|ao> shows raw G-buffer/AO (bisection).
    let devGtaoOutput: number | null = null;
    if (typeof window !== 'undefined') {
      const go = new URLSearchParams(window.location.search).get('gtaoOutput');
      if (go === 'normal') devGtaoOutput = GTAOPass.OUTPUT.Normal;
      else if (go === 'depth') devGtaoOutput = GTAOPass.OUTPUT.Depth;
      else if (go === 'ao') devGtaoOutput = GTAOPass.OUTPUT.AO;
    }
    if (tier.ao || devGtaoOutput !== null) {
      try {
        const gtao = new GTAOPass(this.scene, this.cameraController.camera, w, h);
        gtao.updateGtaoMaterial({
          // Small radius + modest budget → "grounded", not "outlined".
          radius: 0.35,
          distanceExponent: 1.2,
          thickness: 1.0,
          scale: 1.0,
          samples: 8,
          distanceFallOff: 1.0,
          screenSpaceRadius: false,
        });
        // Half-resolution AO when the tier demands it (weak GPUs).
        gtao.setSize(w * (tier.aoHalfRes ? 0.5 : 1), h * (tier.aoHalfRes ? 0.5 : 1));
        gtao.output = devGtaoOutput ?? GTAOPass.OUTPUT.Default;
        this.composer.addPass(gtao);
        this.gtaoPass = gtao;
      } catch {
        // AO is polish, not a requirement — never block startup on it.
        this.gtaoPass = null;
      }
    }
    if (this.gtaoPass && this._devDisableGtao) this.gtaoPass.enabled = false;

    // Restrained luminance-threshold bloom: small warm halos around lamps.
    const bloomRes = new THREE.Vector2(w * tier.bloomRes, h * tier.bloomRes);
    this.bloomPass = new UnrealBloomPass(bloomRes, /*strength*/ 0.28, /*radius*/ 0.45, /*threshold*/ 0.92);
    this.composer.addPass(this.bloomPass);
    if (this._devDisableBloom) this.bloomPass.enabled = false;

    // OutputPass applies tone mapping + color-space conversion at the end.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    this.composer.setSize(w, h);
  }

  /** Rebuilds post-FX for a quality tier without touching lights or scene. */
  private _applyQualityTier(tier: QualityTier, w: number, h: number) {
    if (this.gtaoPass) {
      this.gtaoPass.enabled = tier.ao;
      if (tier.ao) {
        this.gtaoPass.setSize(w * (tier.aoHalfRes ? 0.5 : 1), h * (tier.aoHalfRes ? 0.5 : 1));
      }
    }
    if (this.bloomPass) {
      this.bloomPass.resolution.set(w * tier.bloomRes, h * tier.bloomRes);
      this.bloomPass.setSize(w * tier.bloomRes, h * tier.bloomRes);
    }
    // Street-light pool cap & local shadow casters live in TerrainGrid.
    this.terrainGrid.applyQualityBudget(tier.maxStreetLights, tier.localShadowLights);
    // Directional shadow map day size (night always uses NIGHT_SHADOW_MAP_SIZE).
    if (this.dirLight.shadow.mapSize.width !== tier.dirShadowSize) {
      this.dirLight.shadow.mapSize.set(tier.dirShadowSize, tier.dirShadowSize);
      if (this.dirLight.shadow.map) {
        this.dirLight.shadow.map.dispose();
        // three re-creates the map lazily on the next shadow render
        (this.dirLight.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
      }
    }
  }

  private _startLoop() {
    const animate = (timestamp: number) => {
      this.animationFrameId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, (timestamp - this.lastFrameTime) / 1000);
      this.lastFrameTime = timestamp;

      // ── REAL TIME (item 12): camera + UI-facing motion never scale with the
      // simulation speed — panning/orbiting feels identical at pause and 5×.
      this.cameraController.update(dt);

      // ── SIMULATED TIME (items 9/11/13): ONE authoritative world clock.
      // Pause ⇒ simDt = 0 ⇒ vehicles/river/clouds/machinery freeze cleanly.
      // 5× ⇒ every world animation advances 5× per real second. Exactly one
      // requestAnimationFrame loop and one render per frame regardless (item 18).
      const simDt = dt * this.worldTimeScale;
      this.visualSimElapsed += simDt;

      // ── DAY/NIGHT FROM THE ACTUAL GAME CLOCK (item 15): the lighting state
      // is a pure function of gameTimeDays — dawn/day/sunset/night come from
      // the simulated clock, so sunset progresses 5× faster at 5× and freezing
      // mid-sunset at pause holds the blend. No independent boolean lerp.
      const dayFactor = getDayNightFactor(this.gameTimeDays);
      if (this.lastAppliedDayFactor < 0 || Math.abs(dayFactor - this.lastAppliedDayFactor) > 0.0008) {
        this.lastAppliedDayFactor = dayFactor;
        const nf = 1 - dayFactor; // 0 = full day, 1 = full night
        const bg = this.dayPal.bg.clone().lerp(this.nightPal.bg, nf);
        const fg = this.dayPal.fog.clone().lerp(this.nightPal.fog, nf);
        this.scene.background = bg;
        (this.scene.fog as THREE.FogExp2).color.copy(fg);
        this.dirLight.color.copy(this.dayPal.dirColor).lerp(this.nightPal.dirColor, nf);
        this.dirLight.intensity = lerpN(this.dayPal.dirIntensity, this.nightPal.dirIntensity, nf);
        this.ambientLight.intensity = lerpN(this.dayPal.ambientIntensity, this.nightPal.ambientIntensity, nf);
        this.hemiLight.color.copy(this.dayPal.hemiSky).lerp(this.nightPal.hemiSky, nf);
        this.hemiLight.groundColor.copy(this.dayPal.hemiGround).lerp(this.nightPal.hemiGround, nf);
        this.skyMatDay.uniforms.nightFactor.value = nf;
        (this.sunMesh.material as THREE.MeshBasicMaterial).color.setHex(nf > 0.5 ? this.nightPal.sunEmissive : this.dayPal.sunEmissive);
        this.starsMat.opacity = lerpN(this.dayPal.starOpacity, this.nightPal.starOpacity, nf);
        this.sunMesh.position.y = lerpN(this.dayPal.sunY, this.nightPal.sunY, nf);
        this.sunMesh.visible = this.sunMesh.position.y > -25 || nf < 0.5;
        // Shadow budget (Prompt 3.4 item 6): the directional light NEVER goes
        // fully shadowless — by day it's the sun @1024², at night a weak blue
        // moon keeps real depth @512². Dusk/dawn interpolates intensity while
        // the map size switches once at the midpoint (cheap, stable).
        const wantNightMap = dayFactor <= 0.4;
        const wantSize = wantNightMap ? NIGHT_SHADOW_MAP_SIZE : DAY_SHADOW_MAP_SIZE;
        if (this.dirLight.shadow.mapSize.width !== wantSize) {
          this.dirLight.shadow.mapSize.set(wantSize, wantSize);
          if (this.dirLight.shadow.map) {
            this.dirLight.shadow.map.dispose();
            // three re-creates the map lazily on the next shadow render
            (this.dirLight.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
          }
        }
      }

      // WORLD runs on simulated time (vehicles, river, foam, clouds, lamps)
      this.terrainGrid.tick(simDt, this.visualSimElapsed, 1 - dayFactor);

      // Street-light pool: reassign the bounded real lights to the lamps
      // nearest the camera at a modest cadence (items 4–5).
      this.lightPoolTimer += dt;
      if (this.lightPoolTimer >= LIGHT_POOL_INTERVAL_SEC) {
        this.lightPoolTimer = 0;
        // CameraController.target is the live look-at focus on the ground.
        const camFocus = this.cameraController.target;
        this.terrainGrid.updateLightPool(camFocus.x, camFocus.z);
      }

      // PROCESS MACHINERY on simulated time too
      for (const mesh of this.unitMeshMap.values()) {
        UnitMeshBuilder.updateUnitAnimation(mesh, this.visualSimElapsed);
      }
      this._animateGhostSuggest(this.visualSimElapsed);

      // ── AUTOMATIC QUALITY SCALING (item 10): steps down one tier when FPS
      // is poor, climbs back only after sustained health. Never removes real
      // lighting — it trims AO res → bloom res → street count → shadow count
      // → dir map → pixel ratio, in that order.
      this.frameTimeAccum += dt;
      this.frameCount++;
      this.adaptTimer += dt;
      this.qualityCooldown = Math.max(0, this.qualityCooldown - ADAPT_INTERVAL_SEC);
      if (this.adaptTimer >= ADAPT_INTERVAL_SEC) {
        const avgFps = this.frameCount / Math.max(1e-4, this.frameTimeAccum);
        let changedQuality = false;
        if (avgFps < 26 && this.qualityIndex < QUALITY_TIERS.length - 1 && this.qualityCooldown === 0) {
          this.qualityIndex++;
          changedQuality = true;
        } else if (avgFps > 55 && this.qualityIndex > 0 && this.qualityCooldown === 0) {
          this.qualityIndex--;
          changedQuality = true;
        }
        if (changedQuality) {
          this._applyQualityTier(QUALITY_TIERS[this.qualityIndex], window.innerWidth, window.innerHeight);
          this.qualityCooldown = 3; // hold for ≥2 evaluation windows before next change
        } else {
          // Pixel-ratio fallback remains the LAST resort, below all tiers.
          if (avgFps < 22 && this.currentPixelRatio > MIN_PIXEL_RATIO + 1e-3) {
            this.currentPixelRatio = Math.max(MIN_PIXEL_RATIO, this.currentPixelRatio - 0.15);
            this.renderer.setPixelRatio(this.currentPixelRatio);
          } else if (avgFps > 55 && this.currentPixelRatio < this.basePixelRatio - 1e-3) {
            this.currentPixelRatio = Math.min(this.basePixelRatio, this.currentPixelRatio + 0.05);
            this.renderer.setPixelRatio(this.currentPixelRatio);
          }
        }
        this.adaptTimer = 0;
        this.frameTimeAccum = 0;
        this.frameCount = 0;
      }

      // Dev-only telemetry (item 19): console lines, never on-screen HUD.
      if (this.telemetryEnabled) {
        this.telemetryFrames++;
        this.telemetryAccum += dt;
        if (this.telemetryAccum >= 1) {
          const msPerFrame = (this.telemetryAccum / this.telemetryFrames) * 1000;
          console.log(
            `[aquateycoon-fps] ${this.telemetryFrames} fps · ${msPerFrame.toFixed(2)} ms/frame · ` +
            `ratio ${this.currentPixelRatio.toFixed(2)} · ${dayFactor > 0.5 ? 'day' : 'night'} · ` +
            `${this.worldTimeScale}× · dirShadow ${SceneManager.dirShadowLabel(dayFactor)}² · ` +
            `quality tier ${this.qualityIndex}`
          );
          this.telemetryFrames = 0;
          this.telemetryAccum = 0;
        }
      }

      // Post-processing chain ends in OutputPass (tone mapping + sRGB);
      // ?nopost=1 bypasses it for composer-regression diagnostics.
      if (this.postDisabled) {
        this.renderer.render(this.scene, this.cameraController.camera);
      } else {
        this.composer.render();
      }
    };
    this.lastFrameTime = performance.now();
    animate(this.lastFrameTime);
  }

  /** Telemetry helper: current directional shadow-map size label. */
  private static dirShadowLabel(dayFactor: number): string {
    return dayFactor <= 0.4 ? String(NIGHT_SHADOW_MAP_SIZE) : String(DAY_SHADOW_MAP_SIZE);
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

  // ── CONSTRUCTION-BUILDER Phase 1: player-drawn basins ──────────────────────
  private basinGroup: THREE.Group = new THREE.Group();
  private basinMeshMap: Map<string, THREE.Group> = new Map();
  // P4 slice 2: in-world basin wall drag-handles + grouping brackets
  private basinHandleGroup: THREE.Group = new THREE.Group();
  private bracketGroup: THREE.Group = new THREE.Group();
  // P4 slice 3: floating in-world dimension labels for selected basins
  private dimensionLabelGroup: THREE.Group = new THREE.Group();
  private dimensionSpriteMap: Map<string, THREE.Sprite> = new Map();
  // P5: in-world equipment drag handle (grab to move, live ghost polish)
  private equipDragHandleGroup: THREE.Group = new THREE.Group();
  // ITER 58: edge-snap alignment guides — dashed amber lines at snapped edges
  private snapGuideGroup: THREE.Group = new THREE.Group();
  private snapVLine: THREE.Line | null = null;
  private snapHLine: THREE.Line | null = null;

  /**
   * Renders each player-drawn CustomBasin as a real in-world structure:
   * floor slab + four perimeter walls + a water/empty volume. The footprint
   * is the exact drawn rectangle; depth comes from basin.depthM. Called from
   * App after every place/demolish. Mirrors syncUnits' add/remove discipline.
   */
  public syncBasins(basins: { id: string; x: number; y: number; w: number; h: number; depthM: number }[], selectedId?: string | Set<string> | null) {
    if (!this.basinGroup.parent) this.scene.add(this.basinGroup);
    const activeIds = new Set(basins.map(b => b.id));

    for (const [id, mesh] of this.basinMeshMap.entries()) {
      if (!activeIds.has(id)) {
        this.basinGroup.remove(mesh);
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.geometry) mm.geometry.dispose();
        });
        this.basinMeshMap.delete(id);
      }
    }

    for (const b of basins) {
      let mesh = this.basinMeshMap.get(b.id);
      const needsRebuild = mesh && (
        (mesh as any)._basinW !== b.w ||
        (mesh as any)._basinH !== b.h ||
        (mesh as any)._basinDepth !== b.depthM
      );
      if (needsRebuild && mesh) {
        this.basinGroup.remove(mesh);
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.geometry) mm.geometry.dispose();
        });
        this.basinMeshMap.delete(b.id);
        mesh = undefined as any;
      }
      if (!mesh) {
        mesh = this.buildBasinMesh(b);
        (mesh as any)._basinW = b.w;
        (mesh as any)._basinH = b.h;
        (mesh as any)._basinDepth = b.depthM;
        this.basinMeshMap.set(b.id, mesh);
        this.basinGroup.add(mesh);
      }
      // Selected basin gets a subtle emerald tint — now supports multi-select Set
      const selected = selectedId instanceof Set ? selectedId.has(b.id) : b.id === selectedId;
      mesh.traverse(o => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh && mm.material) {
          const mat = Array.isArray(mm.material) ? mm.material[0] : mm.material;
          const m = mat as THREE.MeshStandardMaterial;
          if (m && (m as any)._basinBase) {
            m.emissive.setHex(selected ? 0x0c5a3a : 0x000000);
            m.emissiveIntensity = selected ? 0.6 : 0;
          }
        }
      });
      // ITER 63 — foundation ground-condition visual: apron + subtle wall/floor tint
      // The apron makes cheap rocky vs soft ground tangibly visible from overview,
      // not just as a number in the inspector — BUILD THE PROCESS means the site
      // itself tells the cost story.
      try {
        const factor = terrainFactorForRect(b as unknown as BasinRect);
        const tone = foundationConditionTone(factor);
        const hex = FOUNDATION_TONE_HEX[tone];
        // Apron: solid foundation colour outside the walls (selection does NOT override)
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if ((mm as any)._isFoundationApron) {
            const mat = mm.material as THREE.MeshStandardMaterial;
            mat.color.setHex(hex);
            mat.emissive.setHex(hex);
            mat.emissiveIntensity = 0.11;
          }
        });
        // Floor/wall subtle tint: lerp base concrete toward the tone so the whole
        // basin shell hints at ground difficulty while keeping selection legible.
        const tFloor = 0.22, tWall = 0.14;
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.isMesh && mm.material) {
            const mat = Array.isArray(mm.material) ? mm.material[0] : mm.material as THREE.MeshStandardMaterial;
            const m = mat as THREE.MeshStandardMaterial;
            if ((m as any)._basinBase) {
              const baseHex = (m as any)._baseHex as number | undefined;
              if (typeof baseHex === 'number') {
                const baseCol = new THREE.Color(baseHex);
                const toneCol = new THREE.Color(hex);
                const t = baseHex === 0x8d9097 ? tFloor : tWall;
                baseCol.lerp(toneCol, t);
                m.color.copy(baseCol);
              }
            }
          }
        });
        (mesh as any)._foundationHex = hex;
        (mesh as any)._foundationTone = tone;
        (mesh as any)._terrainFactor = factor;
      } catch {}
      // Basin footprint origin in world space (tile centers at +0.5).
      mesh.position.set(b.x, 0, b.y);
    }
    // P4 slice 2: sync 3D wall drag-handles for the lone selected basin,
    // and grouping brackets for multi-select — mirrors syncUnits discipline.
    {
      let solo: { x: number; y: number; w: number; h: number; depthM: number } | null = null;
      if (selectedId instanceof Set) {
        if (selectedId.size === 1) solo = basins.find(b => selectedId.has(b.id)) ?? null;
      } else if (typeof selectedId === 'string' && selectedId) {
        solo = basins.find(b => b.id === selectedId) ?? null;
      }
      this.syncBasinHandles(solo);
      // Grouping brackets: multi-select draws corner brackets around each selected tile group
      if (selectedId instanceof Set && selectedId.size > 1) {
        const selBasins = basins.filter(b => (selectedId as Set<string>).has(b.id));
        // brackets for selected basins + for selected equipment/utility/baffle counted via canvas highlight —
        // basin brackets are the primary grouping cue; equipment brackets ride on amber selection glow
        this.syncSelectionBrackets(selBasins.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })));
      } else {
        this.syncSelectionBrackets(null);
      }
    }
  }

  /**
   * In-world basin wall drag-handles (P4 slice 2) — 8 small amber handles at
   * wall-top edge midpoints and corners when a single basin is selected.
   * Each handle is a small emissive box so the player sees grip points; the
   * drag logic itself uses tile-edge hit-testing (forgiving), not raycasts.
   */
  public syncBasinHandles(basin: { x: number; y: number; w: number; h: number; depthM: number } | null) {
    if (!this.basinHandleGroup.parent) this.scene.add(this.basinHandleGroup);
    // clear
    for (const c of [...this.basinHandleGroup.children]) {
      this.basinHandleGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    if (!basin) return;
    const depth = Math.max(1, basin.depthM);
    const yTop = depth + 0.12; // just above wall top
    const matCorner = new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0x8a5200, emissiveIntensity: 0.55, roughness: 0.5 });
    const matEdge = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x78350f, emissiveIntensity: 0.45, roughness: 0.5 });
    const mkHandle = (lx: number, lz: number, isCorner: boolean) => {
      const s = isCorner ? 0.34 : 0.30;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, 0.18, s), isCorner ? matCorner : matEdge);
      // world = basin origin + local (basin positioned at (x, y) in xz)
      m.position.set(basin.x + lx, yTop, basin.y + lz);
      m.castShadow = true;
      this.basinHandleGroup.add(m);
    };
    const cx = basin.w / 2;
    const cz = basin.h / 2;
    const w = basin.w, h = basin.h;
    // corners
    mkHandle(0, 0, true); mkHandle(w, 0, true); mkHandle(0, h, true); mkHandle(w, h, true);
    // edge midpoints (inset by 0 for north/south, but at mid)
    mkHandle(cx, 0, false); mkHandle(cx, h, false); mkHandle(0, cz, false); mkHandle(w, cz, false);
  }

  /**
   * P5 — In-world equipment drag handle: single amber box floating above the
   * lone selected machine. Grab and drag to reposition with live ghost preview
   * (green = valid, red = blocked). Mirrors syncBasinHandles discipline.
   */
  public syncEquipmentDragHandle(item: { x: number; y: number; typeId?: string } | null, basins: { x: number; y: number; w: number; h: number; depthM: number }[] = []) {
    if (!this.equipDragHandleGroup.parent) this.scene.add(this.equipDragHandleGroup);
    for (const c of [...this.equipDragHandleGroup.children]) {
      this.equipDragHandleGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      const mat = (c as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) (mat as any).dispose?.();
    }
    if (!item) return;
    // Handle height: above water for in-basin, above plinth for ground kit
    const host = basins.find(b => item.x >= b.x && item.x < b.x + b.w && item.y >= b.y && item.y < b.y + b.h);
    const yTop = host ? Math.max(1, host.depthM) + 0.55 : 1.15;
    const isGround = !host;
    const matHandle = new THREE.MeshStandardMaterial({
      color: isGround ? 0xf59e0b : 0xfbbf24,
      emissive: isGround ? 0x78350f : 0x92400e,
      emissiveIntensity: 0.55,
      roughness: 0.45,
    });
    const stemMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0x78350f, emissiveIntensity: 0.35, roughness: 0.5 });
    // Vertical stem from machine top to handle
    const stemH = yTop - 0.35;
    if (stemH > 0.05) {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, stemH, 8), stemMat);
      stem.position.set(item.x + 0.5, 0.35 + stemH / 2, item.y + 0.5);
      stem.castShadow = true;
      this.equipDragHandleGroup.add(stem);
    }
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.32), matHandle);
    box.position.set(item.x + 0.5, yTop, item.y + 0.5);
    box.castShadow = true;
    // Small arrow hint on top
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.14, 4), matHandle);
    cone.position.set(item.x + 0.5, yTop + 0.16, item.y + 0.5);
    cone.rotation.y = Math.PI / 4;
    this.equipDragHandleGroup.add(box);
    this.equipDragHandleGroup.add(cone);
  }

  /**
   * ITER 58: Edge-snap alignment guides — dashed amber lines at the snapped
   * tile edge(s) while dragging. Map-spanning so alignment is readable.
   */
  public setSnapGuides(vGuide: number | null, hGuide: number | null, mapSize: [number, number] = [24, 20]) {
    const [mapW, mapH] = mapSize;
    const ensure = () => { if (!this.snapGuideGroup.parent) this.scene.add(this.snapGuideGroup); };
    const mk = (pts:any) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts as any);
      const mat = new THREE.LineDashedMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.92, linewidth: 2, dashSize: 0.35, gapSize: 0.22 });
      const line = new THREE.Line(geo, mat as any);
      (line as any).computeLineDistances();
      line.frustumCulled = false;
      (line as any).renderOrder = 950;
      return line;
    };
    if (vGuide !== null && Number.isFinite(vGuide)) {
      ensure();
      const pts = [new THREE.Vector3(vGuide, 0.06, 0), new THREE.Vector3(vGuide, 0.06, mapH)];
      if (!this.snapVLine) { this.snapVLine = mk(pts); this.snapGuideGroup.add(this.snapVLine); }
      else {
        const pos = this.snapVLine.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, vGuide, 0.06, 0); pos.setXYZ(1, vGuide, 0.06, mapH); pos.needsUpdate = true;
        (this.snapVLine.geometry as THREE.BufferGeometry).computeBoundingSphere();
        this.snapVLine.computeLineDistances();
      }
      this.snapVLine.visible = true;
    } else if (this.snapVLine) this.snapVLine.visible = false;
    if (hGuide !== null && Number.isFinite(hGuide)) {
      ensure();
      const pts = [new THREE.Vector3(0, 0.06, hGuide), new THREE.Vector3(mapW, 0.06, hGuide)];
      if (!this.snapHLine) { this.snapHLine = mk(pts); this.snapGuideGroup.add(this.snapHLine); }
      else {
        const pos = this.snapHLine.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, 0, 0.06, hGuide); pos.setXYZ(1, mapW, 0.06, hGuide); pos.needsUpdate = true;
        this.snapHLine.geometry.computeBoundingSphere();
        this.snapHLine.computeLineDistances();
      }
      this.snapHLine.visible = true;
    } else if (this.snapHLine) this.snapHLine.visible = false;
  }
  public clearSnapGuides() { this.setSnapGuides(null, null); }

  /**
   * Grouping brackets for multi-select — corner L-brackets around each selected rect.
   * Lightweight LineSegments so they read as selection grouping, not solid walls.
   */
  public syncSelectionBrackets(rects: { x: number; y: number; w: number; h: number }[] | null) {
    if (!this.bracketGroup.parent) this.scene.add(this.bracketGroup);
    for (const c of [...this.bracketGroup.children]) {
      this.bracketGroup.remove(c);
      const line = c as THREE.LineSegments;
      (line.geometry as THREE.BufferGeometry)?.dispose();
      (line.material as THREE.Material)?.dispose();
    }
    if (!rects || rects.length === 0) return;
    for (const r of rects) {
      // bracket lines: 4 corners each L with 0.9m legs, y just above ground 0.35m
      // Clamp leg so very small rects (baffles/equipment 1×1) don't overlap
      const y = 0.35;
      const leg = Math.min(0.9, Math.min(r.w, r.h) * 0.45 + 0.15);
      const pts: THREE.Vector3[] = [];
      const corners: [number, number][] = [
        [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
      ];
      for (const [cx, cz] of corners) {
        // Each corner emits two leg segments (axis-aligned)
        const onWest = cx === r.x;
        const onNorth = cz === r.y;
        const dx = onWest ? leg : -leg;
        const dz = onNorth ? leg : -leg;
        pts.push(new THREE.Vector3(cx, y, cz), new THREE.Vector3(cx + dx, y, cz));
        pts.push(new THREE.Vector3(cx, y, cz), new THREE.Vector3(cx, y, cz + dz));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 2, transparent: true, opacity: 0.95 });
      const line = new THREE.LineSegments(geo, mat);
      this.bracketGroup.add(line);
    }
  }

  /**
   * P4 slice 3 — Floating in-world dimension labels for selected basins.
   * Each selected basin gets a canvas-texture Sprite hovering above its centre
   * (e.g. "18×12 m · 4.0 m deep · 864 m³"). Mirrors syncUnits discipline:
   * add/remove/dispose; also disposes textures on removal.
   */
  public syncDimensionLabels(
    basins: { id: string; x: number; y: number; w: number; h: number; depthM: number }[],
    selectedIds: Set<string> | string | null,
  ) {
    if (!this.dimensionLabelGroup.parent) this.scene.add(this.dimensionLabelGroup);
    const wanted = new Set<string>();
    if (selectedIds instanceof Set) {
      for (const id of selectedIds) wanted.add(id);
    } else if (typeof selectedIds === 'string' && selectedIds) {
      wanted.add(selectedIds);
    }
    // Remove sprites for basins no longer selected or demolished
    for (const [id, sprite] of this.dimensionSpriteMap.entries()) {
      if (!wanted.has(id) || !basins.some(b => b.id === id)) {
        this.dimensionLabelGroup.remove(sprite);
        const mat = sprite.material as THREE.SpriteMaterial;
        (mat.map as THREE.Texture | null)?.dispose();
        mat.dispose();
        this.dimensionSpriteMap.delete(id);
      }
    }
    if (wanted.size === 0) return;
    // Headless guard — no DOM in node tests
    if (typeof document === 'undefined') return;
    for (const b of basins) {
      if (!wanted.has(b.id)) continue;
      const label = this.basinLabelText(b);
      const existing = this.dimensionSpriteMap.get(b.id);
      if (existing && (existing as any)._labelText === label && Math.abs((existing as any)._depthM - b.depthM) < 0.01) {
        // Update position if basin moved/resized (depth influences y)
        existing.position.set(b.x + b.w / 2, Math.max(1, b.depthM) + 1.55, b.y + b.h / 2);
        continue;
      }
      // Recreate if text/depth changed
      if (existing) {
        this.dimensionLabelGroup.remove(existing);
        const mat = existing.material as THREE.SpriteMaterial;
        (mat.map as THREE.Texture | null)?.dispose();
        mat.dispose();
        this.dimensionSpriteMap.delete(b.id);
      }
      const sprite = this.makeDimensionSprite(label);
      sprite.position.set(b.x + b.w / 2, Math.max(1, b.depthM) + 1.55, b.y + b.h / 2);
      (sprite as any)._labelText = label;
      (sprite as any)._depthM = b.depthM;
      this.dimensionLabelGroup.add(sprite);
      this.dimensionSpriteMap.set(b.id, sprite);
    }
  }

  private basinLabelText(b: { w: number; h: number; depthM: number }): string {
    const lenM = b.w * 6;
    const widM = b.h * 6;
    const vol = b.w * 6 * b.h * 6 * Math.max(1, b.depthM);
    return `${lenM}×${widM} m · ${b.depthM.toFixed(1)} m deep · ${Math.round(vol).toLocaleString()} m³`;
  }

  private makeDimensionSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const w = 560; const h = 64;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    // Background pill
    ctx.fillStyle = 'rgba(15,23,42,0.88)';
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(245,158,11,0.55)';
    ctx.lineWidth = 2; ctx.stroke();
    // Text
    ctx.fillStyle = '#fde68a';
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(5.2, 0.62, 1);
    sprite.renderOrder = 900;
    sprite.frustumCulled = false;
    return sprite;
  }

  private buildBasinMesh(b: { w: number; h: number; depthM: number }): THREE.Group {
    const g = new THREE.Group();
    const wallT = 0.25;                 // 25 cm concrete wall
    const depth = Math.max(1, b.depthM);

    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.85, metalness: 0.05 });
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x8d9097, roughness: 0.9 });
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x3b7fa6, roughness: 0.25, metalness: 0.0,
      transparent: true, opacity: 0.6,
    });
    // Mark structural (non-water) materials so the selection highlight can
    // tint only the concrete shell, not the water volume.
    (concrete as any)._basinBase = true;
    (floorMat as any)._basinBase = true;
    // Store base hexes so floor/wall tinting toward foundation tone can be
    // recomputed without accumulating lerp drift when the basin moves terrain.
    (concrete as any)._baseHex = 0xb9bcc2;
    (floorMat as any)._baseHex = 0x8d9097;

    // Floor slab
    const floor = new THREE.Mesh(new THREE.BoxGeometry(b.w, 0.2, b.h), floorMat);
    floor.position.set(b.w / 2, -0.1, b.h / 2);
    floor.receiveShadow = true;
    g.add(floor);

    // Four perimeter walls (open-top)
    const mkWall = (w: number, l: number, px: number, pz: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, depth, l), concrete);
      m.position.set(px, depth / 2, pz);
      m.castShadow = true; m.receiveShadow = true;
      return m;
    };
    g.add(mkWall(b.w, wallT, b.w / 2, wallT / 2));            // north
    g.add(mkWall(b.w, wallT, b.w / 2, b.h - wallT / 2));     // south
    g.add(mkWall(wallT, b.h, wallT / 2, b.h / 2));            // west
    g.add(mkWall(wallT, b.h, b.w - wallT / 2, b.h / 2));      // east

    // Water / empty volume (slightly inset, sits above floor)
    const water = new THREE.Mesh(
      new THREE.BoxGeometry(b.w - 2 * wallT, depth * 0.85, b.h - 2 * wallT),
      waterMat
    );
    water.position.set(b.w / 2, 0.2 + (depth * 0.85) / 2, b.h / 2);
    g.add(water);

    // ── ITER 63: foundation apron — thin ground pad outside the walls
    // coloured by terrain condition (emerald/sky/amber/rose). The pad makes
    // foundation cost tangible in-world: soft (green) vs rocky (rose) reads
    // at a glance from overview, not just in the inspector.
    const apronMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, roughness: 0.92, metalness: 0.03,
      emissive: 0x000000, emissiveIntensity: 0,
    });
    // Do NOT mark as _basinBase — apron keeps its foundation colour even
    // when the basin is selected (selection emissive tints only walls/floor).
    (apronMat as any)._isFoundationApronMat = true;
    const apron = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.46, 0.045, b.h + 0.46), apronMat);
    apron.position.set(b.w / 2, 0.022, b.h / 2);
    apron.receiveShadow = true;
    (apron as any)._isFoundationApron = true;
    g.add(apron);

    return g;
  }

  // ── CONSTRUCTION-BUILDER Phase 2: installed process equipment ──────────────
  private equipGroup: THREE.Group = new THREE.Group();
  private equipMeshMap: Map<string, THREE.Group> = new Map();

  /**
   * Renders each installed machine as a real in-world object: wet-installed
   * types sit on their basin's floor, ground types stand on open terrain.
   * Called from App after every install/demolish/load. Mirrors syncBasins'
   * add/remove/dispose discipline. Selection = amber emissive.
   */
  public syncEquipment(
    items: { id: string; typeId: string; x: number; y: number; rotation?: number }[],
    basins: { x: number; y: number; w: number; h: number; depthM: number }[],
    selectedId?: string | Set<string> | null,
    poweredIds?: Set<string> | null,
    aeratedIds?: Set<string> | null,
    filtration?: { liveMembraneIds?: Set<string>; degradedMembraneIds?: Set<string>; activeCarrierIds?: Set<string>; aeratedCarrierIds?: Set<string> } | null,
    chemical?: { poweredStorageIds?: Set<string>; activeDosingIds?: Set<string>; poweredDosingIds?: Set<string> } | null
  ) {
    if (!this.equipGroup.parent) this.scene.add(this.equipGroup);
    const activeIds = new Set(items.map(i => i.id));

    for (const [id, mesh] of this.equipMeshMap.entries()) {
      if (!activeIds.has(id)) {
        this.equipGroup.remove(mesh);
        mesh.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.geometry) mm.geometry.dispose();
        });
        this.equipMeshMap.delete(id);
      }
    }

    for (const it of items) {
      let mesh = this.equipMeshMap.get(it.id);
      if (!mesh) {
        const host = basins.find(b =>
          it.x >= b.x && it.x < b.x + b.w && it.y >= b.y && it.y < b.y + b.h
        );
        mesh = this.buildEquipmentMesh(it.typeId, host ? host.depthM : 0);
        // Tile centers sit at (+0.5, +0.5) in world tile space.
        mesh.position.set(it.x + 0.5, 0, it.y + 0.5);
        mesh.rotation.y = ((it.rotation ?? 0) * Math.PI) / 180;
        this.equipMeshMap.set(it.id, mesh);
        this.equipGroup.add(mesh);
      } else {
        // Keep mesh in sync when equipment is moved or rotated (P2 direct manipulation)
        const targetX = it.x + 0.5;
        const targetZ = it.y + 0.5;
        if (Math.abs(mesh.position.x - targetX) > 0.001 || Math.abs(mesh.position.z - targetZ) > 0.001) {
          mesh.position.set(targetX, 0, targetZ);
        }
        const targetRot = ((it.rotation ?? 0) * Math.PI) / 180;
        if (Math.abs(mesh.rotation.y - targetRot) > 0.001) mesh.rotation.y = targetRot;
      }
      const selected = selectedId instanceof Set ? selectedId.has(it.id) : it.id === selectedId;
      // ── Phase 4 functional status (power + aeration) ────────────────
      // Selection takes precedence (amber); otherwise unpowered machines glow
      // dim red and aerated diffusers get a cool blue shimmer so the player
      // can see at a glance what is actually live without opening a panel.
      const isDiffuser = it.typeId === 'fine_bubble_diffuser';
      const isMembrane = it.typeId === 'membrane_cassette';
      const isCarrier = it.typeId === 'mbbr_carrier';
      const isSensor = it.typeId === 'do_probe' || it.typeId === 'flow_meter' || it.typeId === 'level_sensor';
      const isStorage = it.typeId === 'chemical_storage_tank';
      const isDosing = it.typeId === 'chemical_dosing_pump';
      const isRoSkid = it.typeId === 'ro_skid';
      const isBrine = it.typeId === 'brine_tank';
      const isChp = it.typeId === 'biogas_chp_skid';
      const isUv = it.typeId === 'uv_channel';
      const isAop = it.typeId === 'aop_skid';
      const isPowered = !poweredIds || poweredIds.has(it.id);
      const isAerated = !aeratedIds || !isDiffuser || aeratedIds.has(it.id);
      // Phase 6 slice 2 filtration status for tinting
      const filtLive = filtration?.liveMembraneIds?.has(it.id) ?? false;
      const filtDegraded = filtration?.degradedMembraneIds?.has(it.id) ?? false;
      const carrierActive = filtration?.activeCarrierIds?.has(it.id) ?? false;
      const carrierAerated = filtration?.aeratedCarrierIds?.has(it.id) ?? false;
      const dosingActive = chemical?.activeDosingIds?.has(it.id) ?? false;
      const dosingPowered = chemical?.poweredDosingIds?.has(it.id) ?? false;
      const storagePowered = chemical?.poweredStorageIds?.has(it.id) ?? false;
      mesh.traverse(o => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh && mm.material) {
          const mat = Array.isArray(mm.material) ? mm.material[0] : mm.material;
          const m = mat as THREE.MeshStandardMaterial;
          if (m && (m as any)._equipBase) {
            if (selected) {
              m.emissive.setHex(0x8a5200);
              m.emissiveIntensity = 0.65;
            } else if (isMembrane) {
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else if (filtLive) {
                m.emissive.setHex(0x0ea5e9);
                m.emissiveIntensity = 0.52;
              } else if (filtDegraded) {
                m.emissive.setHex(0x92400e);
                m.emissiveIntensity = 0.38;
              } else {
                // Powered but no zone health info (should not happen) — amber hint
                m.emissive.setHex(0x6b4c1a);
                m.emissiveIntensity = 0.30;
              }
            } else if (isCarrier) {
              if (carrierAerated) {
                m.emissive.setHex(0x06b6d4);
                m.emissiveIntensity = 0.52;
              } else if (carrierActive) {
                m.emissive.setHex(0x38bdf8);
                m.emissiveIntensity = 0.34;
              } else {
                m.emissive.setHex(0x57534e);
                m.emissiveIntensity = 0.14;
              }
            } else if (isSensor) {
              // Phase 7 slice 2 instrumentation: powered sensors get a teal shimmer (live telemetry)
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else {
                m.emissive.setHex(0x14b8a6);
                m.emissiveIntensity = 0.48;
              }
            } else if (isStorage) {
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else if (storagePowered) {
                m.emissive.setHex(0x65a30d);
                m.emissiveIntensity = 0.48;
              } else {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              }
            } else if (isDosing) {
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else if (dosingActive) {
                m.emissive.setHex(0x84cc16);
                m.emissiveIntensity = 0.52;
              } else if (dosingPowered) {
                // Powered but septic zone — not injecting effectively
                m.emissive.setHex(0x92400e);
                m.emissiveIntensity = 0.35;
              } else {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              }
            } else if (isRoSkid) {
              // RO skid: powered = bright cyan tertiary barrier shimmer
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else {
                m.emissive.setHex(0x0284c7);
                m.emissiveIntensity = 0.52;
              }
            } else if (isBrine) {
              // Brine tank: powered = amber recirc shimmer
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else {
                m.emissive.setHex(0xd97706);
                m.emissiveIntensity = 0.42;
              }
            } else if (isChp) {
              // CHP engine: powered = green biogas shimmer (sludge→energy), unpowered = dark red
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else {
                m.emissive.setHex(0x16a34a);
                m.emissiveIntensity = 0.52;
              }
            } else if (isUv) {
              // UV channel: powered = violet disinfection shimmer, unpowered = dark red
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else {
                m.emissive.setHex(0x7c3aed);
                m.emissiveIntensity = 0.52;
              }
            } else if (isAop) {
              // AOP/Ozone skid: powered = amber-lime oxidation shimmer (toxics burn), unpowered = dark red
              if (!isPowered) {
                m.emissive.setHex(0x5a1a1a);
                m.emissiveIntensity = 0.52;
              } else {
                m.emissive.setHex(0xa3e635);
                m.emissiveIntensity = 0.52;
              }
            } else if (isDiffuser) {
              // Diffusers: aerated = blue shimmer, idle = no glow
              if (isAerated) {
                m.emissive.setHex(0x1a4a8a);
                m.emissiveIntensity = 0.45;
              } else {
                m.emissive.setHex(0x000000);
                m.emissiveIntensity = 0;
              }
            } else if (!isPowered) {
              m.emissive.setHex(0x5a1a1a);
              m.emissiveIntensity = 0.52;
            } else {
              m.emissive.setHex(0x000000);
              m.emissiveIntensity = 0;
            }
          }
        }
      });
    }
  }

  private buildEquipmentMesh(typeId: string, basinDepthM: number): THREE.Group {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.45, metalness: 0.65 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2f3640, roughness: 0.6, metalness: 0.3 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5, metalness: 0.2 });
    const plinth = new THREE.MeshStandardMaterial({ color: 0xa8abb1, roughness: 0.9 });
    (steel as any)._equipBase = true;
    (dark as any)._equipBase = true;

    const add = (mesh: THREE.Mesh) => { mesh.castShadow = true; g.add(mesh); return mesh; };

    switch (typeId) {
      case 'fine_bubble_diffuser': {
        // Flat grid panel hovering just above the basin floor.
        const panel = add(new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.12, 24), dark));
        panel.position.set(0, 0.32, 0);
        for (let i = 0; i < 4; i++) {
          const dome = add(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12), steel));
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          dome.position.set(Math.cos(a) * 0.85, 0.48, Math.sin(a) * 0.85);
        }
        break;
      }
      case 'submersible_mixer': {
        const depth = Math.max(1, basinDepthM);
        const base = add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.9), dark));
        base.position.set(0, 0.09, 0);
        const shaftLen = Math.max(1.2, depth * 0.62);
        const shaft = add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, shaftLen, 10), steel));
        shaft.position.set(0, shaftLen / 2 + 0.15, 0);
        const motor = add(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.55, 14), dark));
        motor.position.set(0, 0.45, 0);
        const hub = add(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.2, 10), accent));
        hub.position.set(0, shaftLen - 0.25, 0);
        for (const rot of [Math.PI / 2, 0]) {
          const blade = add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.28), steel));
          blade.position.set(0, shaftLen - 0.25, 0);
          blade.rotation.z = rot;
        }
        break;
      }
      case 'process_pump': {
        const pad = add(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.35, 2.4), plinth));
        pad.position.set(0, 0.175, 0);
        const body = add(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.1, 16), accent));
        body.rotation.z = Math.PI / 2;
        body.position.set(-0.8, 0.95, 0);
        const motorBody = add(new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 1.5, 16), dark));
        motorBody.rotation.z = Math.PI / 2;
        motorBody.position.set(0.85, 0.95, 0);
        const flange = add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 12), steel));
        flange.position.set(-1.5, 0.95, 0);
        break;
      }
      case 'rotary_blower': {
        const skid = add(new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.3, 2.2), plinth));
        skid.position.set(0, 0.15, 0);
        for (const dx of [-0.9, 0.9]) {
          const tank = add(new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.35, 18), accent));
          tank.position.set(dx, 0.98, 0);
          const head = add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.9), steel));
          head.position.set(dx, 1.83, 0);
        }
        const inlet = add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 0.6), dark));
        inlet.position.set(0, 1.05, 1.15);
        break;
      }
      // ── PHASE 6: filtration stage ─────────────────────────────────────
      case 'membrane_cassette': {
        // Vertical cassette frame with hollow-fiber bundles: the standout
        // visual for the first custom MBR lane — a tall rectangular white
        // housing with visible vertical fibers inside.
        const frameMat = new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.35, metalness: 0.1 });
        const fiberMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 });
        (frameMat as any)._equipBase = true;
        (fiberMat as any)._equipBase = true;
        const depth = Math.max(2.5, basinDepthM);
        const h = Math.max(1.2, Math.min(depth * 0.85, 3.2));
        // Outer housing — tall box, white
        const housing = add(new THREE.Mesh(new THREE.BoxGeometry(1.6, h, 0.9), frameMat));
        housing.position.set(0, h / 2 + 0.15, 0);
        // Vertical fiber bundles (thin cylinders inside the housing)
        for (let i = 0; i < 5; i++) {
          const fib = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, h * 0.82, 8), fiberMat);
          fib.position.set(-0.6 + i * 0.30, h / 2 + 0.15, 0);
          fib.castShadow = true;
          g.add(fib);
        }
        // Top manifold header
        const header = add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 1.0), dark));
        header.position.set(0, h + 0.18, 0);
        // Permeate outlet stub
        const stub = add(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 10), steel));
        stub.rotation.z = Math.PI / 2;
        stub.position.set(1.05, h * 0.65, 0);
        break;
      }
      case 'mbbr_carrier': {
        // Carrier cluster: a loose heap of biofilm carriers bobbing at mid-depth.
        // Each carrier is a small spoked wheel; together they read as \"media\".
        const carrierMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.55, transparent: true, opacity: 0.92 });
        const rimMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.45 });
        (carrierMat as any)._equipBase = true;
        (rimMat as any)._equipBase = true;
        const depth = Math.max(1, basinDepthM);
        const baseY = 0.35 + depth * 0.28; // mid-water heap
        // Seeded layout so all tiles look identical (no flicker on re-render)
        const offsets: [number, number, number, number][] = [
          [0, 0, 0, 0], [0.42, 0.11, -0.18, 0.8], [-0.38, -0.05, 0.22, 1.2],
          [0.21, 0.07, 0.35, 0.4], [-0.25, -0.08, -0.31, 1.9], [0.48, 0.05, 0.08, 0.6],
          [-0.12, 0.14, -0.08, 2.1],
        ];
        for (const [dx, dy, dz, rot] of offsets) {
          const grp = new THREE.Group();
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 14), carrierMat);
          // lay flat
          wheel.rotation.x = Math.PI / 2;
          grp.add(wheel);
          const inner = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.18, 10), rimMat as any);
          inner.rotation.x = Math.PI / 2;
          inner.position.y = 0.015;
          grp.add(inner);
          // spoked detail — 3 internal walls
          for (let s = 0; s < 3; s++) {
            const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.04, 0.03), rimMat);
            spoke.position.set(0, 0.02, 0);
            spoke.rotation.y = (s / 3) * Math.PI;
            grp.add(spoke);
          }
          grp.position.set(dx, baseY + dy, dz);
          grp.rotation.y = rot;
          grp.rotation.z = 0.12;
          grp.traverse(o => { const mm = o as THREE.Mesh; if (mm.isMesh) mm.castShadow = true; });
          g.add(grp);
        }
        // Thin retaining mesh hint — faint wireframe box around carriers
        const cage = new THREE.Mesh(
          new THREE.BoxGeometry(1.5, 0.55, 1.3),
          new THREE.MeshStandardMaterial({ color: 0xb9d7ff, wireframe: true, transparent: true, opacity: 0.18 })
        );
        cage.position.set(0, baseY, 0);
        g.add(cage);
        break;
      }
      // ── PHASE 7 slice 2: instrumentation kit — process sensors ─────────
      case 'do_probe': {
        // Slender luminescent DO probe: stands on basin floor, shaft + sensor head
        // mid-water with a small transmitter puck above the surface — distinctive yellow tip.
        const shaftMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.35, metalness: 0.15 });
        const tipMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, emissive: 0x442200, emissiveIntensity: 0.25 });
        (shaftMat as any)._equipBase = true;
        (tipMat as any)._equipBase = true;
        const depth = Math.max(1, basinDepthM);
        const shaftLen = Math.max(1.0, depth * 0.55);
        const shaft = add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, shaftLen, 10), shaftMat));
        shaft.position.set(0, shaftLen / 2 + 0.08, 0);
        const base = add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.12, 14), dark));
        base.position.set(0, 0.06, 0);
        const tip = add(new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), tipMat));
        tip.position.set(0, shaftLen * 0.72, 0);
        const transmitter = add(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.14, 0.32), steel));
        transmitter.position.set(0, shaftLen + 0.12, 0);
        const cable = add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 6), dark));
        cable.position.set(0.18, shaftLen * 0.88, 0);
        break;
      }
      case 'flow_meter': {
        // Dry mag-flow spool: flanged inline tube + transmitter box with sight glass.
        const tubeMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.3, metalness: 0.55 });
        const boxMat = new THREE.MeshStandardMaterial({ color: 0x14b8a6, roughness: 0.45 });
        (tubeMat as any)._equipBase = true;
        (boxMat as any)._equipBase = true;
        const pl = add(new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.28, 1.9), plinth));
        pl.position.set(0, 0.14, 0);
        // spool tube (horizontal along X)
        const spool = add(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.9, 16), tubeMat));
        spool.rotation.z = Math.PI / 2;
        spool.position.set(0, 0.62, 0);
        // flanges
        for (const dx of [-0.9, 0.9]) {
          const flange = add(new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.14, 16), steel));
          flange.rotation.z = Math.PI / 2;
          flange.position.set(dx, 0.62, 0);
        }
        const tx = add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.42), boxMat));
        tx.position.set(0, 1.15, 0);
        const glass = add(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.02), new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: 0x14b8a6, emissiveIntensity: 0.55 })));
        glass.position.set(0, 1.18, 0.22);
        break;
      }
      case 'level_sensor': {
        // Ultrasonic horn on a pole over the water surface — elevated transmitter.
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.4 });
        const hornMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.35 });
        const housingMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
        (poleMat as any)._equipBase = true;
        (hornMat as any)._equipBase = true;
        (housingMat as any)._equipBase = true;
        const depth = Math.max(1, basinDepthM);
        const poleH = Math.max(1.2, depth + 0.6);
        const pole = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, poleH, 10), poleMat));
        pole.position.set(-0.32, poleH / 2 + 0.1, 0);
        const arm = add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.08), poleMat));
        arm.position.set(0, poleH + 0.0, 0);
        const horn = add(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.10, 0.40, 16), hornMat));
        horn.position.set(0.18, poleH - 0.22, 0);
        horn.rotation.z = Math.PI; // facing down
        const housing = add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.30), housingMat));
        housing.position.set(-0.32, poleH - 0.05, 0);
        const lens = add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12), new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0e7490, emissiveIntensity: 0.45 })));
        lens.position.set(0.18, poleH - 0.42, 0);
        break;
      }
      // ── PHASE 7 slice 3: chemical dosing kit ───────────────────────────
      case 'chemical_storage_tank': {
        // Ground bulk tank farm: horizontal cylindrical tank on a bund, with
        // inlet piping and a small control kiosk. Distinct orange/brown palette.
        const tankMat = new THREE.MeshStandardMaterial({ color: 0xe2d8c3, roughness: 0.55 });
        const bundMat = new THREE.MeshStandardMaterial({ color: 0xa89060, roughness: 0.85 });
        const valveMat = new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.4 });
        (tankMat as any)._equipBase = true;
        (valveMat as any)._equipBase = true;
        const bund = add(new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.22, 2.2), bundMat));
        bund.position.set(0, 0.11, 0);
        const tank = add(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.4, 18), tankMat));
        tank.rotation.z = Math.PI / 2;
        tank.position.set(0, 0.85, 0);
        const cradle1 = add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 1.4), dark));
        cradle1.position.set(-0.7, 0.40, 0);
        const cradle2 = add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 1.4), dark));
        cradle2.position.set(0.7, 0.40, 0);
        const kiosk = add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.6), valveMat));
        kiosk.position.set(1.25, 0.55, 0.75);
        const pipe = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 10), steel));
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(-1.4, 0.85, 0);
        break;
      }
      case 'chemical_dosing_pump': {
        // In-basin dosing skid: compact skid with day tank + peristaltic pump head
        // + injection lance descending to water. Lime-accented.
        const skidMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.4, metalness: 0.15 });
        const limeMat = new THREE.MeshStandardMaterial({ color: 0x84cc16, roughness: 0.5 });
        const chemMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.3, transparent: true, opacity: 0.75 });
        (skidMat as any)._equipBase = true;
        (limeMat as any)._equipBase = true;
        const depth = Math.max(1, basinDepthM);
        const base = add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.14, 1.0), dark));
        base.position.set(0, 0.07, 0);
        const dayTank = add(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.6, 16), chemMat));
        dayTank.position.set(-0.32, 0.44, 0);
        const pumpHead = add(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.35, 0.35), limeMat));
        pumpHead.position.set(0.35, 0.34, 0);
        const motor2 = add(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.35, 12), dark));
        motor2.rotation.z = Math.PI / 2;
        motor2.position.set(0.35, 0.60, 0);
        // Injection lance into water
        const lanceLen = Math.max(0.8, depth * 0.45);
        const lance = add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, lanceLen, 8), steel));
        lance.position.set(0.35, lanceLen / 2 + 0.14, 0.22);
        const nozzle = add(new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.12, 10), limeMat));
        nozzle.position.set(0.35, 0.20, 0.22);
        nozzle.rotation.x = Math.PI;
        break;
      }
      // ── RO SLICE 1: tertiary reverse-osmosis kit ─────────────────────────
      case 'ro_skid': {
        // Containerised RO skid: 4 horizontal spiral-wound pressure vessels on a
        // skid frame + HP pump + CIP manifold — the tertiary barrier visual.
        const frameMat = new THREE.MeshStandardMaterial({ color: 0xe0f2fe, roughness: 0.28, metalness: 0.12 });
        const vesselMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.25, metalness: 0.05 });
        const capMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.35, emissive: 0x0c4a6e, emissiveIntensity: 0.18 });
        const pumpMat = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.45, metalness: 0.35 });
        (frameMat as any)._equipBase = true;
        (vesselMat as any)._equipBase = true;
        (capMat as any)._equipBase = true;
        const skid = add(new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.28, 2.0), plinth));
        skid.position.set(0, 0.14, 0);
        // 4 pressure vessels stacked 2×2 on the skid
        for (let row = 0; row < 2; row++) {
          for (let col = 0; col < 2; col++) {
            const vessel = add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.2, 16), vesselMat));
            vessel.rotation.z = Math.PI / 2;
            vessel.position.set(0, 0.82 + row * 0.62, -0.55 + col * 1.1);
            // blue end caps
            for (const dx of [-1.05, 1.05]) {
              const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.14, 16), capMat);
              cap.rotation.z = Math.PI / 2;
              cap.position.set(dx, 0.82 + row * 0.62, -0.55 + col * 1.1);
              cap.castShadow = true;
              g.add(cap);
            }
          }
        }
        // HP pump at skid front
        const hp = add(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.75, 16), pumpMat));
        hp.rotation.z = Math.PI / 2;
        hp.position.set(-1.65, 0.62, 0);
        const hpHead = add(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.42, 0.42), steel));
        hpHead.position.set(-1.65, 0.95, 0);
        // Interconnect manifold
        const manifold = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 10), steel));
        manifold.rotation.z = Math.PI / 2;
        manifold.position.set(0, 1.55, -0.55);
        const manifold2 = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 10), steel));
        manifold2.rotation.z = Math.PI / 2;
        manifold2.position.set(0, 1.55, 0.55);
        // Control cabinet
        const cabinet = add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.38), dark));
        cabinet.position.set(1.55, 0.55, 0);
        const plcLight = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x16a34a, emissiveIntensity: 0.9 })));
        plcLight.position.set(1.60, 0.85, 0.20);
        break;
      }
      case 'brine_tank': {
        // Bunded brine holding tank: vertical cylinder with bund wall, ladder,
        // vent + discharge pipe — distinctive rust / amber palette.
        const tankMat = new THREE.MeshStandardMaterial({ color: 0xc9b896, roughness: 0.55 });
        const brineMat = new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.65, transparent: true, opacity: 0.85 });
        const bundMat2 = new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 });
        (tankMat as any)._equipBase = true;
        (brineMat as any)._equipBase = true;
        const bund = add(new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.24, 2.8), bundMat2));
        bund.position.set(0, 0.12, 0);
        const tank = add(new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.88, 1.85, 20), tankMat));
        tank.position.set(0, 1.20, 0);
        // Brine surface hint inside
        const brineSurf = add(new THREE.Mesh(new THREE.CylinderGeometry(0.80, 0.80, 0.08, 20), brineMat));
        brineSurf.position.set(0, 1.95, 0);
        // Top walkway rim
        const rim = add(new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.08, 8, 20), steel));
        rim.position.set(0, 2.12, 0);
        rim.rotation.x = Math.PI / 2;
        // Small vent stack
        const vent = add(new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.55, 10), steel));
        vent.position.set(0, 2.45, 0);
        const ventCap = add(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.18, 10), dark));
        ventCap.position.set(0, 2.75, 0);
        // Discharge pipe stub
        const discharge = add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.85, 10), steel));
        discharge.rotation.z = Math.PI / 2;
        discharge.position.set(1.15, 0.62, 0);
        break;
      }
      case 'biogas_chp_skid': {
        // Containerised biogas CHP engine: 20-ft ISO container with exhaust
        // stack, radiator, and gas train — the sludge→energy closer.
        // Distinct emergency-green / yellow genset palette.
        const containerMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.5, metalness: 0.15 });
        const yellowMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4 });
        const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x44403c, roughness: 0.7, metalness: 0.55 });
        (containerMat as any)._equipBase = true;
        (yellowMat as any)._equipBase = true;
        const base = add(new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.28, 2.0), plinth));
        base.position.set(0, 0.14, 0);
        const container = add(new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.25, 1.55), containerMat));
        container.position.set(0, 0.92, 0);
        // Yellow genset doors + vents
        const door = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.95, 1.2), yellowMat));
        door.position.set(1.41, 0.92, 0);
        for (let i = 0; i < 3; i++) {
          const vent2 = add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.22), dark));
          vent2.position.set(-0.75 + i * 0.75, 1.05, 0.80);
        }
        // Exhaust stack with heat shimmer hint
        const stack = add(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.1, 14), exhaustMat));
        stack.position.set(-0.95, 1.95, -0.45);
        const stackCap = add(new THREE.Mesh(new THREE.ConeGeometry(0.20, 0.18, 14), dark));
        stackCap.position.set(-0.95, 2.55, -0.45);
        // Radiator at rear
        const radiator = add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.65, 1.35), dark));
        radiator.position.set(1.05, 0.92, 0);
        const fan = add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 16), steel));
        fan.rotation.x = Math.PI / 2;
        fan.position.set(1.33, 0.92, 0);
        // Small control cabinet + green status lamp
        const cabinet = add(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.55, 0.32), dark));
        cabinet.position.set(0, 0.58, 0.95);
        const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x16a34a, emissiveIntensity: 0.9 })));
        lamp.position.set(0, 0.88, 1.11);
        // Gas inlet pipe stub
        const gasPipe = add(new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.9, 10), yellowMat));
        gasPipe.rotation.z = Math.PI / 2;
        gasPipe.position.set(-1.70, 0.62, -0.15);
        break;
      }
      case 'uv_channel': {
        // Ground UV disinfection channel — concrete open channel with LP lamp banks.
        // Distinct violet / stainless palette vs RO vessels and CHP green.
        const concreteMat = new THREE.MeshStandardMaterial({ color: 0xa8a29e, roughness: 0.85 });
        const stainlessMat = new THREE.MeshStandardMaterial({ color: 0xd6d3d1, roughness: 0.25, metalness: 0.7 });
        const violetMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.35, metalness: 0.15, emissive: 0x4c1d95, emissiveIntensity: 0.22 });
        const lampMat = new THREE.MeshStandardMaterial({ color: 0xa78bfa, roughness: 0.2, emissive: 0x7c3aed, emissiveIntensity: 0.35 });
        (concreteMat as any)._equipBase = true;
        (violetMat as any)._equipBase = true;
        (stainlessMat as any)._equipBase = true;
        // Plinth
        const base = add(new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.22, 1.9), plinth));
        base.position.set(0, 0.11, 0);
        // Open channel trough (U-shape: floor + 2 walls)
        const floor = add(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 1.42), concreteMat));
        floor.position.set(0, 0.28, 0);
        const leftWall = add(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.62, 0.12), concreteMat));
        leftWall.position.set(0, 0.60, -0.65);
        const rightWall = add(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.62, 0.12), concreteMat));
        rightWall.position.set(0, 0.60, 0.65);
        // Water surface hint inside channel (slightly below wall top)
        const water = add(new THREE.Mesh(new THREE.BoxGeometry(2.95, 0.04, 1.18), new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.38, roughness: 0.1 })));
        water.position.set(0, 0.52, 0);
        // UV lamp banks — 3 racks across the channel length, each with 2 parallel lamps
        for (let rack = 0; rack < 3; rack++) {
          const rx = -0.9 + rack * 0.9;
          // Stainless rack frame
          const frame = add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.45, 1.28), stainlessMat));
          frame.position.set(rx, 0.68, 0);
          for (let l = 0; l < 2; l++) {
            const lamp = add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.05, 12), lampMat));
            lamp.rotation.z = Math.PI / 2;
            lamp.position.set(rx, 0.68, -0.28 + l * 0.56);
          }
        }
        // Inlet / outlet pipe stubs (channel ends)
        const inlet = add(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.6, 12), stainlessMat));
        inlet.rotation.z = Math.PI / 2;
        inlet.position.set(-1.95, 0.42, 0);
        const outlet = add(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.6, 12), stainlessMat));
        outlet.rotation.z = Math.PI / 2;
        outlet.position.set(1.95, 0.42, 0);
        // Control cabinet with violet status lamp
        const cabinet = add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.52, 0.30), dark));
        cabinet.position.set(0, 0.48, 0.95);
        const lampStat = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshStandardMaterial({ color: 0xa78bfa, emissive: 0x7c3aed, emissiveIntensity: 0.9 })));
        lampStat.position.set(0, 0.76, 1.10);
        break;
      }
      case 'aop_skid': {
        // Ground O₃/AOP oxidation skid — O₂ concentrator + ozone generator + reactor contactor
        // Distinct lime/amber oxidation palette (toxics burn) vs UV violet and RO blue.
        const skidMat = new THREE.MeshStandardMaterial({ color: 0xe7e5c8, roughness: 0.45 });
        const o2Mat = new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.5 });
        const reactorMat = new THREE.MeshStandardMaterial({ color: 0xa3e635, roughness: 0.35, emissive: 0x3f6212, emissiveIntensity: 0.18 });
        const yellowMat2 = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4 });
        (skidMat as any)._equipBase = true;
        (reactorMat as any)._equipBase = true;
        (yellowMat2 as any)._equipBase = true;
        const base2 = add(new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.24, 2.0), plinth));
        base2.position.set(0, 0.12, 0);
        // O₂ concentrator tower
        const tower = add(new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 1.55, 18), skidMat));
        tower.position.set(-0.95, 0.95, 0);
        const towerCap = add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.16, 18), o2Mat));
        towerCap.position.set(-0.95, 1.78, 0);
        // Ozone generator cabinet (lime)
        const genCab = add(new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.05, 0.85), o2Mat));
        genCab.position.set(0.15, 0.72, 0);
        const genLight = add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: 0xa3e635, emissive: 0x65a30d, emissiveIntensity: 0.9 })));
        genLight.position.set(0.15, 1.30, 0.43);
        // Reactor / contactor vessel (horizontal stainless with lime caps)
        const reactor = add(new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 1.85, 16), reactorMat));
        reactor.rotation.z = Math.PI / 2;
        reactor.position.set(0.15, 0.72, 0);
        for (const dx of [-0.85, 0.85]) {
          const cap2 = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.40, 0.12, 16), yellowMat2);
          cap2.rotation.z = Math.PI / 2;
          cap2.position.set(0.15 + dx, 0.72, 0);
          cap2.castShadow = true;
          g.add(cap2);
        }
        // Vent stack with ozone off-gas
        const vent2 = add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.65, 12), steel));
        vent2.position.set(0.85, 1.25, -0.55);
        const ventCap2 = add(new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.18, 12), dark));
        ventCap2.position.set(0.85, 1.62, -0.55);
        // Inlet / outlet stubs
        const inlet2 = add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 12), steel));
        inlet2.rotation.z = Math.PI / 2;
        inlet2.position.set(-1.85, 0.52, 0.25);
        const outlet2 = add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 12), steel));
        outlet2.rotation.z = Math.PI / 2;
        outlet2.position.set(1.95, 0.52, 0.25);
        // Small O₂ inlet pipe
        const o2Pipe = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 10), steel));
        o2Pipe.rotation.z = Math.PI / 2;
        o2Pipe.position.set(-1.45, 1.05, 0);
        break;
      }
      default: {
        // Unknown type → plain marker cube so it is never invisible.
        const marker = add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), dark));
        marker.position.set(0, 0.5, 0);
        break;
      }
    }

    // Wet-installed machines render submerged on the basin floor; ground
    // machines stand at terrain level. y=0 serves both (basin floors sit at 0).
    return g;
  }

  // ── CONSTRUCTION-BUILDER Phase 3: utility connections ──────────────────
  private utilityGroup: THREE.Group = new THREE.Group();
  private utilityLineMap: Map<string, THREE.Line> = new Map();
  private utilityPreviewLine: THREE.Line | null = null;

  private ensureUtilityPreviewLine(): THREE.Line {
    if (this.utilityPreviewLine) return this.utilityPreviewLine;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      linewidth: 2,
      dashSize: 0.4,
      gapSize: 0.25,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    line.visible = false;
    line.frustumCulled = false;
    this.utilityPreviewLine = line;
    this.scene.add(line);
    return line;
  }

  /** Straight tile-center → tile-center lines per utility type. */
  public syncUtilityConnections(
    conns: { id: string; type: string; ax: number; ay: number; bx: number; by: number }[],
    selectedId?: string | Set<string> | null
  ) {
    if (!this.utilityGroup.parent) this.scene.add(this.utilityGroup);
    const active = new Set(conns.map(c => c.id));
    for (const [id, line] of this.utilityLineMap.entries()) {
      if (!active.has(id)) {
        this.utilityGroup.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
        this.utilityLineMap.delete(id);
      }
    }
    const colorFor = (t: string) =>
      t === 'water_pipe' ? 0x3b82f6 : t === 'air_pipe' ? 0xf97316 : 0xeab308;
    for (const c of conns) {
      let line = this.utilityLineMap.get(c.id);
      if (!line) {
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array([
          c.ax + 0.5, 0.18, c.ay + 0.5,
          c.bx + 0.5, 0.18, c.by + 0.5,
        ]);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.LineBasicMaterial({
          color: colorFor(c.type),
          transparent: true,
          opacity: 0.95,
        });
        line = new THREE.Line(geo, mat);
        line.frustumCulled = false;
        (line as any)._utilType = c.type;
        this.utilityLineMap.set(c.id, line);
        this.utilityGroup.add(line);

        // Small endpoint markers so even short cables are visible
        const mkDot = (x: number, z: number) => {
          const g = new THREE.SphereGeometry(0.18, 10, 8);
          const m = new THREE.MeshBasicMaterial({ color: colorFor(c.type) });
          const s = new THREE.Mesh(g, m);
          s.position.set(x, 0.18, z);
          line!.add(s);
        };
        mkDot(c.ax + 0.5, c.ay + 0.5);
        mkDot(c.bx + 0.5, c.by + 0.5);
      } else {
        const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(0, c.ax + 0.5, 0.18, c.ay + 0.5);
        pos.setXYZ(1, c.bx + 0.5, 0.18, c.by + 0.5);
        pos.needsUpdate = true;
      }
      // Selection highlight: boost opacity + emissive via color lerp
      const selected = selectedId instanceof Set ? selectedId.has(c.id) : c.id === selectedId;
      const mat = line.material as THREE.LineBasicMaterial;
      mat.opacity = selected ? 1 : 0.92;
      mat.color.setHex(selected ? 0xffffff : colorFor(c.type));
      // line width hint: selection thicker (note: linewidth only on some platforms)
      (mat as any).linewidth = selected ? 4 : 2;
    }
  }

  /** Live preview from anchored source tile to hover tile. */
  public setUtilityPreview(
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null,
    type: string = 'water_pipe'
  ) {
    const line = this.ensureUtilityPreviewLine();
    if (!from || !to) {
      line.visible = false;
      return;
    }
    const colorFor = (t: string) =>
      t === 'water_pipe' ? 0x3b82f6 : t === 'air_pipe' ? 0xf97316 : 0xeab308;
    (line.material as THREE.LineDashedMaterial).color.setHex(colorFor(type));
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, from.x + 0.5, 0.22, from.y + 0.5);
    pos.setXYZ(1, to.x + 0.5, 0.22, to.y + 0.5);
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.computeLineDistances();
    line.visible = true;
  }

  public syncPipes(pipes: PipeConnection[]) {
    // Flow animation runs on SIMULATED time — pause freezes the pipe flow.
    this.pipeRenderer.updatePipes(pipes, this.visualSimElapsed);
  }

  // ── CONSTRUCTION-BUILDER Phase 5: baffle walls (basin compartmentalisation)
  private baffleGroup: THREE.Group = new THREE.Group();
  private baffleMeshMap: Map<string, THREE.Group> = new Map();
  private bafflePreviewLine: THREE.Line | null = null;

  private ensureBafflePreviewLine(): THREE.Line {
    if (this.bafflePreviewLine) return this.bafflePreviewLine;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineDashedMaterial({
      color: 0xa78bfa,
      transparent: true,
      opacity: 0.95,
      linewidth: 2,
      dashSize: 0.35,
      gapSize: 0.2,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    line.visible = false;
    line.frustumCulled = false;
    this.bafflePreviewLine = line;
    this.scene.add(line);
    return line;
  }

  /**
   * Renders each interior baffle wall as a thin concrete wall standing
   * inside its basin (full span, height = basin depth). Mirrors syncUnits
   * add/remove/dispose discipline. Selection = purple emissive.
   */
  public syncBaffles(
    baffles: { id: string; basinId: string; orientation: string; offsetTiles: number }[],
    basins: { id: string; x: number; y: number; w: number; h: number; depthM: number }[],
    selectedId?: string | Set<string> | null,
  ) {
    if (!this.baffleGroup.parent) this.scene.add(this.baffleGroup);
    const activeIds = new Set(baffles.map(b => b.id));
    for (const [id, group] of this.baffleMeshMap.entries()) {
      if (!activeIds.has(id)) {
        this.baffleGroup.remove(group);
        group.traverse(o => {
          const mm = o as THREE.Mesh;
          if (mm.geometry) mm.geometry.dispose();
        });
        this.baffleMeshMap.delete(id);
      }
    }
    for (const bf of baffles) {
      let group = this.baffleMeshMap.get(bf.id);
      const basin = basins.find(b => b.id === bf.basinId);
      if (!basin) continue;
      if (!group) {
        group = this.buildBaffleMesh(bf.orientation as 'vertical'|'horizontal', basin.depthM, basin);
        this.baffleMeshMap.set(bf.id, group);
        this.baffleGroup.add(group);
      }
      // Position wall on its basin-relative offset
      if (bf.orientation === 'vertical') {
        group.position.set(basin.x + bf.offsetTiles, 0, basin.y);
      } else {
        group.position.set(basin.x, 0, basin.y + bf.offsetTiles);
      }
      const selected = selectedId instanceof Set ? selectedId.has(bf.id) : bf.id === selectedId;
      group.traverse(o => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh && mm.material) {
          const mat = Array.isArray(mm.material) ? mm.material[0] : mm.material;
          const m = mat as THREE.MeshStandardMaterial;
          if ((m as any)._baffleBase) {
            m.emissive.setHex(selected ? 0x4c1d95 : 0x000000);
            m.emissiveIntensity = selected ? 0.7 : 0;
          }
        }
      });
    }
  }

  private buildBaffleMesh(orientation: 'vertical'|'horizontal', depthM: number, basin: { w: number; h: number }): THREE.Group {
    const g = new THREE.Group();
    const wallT = 0.18;
    const depth = Math.max(1, depthM);
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc4b5fd, roughness: 0.85, metalness: 0.05 });
    (concrete as any)._baffleBase = true;
    let geo: THREE.BoxGeometry;
    if (orientation === 'vertical') {
      // Wall runs south–north (along Z), thin in X
      geo = new THREE.BoxGeometry(wallT, depth, basin.h);
      const m = new THREE.Mesh(geo, concrete);
      m.position.set(0, depth / 2, basin.h / 2);
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
    } else {
      geo = new THREE.BoxGeometry(basin.w, depth, wallT);
      const m = new THREE.Mesh(geo, concrete);
      m.position.set(basin.w / 2, depth / 2, 0);
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
    }
    return g;
  }

  /** Live preview for baffle placement: dashed line across the hovered basin at the hovered offset. */
  public setBafflePreview(
    basin: { x: number; y: number; w: number; h: number; depthM: number } | null,
    orientation: 'vertical'|'horizontal' | null,
    offsetTiles: number | null,
  ) {
    const line = this.ensureBafflePreviewLine();
    if (!basin || !orientation || offsetTiles == null) {
      line.visible = false;
      return;
    }
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const y = basin.depthM * 0.55 + 0.25;
    if (orientation === 'vertical') {
      const wx = basin.x + offsetTiles;
      pos.setXYZ(0, wx, y, basin.y);
      pos.setXYZ(1, wx, y, basin.y + basin.h);
    } else {
      const wz = basin.y + offsetTiles;
      pos.setXYZ(0, basin.x, y, wz);
      pos.setXYZ(1, basin.x + basin.w, y, wz);
    }
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.computeLineDistances();
    line.visible = true;
  }

  /**
   * Pushes the authoritative game clock into the renderer. Lighting derives
   * from this via getDayNightFactor — no independent real-time lerp.
   */
  public setGameClock(gameTimeDays: number) {
    this.gameTimeDays = gameTimeDays;
  }

  /**
   * Explicit world-speed control (item 14): 0 = paused, 1 = normal, 2 = fast,
   * 5 = ultra. Scales ALL world animation; never the camera or UI.
   */
  public setSimulationSpeed(speed: SimulationSpeed) {
    this.worldTimeScale = speed;
  }

  /** Alias matching the prompt's suggested API name. */
  public setWorldTimeScale(scale: number) {
    this.worldTimeScale = scale as SimulationSpeed;
  }

  /** Dev-only FPS/frame-time telemetry toggle (item 19). Off in production. */
  public setTelemetryEnabled(enabled: boolean) {
    this.telemetryEnabled = enabled;
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
      // Dispose transient preview resources — each ghost creates fresh
      // geometry/material, so skipping this leaks VRAM on every refresh.
      c.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(mm => mm.dispose());
        else if (mat) mat.dispose();
      });
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
   * Highlights the selected pipe source unit with a glowing ring, centered on
   * the ROTATED footprint so non-square units ring correctly at any rotation.
   * Optionally draws markers on every selectable port (chosen one emphasized).
   */
  public setPipeSourceHighlight(
    unitInstanceId: string | null,
    units: PlacedUnit[],
    opts?: { chosenPortId?: string | null; showPorts?: boolean }
  ) {
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

    const [fw, fl] = getRotatedFootprint(def, unit.rotation);
    const radius = Math.max(fw, fl) * 0.65;
    const cx = unit.gridX + fw / 2;
    const cz = unit.gridY + fl / 2;

    const ringGeo = new THREE.TorusGeometry(radius, 0.06, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, 0.15, cz);
    this.unitGroup.add(ring);
    this.pipeSelectRingMap.set(unitInstanceId + '__ring', ring);

    // Optional per-port markers: cyan = available, amber = currently chosen.
    if (opts?.showPorts) {
      const chosen = opts.chosenPortId ?? null;
      for (const port of def.ports) {
        const [px, py, pz] = getPortWorldPosition(unit, port.id);
        const isChosen = port.id === chosen;
        const markerGeo = new THREE.SphereGeometry(isChosen ? 0.3 : 0.18, 12, 10);
        const markerMat = new THREE.MeshBasicMaterial({
          color: isChosen ? 0xfbbf24 : 0x22d3ee,
          transparent: true,
          opacity: isChosen ? 0.95 : 0.55
        });
        const marker = new THREE.Mesh(markerGeo, markerMat);
        marker.position.set(px, Math.max(0.25, py), pz);
        this.unitGroup.add(marker);
        this.pipeSelectRingMap.set(`${unitInstanceId}__port_${port.id}`, marker);
      }
    }
  }

  /** Projects a world point to canvas pixel coordinates (for HTML overlays). */
  public worldToScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const v = new THREE.Vector3(x, y, z).project(this.cameraController.camera);
    if (v.z > 1) return null; // behind camera
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((-v.y + 1) / 2) * rect.height
    };
  }

  /** Canvas-local projection (same as worldToScreen but relative to canvas top-left). */
  public worldToCanvasPx(x: number, y: number, z: number): { x: number; y: number } | null {
    const s = this.worldToScreen(x, y, z);
    if (!s) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    return { x: s.x - rect.left, y: s.y - rect.top };
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

  /** Raw ground-plane hit point (not snapped to the grid) */
  public getGroundPointFromScreen(clientX: number, clientY: number): THREE.Vector3 | null {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndcX =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.cameraController.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, hit) ? hit : null;
  }

  /** Shows the live connection preview from the chosen source port to the cursor */
  public setPipePreview(from: THREE.Vector3 | null, to: THREE.Vector3 | null) {
    if (!from || !to) {
      this.pipePreviewLine.visible = false;
      this.pipePreviewCursor.visible = false;
      return;
    }
    const posAttr = this.pipePreviewLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setXYZ(0, from.x, from.y, from.z);
    posAttr.setXYZ(1, to.x, to.y + 0.15, to.z);
    posAttr.needsUpdate = true;
    this.pipePreviewLine.geometry.computeBoundingSphere();
    this.pipePreviewLine.visible = true;
    this.pipePreviewCursor.position.set(to.x, 0.12, to.z);
    this.pipePreviewCursor.visible = true;
  }

  public getUnitAtScreen(clientX: number, clientY: number, units: PlacedUnit[]): PlacedUnit | null {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const ndcX =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.cameraController.camera);

    // 1) TRUE MESH PICKING FIRST — tall units (digesters, turbines, tanks) must
    //    be clickable on their whole body, not just their ground footprint.
    const hits = this.raycaster.intersectObjects(this.unitGroup.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.name) {
          const u = units.find(uu => uu.instanceId === o!.name);
          if (u) return u;
        }
        o = o.parent;
      }
    }

    // 2) Ground-tile fallback (clicking the pad / ground inside the footprint)
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    const tile = { x: Math.floor(hit.x), y: Math.floor(hit.z) };
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
    this.composer.setSize(width, height);
    this.cameraController.setAspect(width / height);
  }

  /** Re-fit the sun/shadow frustum and light rig when a bigger level loads */
  public updateShadowBounds(mapWidth: number, mapDepth: number) {
    const sd = Math.max(mapWidth, mapDepth) * 0.85 + 22;
    this.dirLight.shadow.camera.left   = -sd;
    this.dirLight.shadow.camera.right  =  sd;
    this.dirLight.shadow.camera.top    =  sd;
    this.dirLight.shadow.camera.bottom = -sd;
    this.dirLight.shadow.camera.far = sd * 6 + 200;
    this.dirLight.shadow.camera.updateProjectionMatrix();
    this.dirLight.position.set(mapWidth / 2 + 45, this.dayPal.sunY, mapDepth / 2 + 30);
    this.dirLight.target.position.set(mapWidth / 2, 0, mapDepth / 2);
    this.dirLight.target.updateMatrixWorld();
    this.skyDome.position.set(mapWidth / 2, 0, mapDepth / 2);
    this.sunMesh.position.x = mapWidth / 2 + 180;
    this.sunMesh.position.z = mapDepth / 2 + 90;
    this.stars.position.set(mapWidth / 2, 0, mapDepth / 2);
  }

  /** Tints the whole sky/fog/light rig to match the level's scenario biome */
  public setEnvironment(biome: LevelBiome) {
    this.dayPal = makeDay(biome);
    this.nightPal = NIGHT_BASE();
    if (biome === 'industrial') {
      this.nightPal.fog.setHex(0x11161c);
      this.nightPal.hemiSky.setHex(0x1a2030);
    } else if (biome === 'desert') {
      this.nightPal.fog.setHex(0x1a1610);
      this.nightPal.hemiGround.setHex(0x241d12);
    } else if (biome === 'lake_forest') {
      this.nightPal.fog.setHex(0x0a1a16);
    }
    // Apply immediately for a snappy level transition
    this.scene.background = this.dayPal.bg.clone();
    (this.scene.fog as THREE.FogExp2).color.copy(this.dayPal.fog);
    // Force the day/night rig to re-apply with the new biome palettes.
    this.lastAppliedDayFactor = -1;
  }

  public dispose() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Release post-processing targets before tearing down the renderer.
    this.composer?.dispose();
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
