import * as THREE from 'three';
import { PlacedUnit } from '../types/simulation';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';

/**
 * Procedural 3D models for every WWTP unit, modeled after real plants:
 * clarifiers with rotating bridges & effluent launders, aeration basins with
 * walkways and blower buildings, egg-shaped anaerobic digesters, UV channels,
 * cascade outfalls, plus site infrastructure (PV arrays, wind turbines).
 */

// ── Shared cached materials ──────────────────────────────────────────────────
const matCache = new Map<string, THREE.MeshStandardMaterial>();
function std(color: number, roughness = 0.8, metalness = 0.05): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    matCache.set(key, m);
  }
  return m;
}

const CONCRETE = () => std(0x9aa5b0, 0.92, 0.02);
const CONCRETE_DARK = () => std(0x77828e, 0.94, 0.02);
const STEEL = () => std(0xb7c2cc, 0.35, 0.85);
const RAIL = () => std(0xdde5ea, 0.4, 0.75);
const MACHINE_BLUE = () => std(0x1f6fb2, 0.45, 0.55);
const SAFETY_YELLOW = () => std(0xe6b93c, 0.6, 0.3);
const WALKWAY_MAT = () => std(0x8b95a1, 0.85, 0.25);

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function cyl(rt: number, rb: number, h: number, seg: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Handrail along a straight run centered on (x,z) */
function addRail(parent: THREE.Group, x: number, y: number, z: number, len: number, alongX: boolean) {
  const railGeo = new THREE.CylinderGeometry(0.03, 0.03, len, 6);
  const top = new THREE.Mesh(railGeo, RAIL());
  top.rotation.z = alongX ? Math.PI / 2 : 0;
  if (!alongX) top.rotation.x = Math.PI / 2;
  top.position.set(x, y + 0.22, z);
  parent.add(top);
  const mid = new THREE.Mesh(railGeo, RAIL());
  mid.rotation.copy(top.rotation);
  mid.position.set(x, y + 0.12, z);
  parent.add(mid);
  const nPosts = Math.max(2, Math.round(len / 1.2));
  for (let i = 0; i <= nPosts; i++) {
    const t = -len / 2 + (len * i) / nPosts;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 6), RAIL());
    post.position.set(alongX ? x + t : x, y + 0.11, alongX ? z : z + t);
    parent.add(post);
  }
}

/** Elevated walkway strip with railings on both sides */
function addWalkway(parent: THREE.Group, x: number, y: number, z: number, len: number, width: number, alongX: boolean) {
  const deck = box(alongX ? len : width, 0.07, alongX ? width : len, WALKWAY_MAT());
  deck.position.set(x, y, z);
  parent.add(deck);
  if (alongX) {
    addRail(parent, x, y + 0.04, z - width / 2 + 0.06, len, true);
    addRail(parent, x, y + 0.04, z + width / 2 - 0.06, len, true);
  } else {
    addRail(parent, x - width / 2 + 0.06, y + 0.04, z, len, false);
    addRail(parent, x + width / 2 - 0.06, y + 0.04, z, len, false);
  }
}

function addCabinet(parent: THREE.Group, x: number, z: number, color = 0xd7dde3) {
  const cab = box(0.42, 0.62, 0.3, std(color, 0.5, 0.35));
  cab.position.set(x, 0.51, z);
  parent.add(cab);
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x14212e, emissive: 0x0d3a52, emissiveIntensity: 0.9 })
  );
  face.position.set(x, 0.56, z + 0.155);
  parent.add(face);
}

/** Open concrete basin made of four walls + water surface */
function basin(
  group: THREE.Group, w: number, l: number, wallH: number,
  waterColor: number, waterY: number
) {
  const th = 0.15;
  const mkWall = (bw: number, bd: number, bx: number, bz: number) => {
    const wall = box(bw, wallH, bd, CONCRETE());
    wall.position.set(bx, wallH / 2, bz);
    group.add(wall);
  };
  mkWall(w * 0.88, th, 0, -l * 0.42);
  mkWall(w * 0.88, th, 0, l * 0.42);
  mkWall(th, l * 0.88, -w * 0.42, 0);
  mkWall(th, l * 0.88, w * 0.42, 0);
  const water = box(w * 0.82, 0.05, l * 0.8, std(waterColor, 0.22, 0.28));
  water.position.y = waterY;
  group.add(water);
}

