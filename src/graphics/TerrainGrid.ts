import * as THREE from 'three';

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

interface Placed { x: number; z: number; r: number; }

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

  private W = 24;
  private D = 20;
  private padX = 46;
  private padZ = 40;
  private riverHW = 4.2;
  private zRoad = 22;

  private riverMesh: THREE.Mesh | null = null;
  private riverBasePos: Float32Array | null = null;
  private cloudMesh: THREE.InstancedMesh | null = null;
  private cloudData: { y: number; z: number; speed: number; sx: number; sy: number; sz: number }[] = [];
  private lampBulbMat: THREE.MeshStandardMaterial | null = null;
  private windowMat: THREE.MeshStandardMaterial | null = null;

  constructor(mapWidth: number = 24, mapDepth: number = 20) {
    this.group = new THREE.Group();
    this.group.add(this.envGroup);
    this.group.add(this.slabGroup);

    this._buildHoverAndGhost();
    this._buildAll(mapWidth, mapDepth);
  }

  // ════════════════════════════ PUBLIC API ════════════════════════════

  public updateSize(w: number, d: number) {
    this._disposeEnv();
    this._buildAll(w, d);
    this.group.add(this.hoverMesh);
    this.group.add(this.ghostMesh);
  }

  /** Per-frame updates: river waves, cloud drift, night glow */
  public tick(dt: number, elapsed: number, nightFactor: number) {
    if (this.riverMesh && this.riverBasePos) {
      const posAttr = this.riverMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      const base = this.riverBasePos;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i];
        const bz = base[i + 2];
        arr[i + 1] =
          Math.sin(bx * 0.55 + elapsed * 1.9) * 0.05 +
          Math.sin(bz * 0.42 - elapsed * 1.15) * 0.05 +
          Math.sin((bx + bz) * 0.23 + elapsed * 0.7) * 0.03;
      }
      posAttr.needsUpdate = true;
    }

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
    let h = hills * sstep(1, 15, odist) * 2.1;

    const roadDist = Math.abs(z - this.zRoad);
    h *= 1 - sstep(4.2, 1.6, roadDist);
    if (z > this.D - 2 && z < this.zRoad + 1 && Math.abs(x - this.W / 2) < 5.5) {
      h *= 1 - sstep(6.5, 3.5, Math.abs(x - this.W / 2));
    }

    const dr = Math.abs(x - this.riverCenterX(z));
    const t = dr / (this.riverHW * 1.25);
    h -= 1.7 * Math.exp(-t * t);

    return h;
  }

  private _buildAll(w: number, d: number) {
    this.W = w;
    this.D = d;
    this.padX = Math.max(46, w * 0.5 + 38);
    this.padZ = Math.max(40, d * 0.6 + 22);
    this.zRoad = d + 2.6;

    const rng = mulberry32(20260823);

    this._buildTerrain(rng);
    this._buildRiver();
    this._buildPlantSite();
    this._buildRoadsAndBridge();
    this._buildFenceAndGate();
    this._buildForests(rng);
    this._buildTown(rng);
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
    const segX = Math.min(170, Math.round(sizeX / 1.6));
    const segZ = Math.min(150, Math.round(sizeZ / 1.6));

    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(this.W / 2, 0, this.D / 2);

    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const cGrassA = new THREE.Color(0x4d7c3a);
    const cGrassB = new THREE.Color(0x3c6630);
    const cSand   = new THREE.Color(0xc2b280);
    const cMud    = new THREE.Color(0x6e5b3a);
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
  }

  private _buildRiver() {
    const zMin = -this.padZ;
    const zMax = this.D + this.padZ;
    const steps = Math.round((zMax - zMin) / 1.5);

    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const z = zMin + ((zMax - zMin) * i) / steps;
      const cx = this.riverCenterX(z);
      positions.push(cx - this.riverHW, -0.62, z);
      positions.push(cx + this.riverHW, -0.62, z);
      if (i < steps) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x1d6fa5,
      roughness: 0.12,
      metalness: 0.25,
      transparent: true,
      opacity: 0.92,
    });
    this.riverMesh = new THREE.Mesh(geo, mat);
    this.riverBasePos = new Float32Array(positions);
    this.envGroup.add(this.riverMesh);
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
    const road = new THREE.Mesh(new THREE.PlaneGeometry(xMax - xMin, 4.6), asphaltMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set((xMin + xMax) / 2, 0.04, zR);
    road.receiveShadow = true;
    roadGroup.add(road);

    const driveLen = Math.max(1, zR - this.D + 2.4);
    const drive = new THREE.Mesh(new THREE.PlaneGeometry(7, driveLen), asphaltMat);
    drive.rotation.x = -Math.PI / 2;
    drive.position.set(this.W / 2, 0.035, this.D + (zR - this.D) / 2 + 0.6);
    roadGroup.add(drive);

    const dashMat = new THREE.MeshStandardMaterial({ color: 0xe8e3d3, roughness: 0.9 });
    const dashGeo = new THREE.PlaneGeometry(1.6, 0.16);
    for (let x = xMin + 2; x < xMax; x += 4.2) {
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(x, 0.05, zR);
      roadGroup.add(dash);
    }
    this.envGroup.add(roadGroup);

    // Bridge where the road crosses the river
    const cx = this.riverCenterX(zR);
    const span = this.riverHW * 2 + 7;
    const bridgeGroup = new THREE.Group();

    const deckMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.5, 5.4), deckMat);
    deck.position.set(cx, -0.2, zR);
    deck.castShadow = true;
    bridgeGroup.add(deck);

    const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa5b1, metalness: 0.5, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.09, 0.09), railMat);
      rail.position.set(cx, 0.62, zR + s * 2.55);
      bridgeGroup.add(rail);
      for (let px = -span / 2 + 1; px <= span / 2 - 1; px += 2.4) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.75, 0.09), railMat);
        post.position.set(cx + px, 0.28, zR + s * 2.55);
        bridgeGroup.add(post);
      }
    }
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x575f6b, roughness: 0.9 });
    for (const px of [-span * 0.3, span * 0.3]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 3.4, 10), pillarMat);
      pillar.position.set(cx + px, -1.6, zR);
      bridgeGroup.add(pillar);
    }
    this.envGroup.add(bridgeGroup);
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
    if (Math.abs(z - this.zRoad) < 4.4) return false;
    if (Math.abs(x - this.riverCenterX(z)) < this.riverHW + 2.8) return false;
    return true;
  }

  private _buildForests(rng: () => number) {
    const areaK = Math.min(1.5, Math.max(0.75, Math.sqrt(((this.W + this.padX * 0.9) * (this.D + this.padZ * 0.9)) / (28 * 60))));
    const N_CONIFER = Math.round(300 * areaK);
    const N_BROAD   = Math.round(130 * areaK);
    const N_BUSH    = Math.round(120 * areaK);
    const N_ROCK    = Math.round(42 * areaK);

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
      col.setHex(CONIFER_GREENS[Math.floor(rng() * CONIFER_GREENS.length)]);
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
      col.setHex(BROADLEAF_GREENS[Math.floor(rng() * BROADLEAF_GREENS.length)]);
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
      col.setHex(BROADLEAF_GREENS[Math.floor(rng() * BROADLEAF_GREENS.length)]).offsetHSL(0, 0, -0.04);
      bushes.setColorAt(nBush, col);
      nBush++;
    }
    bushes.count = nBush;
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    this.envGroup.add(bushes);

    // Riverbank rocks
    const rockGeo = new THREE.DodecahedronGeometry(0.4, 0);
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x7d7f83, roughness: 0.95 }), N_ROCK);
    rocks.castShadow = true;
    let nR = 0;
    for (let tries = 0; tries < N_ROCK * 16 && nR < N_ROCK; tries++) {
      const z = lerpN(zMin, zMax, rng());
      const side = rng() > 0.5 ? 1 : -1;
      const x = this.riverCenterX(z) + side * (this.riverHW + 1.2 + rng() * 1.4);
      const y = Math.max(-0.35, this.terrainHeight(x, z));
      const s = 0.5 + rng() * 1.1;
      eul.set(rng() * Math.PI, rng() * Math.PI, rng() * 0.4);
      q.setFromEuler(eul);
      vPos.set(x, y, z); vScl.set(s, s * 0.8, s);
      m.compose(vPos, q, vScl);
      rocks.setMatrixAt(nR, m);
      nR++;
    }
    rocks.count = nR;
    rocks.instanceMatrix.needsUpdate = true;
    this.envGroup.add(rocks);
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
    const MAX_HOUSES = 90;
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
    const MAX_TOWERS = 46;
    const towers = new THREE.InstancedMesh(towerGeo, this.windowMat, MAX_TOWERS);
    towers.castShadow = true; towers.receiveShadow = true;
    const roofSlabMat = new THREE.MeshStandardMaterial({ color: 0x39404d, roughness: 0.9 });
    const towerRoofs = new THREE.InstancedMesh(towerGeo, roofSlabMat, MAX_TOWERS);

    let nH = 0, nT = 0;

    const addHouse = (x: number, z: number, s: number) => {
      if (nH >= MAX_HOUSES) return;
      const y = Math.max(0, this.terrainHeight(x, z));
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
      const y = Math.max(0, this.terrainHeight(x, z));
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
    for (let i = 0; i < 26; i++) {
      const x = lerpN(-this.padX + 10, -12, rng());
      const z = lerpN(-this.padZ + 10, this.zRoad - 7, rng());
      if (!this._townAllowed(x, z, placed, 3.4)) continue;
      addHouse(x, z, 1);
    }
    // South town across the road
    for (let i = 0; i < 30; i++) {
      const x = lerpN(-this.padX + 10, this.W * 0.65, rng());
      const z = lerpN(this.zRoad + 6.5, this.D + this.padZ - 10, rng());
      if (!this._townAllowed(x, z, placed, 3.4)) continue;
      addHouse(x, z, 1 + rng() * 0.35);
    }
    // North farms
    for (let i = 0; i < 16; i++) {
      const x = lerpN(-this.padX + 12, this.W - 8, rng());
      const z = lerpN(-this.padZ + 10, -8, rng());
      if (!this._townAllowed(x, z, placed, 4)) continue;
      addHouse(x, z, 1.15 + rng() * 0.5);
    }
    // East city core across the river
    for (let i = 0; i < 34; i++) {
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
      const y = Math.max(0, this.terrainHeight(sx, sz));
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
    stack.position.set(this.W * 0.38, Math.max(0, this.terrainHeight(this.W * 0.38, -this.padZ * 0.4)) + 4.5, -this.padZ * 0.4);
    stack.castShadow = true;
    this.envGroup.add(stack);

    void eul; void q; void m; // retained for future builders
  }

  // ═══════════════ STREET LIGHTS / MOUNTAINS / CLOUDS ═════════════════

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
      const y = Math.max(0, this.terrainHeight(sp.x, zR + sp.side * 2.9));
      eul.set(0, sp.side > 0 ? 0 : Math.PI, 0);
      q.setFromEuler(eul);
      vPos.set(sp.x, y, zR + sp.side * 2.9);
      m.compose(vPos, q, vOne);
      poles.setMatrixAt(i, m);
      vPos.set(sp.x + sp.side * 0.45, y + 2.95, zR + sp.side * 2.9);
      m.compose(vPos, q, vOne);
      arms.setMatrixAt(i, m);
      vPos.set(sp.x + sp.side * 0.85, y + 2.88, zR + sp.side * 2.9);
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
      m.compose(new THREE.Vector3(x, -2, z), q, new THREE.Vector3(s * 1.5, s, s * 1.5));
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
