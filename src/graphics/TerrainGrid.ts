import * as THREE from 'three';
import { LevelBiome } from '../types/game';

/**
 * Realistic 3D environment surrounding the plant site:
 * rolling terrain, a meandering animated river, instanced forests,
 * a neighbouring town (houses / city blocks / silos), roads with a
 * river bridge, perimeter fencing, street lights, drifting clouds and
 * a distant mountain ring — with smooth day/night transitions.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

const HOUSE_COLORS     = [0xc9a37e, 0xb0764f, 0x9c6644, 0xd9cdb6, 0xa89078, 0xcbd5e1];
const ROOF_COLORS      = [0x7f4f45, 0x5b3a34, 0x8c4a3c, 0x46536b, 0x6b4436];
const TOWER_COLORS     = [0x94a3b8, 0xa8b3c5, 0x7d8aa0, 0xb0bac9];
const CONIFER_GREENS   = [0x2d6a34, 0x275e2d, 0x35753c, 0x1f5426];
const BROADLEAF_GREENS = [0x4a8f3c, 0x579c46, 0x3f7d33, 0x6aa84f];

// Cached material helper + shadowed box builder for environment pieces
const envMatCache = new Map<string, THREE.MeshStandardMaterial>();
function std(color: number, roughness = 0.85, metalness = 0.05): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = envMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    envMatCache.set(key, m);
  }
  return m;
}
function tbox(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

interface Placed { x: number; z: number; r: number; }

/** Per-scenario world generation rules */
interface BiomeConfig {
  grassA: number; grassB: number; sand: number; mud: number;
  hillAmp: number;
  conifers: number; broadleaf: number; bushes: number;
  coniferGreens: number[]; broadleafGreens: number[];
  farmPlots: number; villageCottages: number;
  cityDensity: number;      // multiplier on tower attempts
  factories: number;        // industrial halls with smokestacks
  desertMode: boolean;      // cacti/palms instead of conifers/broadleaf
  dayBg: number; dayFog: number;
}

function biomeConfig(biome: LevelBiome): BiomeConfig {
  switch (biome) {
    case 'farmland':
      return {
        grassA: 0x6f8f3c, grassB: 0x5c7a32, sand: 0xc2b280, mud: 0x6e5b3a, hillAmp: 1.7,
        conifers: 1300, broadleaf: 1100, bushes: 750,
        coniferGreens: CONIFER_GREENS, broadleafGreens: BROADLEAF_GREENS,
        farmPlots: 48, villageCottages: 20, cityDensity: 1.2, factories: 2,
        desertMode: false, dayBg: 0x93c2e6, dayFog: 0xb8d4e6,
      };
    case 'industrial':
      return {
        grassA: 0x77743a, grassB: 0x66653a, sand: 0xa89a72, mud: 0x5c5138, hillAmp: 1.2,
        conifers: 650, broadleaf: 480, bushes: 400,
        coniferGreens: [0x5c6e35, 0x69773d], broadleafGreens: [0x7a7d36, 0x8c8030],
        farmPlots: 8, villageCottages: 12, cityDensity: 1.9, factories: 8,
        desertMode: false, dayBg: 0x9fb0bd, dayFog: 0xb3bec6,
      };
    case 'lake_forest':
      return {
        grassA: 0x3f7a34, grassB: 0x2f6428, sand: 0xc9bd94, mud: 0x5f5236, hillAmp: 2.4,
        conifers: 2400, broadleaf: 1600, bushes: 1200,
        coniferGreens: [0x1e5c28, 0x276b30, 0x2f7a38], broadleafGreens: [0x3f8a33, 0x4c9a3e, 0x57a848],
        farmPlots: 8, villageCottages: 18, cityDensity: 1.6, factories: 0,
        desertMode: false, dayBg: 0x8ecaefff & 0xffffff, dayFog: 0xcfe8dc,
      };
    case 'desert':
      return {
        grassA: 0xd4b26a, grassB: 0xc4a058, sand: 0xe0c184, mud: 0x9a7d4e, hillAmp: 3.1,
        conifers: 0, broadleaf: 0, bushes: 140,
        coniferGreens: [], broadleafGreens: [],
        farmPlots: 0, villageCottages: 20, cityDensity: 2.2, factories: 1,
        desertMode: true, dayBg: 0xbfe0ef, dayFog: 0xecd9ae,
      };
    case 'coastal':
    default:
      return {
        grassA: 0x4d7c3a, grassB: 0x3c6630, sand: 0xd6c491, mud: 0x6e5b3a, hillAmp: 1.9,
        conifers: 1800, broadleaf: 1500, bushes: 900,
        coniferGreens: CONIFER_GREENS, broadleafGreens: BROADLEAF_GREENS,
        farmPlots: 20, villageCottages: 24, cityDensity: 1.1, factories: 1,
        desertMode: false, dayBg: 0x87b8e4, dayFog: 0xaacdea,
      };
  }
}

export class TerrainGrid {
  public group: THREE.Group;

  private envGroup: THREE.Group = new THREE.Group();
  private slabGroup: THREE.Group = new THREE.Group();

  private hoverMesh!: THREE.Mesh;
  private ghostMesh!: THREE.Group;