export class UnitMeshBuilder {
  /**
   * Builds a full 3D procedural model for any wastewater treatment unit
   */
  public static buildUnitMesh(unit: PlacedUnit): THREE.Group {
    const group = new THREE.Group();
    group.name = unit.instanceId;
    const def = UNIT_DEFINITIONS[unit.typeId];
    if (!def) return group;

    const [w, l] = def.footprint;

    // Concrete foundation pad
    const pad = box(w - 0.08, 0.16, l - 0.08, CONCRETE_DARK());
    pad.position.y = 0.08;
    pad.castShadow = false;
    group.add(pad);

    switch (unit.typeId) {
      case 'bar_screen': this.buildBarScreen(group, w, l); break;
      case 'grit_chamber': this.buildGritChamber(group, w, l); break;
      case 'equalization_basin': this.buildEqualizationBasin(group, w, l); break;
      case 'primary_clarifier_circular': this.buildCircularClarifier(group, w, l, 0x6d5233); break;
      case 'primary_clarifier_rect': this.buildRectClarifier(group, w, l); break;
      case 'daf_unit': this.buildDAF(group, w, l); break;
      case 'activated_sludge_cas': this.buildAerationBasin(group, w, l); break;
      case 'a2o_bardenpho': this.buildA2OBasin(group, w, l); break;
      case 'mbbr_reactor': this.buildMBBR(group, w, l); break;
      case 'mbr_membrane': this.buildMBR(group, w, l); break;
      case 'secondary_clarifier': this.buildCircularClarifier(group, w, l, 0x1c6e64); break;
      case 'trickling_filter': this.buildTricklingFilter(group, w, l); break;
      case 'sbr_reactor': this.buildSBR(group, w, l); break;
      case 'sand_filter': this.buildSandFilter(group, w, l); break;
      case 'chemical_phosphorus': this.buildChemicalCoagulation(group, w, l); break;
      case 'uv_disinfection': this.buildUVDisinfection(group, w, l); break;
      case 'chlorination_basin': this.buildChlorinationBasin(group, w, l); break;
      case 'reverse_osmosis': this.buildReverseOsmosis(group, w, l); break;
      case 'advanced_oxidation_aop': this.buildAOP(group, w, l); break;
      case 'sludge_thickener': this.buildCircularClarifier(group, w, l, 0x4a3016); break;
      case 'anaerobic_digester': this.buildAnaerobicDigester(group, w, l); break;
      case 'sludge_dewatering_press': this.buildDewateringPress(group, w, l); break;
      case 'solar_drying_bed': this.buildSolarDryingBed(group, w, l); break;
      case 'pump_station': this.buildPumpStation(group, w, l); break;
      case 'pipe_junction': this.buildJunction(group, w, l); break;
      case 'influent_inlet': this.buildInfluentInlet(group, w, l); break;
      case 'effluent_outfall': this.buildEffluentOutfall(group, w, l); break;
      case 'solar_array': this.buildSolarArray(group, w, l); break;
      case 'wind_turbine': this.buildWindTurbine(group, w, l); break;
      default: this.buildDefaultTank(group, w, l); break;
    }

    group.position.set(unit.gridX + w / 2, 0, unit.gridY + l / 2);
    group.rotation.y = (unit.rotation * Math.PI) / 180;
    return group;
  }

  // ══════════════════════ PRELIMINARY UNITS ═══════════════════════════

  private static buildBarScreen(group: THREE.Group, w: number, l: number) {
    // Open U-channel
    const wallH = 0.95, th = 0.14;
    const left = box(th, wallH, l * 0.86, CONCRETE()); left.position.set(-w * 0.36, wallH / 2, 0); group.add(left);
    const right = box(th, wallH, l * 0.86, CONCRETE()); right.position.set(w * 0.36, wallH / 2, 0); group.add(right);
    const water = box(w * 0.6, 0.1, l * 0.8, std(0x4c3a20, 0.3, 0.2));
    water.position.y = 0.32; group.add(water);

    // Inclined mechanical rake screen
    const rack = new THREE.Group();
    const bandGeo = new THREE.BoxGeometry(0.06, 1.5, 0.5);
    const band1 = new THREE.Mesh(bandGeo, STEEL()); band1.position.set(-0.18, 0, 0);
    const band2 = new THREE.Mesh(bandGeo, STEEL()); band2.position.set(0.18, 0, 0);
    rack.add(band1, band2);
    for (let i = 0; i < 9; i++) {
      const bar = box(0.42, 0.05, 0.05, STEEL());
      bar.position.set(0, -0.68 + i * 0.17, 0);
      rack.add(bar);
    }
    rack.position.set(-w * 0.1, 0.72, 0);
    rack.rotation.z = 0.42;
    group.add(rack);

    // Drive motor & screenings discharge chute
    const motor = box(0.5, 0.42, 0.5, MACHINE_BLUE());
    motor.position.set(w * 0.05, 1.42, 0); group.add(motor);
    const chute = box(0.55, 0.4, 0.6, SAFETY_YELLOW());
    chute.position.set(w * 0.24, 1.05, 0); group.add(chute);
    addCabinet(group, w * 0.3, l * 0.32);
  }