  private static ghostGeoCache = new Map<string, THREE.BoxGeometry>();
  private static ghostBoxMatOk  = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.38 });
  private static ghostWireMatOk = new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true, transparent: true, opacity: 0.8 });
  private static ghostBoxMatNo  = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.38 });
  private static ghostWireMatNo = new THREE.MeshBasicMaterial({ color: 0xf87171, wireframe: true, transparent: true, opacity: 0.8 });

  private cfg: BiomeConfig = biomeConfig('coastal');

  private W = 24;
  private D = 20;
  private padX = 46;
  private padZ = 40;
  private riverHW = 4.2;
  private zRoad = 22;

  private riverMesh: THREE.Mesh | null = null;
  private riverBasePos: Float32Array | null = null;
  private baseY: number = -9;
  private cloudMesh: THREE.InstancedMesh | null = null;
  private cloudData: { y: number; z: number; speed: number; sx: number; sy: number; sz: number }[] = [];
  private lampBulbMat: THREE.MeshStandardMaterial | null = null;
  private windowMat: THREE.MeshStandardMaterial | null = null;
  private siteLights: THREE.SpotLight[] = [];
  private flowParticles: THREE.InstancedMesh | null = null;
  private flowData: { t: number; u: number; speed: number; scale: number }[] = [];

  constructor(mapWidth: number = 24, mapDepth: number = 20) {
    this.group = new THREE.Group();
    this.group.add(this.envGroup);
    this.group.add(this.slabGroup);

    this._buildHoverAndGhost();
    this._buildAll(mapWidth, mapDepth);
  }

  // ════════════════════════════ PUBLIC API ════════════════════════════

  public updateSize(w: number, d: number, biome: LevelBiome = 'coastal') {
    this.cfg = biomeConfig(biome);
    this._disposeEnv();
    this._buildAll(w, d);
    this.group.add(this.hoverMesh);
    this.group.add(this.ghostMesh);
  }

  /** Per-frame updates: river flow, cloud drift, night glow */
  public tick(dt: number, elapsed: number, nightFactor: number) {
    // ── River fluid mechanics: advected waves + scrolling ripple normals ──
    if (this.riverMesh && this.riverBasePos) {
      const zMin = -this.padZ;
      const span = this.D + this.padZ * 2;
      const posAttr = this.riverMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      const base = this.riverBasePos;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i];
        const bz = base[i + 2];
        const v = (bz - zMin) / span; // downstream parameter
        const phase = v * 14 - elapsed * 1.9; // waves travel +Z (downstream)
        arr[i + 1] =
          Math.sin(phase) * 0.07 +
          Math.sin(bx * 0.55 + elapsed * 1.4) * 0.04 +
          Math.sin((bx + bz) * 0.3 - elapsed * 0.8) * 0.03;
      }
      posAttr.needsUpdate = true;
    }
    // Flow dashes ride the current, rotated to the local river direction
    if (this.flowParticles && this.flowData.length > 0) {
      const zMin = -this.padZ;
      const span = this.D + this.padZ * 2;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const eul = new THREE.Euler();
      const scl = new THREE.Vector3();
      const pos = new THREE.Vector3();
      for (let i = 0; i < this.flowData.length; i++) {
        const f = this.flowData[i];
        f.t += ((f.speed * dt) / span) % 1;
        if (f.t > 1) f.t -= 1;
        const z = zMin + f.t * span;
        const meander = this.riverCenterX(z);
        // Yaw follows the local meander tangent so dashes point downstream
        const dcx = this.riverCenterX(z + 0.6) - this.riverCenterX(z - 0.6);
        eul.set(0, Math.atan2(dcx, 1.2), 0);
        q.setFromEuler(eul);
        pos.set(meander + f.u, -0.86, z);
        scl.set(f.scale, f.scale, f.scale);
        m.compose(pos, q, scl);
        this.flowParticles.setMatrixAt(i, m);
      }
      this.flowParticles.instanceMatrix.needsUpdate = true;
    }

    // ── Traffic: vehicles cruise along the road and across the bridge ──
    if (this.traffic.length > 0) {
      const xMin = -this.padX - 14;
      const xMax = this.W + this.padX + 14;
      for (const v of this.traffic) {
        let x = v.group.position.x + v.dir * v.speed * dt;
        if (x > xMax) x = xMin;
        if (x < xMin) x = xMax;
        v.group.position.x = x;
      }
    }

    // ── Cloud drift ──
    if (this.cloudMesh && this.cloudData.length > 0) {
      const maxX = this.W + this.padX + 55;
      const minX = -this.padX - 55;
      const m = new THREE.Matrix4();
      const scl = new THREE.Vector3();
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      for (let i = 0; i < this.cloudData.length; i++) {
        const c = this.cloudData[i];
        c.speed = c.speed; // keep shape
        this.cloudMesh.getMatrixAt(i, m);
        m.decompose(pos, q, scl);
        pos.x += c.speed * dt;
        if (pos.x > maxX) pos.x = minX;
        m.compose(pos, q, scl);
        this.cloudMesh.setMatrixAt(i, m);
      }
      this.cloudMesh.instanceMatrix.needsUpdate = true;
    }

    if (this.lampBulbMat) this.lampBulbMat.emissiveIntensity = lerpN(0.05, 2.4, nightFactor);
    if (this.windowMat) this.windowMat.emissiveIntensity = lerpN(0.05, 1.15, nightFactor);
    // Site floodlights switch on at dusk
    for (const light of this.siteLights) {
      light.intensity = nightFactor * 2.6;
      light.visible = nightFactor > 0.03;
    }
  }

  public setHoverTile(x: number, y: number, visible: boolean = true) {
    this.hoverMesh.visible = visible;
    if (visible) this.hoverMesh.position.set(x + 0.5, 0.03, y + 0.5);
  }

  public setGhostPreview(
    x: number, y: number,
    width: number, length: number,
    isValid: boolean = true,
    visible: boolean = true
  ) {
    this.ghostMesh.visible = visible;
    if (!visible) return;

    const key = `${width}x${length}`;
    let geo = TerrainGrid.ghostGeoCache.get(key);
    if (!geo) {
      geo = new THREE.BoxGeometry(width - 0.08, 1.1, length - 0.08);
      TerrainGrid.ghostGeoCache.set(key, geo);
    }
    const boxMat = isValid ? TerrainGrid.ghostBoxMatOk : TerrainGrid.ghostBoxMatNo;
    const wireMat = isValid ? TerrainGrid.ghostWireMatOk : TerrainGrid.ghostWireMatNo;

    this.ghostMesh.clear();
    const box = new THREE.Mesh(geo, boxMat);
    box.position.set(x + width / 2, 0.6, y + length / 2);
    const wire = new THREE.Mesh(geo, wireMat);
    wire.position.copy(box.position);
    this.ghostMesh.add(box);
    this.ghostMesh.add(wire);
  }

  // ══════════════════════ WORLD GEOMETRY HELPERS ══════════════════════

  private riverCenterX(z: number): number {
    return this.W + 11 + Math.sin(z * 0.07) * 3.2 + Math.sin(z * 0.021 + 2.0) * 2.6;
  }

  private terrainHeight(x: number, z: number): number {
    const odx = Math.max(-x, x - this.W, 0);
    const odz = Math.max(-z, z - this.D, 0);
    const odist = Math.hypot(odx, odz);

    const hills =
      Math.sin(x * 0.043) * Math.cos(z * 0.051) * 1.15 +
      Math.sin(x * 0.09 + 1.3) * Math.cos(z * 0.075 + 0.4) * 0.55 +
      Math.sin((x + z) * 0.021) * 0.9;
    let h = hills * sstep(1, 15, odist) * this.cfg.hillAmp;

    const roadDist = Math.abs(z - this.zRoad);
    h *= 1 - sstep(7.0, 4.2, roadDist);
    if (z > this.D - 2 && z < this.zRoad + 1 && Math.abs(x - this.W / 2) < 5.5) {
      h *= 1 - sstep(6.5, 3.5, Math.abs(x - this.W / 2));
    }

    // ── Properly DUG river channel ──
    // Hills alone could rise above a flat water plane and bury the river, so
    // the channel is sculpted explicitly: flat bed → curved slopes → bank top,
    // then blended into the surrounding terrain.
    const dr = Math.abs(x - this.riverCenterX(z));
    const bankY = 0.25;
    const bedY = bankY - 2.0;
    const flatHalf = this.riverHW;        // flat bed half-width
    const slopeEnd = this.riverHW * 2.3;  // where slopes meet bank top
    let cy: number;
    if (dr <= flatHalf) {
      cy = bedY;
    } else if (dr <= slopeEnd) {
      const k = (dr - flatHalf) / (slopeEnd - flatHalf);
      const s = k * k * (3 - 2 * k); // smoothstep slope
      cy = bedY + (bankY - bedY) * s;
    } else {
      cy = bankY;
    }
    const blend = 1 - sstep(slopeEnd, slopeEnd + 3.5, dr);
    h = h * (1 - blend) + cy * blend;

    return h;
  }

  private _buildAll(w: number, d: number) {
    this.W = w;
    this.D = d;
    // Vast worlds: the environment spans multiple blocks toward the horizon
    this.padX = Math.max(170, w * 2.0 + 130);
    this.padZ = Math.max(150, d * 1.8 + 110);
    this.zRoad = d + 3.2;

    // Seed varies per map size → every level gets its own unique world
    const rng = mulberry32(1337 + w * 7919 + d * 104729);

    this._buildTerrain(rng);
    this._buildRiver();
    this._buildPlantSite();
    this._buildSiteLighting();
    this._buildRoadsAndBridge();
    this._buildFenceAndGate();
    if (!this.cfg.desertMode) {
      this._buildForests(rng);
      this._buildBushTrees(rng);
    } else {
      this._buildDesertVegetation(rng);
      this._buildBushTrees(rng);
    }
    if (this.cfg.farmPlots > 0) this._buildFarmFields(rng);
    this._buildVillage(rng);
    this._buildTown(rng);
    if (this.cfg.factories > 0) this._buildFactories(rng);
    this._buildStreetLights();
    this._buildMountains();
    this._buildClouds(rng);
    this._buildChannelMarkers();
  }

  private _disposeEnv() {
    const kill = (obj: THREE.Object3D) => {
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
    };
    this.envGroup.traverse(kill);
    this.slabGroup.traverse(kill);
    this.envGroup.clear();
    this.slabGroup.clear();
    this.riverMesh = null;
    this.riverBasePos = null;
    this.cloudMesh = null;
    this.cloudData = [];
    this.lampBulbMat = null;
    this.windowMat = null;
    this.siteLights = [];
    this.flowParticles = null;
    this.flowData = [];
    this.traffic = [];
  }

  // ══════════════ SITE FLOODLIGHTING (night visibility) ═══════════════

  private _buildSiteLighting() {
    const w = this.W;
    const d = this.D;

    // Visual floodlight masts at the four corners of the plant
    const mastMat = std(0x6b7480, 0.6, 0.4);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfff8e0, emissive: 0xfff2c4, emissiveIntensity: 0.05,
    });
    const corners: [number, number][] = [[-1.5, -1.5], [w + 1.5, -1.5], [-1.5, d + 1.5], [w + 1.5, d + 1.5]];
    for (const [cx, cz] of corners) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 7.5, 8), mastMat);
      mast.position.set(cx, 3.75, cz);
      mast.castShadow = true;
      this.envGroup.add(mast);
      const crossbar = tbox(1.1, 0.09, 0.09, mastMat);
      crossbar.position.set(cx, 7.4, cz);
      crossbar.rotation.y = cx < w / 2 ? Math.PI / 4 : -Math.PI / 4;
      this.envGroup.add(crossbar);
      const head = tbox(0.55, 0.16, 0.35, headMat);
      head.position.set(cx, 7.28, cz);
      head.lookAt(w / 2, 0, d / 2);
      this.envGroup.add(head);
    }

    // Real SpotLights (one per corner) so the whole plant is readable at night
    for (const [cx, cz] of corners) {
      const spot = new THREE.SpotLight(0xffe9b8, 0, 90, 1.05, 0.55, 1.0);
      spot.position.set(cx, 7.3, cz);
      spot.target.position.set(cx < w / 2 ? w * 0.35 : w * 0.65, 0, cz < d / 2 ? d * 0.35 : d * 0.65);
      this.envGroup.add(spot);
      this.envGroup.add(spot.target);
      this.siteLights.push(spot);
    }
    // Gate floodlight
    const gateSpot = new THREE.SpotLight(0xffe9b8, 0, 40, 0.9, 0.6, 1.0);
    gateSpot.position.set(w / 2, 5.5, d + 3);
    gateSpot.target.position.set(w / 2, 0, d - 2);
    this.envGroup.add(gateSpot);
    this.envGroup.add(gateSpot.target);
    this.siteLights.push(gateSpot);
  }

  // ══════════════════ HOVER / GHOST PLACEMENT INDICATORS ══════════════════

  private _buildHoverAndGhost() {
    const hoverGeo = new THREE.PlaneGeometry(0.95, 0.95);
    const hoverMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    });
    this.hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverMesh.rotation.x = -Math.PI / 2;
    this.hoverMesh.position.y = 0.03;
    this.hoverMesh.visible = false;
    this.group.add(this.hoverMesh);

    this.ghostMesh = new THREE.Group();
    this.ghostMesh.visible = false;
    this.group.add(this.ghostMesh);
  }

  // ════════════════════════ TERRAIN + RIVER ═══════════════════════════

  private _buildTerrain(rng: () => number) {
    const sizeX = this.W + this.padX * 2;
    const sizeZ = this.D + this.padZ * 2;
    const segX = Math.min(190, Math.round(sizeX / 2.2));
    const segZ = Math.min(170, Math.round(sizeZ / 2.2));

    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(this.W / 2, 0, this.D / 2);

    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const cGrassA = new THREE.Color(this.cfg.grassA);
    const cGrassB = new THREE.Color(this.cfg.grassB);
    const cSand   = new THREE.Color(this.cfg.sand);
    const cMud    = new THREE.Color(this.cfg.mud);
    const tmp     = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.terrainHeight(x, z);
      pos.setY(i, h - 0.02);

      const n = rng();
      tmp.copy(cGrassA).lerp(cGrassB, 0.5 + 0.5 * Math.sin(x * 0.11 + z * 0.13) * (0.6 + n * 0.4));

      const dr = Math.abs(x - this.riverCenterX(z));
      const bankT = sstep(this.riverHW + 2.4, this.riverHW + 0.4, dr);
      tmp.lerp(cSand, bankT * 0.85);
      if (h < -0.85) tmp.lerp(cMud, sstep(-0.85, -1.6, h));

      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    this.envGroup.add(terrain);

    // Endless base plane far BELOW all terrain (valleys can dip to
    // -2.6 × hillAmp) so it only shows at the horizon — never as green
    // "flooded water" inside valleys.
    this.baseY = -(2.7 * this.cfg.hillAmp + 2);
    const underTone = new THREE.Color(this.cfg.grassB).lerp(new THREE.Color(0x8a9aa8), 0.35);
    const underMat = new THREE.MeshStandardMaterial({ color: underTone, roughness: 1, metalness: 0 });
    const under = new THREE.Mesh(new THREE.PlaneGeometry(4200, 4200), underMat);
    under.rotation.x = -Math.PI / 2;
    under.position.set(this.W / 2, this.baseY, this.D / 2);
    this.envGroup.add(under);
  }

  private _buildRiver() {
    const zMin = -this.padZ;
    const rngFleck = mulberry32(424242);
    const zMax = this.D + this.padZ;
    const steps = Math.round((zMax - zMin) / 1.5);

    // WATER RIBBON � built with the exact same recipe as the shoreline foam
    // (which provably renders in this scene): position-only indexed ribbon,
    // unlit material, no textures, no normals, frustum culling off.
    const mkRibbon = (halfWidth: number, y: number) => {
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const z = zMin + ((zMax - zMin) * i) / steps;
        const cx = this.riverCenterX(z);
        pos.push(cx - halfWidth, y, z);
        pos.push(cx + halfWidth, y, z);
        if (i < steps) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      return g;
    };

    // Flat cartoon blue surface, riding high in the dug channel
    const waterGeo = mkRibbon(this.riverHW * 0.96, -0.92);
    const water = new THREE.Mesh(
      waterGeo,
      new THREE.MeshBasicMaterial({ color: 0x3fc0ff })
    );
    water.frustumCulled = false;
    water.renderOrder = 2;
    this.riverMesh = water;
    this.riverBasePos = new Float32Array(waterGeo.getAttribute('position').array as Float32Array);
    this.envGroup.add(water);
// Drifting foam flecks that ride the current downstream (+Z direction)
    const N_FLECKS = Math.round((zMax - zMin) / 3.0);
    // Dash baked flat with its LONG AXIS along +Z (the flow direction);
    // per-instance yaw then follows the local river tangent.
    const fleckGeo = new THREE.PlaneGeometry(0.16, 0.66);
    fleckGeo.rotateX(-Math.PI / 2);
    const fleckMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
    });
    this.flowParticles = new THREE.InstancedMesh(fleckGeo, fleckMat, N_FLECKS);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    for (let i = 0; i < N_FLECKS; i++) {
      this.flowData.push({ t: rngFleck(), u: (rngFleck() - 0.5) * 5.6, speed: 0.75 + rngFleck() * 0.5, scale: 0.8 + rngFleck() * 0.9 });
      pos.set(this.riverCenterX(this.flowData[i].t * (zMax - zMin) + zMin), -1.0, 0);
      m.compose(pos, q, one);
      this.flowParticles.setMatrixAt(i, m);
    }
    this.flowParticles.instanceMatrix.needsUpdate = true;
    this.envGroup.add(this.flowParticles);
  }

  // ══════════════════ PLANT SLAB, GRID & LOT MARKERS ═══════════════════

  private _buildPlantSite() {
    const w = this.W;
    const d = this.D;

    const slabGeo = new THREE.BoxGeometry(w + 0.8, 0.5, d + 0.8);
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x55606e, roughness: 0.92 });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.set(w / 2, -0.25, d / 2);
    slab.receiveShadow = true;
    this.slabGroup.add(slab);

    const yardGeo = new THREE.PlaneGeometry(w, d);
    const yardMat = new THREE.MeshStandardMaterial({ color: 0x414c59, roughness: 0.96 });
    const yard = new THREE.Mesh(yardGeo, yardMat);
    yard.rotation.x = -Math.PI / 2;
    yard.position.set(w / 2, 0.005, d / 2);
    yard.receiveShadow = true;
    this.slabGroup.add(yard);

    this._buildGrid(w, d);
    this._buildLotLabels(w, d);
  }

  private _buildGrid(w: number, d: number) {
    const material = new THREE.LineBasicMaterial({ color: 0x3a4a5e, opacity: 0.55, transparent: true });
    const gridGroup = new THREE.Group();

    for (let x = 0; x <= w; x++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 0.012, 0),
        new THREE.Vector3(x, 0.012, d),
      ]);
      gridGroup.add(new THREE.Line(geo, material));
    }
    for (let z = 0; z <= d; z++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.012, z),
        new THREE.Vector3(w, 0.012, z),
      ]);
      gridGroup.add(new THREE.Line(geo, material));
    }
    const perimMat = new THREE.LineBasicMaterial({ color: 0x0ea5e9, opacity: 0.65, transparent: true });
    const perimGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.02, 0),
      new THREE.Vector3(w, 0.02, 0),
      new THREE.Vector3(w, 0.02, d),
      new THREE.Vector3(0, 0.02, d),
      new THREE.Vector3(0, 0.02, 0),
    ]);
    gridGroup.add(new THREE.Line(perimGeo, perimMat));

    this.slabGroup.add(gridGroup);
  }

  private _buildLotLabels(w: number, d: number) {
    const dotGeo = new THREE.CircleGeometry(0.1, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x5b6b7d });
    for (let x = 0; x <= w; x += 5) {
      for (let z = 0; z <= d; z += 5) {
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.rotation.x = -Math.PI / 2;
        dot.position.set(x, 0.018, z);
        this.slabGroup.add(dot);
      }
    }
  }

  // ═════════════════════ ROADS + RIVER BRIDGE ═════════════════════════

  private _buildRoadsAndBridge() {
    const roadGroup = new THREE.Group();
    const zR = this.zRoad;
    const xMin = -this.padX;
    const xMax = this.W + this.padX;

    const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x2b303b, roughness: 0.98 });
    const ROAD_W = 6.4;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(xMax - xMin, ROAD_W), asphaltMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set((xMin + xMax) / 2, 0.09, zR);
    road.receiveShadow = true;
    roadGroup.add(road);

    // Shoulder edges (lighter strips)
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x4a5261, roughness: 0.95 });
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Mesh(new THREE.PlaneGeometry(xMax - xMin, 0.5), shoulderMat);
      shoulder.rotation.x = -Math.PI / 2;
      shoulder.position.set((xMin + xMax) / 2, 0.095, zR + s * (ROAD_W / 2 + 0.25));
      roadGroup.add(shoulder);
    }

    // Driveway from plant gate to road
    const driveLen = Math.max(1, zR - this.D + 2.4);
    const drive = new THREE.Mesh(new THREE.PlaneGeometry(7, driveLen), asphaltMat);
    drive.rotation.x = -Math.PI / 2;
    drive.position.set(this.W / 2, 0.085, this.D + (zR - this.D) / 2 + 0.6);
    roadGroup.add(drive);

    // Double yellow centre line (two-way traffic)
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xd8b13a, roughness: 0.9 });
    for (const s of [-0.14, 0.14]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(xMax - xMin, 0.12), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set((xMin + xMax) / 2, 0.105, zR + s);
      roadGroup.add(line);
    }
    // White edge lines
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe8e3d3, roughness: 0.9 });
    for (const s of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(xMax - xMin, 0.14), edgeMat);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set((xMin + xMax) / 2, 0.105, zR + s * (ROAD_W / 2 - 0.35));
      roadGroup.add(edge);
    }
    this.envGroup.add(roadGroup);

    // Bridge where the road crosses the river
    const cx = this.riverCenterX(zR);
    const span = this.riverHW * 2 + 9;
    const bridgeGroup = new THREE.Group();

    const deckMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.6, ROAD_W), deckMat);
    deck.position.set(cx, -0.2, zR);
    deck.castShadow = true;
    bridgeGroup.add(deck);
    // Bridge asphalt overlay so lanes continue seamlessly
    const bridgeRoad = new THREE.Mesh(new THREE.PlaneGeometry(span, ROAD_W), asphaltMat);
    bridgeRoad.rotation.x = -Math.PI / 2;
    bridgeRoad.position.set(cx, 0.1, zR);
    bridgeGroup.add(bridgeRoad);
    const bridgeLineMat = lineMat;
    for (const s of [-0.14, 0.14]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(span, 0.12), bridgeLineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(cx, 0.11, zR + s);
      bridgeGroup.add(line);
    }

    const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa5b1, metalness: 0.5, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.09, 0.09), railMat);
      rail.position.set(cx, 0.82, zR + s * (ROAD_W / 2 + 0.55));
      bridgeGroup.add(rail);
      const railLow = new THREE.Mesh(new THREE.BoxGeometry(span, 0.07, 0.07), railMat);
      railLow.position.set(cx, 0.5, zR + s * (ROAD_W / 2 + 0.55));
      bridgeGroup.add(railLow);
      for (let px = -span / 2 + 1; px <= span / 2 - 1; px += 2.4) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.85, 0.09), railMat);
        post.position.set(cx + px, 0.42, zR + s * (ROAD_W / 2 + 0.55));
        bridgeGroup.add(post);
      }
    }
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x575f6b, roughness: 0.9 });
    for (const px of [-span * 0.28, span * 0.28]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 3.6, 10), pillarMat);
      pillar.position.set(cx + px, -1.5, zR);
      bridgeGroup.add(pillar);
    }
    this.envGroup.add(bridgeGroup);

    this._buildTraffic();
  }

  // ══════════════════ ROAD TRAFFIC (cars & trucks) ════════════════════

  private traffic: { group: THREE.Group; dir: 1 | -1; speed: number }[] = [];

  private _buildTraffic() {
    const zR = this.zRoad;
    const rng = mulberry32(55555);
    const N = 12;
    const carColors = [0xd94f4f, 0x4f7dd9, 0xe8e6e1, 0x3a3f47, 0xd9a53a, 0x4fae6a, 0x8f5fd4];
    const wheelMat = std(0x1c1f24, 0.9, 0.1);
    const glassMat = std(0x9fd8ee, 0.25, 0.4);

    const makeCar = () => {
      const g = new THREE.Group();
      const col = carColors[Math.floor(rng() * carColors.length)];
      const body = tbox(1.7, 0.42, 0.85, std(col, 0.45, 0.5));
      body.position.y = 0.32; g.add(body);
      const cabin = tbox(0.85, 0.36, 0.75, std(col, 0.45, 0.5));
      cabin.position.set(-0.08, 0.68, 0); g.add(cabin);
      const windshield = tbox(0.1, 0.28, 0.66, glassMat);
      windshield.position.set(0.36, 0.68, 0); g.add(windshield);
      for (const [wx, wz] of [[0.52, 0.42], [0.52, -0.42], [-0.52, 0.42], [-0.52, -0.42]] as const) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 10), wheelMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(wx, 0.2, wz);
        g.add(wheel);
      }
      // Headlights / taillights
      const hl = tbox(0.06, 0.1, 0.18, new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
      hl.position.set(0.86, 0.34, 0.24); g.add(hl);
      const hl2 = hl.clone(); hl2.position.z = -0.24; g.add(hl2);
      const tl = tbox(0.05, 0.09, 0.16, new THREE.MeshBasicMaterial({ color: 0xff5544 }));
      tl.position.set(-0.86, 0.36, 0.24); g.add(tl);
      const tl2 = tl.clone(); tl2.position.z = -0.24; g.add(tl2);
      return g;
    };

    const makeTruck = () => {
      const g = new THREE.Group();
      const col = carColors[Math.floor(rng() * carColors.length)];
      const cab = tbox(1.0, 0.95, 1.0, std(col, 0.45, 0.5));
      cab.position.set(1.35, 0.62, 0); g.add(cab);
      const glass = tbox(0.08, 0.4, 0.9, glassMat);
      glass.position.set(1.88, 0.78, 0); g.add(glass);
      const trailer = tbox(2.6, 1.15, 1.05, std(0xe4e7ea, 0.6, 0.3));
      trailer.position.set(-0.55, 0.78, 0); g.add(trailer);
      for (const [wx, wz] of [[1.35, 0.5], [1.35, -0.5], [-1.2, 0.5], [-1.2, -0.5], [-1.85, 0.5], [-1.85, -0.5]] as const) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.16, 10), wheelMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(wx, 0.24, wz);
        g.add(wheel);
      }
      return g;
    };

    for (let i = 0; i < N; i++) {
      const isTruck = rng() > 0.62;
      const g = isTruck ? makeTruck() : makeCar();
      const dir: 1 | -1 = rng() > 0.5 ? 1 : -1;
      const lane = dir === 1 ? -1.55 : 1.55; // right-hand traffic
      const speed = (isTruck ? 7 : 10) + rng() * 6;
      const x = lerpN(-this.padX, this.W + this.padX, rng());
      g.position.set(x, 0.06, zR + lane);
      g.rotation.y = dir === 1 ? 0 : Math.PI;
      g.traverse(o => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh) mm.castShadow = true;
      });
      this.envGroup.add(g);
      this.traffic.push({ group: g, dir, speed });
    }
  }

  // ══════════════════ FENCE, GATE & WELCOME SIGN ══════════════════════

  private _buildFenceAndGate() {
    const w = this.W;
    const d = this.D;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8ea3b8, metalness: 0.55, roughness: 0.45 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xaebccb, metalness: 0.5, roughness: 0.5 });

    const gateHalf = 3.6;
    const postGeo = new THREE.BoxGeometry(0.1, 1.15, 0.1);

    for (let x = 0; x <= w; x += 4) {
      const pN = new THREE.Mesh(postGeo, postMat);
      pN.position.set(x, 0.58, 0);
      this.envGroup.add(pN);
      const pS = new THREE.Mesh(postGeo, postMat);
      pS.position.set(x, 0.58, d);
      if (Math.abs(x - w / 2) > gateHalf) this.envGroup.add(pS);
    }
    for (let z = 4; z < d; z += 4) {
      const pW = new THREE.Mesh(postGeo, postMat);
      pW.position.set(0, 0.58, z);
      this.envGroup.add(pW);
      const pE = new THREE.Mesh(postGeo, postMat);
      pE.position.set(w, 0.58, z);
      this.envGroup.add(pE);
    }

    const addRail = (x1: number, z1: number, x2: number, z2: number, y: number) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len <= 0.01) return;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.055, 0.055), railMat);
      rail.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
      rail.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      this.envGroup.add(rail);
    };
    for (const y of [0.45, 0.95]) {
      addRail(0, 0, w, 0, y);
      addRail(0, d, w / 2 - gateHalf, d, y);
      addRail(w / 2 + gateHalf, d, w, d, y);
      addRail(0, 0, 0, d, y);
      addRail(w, 0, w, d, y);
    }

    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.8 });
    for (const s of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.1, 0.5), pillarMat);
      pillar.position.set(w / 2 + s * gateHalf, 1.05, d);
      pillar.castShadow = true;
      this.envGroup.add(pillar);
    }

    const signCanvas = document.createElement('canvas');
    signCanvas.width = 512; signCanvas.height = 128;
    const ctx = signCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 512, 128);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 8;
      ctx.strokeRect(6, 6, 500, 116);
      ctx.fillStyle = '#67e8f9';
      ctx.font = 'bold 52px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AQUATYCOON WWTP', 256, 68);
    }
    const signTex = new THREE.CanvasTexture(signCanvas);
    signTex.colorSpace = THREE.SRGBColorSpace;
    const signPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 1.6),
      new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide })
    );
    signPanel.position.set(w / 2, 2.7, d + 0.35);
    this.envGroup.add(signPanel);
  }

  // ═══════════════════════ FORESTS (instanced) ════════════════════════

  private _natureAllowed(x: number, z: number): boolean {
    if (x > -3.2 && x < this.W + 3.2 && z > -3.2 && z < this.D + 3.2) return false;
    if (Math.abs(z - this.zRoad) < 5.2) return false;
    if (Math.abs(x - this.riverCenterX(z)) < this.riverHW + 2.8) return false;
    return true;
  }

  private _buildForests(rng: () => number) {
    const N_CONIFER = this.cfg.conifers;
    const N_BROAD   = this.cfg.broadleaf;
    const N_BUSH    = this.cfg.bushes;
    const N_ROCK    = Math.round(60 * ((N_CONIFER + N_BROAD) / 620) + 20);

    const xMin = -this.padX + 4;
    const xMax = this.W + this.padX - 4;
    const zMin = -this.padZ + 4;
    const zMax = this.D + this.padZ - 4;

    const trunkGeo = new THREE.CylinderGeometry(0.09, 0.15, 1.0, 6);
    trunkGeo.translate(0, 0.5, 0);
    const coneGeo = new THREE.ConeGeometry(1.0, 1.0, 7);
    coneGeo.translate(0, 0.5, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.95 });
    const coniferMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });

    // Conifers
    const conifer = new THREE.InstancedMesh(coneGeo, coniferMat, N_CONIFER);
    const coniferTrunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N_CONIFER);
    conifer.castShadow = true;
    coniferTrunks.castShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();
    const vPos = new THREE.Vector3();
    const vScl = new THREE.Vector3();

    let nC = 0;
    for (let tries = 0; tries < N_CONIFER * 14 && nC < N_CONIFER; tries++) {
      const x = lerpN(xMin, xMax, rng());
      const z = lerpN(zMin, zMax, rng());
      if (!this._natureAllowed(x, z)) continue;
      const y = this.terrainHeight(x, z);
      if (y < -0.7) continue;
      const s = 0.9 + rng() * 1.5;
      eul.set(0, rng() * Math.PI * 2, 0);
      q.setFromEuler(eul);
      vPos.set(x, y, z); vScl.set(s * 0.85, s * (1.7 + rng() * 1.2), s * 0.85);
      m.compose(vPos, q, vScl);
      conifer.setMatrixAt(nC, m);
      col.setHex(this.cfg.coniferGreens[Math.floor(rng() * this.cfg.coniferGreens.length)]);
      conifer.setColorAt(nC, col);
      vScl.set(s * 0.8, s * 1.1, s * 0.8);
      m.compose(vPos, q, vScl);
      coniferTrunks.setMatrixAt(nC, m);
      nC++;
    }
    conifer.count = nC;
    coniferTrunks.count = nC;
    conifer.instanceMatrix.needsUpdate = true;
    coniferTrunks.instanceMatrix.needsUpdate = true;
    if (conifer.instanceColor) conifer.instanceColor.needsUpdate = true;
    this.envGroup.add(coniferTrunks);
    this.envGroup.add(conifer);

    // Broadleaf trees
    const blobGeo = new THREE.IcosahedronGeometry(1.0, 0);
    blobGeo.translate(0, 1.25, 0);
    const broadMat = new THREE.MeshStandardMaterial({ roughness: 0.88 });
    const broad = new THREE.InstancedMesh(blobGeo, broadMat, N_BROAD);
    const broadTrunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N_BROAD);
    broad.castShadow = true;
    broadTrunks.castShadow = true;

    let nB = 0;
    for (let tries = 0; tries < N_BROAD * 14 && nB < N_BROAD; tries++) {
      const x = lerpN(xMin, xMax, rng());
      const z = lerpN(zMin, zMax, rng());
      if (!this._natureAllowed(x, z)) continue;
      const y = this.terrainHeight(x, z);
      if (y < -0.7) continue;
      const s = 0.9 + rng() * 1.2;
      eul.set(0, rng() * Math.PI * 2, 0);
      q.setFromEuler(eul);
      vPos.set(x, y, z); vScl.set(s, s * (0.85 + rng() * 0.4), s);
      m.compose(vPos, q, vScl);
      broad.setMatrixAt(nB, m);
      col.setHex(this.cfg.broadleafGreens[Math.floor(rng() * this.cfg.broadleafGreens.length)]);
      broad.setColorAt(nB, col);
      vScl.set(s * 0.75, s, s * 0.75);
      m.compose(vPos, q, vScl);
      broadTrunks.setMatrixAt(nB, m);
      nB++;
    }
    broad.count = nB;
    broadTrunks.count = nB;
    broad.instanceMatrix.needsUpdate = true;
    broadTrunks.instanceMatrix.needsUpdate = true;
    if (broad.instanceColor) broad.instanceColor.needsUpdate = true;
    this.envGroup.add(broadTrunks);
    this.envGroup.add(broad);

    // Bushes
    const bushGeo = new THREE.IcosahedronGeometry(0.55, 0);
    bushGeo.translate(0, 0.35, 0);
    const bushes = new THREE.InstancedMesh(bushGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), N_BUSH);
    let nBush = 0;
    for (let tries = 0; tries < N_BUSH * 12 && nBush < N_BUSH; tries++) {
      const x = lerpN(xMin, xMax, rng());
      const z = lerpN(zMin, zMax, rng());
      if (!this._natureAllowed(x, z)) continue;
      const y = this.terrainHeight(x, z);
      if (y < -0.5) continue;
      const s = 0.6 + rng();
      eul.set(0, rng() * Math.PI, 0);
      q.setFromEuler(eul);
      vPos.set(x, y, z); vScl.set(s, s * 0.7, s);
      m.compose(vPos, q, vScl);
      bushes.setMatrixAt(nBush, m);
      col.setHex(this.cfg.broadleafGreens[Math.floor(rng() * this.cfg.broadleafGreens.length)]).offsetHSL(0, 0, -0.04);
      bushes.setColorAt(nBush, col);
      nBush++;
    }
    bushes.count = nBush;
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    this.envGroup.add(bushes);

    // River rocks — a few sitting in the water, each marked with a THIN white
    // waterline ring (cartoon outline, not a filled disc). Banks stay clean.
    const rockGeo = new THREE.DodecahedronGeometry(0.4, 0);
    const N_ROCK_IN = Math.round(N_ROCK * 0.3);
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x7d7f83, roughness: 0.95 }), N_ROCK);
    rocks.castShadow = true;
    const ringGeo = new THREE.RingGeometry(0.42, 0.56, 20);
    const rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      N_ROCK_IN
    );
    let nR = 0;
    let nF = 0;
    for (let tries = 0; tries < N_ROCK * 14 && nR < N_ROCK; tries++) {
      const z = lerpN(zMin, zMax, rng());
      const side = rng() > 0.5 ? 1 : -1;
      const inWater = nR % 4 === 0; // ~25% of rocks break the surface
      const x = inWater
        ? this.riverCenterX(z) + side * rng() * this.riverHW * 0.6
        : this.riverCenterX(z) + side * (this.riverHW + 1.4 + rng() * 2.2);
      const y = this.terrainHeight(x, z);
      const s = 0.5 + rng() * 0.9;
      eul.set(rng() * Math.PI, rng() * Math.PI, rng() * 0.4);
      q.setFromEuler(eul);
      const rockY = inWater ? -1.12 + s * 0.22 : y;
      vPos.set(x, rockY, z); vScl.set(s, s * 0.8, s);
      m.compose(vPos, q, vScl);
      rocks.setMatrixAt(nR, m);
      // Thin ring at the waterline where the stone breaks the surface
      if (inWater) {
        eul.set(-Math.PI / 2 + (rng() - 0.5) * 0.2, 0, rng() * Math.PI);
        q.setFromEuler(eul);
        vPos.set(x, -1.03, z); vScl.set(s, s, s);
        m.compose(vPos, q, vScl);
        rings.setMatrixAt(nF++, m);
      }
      nR++;
    }
    rocks.count = nR;
    rings.count = nF;
    rocks.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    this.envGroup.add(rocks);
    this.envGroup.add(rings);
  }

  // ══════════════════ SURROUNDING TOWN & CITY ═════════════════════════

  private _townAllowed(x: number, z: number, placed: Placed[], r: number): boolean {
    if (x > -4 && x < this.W + 4 && z > -4 && z < this.D + 2) return false;
    if (Math.abs(z - this.zRoad) < 5) return false;
    if (Math.abs(x - this.riverCenterX(z)) < this.riverHW + 3.4) return false;
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.z - z) < p.r + r) return false;
    }
    return true;
  }

  private _makeWindowTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#243040';
      ctx.fillRect(0, 0, 128, 256);
      const rng = mulberry32(7);
      for (let wy = 10; wy < 250; wy += 22) {
        for (let wx = 10; wx < 120; wx += 20) {
          ctx.fillStyle = rng() > 0.42 ? '#ffd98a' : '#16202e';
          ctx.fillRect(wx, wy, 12, 14);
        }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private _buildTown(rng: () => number) {
    const placed: Placed[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();
    const vPos = new THREE.Vector3();
    const vScl = new THREE.Vector3();

    // Shared instanced pools
    const MAX_HOUSES = Math.round(Math.min(950, Math.max(400, ((this.W + this.padX) * (this.D + this.padZ)) / 19)));
    const MAX_ROOFS = MAX_HOUSES;
    const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
    bodyGeo.translate(0, 0.5, 0);
    const roofGeo = new THREE.ConeGeometry(0.72, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.translate(0, 0.5, 0);
    const houseMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const houses = new THREE.InstancedMesh(bodyGeo, houseMat, MAX_HOUSES);
    const roofs = new THREE.InstancedMesh(roofGeo, roofMat, MAX_ROOFS);
    houses.castShadow = true; houses.receiveShadow = true;
    roofs.castShadow = true;

    const windowTex = this._makeWindowTexture();
    this.windowMat = new THREE.MeshStandardMaterial({
      color: 0xbfc8d4,
      roughness: 0.55,
      metalness: 0.15,
      emissive: 0xffd27a,
      emissiveMap: windowTex,
      map: windowTex,
      emissiveIntensity: 0.05,
    });
    const towerGeo = new THREE.BoxGeometry(1, 1, 1);
    towerGeo.translate(0, 0.5, 0);
    const MAX_TOWERS = Math.round(Math.min(340, Math.max(140, ((this.W * 0.4 + this.padX) * (this.D + this.padZ)) / 52)));
    const towers = new THREE.InstancedMesh(towerGeo, this.windowMat, MAX_TOWERS);
    towers.castShadow = true; towers.receiveShadow = true;
    const roofSlabMat = new THREE.MeshStandardMaterial({ color: 0x39404d, roughness: 0.9 });
    const towerRoofs = new THREE.InstancedMesh(towerGeo, roofSlabMat, MAX_TOWERS);

    let nH = 0, nT = 0;

    const addHouse = (x: number, z: number, s: number) => {
      if (nH >= MAX_HOUSES) return;
      const y = this.terrainHeight(x, z);
      eul.set(0, (rng() - 0.5) * 0.7, 0);
      q.setFromEuler(eul);
      const bw = (1.9 + rng() * 0.9) * s;
      const bh = (1.25 + rng() * 0.5) * s;
      const bd = (1.9 + rng() * 0.9) * s;
      vPos.set(x, y, z); vScl.set(bw, bh, bd);
      m.compose(vPos, q, vScl);
      houses.setMatrixAt(nH, m);
      col.setHex(HOUSE_COLORS[Math.floor(rng() * HOUSE_COLORS.length)]);
      houses.setColorAt(nH, col);
      const rh = (0.75 + rng() * 0.45) * s;
      vPos.set(x, y + bh, z); vScl.set(Math.max(bw, bd) * 0.82, rh, Math.max(bw, bd) * 0.82);
      m.compose(vPos, q, vScl);
      roofs.setMatrixAt(nH, m);
      col.setHex(ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)]);
      roofs.setColorAt(nH, col);
      placed.push({ x, z, r: Math.max(bw, bd) });
      nH++;
    };

    const addTower = (x: number, z: number) => {
      if (nT >= MAX_TOWERS) return;
      const y = this.terrainHeight(x, z);
      eul.set(0, (rng() - 0.5) * 0.5, 0);
      q.setFromEuler(eul);
      const bw = 2.6 + rng() * 1.6;
      const bh = 3.5 + rng() * 8;
      const bd = 2.6 + rng() * 1.6;
      vPos.set(x, y, z); vScl.set(bw, bh, bd);
      m.compose(vPos, q, vScl);
      towers.setMatrixAt(nT, m);
      col.setHex(TOWER_COLORS[Math.floor(rng() * TOWER_COLORS.length)]);
      towers.setColorAt(nT, col);
      vPos.set(x, y + bh + 0.12, z); vScl.set(bw * 1.02, 0.24, bd * 1.02);
      m.compose(vPos, q, vScl);
      towerRoofs.setMatrixAt(nT, m);
      placed.push({ x, z, r: Math.max(bw, bd) });
      nT++;
    };

    // West suburb
    for (let i = 0; i < 130; i++) {
      const x = lerpN(-this.padX + 10, -12, rng());
      const z = lerpN(-this.padZ + 10, this.zRoad - 7, rng());
      if (!this._townAllowed(x, z, placed, 3.4)) continue;
      addHouse(x, z, 1);
    }
    // South town across the road
    for (let i = 0; i < Math.round(140 * this.cfg.cityDensity); i++) {
      const x = lerpN(-this.padX + 10, this.W * 0.65, rng());
      const z = lerpN(this.zRoad + 6.5, this.D + this.padZ - 10, rng());
      if (!this._townAllowed(x, z, placed, 3.4)) continue;
      addHouse(x, z, 1 + rng() * 0.35);
    }
    // North farms
    for (let i = 0; i < 80; i++) {
      const x = lerpN(-this.padX + 12, this.W - 8, rng());
      const z = lerpN(-this.padZ + 10, -8, rng());
      if (!this._townAllowed(x, z, placed, 4)) continue;
      addHouse(x, z, 1.15 + rng() * 0.5);
    }
    // East city core across the river
    for (let i = 0; i < Math.round(170 * this.cfg.cityDensity); i++) {
      const x = lerpN(this.W + 26, this.W + this.padX - 8, rng());
      const z = lerpN(-this.padZ + 12, this.D + this.padZ - 12, rng());
      if (!this._townAllowed(x, z, placed, 4.2)) continue;
      if (rng() > 0.32) addTower(x, z); else addHouse(x, z, 1.05);
    }

    houses.count = nH; roofs.count = nH;
    towers.count = nT; towerRoofs.count = nT;
    houses.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    towers.instanceMatrix.needsUpdate = true;
    towerRoofs.instanceMatrix.needsUpdate = true;
    if (houses.instanceColor) houses.instanceColor.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
    this.envGroup.add(houses);
    this.envGroup.add(roofs);
    this.envGroup.add(towers);
    this.envGroup.add(towerRoofs);

    // Industrial silos north of the plant
    const siloMat = new THREE.MeshStandardMaterial({ color: 0xc3cad3, metalness: 0.65, roughness: 0.3 });
    for (let i = 0; i < 3; i++) {
      const sx = this.W * 0.18 + i * 3.4;
      const sz = -this.padZ * 0.42;
      const y = this.terrainHeight(sx, sz);
      const silo = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 5.2, 14), siloMat);
      silo.position.set(sx, y + 2.6, sz);
      silo.castShadow = true;
      this.envGroup.add(silo);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), siloMat);
      cap.position.set(sx, y + 5.2, sz);
      this.envGroup.add(cap);
    }
    const stack = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.62, 9, 10),
      new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.8 })
    );
    stack.position.set(this.W * 0.38, this.terrainHeight(this.W * 0.38, -this.padZ * 0.4) + 4.5, -this.padZ * 0.4);
    stack.castShadow = true;
    this.envGroup.add(stack);

    void eul; void q; void m; // retained for future builders
  }

  // ══════════════════ FARMLAND (procedural crops) ═════════════════════

  private _buildFarmFields(rng: () => number) {
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = 32; cropCanvas.height = 32;
    const cctx = cropCanvas.getContext('2d');
    if (cctx) {
      for (let y = 0; y < 32; y += 4) {
        cctx.fillStyle = y % 8 === 0 ? 'rgba(0,0,0,0.30)' : 'rgba(255,255,255,0.15)';
        cctx.fillRect(0, y, 32, 2);
      }
    }
    const cropColors = [0x9aa83f, 0xc2a24a, 0x6d8c33, 0x7d6b3a];
    const plots: [number, number][] = [];

    for (let i = 0; i < this.cfg.farmPlots * 2; i++) {
      if (plots.length >= this.cfg.farmPlots) break;
      const north = i % 2 === 0;
      const fx = north
        ? lerpN(-this.padX * 0.55, this.W * 0.5, rng())
        : lerpN(-this.padX + 14, -this.padX * 0.28, rng());
      const fz = north
        ? lerpN(-this.padZ + 10, Math.min(-this.D - 16, -20), rng())
        : lerpN(-this.padZ * 0.42, this.zRoad - 12, rng());
      let clash = false;
      for (const [px, pz] of plots) {
        if (Math.hypot(px - fx, pz - fz) < 15) { clash = true; break; }
      }
      if (clash) continue;
      if (Math.abs(fx - this.riverCenterX(fz)) < this.riverHW + 6) continue;
      if (fx > -6 && fx < this.W + 6 && fz > -8 && fz < this.zRoad + 6) continue;
      plots.push([fx, fz]);
    }

    for (const [fx, fz] of plots) {
      const size = 9 + rng() * 7;
      const y = this.terrainHeight(fx, fz);
      const tex = new THREE.CanvasTexture(cropCanvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(Math.round(size / 3), Math.round(size / 3));
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: cropColors[Math.floor(rng() * cropColors.length)],
        roughness: 0.95,
      });
      const field = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
      field.rotation.x = -Math.PI / 2;
      field.rotation.z = rng() * Math.PI;
      field.position.set(fx, y + 0.07, fz);
      field.receiveShadow = true;
      this.envGroup.add(field);
    }
  }

  // ══════════════ DESERT VEGETATION (cacti & palms) ═══════════════════

  private _buildDesertVegetation(rng: () => number) {
    const xMin = -this.padX + 6;
    const xMax = this.W + this.padX - 6;
    const zMin = -this.padZ + 6;
    const zMax = this.D + this.padZ - 6;
    const N_CACTI = 450;
    const N_PALMS = 260;

    // Saguaro cacti
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.28, 2.2, 8);
    trunkGeo.translate(0, 1.1, 0);
    const cactusMat = std(0x4f7a3a, 0.85, 0);
    const cacti = new THREE.InstancedMesh(trunkGeo, cactusMat, N_CACTI * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    let n = 0;
    for (let i = 0; i < N_CACTI; i++) {
      const x = lerpN(xMin, xMax, rng());
      const z = lerpN(zMin, zMax, rng());
      if (!this._natureAllowed(x, z)) continue;
      if (Math.abs(x - this.riverCenterX(z)) < this.riverHW + 4) continue;
      const y = this.terrainHeight(x, z);
      const s = 0.7 + rng() * 0.9;
      eul.set(0, rng() * Math.PI * 2, 0); q.setFromEuler(eul);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
      cacti.setMatrixAt(n++, m);
      // Arms
      for (const side of [-1, 1]) {
        if (rng() > 0.55) continue;
        const armM = new THREE.Matrix4()
          .makeTranslation(side * 0.34 * s, (1.15 + rng() * 0.5) * s, 0)
          .multiply(new THREE.Matrix4().makeRotationZ(side * 0.9))
          .multiply(new THREE.Matrix4().makeTranslation(0, 0.35, 0))
          .multiply(new THREE.Matrix4().makeScale(s, s, s));
        const armWorld = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)).multiply(armM);
        cacti.setMatrixAt(n++, armWorld);
      }
    }
    cacti.count = n;
    cacti.instanceMatrix.needsUpdate = true;
    cacti.castShadow = true;
    this.envGroup.add(cacti);

    // Date palms near the riverbanks
    const palmTrunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 3.2, 7);
    palmTrunkGeo.translate(0, 1.6, 0);
    const frondGeo = new THREE.ConeGeometry(1.15, 0.5, 6);
    const palms = new THREE.InstancedMesh(palmTrunkGeo, std(0xa5793f, 0.9, 0), N_PALMS);
    const fronds = new THREE.InstancedMesh(frondGeo, std(0x5c8a3a, 0.8, 0), N_PALMS * 2);
    let np = 0; let nf = 0;
    for (let i = 0; i < N_PALMS; i++) {
      const z = lerpN(zMin, zMax, rng());
      const side = rng() > 0.5 ? 1 : -1;
      const x = this.riverCenterX(z) + side * (this.riverHW + 3 + rng() * 10);
      if (!this._natureAllowed(x, z)) continue;
      const y = Math.max(-0.2, this.terrainHeight(x, z));
      const s = 0.8 + rng() * 0.6;
      eul.set(0, rng() * Math.PI * 2, (rng() - 0.5) * 0.16); q.setFromEuler(eul);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
      palms.setMatrixAt(np++, m);
      for (let f = 0; f < 2; f++) {
        const fm = new THREE.Matrix4().compose(
          new THREE.Vector3((rng() - 0.5) * 0.3, (3.25 - f * 0.28) * s, (rng() - 0.5) * 0.3),
          q.clone(),
          new THREE.Vector3(s, s * 0.8, s)
        );
        fronds.setMatrixAt(nf++, fm);
      }
    }
    palms.count = np; fronds.count = nf;
    palms.instanceMatrix.needsUpdate = true;
    fronds.instanceMatrix.needsUpdate = true;
    palms.castShadow = true; fronds.castShadow = true;
    this.envGroup.add(palms);
    this.envGroup.add(fronds);

    // Dry scrub bushes
    const bushGeo = new THREE.IcosahedronGeometry(0.5, 0);
    bushGeo.translate(0, 0.3, 0);
    const scrubs = new THREE.InstancedMesh(bushGeo, std(0x8a8a4a, 0.95, 0), 90);
    let ns = 0;
    for (let i = 0; i < 900 && ns < 90; i++) {
      const x = lerpN(xMin, xMax, rng());
      const z = lerpN(zMin, zMax, rng());
      if (!this._natureAllowed(x, z)) continue;
      const y = this.terrainHeight(x, z);
      if (y < -0.4) continue;
      const s = 0.5 + rng() * 0.8;
      eul.set(0, rng() * Math.PI, 0); q.setFromEuler(eul);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * 0.6, s));
      scrubs.setMatrixAt(ns++, m);
    }
    scrubs.count = ns;
    scrubs.instanceMatrix.needsUpdate = true;
    this.envGroup.add(scrubs);
  }

  // ══════════════ INDUSTRIAL FACTORIES (scenario dressing) ════════════

  private _buildFactories(rng: () => number) {
    const count = this.cfg.factories;
    for (let i = 0; i < count; i++) {
      const north = rng() > 0.5;
      const fx = north
        ? lerpN(-this.padX * 0.7, this.W * 0.4, rng())
        : lerpN(this.W * 0.55, this.W + this.padX * 0.55, rng());
      const fz = north
        ? lerpN(-this.padZ + 14, -this.D - 20, rng())
        : lerpN(this.zRoad + 14, this.D + this.padZ - 16, rng());
      if (Math.abs(fx - this.riverCenterX(fz)) < this.riverHW + 8) continue;
      if (fx > -8 && fx < this.W + 8 && fz > -10 && fz < this.zRoad + 8) continue;
      const fy = this.terrainHeight(fx, fz);
      const rot = rng() * Math.PI;

      const hall = tbox(10 + rng() * 8, 3.2, 6 + rng() * 3, std(0x8d8578, 0.9, 0.1));
      hall.position.set(fx, fy + 1.6, fz);
      hall.rotation.y = rot;
      this.envGroup.add(hall);

      const sawRoof = tbox(10.6, 0.5, 6.6, std(0x6e675c, 0.9, 0.05));
      sawRoof.position.set(fx, fy + 3.4, fz);
      sawRoof.rotation.y = rot;
      this.envGroup.add(sawRoof);

      // Smokestacks with haze puffs
      const stacks = 1 + Math.floor(rng() * 2);
      for (let sIdx = 0; sIdx < stacks; sIdx++) {
        const sx = fx + Math.cos(rot) * (2 + sIdx * 2.2);
        const sz = fz - Math.sin(rot) * (2 + sIdx * 2.2);
        const stackH = 6 + rng() * 4;
        const stack = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.6, stackH, 10),
          std(0xa39b90, 0.92, 0.03)
        );
        stack.position.set(sx, fy + stackH / 2, sz);
        stack.castShadow = true;
        this.envGroup.add(stack);
        const bandMat = new THREE.MeshBasicMaterial({ color: 0xd9d2c8 });
        for (let b = 1; b <= 2; b++) {
          const band = new THREE.Mesh(new THREE.TorusGeometry(0.52 - b * 0.06, 0.06, 6, 12), bandMat);
          band.rotation.x = Math.PI / 2;
          band.position.set(sx, fy + (stackH * b) / 3, sz);
          this.envGroup.add(band);
        }
        // Smoke plume
        const smokeMat = new THREE.MeshBasicMaterial({
          color: 0xcfd4d8,
          transparent: true,
          opacity: 0.30,
          depthWrite: false,
        });
        for (let p = 0; p < 4; p++) {
          const puff = new THREE.Mesh(new THREE.SphereGeometry(0.8 + p * 0.55, 8, 6), smokeMat);
          puff.position.set(sx + p * 0.7, fy + stackH + 0.6 + p * 1.15, sz + p * 0.25);
          this.envGroup.add(puff);
        }
      }

      // Storage tanks beside the hall
      for (let tIdx = 0; tIdx < 2; tIdx++) {
        const tank = new THREE.Mesh(
          new THREE.CylinderGeometry(1.4, 1.4, 2.4, 14),
          std(tIdx === 0 ? 0xb8bfc6 : 0xc9b08a, 0.6, 0.3)
        );
        tank.position.set(fx + Math.cos(rot + 1.4) * 7 + tIdx * 3, fy + 1.2, fz - Math.sin(rot + 1.4) * 7);
        tank.castShadow = true;
        this.envGroup.add(tank);
      }
    }
  }

  // ════════════ WIDE BUSH-TREES — fills every remaining gap ════════════

  private _buildBushTrees(rng: () => number) {
    const area = (this.W + this.padX * 0.95) * (this.D + this.padZ * 0.95);
    const k = Math.min(2.4, Math.max(1.1, area / 14000));
    const N = Math.round(1500 * k);

    const blobGeo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
    const blobs = new THREE.InstancedMesh(blobGeo, mat, N * 2);
    blobs.castShadow = true;

    const xMin = -this.padX + 3;
    const xMax = this.W + this.padX - 3;
    const zMin = -this.padZ + 3;
    const zMax = this.D + this.padZ - 3;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();
    let n = 0;

    for (let tries = 0; tries < N * 8 && n < N * 2; tries++) {
      const x = lerpN(xMin, xMax, rng());
      const z = lerpN(zMin, zMax, rng());
      if (!this._natureAllowed(x, z)) continue;
      const y = this.terrainHeight(x, z);
      if (y < -0.55) continue; // not in the river
      const wide = 2.1 + rng() * 1.7;
      const tall = 1.0 + rng() * 0.9;
      eul.set(rng() * 0.3, rng() * Math.PI * 2, rng() * 0.3);
      q.setFromEuler(eul);

      // Main wide canopy
      const vPos = new THREE.Vector3(x, y + tall * 0.55, z);
      const vScl = new THREE.Vector3(wide, tall, wide);
      m.compose(vPos, q, vScl);
      blobs.setMatrixAt(n, m);
      col.setHex(this.cfg.broadleafGreens.length > 0
        ? this.cfg.broadleafGreens[Math.floor(rng() * this.cfg.broadleafGreens.length)]
        : 0x8a8a4a
      ).offsetHSL((rng() - 0.5) * 0.03, 0, (rng() - 0.5) * 0.08);
      blobs.setColorAt(n, col);
      n++;

      // Secondary offset blob for a bushy silhouette
      if (n >= N * 2) break;
      vPos.set(x + (rng() - 0.5) * wide * 0.9, y + tall * 0.38, z + (rng() - 0.5) * wide * 0.9);
      vScl.set(wide * 0.62, tall * 0.72, wide * 0.62);
      m.compose(vPos, q, vScl);
      blobs.setMatrixAt(n, m);
      col.offsetHSL(0, 0, (rng() - 0.5) * 0.05);
      blobs.setColorAt(n, col);
      n++;
    }
    blobs.count = n;
    blobs.instanceMatrix.needsUpdate = true;
    if (blobs.instanceColor) blobs.instanceColor.needsUpdate = true;
    this.envGroup.add(blobs);
  }

  // ══════════════════ VILLAGE (chapel, well, green) ═══════════════════

  private _buildVillage(rng: () => number) {
    const vx = -this.padX * 0.42;
    const vz = this.D * 0.15;
    const vy = this.terrainHeight(vx, vz);
    const chapelMat = std(0xd8cdb8, 0.85, 0.05);
    const roofMat = std(0x5e4438, 0.85, 0.05);

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.envGroup.add(m);
      return m;
    };

    // Chapel with bell tower
    mesh(new THREE.BoxGeometry(2.2, 1.5, 3.4), chapelMat, vx, vy + 0.75, vz);
    mesh(new THREE.BoxGeometry(1.1, 3.0, 1.1), chapelMat, vx, vy + 1.5, vz - 2.4);
    const spire = mesh(new THREE.ConeGeometry(0.85, 1.4, 4), roofMat, vx, vy + 3.7, vz - 2.4);
    spire.rotation.y = Math.PI / 4;
    const naveRoof = mesh(new THREE.ConeGeometry(1.9, 1.0, 4), roofMat, vx, vy + 2.25, vz);
    naveRoof.rotation.y = Math.PI / 4;
    naveRoof.scale.set(1, 1, 1.45);

    // Well on the village green
    mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.5, 10), std(0x8d8478, 0.95, 0), vx + 3, vy + 0.25, vz + 2.5);
    const wellRoof = mesh(new THREE.ConeGeometry(0.75, 0.5, 8), roofMat, vx + 3, vy + 1.35, vz + 2.5);
    wellRoof.rotation.y = rng();
    for (const px of [-0.38, 0.38]) {
      mesh(new THREE.BoxGeometry(0.06, 1.0, 0.06), roofMat, vx + 3 + px, vy + 0.85, vz + 2.5);
    }

    // Green space tint
    const green = new THREE.Mesh(new THREE.CircleGeometry(7, 20), std(0x55823d, 0.95, 0));
    green.rotation.x = -Math.PI / 2;
    green.position.set(vx, vy + 0.09, vz);
    green.receiveShadow = true;
    this.envGroup.add(green);

    // Cottages ringing the green
    const bodyGeo = new THREE.BoxGeometry(1, 1, 1); bodyGeo.translate(0, 0.5, 0);
    const roofGeo = new THREE.ConeGeometry(0.72, 1, 4); roofGeo.rotateY(Math.PI / 4); roofGeo.translate(0, 0.5, 0);
    const n = Math.round(this.cfg.villageCottages * 1.6);
    const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    const roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), n);
    bodies.castShadow = true; roofs.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rng() * 0.4;
      const dist = 9 + rng() * 7;
      const hx = vx + Math.cos(ang) * dist;
      const hz = vz + Math.sin(ang) * dist;
      if (Math.abs(hx - this.riverCenterX(hz)) < this.riverHW + 3) continue;
      const hy = this.terrainHeight(hx, hz);
      const s = 0.85 + rng() * 0.4;
      eul.set(0, -ang + Math.PI / 2 + (rng() - 0.5) * 0.3, 0);
      q.setFromEuler(eul);
      m.compose(new THREE.Vector3(hx, hy, hz), q, new THREE.Vector3(2.0 * s, 1.3 * s, 1.8 * s));
      bodies.setMatrixAt(placed, m);
      col.setHex(HOUSE_COLORS[Math.floor(rng() * HOUSE_COLORS.length)]);
      bodies.setColorAt(placed, col);
      m.compose(new THREE.Vector3(hx, hy + 1.3 * s, hz), q, new THREE.Vector3(1.6 * s, 0.9 * s, 1.5 * s));
      roofs.setMatrixAt(placed, m);
      col.setHex(ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)]);
      roofs.setColorAt(placed, col);
      placed++;
    }
    bodies.count = placed; roofs.count = placed;
    bodies.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    this.envGroup.add(bodies);
    this.envGroup.add(roofs);
  }

  private _buildStreetLights() {
    const zR = this.zRoad;
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 3.0, 6);
    poleGeo.translate(0, 1.5, 0);
    const armGeo = new THREE.BoxGeometry(0.9, 0.07, 0.07);
    const bulbGeo = new THREE.SphereGeometry(0.14, 8, 8);

    const poleMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.6, metalness: 0.4 });
    this.lampBulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff2cc,
      emissive: 0xffe9b0,
      emissiveIntensity: 0.05,
    });

    const spots: { x: number; side: number }[] = [];
    const xMin = -this.padX + 6;
    const xMax = this.W + this.padX - 6;
    let idx = 0;
    for (let x = xMin; x <= xMax; x += 11) {
      spots.push({ x, side: idx % 2 === 0 ? -1 : 1 });
      idx++;
    }

    const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, spots.length);
    const bulbs = new THREE.InstancedMesh(bulbGeo, this.lampBulbMat, spots.length);
    poles.castShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const vPos = new THREE.Vector3();
    const vOne = new THREE.Vector3(1, 1, 1);

    spots.forEach((sp, i) => {
      const y = Math.max(0, this.terrainHeight(sp.x, zR + sp.side * 4.6));
      eul.set(0, sp.side > 0 ? 0 : Math.PI, 0);
      q.setFromEuler(eul);
      vPos.set(sp.x, y, zR + sp.side * 4.6);
      m.compose(vPos, q, vOne);
      poles.setMatrixAt(i, m);
      vPos.set(sp.x + sp.side * 0.45, y + 2.95, zR + sp.side * 4.6);
      m.compose(vPos, q, vOne);
      arms.setMatrixAt(i, m);
      vPos.set(sp.x + sp.side * 0.85, y + 2.88, zR + sp.side * 4.6);
      m.compose(vPos, q, vOne);
      bulbs.setMatrixAt(i, m);
    });
    poles.instanceMatrix.needsUpdate = true;
    arms.instanceMatrix.needsUpdate = true;
    bulbs.instanceMatrix.needsUpdate = true;
    this.envGroup.add(poles);
    this.envGroup.add(arms);
    this.envGroup.add(bulbs);
  }

  private _buildMountains() {
    const cxm = this.W * 0.35;
    const czm = this.D * 0.4;
    const R = Math.max(this.W + this.padX, this.D + this.padZ) + 42;
    const COUNT = 13;
    const geo = new THREE.ConeGeometry(1, 1, 5);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x50697c,
      roughness: 1,
      flatShading: true,
    });
    const ring = new THREE.InstancedMesh(geo, mat, COUNT);
    const rng = mulberry32(99);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const ang = (i / COUNT) * Math.PI * 2 + rng() * 0.3;
      const rr = R * (0.92 + rng() * 0.25);
      const x = cxm + Math.cos(ang) * rr;
      const z = czm + Math.sin(ang) * rr;
      const s = 26 + rng() * 30;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
      m.compose(new THREE.Vector3(x, this.baseY + 0.5, z), q, new THREE.Vector3(s * 1.5, s, s * 1.5));
      ring.setMatrixAt(i, m);
      col.setHex(0x50697c).offsetHSL(0, 0.02, rng() * 0.05 - 0.02);
      ring.setColorAt(i, col);
    }
    ring.instanceMatrix.needsUpdate = true;
    if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
    this.envGroup.add(ring);
  }

  private _buildClouds(rng: () => number) {
    const N = 16;
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      transparent: true,
      opacity: 0.82,
      flatShading: true,
    });
    this.cloudMesh = new THREE.InstancedMesh(geo, mat, N);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < N; i++) {
      const x = lerpN(-this.padX, this.W + this.padX, rng());
      const y = 24 + rng() * 12;
      const z = lerpN(-this.padZ, this.D + this.padZ, rng());
      const sx = 3 + rng() * 3.4;
      const sy = 1 + rng() * 0.7;
      const sz = 2 + rng() * 2.4;
      q.setFromEuler(new THREE.Euler(0, rng() * Math.PI, 0));
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
      this.cloudMesh.setMatrixAt(i, m);
      this.cloudData.push({ y, z, speed: 0.5 + rng() * 0.9, sx, sy, sz });
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;
    this.envGroup.add(this.cloudMesh);
  }

  // ══════════════════ INFLUENT / EFFLUENT MARKERS ═════════════════════

  private _buildChannelMarkers() {
    this._addMarker(0, this.D / 2, 'INFLUENT', 0x0891b2, true);
    this._addMarker(this.W, this.D / 2, 'EFFLUENT', 0x059669, false);
  }

  private _addMarker(x: number, z: number, label: string, color: number, pointRight: boolean) {
    void label;
    const postGeo = new THREE.BoxGeometry(0.3, 1.8, 0.3);
    const postMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4 });
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(x, 0.9, z);
    post.castShadow = true;
    this.envGroup.add(post);

    const coneGeo = new THREE.ConeGeometry(0.28, 0.62, 6);
    const coneMat = new THREE.MeshBasicMaterial({ color });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(x, 2.15, z);
    cone.rotation.z = pointRight ? -Math.PI / 2 : Math.PI / 2;
    this.envGroup.add(cone);
  }
}