  private static buildGritChamber(group: THREE.Group, w: number, l: number) {
    const r = Math.min(w, l) * 0.36;
    // Vortex tank with conical floor
    const cone = cyl(r * 0.16, r, 0.85, 20, CONCRETE()); cone.position.y = 0.43; group.add(cone);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 10, 24), CONCRETE_DARK());
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.88; group.add(rim);
    const water = new THREE.Mesh(new THREE.CircleGeometry(r * 0.94, 20), std(0x59431f, 0.25, 0.25));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.74; group.add(water);
    // Central stirrer with rotating paddle
    const shaft = cyl(0.05, 0.05, 1.15, 8, STEEL()); shaft.position.y = 1.28; group.add(shaft);
    const paddle = box(1.15, 0.09, 0.12, STEEL()); paddle.position.y = 0.95;
    paddle.name = 'rotating_bridge';
    group.add(paddle);
    const drive = cyl(0.16, 0.16, 0.3, 12, MACHINE_BLUE()); drive.position.y = 1.98; group.add(drive);
    // Grit screw conveyor
    const trough = box(1.1, 0.22, 0.3, CONCRETE_DARK());
    trough.position.set(w * 0.38, 0.35, l * 0.28); trough.rotation.y = 0.6; group.add(trough);
    addCabinet(group, -w * 0.32, l * 0.34);
  }

  private static buildEqualizationBasin(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.05, 0x3f3350, 0.66);
    for (const [mx, mz] of [[-w * 0.22, -l * 0.2], [w * 0.2, l * 0.18]] as const) {
      const nozzle = cyl(0.07, 0.1, 0.5, 8, STEEL()); nozzle.position.set(mx, 0.95, mz); group.add(nozzle);
    }
    addWalkway(group, 0, 1.12, -l * 0.3, w * 0.78, 0.5, true);
    addCabinet(group, w * 0.32, l * 0.3);
  }

  // ══════════════════════ PRIMARY UNITS ═══════════════════════════════

  private static buildCircularClarifier(group: THREE.Group, w: number, l: number, waterColor: number) {
    const r = Math.min(w, l) * 0.44;
    // Cylindrical tank wall (open cylinder)
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.95, 28, 1, true), CONCRETE());
    (outer.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    outer.position.y = 0.48; outer.castShadow = true; outer.receiveShadow = true;
    group.add(outer);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(r, 28), CONCRETE_DARK());
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.06; floor.receiveShadow = true;
    group.add(floor);
    // Water body
    const water = new THREE.Mesh(new THREE.CircleGeometry(r * 0.97, 28), std(waterColor, 0.18, 0.3));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.7; group.add(water);
    // Peripheral effluent launder (weir ring)
    const launder = new THREE.Mesh(new THREE.TorusGeometry(r * 0.86, 0.09, 10, 30), CONCRETE_DARK());
    launder.rotation.x = Math.PI / 2; launder.position.y = 0.8;
    launder.name = 'rotating_bridge_static';
    group.add(launder);
    // Center pier + influent well
    const pier = cyl(r * 0.16, r * 0.19, 0.9, 14, CONCRETE()); pier.position.y = 0.45; group.add(pier);
    const well = cyl(r * 0.3, r * 0.3, 0.55, 16, CONCRETE_DARK()); well.position.y = 0.85; group.add(well);
    // Rotating half-bridge with walkway, railing and submerged scraper
    const bridge = new THREE.Group();
    bridge.name = 'rotating_bridge';
    addWalkway(bridge, r * 0.46, 1.06, 0, r * 0.92, 0.5, true);
    const frame = box(r * 0.92, 0.09, 0.2, STEEL()); frame.position.set(r * 0.46, 0.96, 0.18); bridge.add(frame);
    const scraper = box(r * 0.8, 0.28, 0.05, std(0x51606e, 0.6, 0.5));
    scraper.position.set(r * 0.45, 0.45, 0.12); scraper.rotation.z = 0.05; bridge.add(scraper);
    group.add(bridge);
    addCabinet(group, -r * 0.6, -r * 0.66);
  }

  private static buildRectClarifier(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 0.95, 0x6d5233, 0.62);
    // Chain-and-flight scrapers
    for (const sx of [-w * 0.2, w * 0.2]) {
      const flight = box(0.08, 0.34, l * 0.72, STEEL()); flight.position.set(sx, 0.42, 0); group.add(flight);
      for (const sz of [-l * 0.34, l * 0.34]) {
        const sprocket = cyl(0.12, 0.12, 0.06, 10, STEEL());
        sprocket.rotation.z = Math.PI / 2; sprocket.position.set(sx, 0.62, sz); group.add(sprocket);
      }
    }
    const trough = box(0.3, 0.18, l * 0.7, CONCRETE_DARK()); trough.position.set(w * 0.3, 0.78, 0); group.add(trough);
    addWalkway(group, -w * 0.34, 1.02, 0, l * 0.86, 0.5, false);
  }

  private static buildDAF(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.0, 0xeef2f4, 0.68); // frothy white-water surface
    // Chain float scrapers at the surface
    for (const sx of [-w * 0.25, w * 0.05]) {
      const blade = box(0.07, 0.22, l * 0.66, SAFETY_YELLOW()); blade.position.set(sx, 0.82, 0); group.add(blade);
    }
    // Recycle saturation vessel (tall pressure tank)
    const satVessel = cyl(0.22, 0.22, 1.5, 12, STEEL()); satVessel.position.set(w * 0.34, 0.95, -l * 0.3); group.add(satVessel);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), STEEL());
    dome.position.set(w * 0.34, 1.7, -l * 0.3); group.add(dome);
    addCabinet(group, -w * 0.36, l * 0.32);
  }

  // ════════════════ SECONDARY / BIOLOGICAL UNITS ══════════════════════

  private static buildAerationBasin(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.05, 0x6b3d16, 0.72);
    // Fine-bubble diffuser grid under the surface (visible shimmer)
    const diffusers = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.7, 0.04, l * 0.66),
      new THREE.MeshBasicMaterial({ color: 0xcfe8f5, wireframe: true })
    );
    diffusers.position.y = 0.25; group.add(diffusers);
    // Air header along the wall with drop legs to the floor
    const header = cyl(0.07, 0.07, w * 0.78, 8, STEEL());
    header.rotation.z = Math.PI / 2; header.position.set(0, 1.2, -l * 0.36); group.add(header);
    for (let i = -1; i <= 1; i++) {
      const drop = cyl(0.045, 0.045, 1.0, 6, STEEL());
      drop.position.set(i * w * 0.26, 0.75, -l * 0.33); group.add(drop);
    }
    addWalkway(group, 0, 1.14, l * 0.38, w * 0.82, 0.55, true);
    // Blower building at the corner
    const blowerHouse = box(1.1, 0.95, 0.9, CONCRETE()); blowerHouse.position.set(-w * 0.32, 0.63, l * 0.34); group.add(blowerHouse);
    const roof = box(1.24, 0.12, 1.02, std(0x5b6774, 0.8, 0.15)); roof.position.set(-w * 0.32, 1.16, l * 0.34); group.add(roof);
    addCabinet(group, -w * 0.18, l * 0.42);
  }

  private static buildA2OBasin(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.05, 0x24343f, 0.7); // base fill; zones override water strips
    // Three zone water strips: anaerobic (dark), anoxic (olive), aerobic (brown froth)
    const zoneW = w * 0.27;
    const zones: [number, number][] = [[-zoneW, 0x33301a], [0.05 * w, 0x4a4420], [zoneW + 0.08 * w, 0x6b3d16]];
    for (const [zx, col] of zones) {
      const strip = box(zoneW * 0.92, 0.06, l * 0.74, std(col, 0.25, 0.22));
      strip.position.set(zx - w * 0.04, 0.72, 0); group.add(strip);
    }
    // Baffle walls between zones
    for (const bx of [-w * 0.155, w * 0.185]) {
      const baffle = box(0.09, 1.0, l * 0.8, CONCRETE_DARK()); baffle.position.set(bx, 0.62, 0); group.add(baffle);
    }
    // Submersible mixers in anoxic zone
    for (const mz of [-l * 0.22, l * 0.22]) {
      const mixerShaft = cyl(0.05, 0.05, 0.55, 8, STEEL()); mixerShaft.position.set(0.05 * w, 0.85, mz); group.add(mixerShaft);
      const prop = box(0.3, 0.05, 0.18, STEEL()); prop.position.set(0.05 * w, 0.58, mz);
      prop.name = 'rotating_bridge';
      group.add(prop);
    }
    addWalkway(group, 0, 1.14, -l * 0.4, w * 0.86, 0.5, true);
    addCabinet(group, -w * 0.4, -l * 0.34);
  }

  private static buildMBBR(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.15, 0x2b5d70, 0.78);
    // Floating K-media carriers (yellow chips scattered on the surface)
    const chipGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.05, 8);
    const chipMat = std(0xe3c23c, 0.75, 0.1);
    for (let i = 0; i < 26; i++) {
      const chip = new THREE.Mesh(chipGeo, chipMat);
      const a = i * 2.399963;
      const rr = Math.sqrt((i % 13) / 13) * Math.min(w, l) * 0.32;
      chip.position.set(Math.cos(a) * rr, 0.83, Math.sin(a) * rr);
      chip.rotation.x = 0.4 * ((i % 3) - 1);
      group.add(chip);
    }
    // Aeration grid + side-mounted mesh screen
    const screen = box(0.06, 0.8, l * 0.7, std(0xa8b2ba, 0.5, 0.6)); screen.position.set(w * 0.37, 0.6, 0); group.add(screen);
    addCabinet(group, -w * 0.36, l * 0.34);
  }

  private static buildMBR(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.15, 0x35424e, 0.82);
    // Submerged hollow-fiber cassette frames
    for (let i = -1; i <= 1; i++) {
      const frame = box(0.16, 0.75, l * 0.58, std(0xe8edf1, 0.4, 0.3));
      frame.position.set(i * 0.48, 0.68, 0); group.add(frame);
      for (const fz of [-l * 0.24, l * 0.24]) {
        const endPlate = box(0.2, 0.1, 0.12, STEEL()); endPlate.position.set(i * 0.48, 1.06, fz); group.add(endPlate);
      }
    }
    // Permeate suction manifold + pump skid
    const manifold = cyl(0.06, 0.06, w * 0.66, 8, STEEL());
    manifold.rotation.z = Math.PI / 2; manifold.position.set(0, 1.22, 0); group.add(manifold);
    const pump = box(0.4, 0.34, 0.34, MACHINE_BLUE()); pump.position.set(w * 0.34, 0.5, l * 0.34); group.add(pump);
    addCabinet(group, -w * 0.36, l * 0.36);
  }

  private static buildTricklingFilter(group: THREE.Group, w: number, l: number) {
    const r = Math.min(w, l) * 0.42;
    const tank = cyl(r, r, 1.25, 22, std(0x6e6257, 0.9, 0.05)); tank.position.y = 0.62; group.add(tank);
    // Rock/media top hint
    const mediaTop = new THREE.Mesh(new THREE.CircleGeometry(r * 0.97, 22), std(0x7a6a52, 0.95, 0));
    mediaTop.rotation.x = -Math.PI / 2; mediaTop.position.y = 1.26; group.add(mediaTop);
    // Rotating 4-arm distributor with feed pipe
    const dist = new THREE.Group();
    dist.name = 'rotating_bridge';
    const hub = cyl(0.1, 0.1, 0.28, 10, MACHINE_BLUE()); dist.add(hub);
    for (let a = 0; a < 4; a++) {
      const arm = cyl(0.045, 0.045, r * 1.8, 8, STEEL());
      arm.rotation.z = Math.PI / 2;
      arm.rotation.y = (a * Math.PI) / 2;
      arm.position.y = 0.16;
      const holder = new THREE.Group();
      holder.rotation.y = (a * Math.PI) / 2;
      const armShifted = cyl(0.045, 0.045, r * 1.8, 8, STEEL());
      armShifted.rotation.z = Math.PI / 2;
      armShifted.position.x = r * 0.45;
      holder.add(armShifted);
      holder.position.y = 0.16;
      dist.add(holder);
      void arm;
    }
    dist.position.y = 1.42;
    group.add(dist);
    // Access ladder to distributor walkway
    const pier = cyl(0.14, 0.14, 1.5, 8, CONCRETE_DARK()); pier.position.set(-r * 0.98, 0.75, 0); group.add(pier);
    addWalkway(group, -r * 0.55, 1.42, 0, r * 0.95, 0.45, true);
  }

  private static buildSBR(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.1, 0x4b3418, 0.66);
    // Decanter weir on swinging arm
    const decanter = box(l * 0.55, 0.08, 0.14, STEEL());
    decanter.position.set(w * 0.18, 0.9, 0); decanter.rotation.y = 0.5; decanter.name = 'rotating_bridge';
    group.add(decanter);
    addWalkway(group, 0, 1.18, -l * 0.4, w * 0.84, 0.5, true);
    addCabinet(group, w * 0.36, l * 0.34);
  }

  // ════════════════ TERTIARY / ADVANCED UNITS ═════════════════════════

  private static buildSandFilter(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 1.0, 0x8a7440, 0.55);
    // Two media cells with different sand tones
    for (const cx of [-w * 0.2, w * 0.2]) {
      const bed = box(w * 0.34, 0.08, l * 0.72, std(cx < 0 ? 0xc79a4e : 0xb08840, 0.95, 0));
      bed.position.set(cx, 0.5, 0); group.add(bed);
    }
    // Backwash washwater troughs
    for (const tz of [-l * 0.22, l * 0.22]) {
      const trough = box(w * 0.72, 0.14, 0.16, STEEL()); trough.position.set(0, 0.86, tz); group.add(trough);
    }
    // Valve pipe gallery at the back
    for (let i = -1; i <= 1; i++) {
      const valve = cyl(0.09, 0.09, 0.16, 10, MACHINE_BLUE());
      valve.rotation.z = Math.PI / 2; valve.position.set(i * w * 0.24, 0.3, l * 0.42); group.add(valve);
      const handwheel = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 12), SAFETY_YELLOW());
      handwheel.position.set(i * w * 0.24, 0.3, l * 0.51); group.add(handwheel);
    }
    addWalkway(group, 0, 1.06, -l * 0.42, w * 0.84, 0.45, true);
  }

  private static buildChemicalCoagulation(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 0.9, 0x7d6a35, 0.52);
    // Reagent storage tank (orange HDPE) with dosing pump
    const chem = cyl(0.32, 0.32, 1.0, 14, std(0xe07a2e, 0.45, 0.15));
    chem.position.set(w * 0.28, 0.72, l * 0.22); group.add(chem);
    const dosePump = box(0.28, 0.26, 0.24, MACHINE_BLUE()); dosePump.position.set(w * 0.28, 0.36, l * 0.34); group.add(dosePump);
    // Flash mixer shaft + flocculator paddles
    const mixerShaft = cyl(0.05, 0.05, 0.9, 8, STEEL()); mixerShaft.position.set(-w * 0.18, 0.72, 0); group.add(mixerShaft);
    const impeller = box(0.34, 0.06, 0.1, STEEL()); impeller.position.set(-w * 0.18, 0.38, 0);
    impeller.name = 'rotating_bridge';
    group.add(impeller);
    addCabinet(group, -w * 0.34, -l * 0.3);
  }

  private static buildUVDisinfection(group: THREE.Group, w: number, l: number) {
    // Open channel
    const wallH = 0.72, th = 0.13;
    for (const sz of [-l * 0.34, l * 0.34]) {
      const wall = box(w * 0.88, wallH, th, CONCRETE()); wall.position.set(0, wallH / 2, sz); group.add(wall);
    }
    const water = box(w * 0.8, 0.08, l * 0.62, std(0x145c66, 0.15, 0.35));
    water.position.y = 0.34; group.add(water);
    // Lamp module racks hanging into the channel
    for (let i = -1; i <= 1; i++) {
      const frame = box(0.1, 0.5, l * 0.5, std(0x30404e, 0.5, 0.6));
      frame.position.set(i * w * 0.24, 0.62, 0); group.add(frame);
      for (let k = 0; k < 3; k++) {
        const lamp = cyl(0.035, 0.035, l * 0.46, 8,
          new THREE.MeshStandardMaterial({ color: 0xaef2ff, emissive: 0x27d5ff, emissiveIntensity: 1.6 }));
        lamp.rotation.x = Math.PI / 2;
        lamp.position.set(i * w * 0.24, 0.42, 0);
        lamp.translateY(0);
        lamp.position.z = 0;
        group.add(lamp);
        break;
      }
    }
    addCabinet(group, w * 0.4, l * 0.4);
  }

  private static buildChlorinationBasin(group: THREE.Group, w: number, l: number) {
    basin(group, w, l, 0.85, 0x1d6f74, 0.48);
    // Serpentine baffles forcing contact time
    for (let i = 0; i < 4; i++) {
      const bx = -w * 0.28 + i * w * 0.19;
      const baffle = box(0.08, 0.62, i % 2 === 0 ? l * 0.68 : l * 0.4, CONCRETE_DARK());
      baffle.position.set(bx, 0.5, i % 2 === 0 ? 0 : -l * 0.12); group.add(baffle);
    }
    addCabinet(group, w * 0.4, -l * 0.34);
  }

  private static buildReverseOsmosis(group: THREE.Group, w: number, l: number) {
    // Skid frame
    const base = box(w * 0.82, 0.12, l * 0.78, std(0x3b4552, 0.6, 0.5)); base.position.y = 0.24; group.add(base);
    for (const [cx, cz] of [[-w * 0.34, -l * 0.32], [w * 0.34, -l * 0.32], [-w * 0.34, l * 0.32], [w * 0.34, l * 0.32]] as const) {
      const post = box(0.08, 1.0, 0.08, std(0x4a5666, 0.55, 0.55)); post.position.set(cx, 0.72, cz); group.add(post);
    }
    // Two rows of white spiral-wound pressure vessels
    for (const rz of [-l * 0.18, l * 0.18]) {
      for (let i = 0; i < 3; i++) {
        const vessel = cyl(0.11, 0.11, w * 0.2, 12, std(0xf4f7f9, 0.25, 0.65));
        vessel.rotation.z = Math.PI / 2;
        vessel.position.set(-w * 0.24 + i * w * 0.24, 0.62, rz); group.add(vessel);
        const capA = cyl(0.115, 0.115, 0.05, 12, std(0x2e3946, 0.5, 0.5));
        capA.rotation.z = Math.PI / 2; capA.position.set(-w * 0.245 + i * w * 0.24, 0.62, rz); group.add(capA);
      }
    }
    // High-pressure pump + interconnecting pipework
    const hpPump = cyl(0.16, 0.16, 0.4, 12, MACHINE_BLUE()); hpPump.rotation.z = Math.PI / 2;
    hpPump.position.set(-w * 0.3, 0.42, 0); group.add(hpPump);
    const manifold = cyl(0.035, 0.035, w * 0.7, 6, STEEL()); manifold.rotation.x = Math.PI / 2;
    manifold.position.set(0, 0.92, 0); group.add(manifold);
    addCabinet(group, w * 0.4, l * 0.4);
  }

  private static buildAOP(group: THREE.Group, w: number, l: number) {
    // Two ozone contact towers with recirculation loops
    for (const sx of [-w * 0.22, w * 0.22]) {
      const tower = cyl(0.32, 0.32, 1.7, 16, std(0x20647f, 0.35, 0.5)); tower.position.set(sx, 1.05, 0); group.add(tower);
      const capDome = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0x20647f, 0.35, 0.5));
      capDome.position.set(sx, 1.9, 0); group.add(capDome);
      const sightGlass = cyl(0.03, 0.03, 1.0, 6, new THREE.MeshBasicMaterial({ color: 0x9be8ff }));
      sightGlass.position.set(sx + 0.33, 1.1, 0); group.add(sightGlass);
    }
    const crossPipe = cyl(0.05, 0.05, w * 0.5, 8, STEEL());
    crossPipe.rotation.z = Math.PI / 2; crossPipe.position.set(0, 0.5, 0.3); group.add(crossPipe);
    addCabinet(group, -w * 0.4, l * 0.38);
  }

  // ══════════════════ SLUDGE TRAIN UNITS ══════════════════════════════

  private static buildAnaerobicDigester(group: THREE.Group, w: number, l: number) {
    const r = Math.min(w, l) * 0.4;
    // Egg-shaped digester body (scaled sphere — European style)
    const egg = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), std(0xe8eaec, 0.4, 0.35));
    egg.scale.set(1, 1.45, 1);
    egg.position.y = r * 1.35;
    egg.castShadow = true; egg.receiveShadow = true;
    group.add(egg);
    // Support skirt
    const skirt = cyl(r * 0.42, r * 0.62, 0.7, 20, CONCRETE_DARK()); skirt.position.y = 0.35; group.add(skirt);
    // Gas holder dome on top + gas line to flare
    const gasDome = new THREE.Mesh(new THREE.SphereGeometry(r * 0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), STEEL());
    gasDome.position.y = r * 2.75; group.add(gasDome);
    const gasLine = cyl(0.05, 0.05, r * 1.6, 8, SAFETY_YELLOW());
    gasLine.position.set(r * 0.85, r * 1.9, 0); gasLine.rotation.z = 0.5; group.add(gasLine);
    // Flare stack with flame
    const flareBase = box(0.5, 0.5, 0.5, CONCRETE()); flareBase.position.set(-r * 0.9, 0.25, l * 0.3); group.add(flareBase);
    const stack = cyl(0.07, 0.09, 1.6, 8, STEEL()); stack.position.set(-r * 0.9, 1.3, l * 0.3); group.add(stack);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.42, 8),
      new THREE.MeshBasicMaterial({ color: 0xffa63c, transparent: true, opacity: 0.92 })
    );
    flame.name = 'flare_flame';
    flame.position.set(-r * 0.9, 2.3, l * 0.3); group.add(flame);
    // Recirculation heat exchanger pipes climbing the shell
    for (const off of [-0.35, 0.35]) {
      const hx = cyl(0.04, 0.04, r * 1.7, 6, std(0xc98a3a, 0.5, 0.4));
      hx.position.set(off, r * 0.9, r * 0.72); hx.rotation.x = 0.06; group.add(hx);
    }
    addWalkway(group, 0, 0.78, -l * 0.42, w * 0.8, 0.5, true);
  }

  private static buildDewateringPress(group: THREE.Group, w: number, l: number) {
    // Machine housing inside a plant room
    const hall = box(w * 0.86, 1.15, l * 0.8, std(0x8d99a5, 0.85, 0.1)); hall.position.y = 0.73; group.add(hall);
    const roofSlab = box(w * 0.94, 0.1, l * 0.88, std(0x59636e, 0.85, 0.1)); roofSlab.position.y = 1.36; group.add(roofSlab);
    const door = box(0.5, 0.7, 0.05, std(0x39434e, 0.7, 0.3)); door.position.set(-w * 0.18, 0.51, l * 0.41); group.add(door);
    // Cake conveyor exiting the building
    const conv = box(w * 0.5, 0.1, 0.34, std(0x232a31, 0.8, 0.2)); conv.position.set(w * 0.55, 0.5, 0); conv.rotation.y = 0; group.add(conv);
    const cake = box(0.22, 0.1, 0.28, std(0x3a2c17, 0.95, 0)); cake.position.set(w * 0.62, 0.58, 0); group.add(cake);
    addCabinet(group, w * 0.3, l * 0.42);
  }

  private static buildSolarDryingBed(group: THREE.Group, w: number, l: number) {
    // Greenhouse: translucent gabled roof over drying beds
    const bed = box(w * 0.86, 0.16, l * 0.78, std(0x33302b, 0.95, 0)); bed.position.y = 0.24; group.add(bed);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd4e8, transparent: true, opacity: 0.32, roughness: 0.12 });
    const roofA = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.05, l * 0.46), glassMat);
    roofA.position.set(0, 1.0, -l * 0.21); roofA.rotation.x = 0.5; group.add(roofA);
    const roofB = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.05, l * 0.46), glassMat);
    roofB.position.set(0, 1.0, l * 0.21); roofB.rotation.x = -0.5; group.add(roofB);
    for (const px of [-w * 0.42, w * 0.42]) {
      const post = box(0.07, 1.0, 0.07, STEEL()); post.position.set(px, 0.5, 0); group.add(post);
    }
    const ridge = box(w * 0.92, 0.06, 0.1, STEEL()); ridge.position.y = 1.22; group.add(ridge);
  }

  // ════════════════ HYDRAULICS / SITE UNITS ═══════════════════════════

  private static buildPumpStation(group: THREE.Group, w: number, l: number) {
    // Wet well (open cylinder) + duty/standby pumps with suction/discharge piping
    const well = cyl(Math.min(w, l) * 0.3, Math.min(w, l) * 0.3, 0.9, 16, CONCRETE());
    well.position.y = 0.45; group.add(well);
    const wellWater = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, l) * 0.26, 16), std(0x4c3a20, 0.25, 0.2));
    wellWater.rotation.x = -Math.PI / 2; wellWater.position.y = 0.6; group.add(wellWater);
    for (const sx of [-w * 0.22, w * 0.22]) {
      const pumpBody = box(0.34, 0.3, 0.3, MACHINE_BLUE()); pumpBody.position.set(sx, 0.42, l * 0.24); group.add(pumpBody);
      const motor = cyl(0.14, 0.14, 0.32, 10, std(0x27435e, 0.45, 0.5));
      motor.rotation.x = Math.PI / 2; motor.position.set(sx, 0.62, l * 0.24); group.add(motor);
      const discharge = cyl(0.06, 0.06, 0.7, 8, STEEL()); discharge.position.set(sx, 0.75, l * 0.1); group.add(discharge);
    }
    // Discharge manifold
    const manifold = cyl(0.07, 0.07, w * 0.55, 8, STEEL());
    manifold.rotation.z = Math.PI / 2; manifold.position.set(0, 1.02, l * 0.1); group.add(manifold);
    addCabinet(group, -w * 0.38, -l * 0.36);
  }

  private static buildJunction(group: THREE.Group, w: number, l: number) {
    const boxStructure = box(w * 0.72, 0.5, l * 0.72, CONCRETE()); boxStructure.position.y = 0.25; group.add(boxStructure);
    const lid = box(w * 0.76, 0.08, l * 0.76, CONCRETE_DARK()); lid.position.y = 0.54; group.add(lid);
    for (const [hx, hz] of [[-w * 0.2, 0], [w * 0.2, 0], [0, l * 0.24]] as const) {
      const handwheel = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.025, 6, 12), SAFETY_YELLOW());
      handwheel.rotation.x = Math.PI / 2; handwheel.position.set(hx, 0.64, hz); group.add(handwheel);
    }
  }

  private static buildInfluentInlet(group: THREE.Group, w: number, l: number) {
    // Screw-lift pump channel aesthetic: flume + headworks housing
    const flume = box(w * 0.85, 0.55, l * 0.5, CONCRETE()); flume.position.y = 0.28; group.add(flume);
    const flow = box(w * 0.7, 0.08, l * 0.34, std(0x4c3a20, 0.28, 0.2)); flow.position.y = 0.5; group.add(flow);
    const housing = box(w * 0.5, 1.05, l * 0.42, std(0x93a0ac, 0.8, 0.15));
    housing.position.set(w * 0.12, 0.68, l * 0.18); group.add(housing);
    const roofSlab = box(w * 0.56, 0.09, l * 0.48, std(0x59636e, 0.8, 0.1));
    roofSlab.position.set(w * 0.12, 1.25, l * 0.18); group.add(roofSlab);
    // Inflow pipe from off-site
    const inflow = cyl(0.3, 0.3, 1.0, 14, std(0x39434e, 0.6, 0.35));
    inflow.rotation.z = Math.PI / 2; inflow.position.set(-w * 0.48, 0.5, 0); group.add(inflow);
    addCabinet(group, w * 0.4, -l * 0.32);
  }

  private static buildEffluentOutfall(group: THREE.Group, w: number, l: number) {
    // Cascade steps discharging toward the river (+X direction)
    let stepY = 0.95;
    for (let i = 0; i < 4; i++) {
      const step = box(0.55, 0.18, l * 0.6, CONCRETE());
      step.position.set(-w * 0.25 + i * 0.5, stepY, 0);
      group.add(step);
      const whiteWater = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, l * 0.5),
        new THREE.MeshStandardMaterial({ color: 0xd9f2fa, transparent: true, opacity: 0.75, roughness: 0.2 })
      );
      whiteWater.rotation.x = -Math.PI / 2;
      whiteWater.position.set(-w * 0.25 + i * 0.5, stepY + 0.1, 0);
      group.add(whiteWater);
      stepY -= 0.2;
    }
    // Sampling / gauging cabinet
    addCabinet(group, -w * 0.38, -l * 0.34);
  }

  // ════════════════ POWER & SITE INFRASTRUCTURE ═══════════════════════

  private static buildSolarArray(group: THREE.Group, w: number, l: number) {
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x14263f, roughness: 0.25, metalness: 0.65 });
    const frameMat = STEEL();
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      const z = -l * 0.3 + (r * l * 0.3);
      // Tilted panel table
      const table = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, 0.05, 0.85), panelMat);
      panel.castShadow = true; panel.receiveShadow = true;
      table.add(panel);
      panel.rotation.x = -0.42;
      // Rack legs
      for (const lx of [-w * 0.36, w * 0.36]) {
        const legA = box(0.06, 0.55, 0.06, frameMat); legA.position.set(lx, 0.28, -0.28); table.add(legA);
        const legB = box(0.06, 0.82, 0.06, frameMat); legB.position.set(lx, 0.41, 0.24); table.add(legB);
      }
      table.position.set(0, 0.55, z);
      group.add(table);
    }
    // Central inverter station
    const inverter = box(0.6, 0.8, 0.44, std(0xdfe5ea, 0.5, 0.35));
    inverter.position.set(-w * 0.42, 0.56, 0); group.add(inverter);
    addCabinet(group, w * 0.44, l * 0.42, 0xf1d38a);
  }

  private static buildWindTurbine(group: THREE.Group, w: number, l: number) {
    void w; void l;
    // Tapered lattice-free tubular tower
    const towerH = 7.5;
    const tower = cyl(0.22, 0.42, towerH, 14, std(0xe9edef, 0.5, 0.25));
    tower.position.y = towerH / 2 + 0.16;
    group.add(tower);
    // Foundation plinth + service door
    const plinth = cyl(0.75, 0.85, 0.32, 16, CONCRETE_DARK()); plinth.position.y = 0.16; group.add(plinth);
    const door = box(0.3, 0.5, 0.05, std(0x39434e, 0.7, 0.3)); door.position.set(0, 0.55, 0.4); group.add(door);
    // Nacelle
    const nacelle = box(0.85, 0.4, 0.4, std(0xf2f5f7, 0.45, 0.3));
    nacelle.position.y = towerH + 0.16; nacelle.position.x = 0.1;
    group.add(nacelle);
    // Hub + three blades (rotating assembly)
    const rotor = new THREE.Group();
    rotor.name = 'rotating_blades';
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), std(0xdfe4e8, 0.45, 0.3));
    rotor.add(hub);
    for (let i = 0; i < 3; i++) {
      const bladeGeo = new THREE.BoxGeometry(0.13, 2.6, 0.04);
      bladeGeo.translate(0, 1.3, 0);
      const blade = new THREE.Mesh(bladeGeo, std(0xf4f7f9, 0.4, 0.25));
      blade.castShadow = true;
      blade.rotation.z = (i * 2 * Math.PI) / 3;
      rotor.add(blade);
    }
    rotor.position.set(0.58, towerH + 0.16, 0);
    rotor.rotation.y = Math.PI / 2;
    group.add(rotor);
    // Aviation warning light
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4444 })
    );
    beacon.position.set(0.1, towerH + 0.44, 0);
    group.add(beacon);
  }

  private static buildDefaultTank(group: THREE.Group, w: number, l: number) {
    const tank = box(w * 0.8, 0.8, l * 0.8, CONCRETE());
    tank.position.y = 0.56;
    group.add(tank);
  }

  /**
   * Updates dynamic animations: rotating clarifier bridges, trickling filter
   * distributors, SBR decanters and wind turbine rotors.
   */
  public static updateUnitAnimation(group: THREE.Group, timeSec: number) {
    const bridge = group.getObjectByName('rotating_bridge');
    if (bridge) bridge.rotation.y = timeSec * 0.2;

    const rotor = group.getObjectByName('rotating_blades');
    if (rotor) {
      // Blades spin around their local Z after the Y-facing mount rotation
      rotor.rotation.z = timeSec * 2.2;
    }

    const flame = group.getObjectByName('flare_flame');
    if (flame) {
      const s = 0.85 + Math.sin(timeSec * 11) * 0.2;
      flame.scale.set(s, 0.9 + Math.sin(timeSec * 7.3) * 0.25, s);
    }
  }
}
