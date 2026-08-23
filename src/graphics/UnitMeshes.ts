import * as THREE from 'three';
import { PlacedUnit } from '../types/simulation';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';

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

    // Concrete Foundation Pad
    const padGeo = new THREE.BoxGeometry(w - 0.1, 0.15, l - 0.1);
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x334155, // Slate 700
      roughness: 0.9
    });
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.y = 0.075;
    pad.receiveShadow = true;
    group.add(pad);

    // Build specific 3D geometry according to unit type
    switch (unit.typeId) {
      // ---------------------------------------------------
      case 'bar_screen':
        this.buildBarScreen(group, w, l);
        break;
      case 'grit_chamber':
        this.buildGritChamber(group, w, l);
        break;
      case 'equalization_basin':
        this.buildEqualizationBasin(group, w, l);
        break;
      case 'primary_clarifier_circular':
        this.buildCircularClarifier(group, w, l, 0x78350f); // Brown primary
        break;
      case 'primary_clarifier_rect':
        this.buildRectClarifier(group, w, l);
        break;
      case 'daf_unit':
        this.buildDAF(group, w, l);
        break;
      case 'activated_sludge_cas':
        this.buildAerationBasin(group, w, l);
        break;
      case 'a2o_bardenpho':
        this.buildA2OBasin(group, w, l);
        break;
      case 'mbbr_reactor':
        this.buildMBBR(group, w, l);
        break;
      case 'mbr_membrane':
        this.buildMBR(group, w, l);
        break;
      case 'secondary_clarifier':
        this.buildCircularClarifier(group, w, l, 0x0d9488); // Teal secondary
        break;
      case 'trickling_filter':
        this.buildTricklingFilter(group, w, l);
        break;
      case 'sbr_reactor':
        this.buildSBR(group, w, l);
        break;
      case 'sand_filter':
        this.buildSandFilter(group, w, l);
        break;
      case 'chemical_phosphorus':
        this.buildChemicalCoagulation(group, w, l);
        break;
      case 'uv_disinfection':
        this.buildUVDisinfection(group, w, l);
        break;
      case 'chlorination_basin':
        this.buildChlorinationBasin(group, w, l);
        break;
      case 'reverse_osmosis':
        this.buildReverseOsmosis(group, w, l);
        break;
      case 'advanced_oxidation_aop':
        this.buildAOP(group, w, l);
        break;
      case 'sludge_thickener':
        this.buildSludgeThickener(group, w, l);
        break;
      case 'anaerobic_digester':
        this.buildAnaerobicDigester(group, w, l);
        break;
      case 'sludge_dewatering_press':
        this.buildDewateringPress(group, w, l);
        break;
      case 'solar_drying_bed':
        this.buildSolarDryingBed(group, w, l);
        break;
      case 'pump_station':
        this.buildPumpStation(group, w, l);
        break;
      case 'pipe_junction':
        this.buildJunction(group, w, l);
        break;
      case 'influent_inlet':
        this.buildInfluentInlet(group, w, l);
        break;
      case 'effluent_outfall':
        this.buildEffluentOutfall(group, w, l);
        break;
      default:
        this.buildDefaultTank(group, w, l);
        break;
    }

    // Set position & rotation
    group.position.set(unit.gridX + w / 2, 0, unit.gridY + l / 2);
    group.rotation.y = (unit.rotation * Math.PI) / 180;

    return group;
  }

  // =======================================================
  // INDIVIDUAL PROCEDURAL UNIT BUILDERS
  // =======================================================

  private static buildBarScreen(group: THREE.Group, w: number, l: number) {
    const channelGeo = new THREE.BoxGeometry(w * 0.8, 0.6, l * 0.7);
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.7 });
    const channel = new THREE.Mesh(channelGeo, concreteMat);
    channel.position.y = 0.4;
    group.add(channel);

    // Inclined Screen Rack
    const screenGeo = new THREE.BoxGeometry(0.3, 0.9, l * 0.5);
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.2 });
    const screen = new THREE.Mesh(screenGeo, steelMat);
    screen.position.set(0, 0.65, 0);
    screen.rotation.z = Math.PI / 4;
    group.add(screen);

    // Motor / Rake Housing
    const motorGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const motorMat = new THREE.MeshStandardMaterial({ color: 0x0284c7 });
    const motor = new THREE.Mesh(motorGeo, motorMat);
    motor.position.set(0.2, 1.1, 0);
    group.add(motor);
  }

  private static buildGritChamber(group: THREE.Group, w: number, l: number) {
    const radius = Math.min(w, l) * 0.38;
    const cylGeo = new THREE.CylinderGeometry(radius, radius * 0.6, 0.9, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.6 });
    const cyl = new THREE.Mesh(cylGeo, mat);
    cyl.position.y = 0.6;
    group.add(cyl);

    // Swirling water top
    const waterGeo = new THREE.CircleGeometry(radius * 0.9, 16);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x713f12, roughness: 0.1 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 1.0;
    group.add(water);

    // Center drive
    const driveGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.5, 8);
    const driveMat = new THREE.MeshStandardMaterial({ color: 0x0284c7 });
    const drive = new THREE.Mesh(driveGeo, driveMat);
    drive.position.y = 1.25;
    group.add(drive);
  }

  private static buildEqualizationBasin(group: THREE.Group, w: number, l: number) {
    const tankGeo = new THREE.BoxGeometry(w * 0.85, 0.9, l * 0.85);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.6;
    group.add(tank);

    // Water surface
    const waterGeo = new THREE.PlaneGeometry(w * 0.75, l * 0.75);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x581c87, roughness: 0.1, transparent: true, opacity: 0.9 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.95;
    group.add(water);
  }

  private static buildCircularClarifier(group: THREE.Group, w: number, l: number, waterColor: number) {
    const radius = Math.min(w, l) * 0.42;
    // Outer concrete wall
    const wallGeo = new THREE.CylinderGeometry(radius, radius, 0.8, 24, 1, true);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x64748b, side: THREE.DoubleSide, roughness: 0.8 });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = 0.55;
    group.add(wall);

    // Water Layer
    const waterGeo = new THREE.CircleGeometry(radius * 0.95, 24);
    const waterMat = new THREE.MeshStandardMaterial({ color: waterColor, roughness: 0.1, metalness: 0.2 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.85;
    group.add(water);

    // Rotating Scraper Bridge (Truss)
    const bridgeGroup = new THREE.Group();
    bridgeGroup.name = 'rotating_bridge';
    const bridgeGeo = new THREE.BoxGeometry(radius * 1.9, 0.12, 0.25);
    const bridgeMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.6 });
    const bridge = new THREE.Mesh(bridgeGeo, bridgeMat);
    bridge.position.y = 1.05;
    bridgeGroup.add(bridge);

    // Center Well Cylinder
    const centerGeo = new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, 0.6, 12);
    const centerMat = new THREE.MeshStandardMaterial({ color: 0x0284c7 });
    const center = new THREE.Mesh(centerGeo, centerMat);
    center.position.y = 0.75;
    group.add(center);
    group.add(bridgeGroup);
  }

  private static buildRectClarifier(group: THREE.Group, w: number, l: number) {
    const tankGeo = new THREE.BoxGeometry(w * 0.85, 0.8, l * 0.8);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.55;
    group.add(tank);

    // Water surface
    const waterGeo = new THREE.PlaneGeometry(w * 0.75, l * 0.7);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.1 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.85;
    group.add(water);
  }

  private static buildDAF(group: THREE.Group, w: number, l: number) {
    const tankGeo = new THREE.BoxGeometry(w * 0.8, 0.85, l * 0.8);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.55;
    group.add(tank);

    // Frothy White Water top (Microbubbles)
    const waterGeo = new THREE.PlaneGeometry(w * 0.7, l * 0.7);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.9 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.9;
    group.add(water);

    // Skimmer Blade
    const skimmerGeo = new THREE.BoxGeometry(0.15, 0.2, l * 0.7);
    const skimmerMat = new THREE.MeshStandardMaterial({ color: 0x0284c7 });
    const skimmer = new THREE.Mesh(skimmerGeo, skimmerMat);
    skimmer.position.set(0, 1.05, 0);
    group.add(skimmer);
  }

  private static buildAerationBasin(group: THREE.Group, w: number, l: number) {
    const tankGeo = new THREE.BoxGeometry(w * 0.88, 0.9, l * 0.85);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.7 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.6;
    group.add(tank);

    // Aerated frothy water
    const waterGeo = new THREE.PlaneGeometry(w * 0.8, l * 0.75);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.4, metalness: 0.1 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.95;
    group.add(water);

    // Aeration Air Supply Pipe Header (Stainless Steel)
    const pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, w * 0.8, 8);
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.8, roughness: 0.2 });
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, 1.15, -l * 0.35);
    group.add(pipe);

    // Fine bubble diffusers indicator (white micro-grid)
    const diffuserGeo = new THREE.BoxGeometry(w * 0.7, 0.05, l * 0.6);
    const diffuserMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe, wireframe: true });
    const diffuser = new THREE.Mesh(diffuserGeo, diffuserMat);
    diffuser.position.y = 0.2;
    group.add(diffuser);
  }

  private static buildA2OBasin(group: THREE.Group, w: number, l: number) {
    // 3 compartmentalized zones (Anaerobic / Anoxic / Aerobic)
    const tankGeo = new THREE.BoxGeometry(w * 0.9, 0.9, l * 0.85);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.6;
    group.add(tank);

    // Baffle Dividers
    const baffleGeo = new THREE.BoxGeometry(0.1, 0.9, l * 0.8);
    const baffleMat = new THREE.MeshStandardMaterial({ color: 0x64748b });
    const b1 = new THREE.Mesh(baffleGeo, baffleMat);
    b1.position.set(-w * 0.25, 0.6, 0);
    const b2 = new THREE.Mesh(baffleGeo, baffleMat);
    b2.position.set(w * 0.1, 0.6, 0);
    group.add(b1);
    group.add(b2);

    // Mixers in Anoxic zone
    const mixerGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8);
    const mixerMat = new THREE.MeshStandardMaterial({ color: 0x0284c7 });
    const mixer = new THREE.Mesh(mixerGeo, mixerMat);
    mixer.position.set(-w * 0.08, 0.9, 0);
    group.add(mixer);
  }

  private static buildMBBR(group: THREE.Group, w: number, l: number) {
    const radius = Math.min(w, l) * 0.4;
    const cylGeo = new THREE.CylinderGeometry(radius, radius, 1.1, 20);
    const cylMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4, metalness: 0.3 });
    const cyl = new THREE.Mesh(cylGeo, cylMat);
    cyl.position.y = 0.7;
    group.add(cyl);

    // Bio-media carriers floating top (Yellow K3 media)
    const mediaGeo = new THREE.CircleGeometry(radius * 0.9, 16);
    const mediaMat = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.8 });
    const media = new THREE.Mesh(mediaGeo, mediaMat);
    media.rotation.x = -Math.PI / 2;
    media.position.y = 1.15;
    group.add(media);
  }

  private static buildMBR(group: THREE.Group, w: number, l: number) {
    const tankGeo = new THREE.BoxGeometry(w * 0.85, 1.0, l * 0.8);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.65;
    group.add(tank);

    // Submerged Hollow-Fiber Membrane Cassettes (White plates)
    for (let i = -1; i <= 1; i++) {
      const cassetteGeo = new THREE.BoxGeometry(0.12, 0.7, l * 0.6);
      const cassetteMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.1, roughness: 0.2 });
      const cassette = new THREE.Mesh(cassetteGeo, cassetteMat);
      cassette.position.set(i * 0.45, 0.75, 0);
      group.add(cassette);
    }

    // Suction Permeate Manifold
    const maniGeo = new THREE.CylinderGeometry(0.06, 0.06, w * 0.6, 8);
    const maniMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.9 });
    const manifold = new THREE.Mesh(maniGeo, maniMat);
    manifold.rotation.z = Math.PI / 2;
    manifold.position.set(0, 1.25, 0);
    group.add(manifold);
  }

  private static buildTricklingFilter(group: THREE.Group, w: number, l: number) {
    const radius = Math.min(w, l) * 0.42;
    const cylGeo = new THREE.CylinderGeometry(radius, radius, 1.2, 20);
    const cylMat = new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.9 });
    const cyl = new THREE.Mesh(cylGeo, cylMat);
    cyl.position.y = 0.75;
    group.add(cyl);

    // Rotating 4-arm distributor
    const armGroup = new THREE.Group();
    armGroup.name = 'rotating_bridge';
    const armGeo = new THREE.CylinderGeometry(0.04, 0.04, radius * 1.8, 8);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8 });
    const arm1 = new THREE.Mesh(armGeo, armMat);
    arm1.rotation.z = Math.PI / 2;
    arm1.position.y = 1.45;
    const arm2 = new THREE.Mesh(armGeo, armMat);
    arm2.rotation.x = Math.PI / 2;
    arm2.position.y = 1.45;
    armGroup.add(arm1);
    armGroup.add(arm2);
    group.add(armGroup);
  }

  private static buildSBR(group: THREE.Group, w: number, l: number) {
    this.buildDefaultTank(group, w, l, 0x0284c7);
  }

  private static buildSandFilter(group: THREE.Group, w: number, l: number) {
    const tankGeo = new THREE.BoxGeometry(w * 0.85, 0.9, l * 0.8);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.6;
    group.add(tank);

    // Sand Bed Top
    const sandGeo = new THREE.PlaneGeometry(w * 0.75, l * 0.7);
    const sandMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.95 });
    const sand = new THREE.Mesh(sandGeo, sandMat);
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = 0.7;
    group.add(sand);

    // Backwash Washwater Troughs
    const troughGeo = new THREE.BoxGeometry(w * 0.75, 0.15, 0.15);
    const troughMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8 });
    const trough = new THREE.Mesh(troughGeo, troughMat);
    trough.position.set(0, 0.95, 0);
    group.add(trough);
  }

  private static buildChemicalCoagulation(group: THREE.Group, w: number, l: number) {
    const basinGeo = new THREE.BoxGeometry(w * 0.8, 0.8, l * 0.8);
    const basinMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
    const basin = new THREE.Mesh(basinGeo, basinMat);
    basin.position.y = 0.55;
    group.add(basin);

    // Reagent Storage Dosing Tank (Yellow/Orange Polyethylene)
    const chemGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12);
    const chemMat = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.3 });
    const chem = new THREE.Mesh(chemGeo, chemMat);
    chem.position.set(w * 0.25, 0.8, l * 0.2);
    group.add(chem);

    // Flash Mixer Impeller Shaft
    const shaftGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 8);
    const shaftMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8 });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.set(-w * 0.15, 0.85, 0);
    group.add(shaft);
  }

  private static buildUVDisinfection(group: THREE.Group, w: number, l: number) {
    const channelGeo = new THREE.BoxGeometry(w * 0.9, 0.5, l * 0.6);
    const channelMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
    const channel = new THREE.Mesh(channelGeo, channelMat);
    channel.position.y = 0.35;
    group.add(channel);

    // Glowing Cyan UV Lamp Quartz Tubes
    for (let i = -2; i <= 2; i++) {
      const lampGeo = new THREE.CylinderGeometry(0.04, 0.04, l * 0.45, 8);
      const lampMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(i * 0.4, 0.45, 0);
      group.add(lamp);
    }
  }

  private static buildChlorinationBasin(group: THREE.Group, w: number, l: number) {
    const basinGeo = new THREE.BoxGeometry(w * 0.85, 0.6, l * 0.85);
    const basinMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
    const basin = new THREE.Mesh(basinGeo, basinMat);
    basin.position.y = 0.45;
    group.add(basin);

    // Serpentine Baffles
    for (let i = -1; i <= 1; i += 2) {
      const bGeo = new THREE.BoxGeometry(w * 0.65, 0.5, 0.08);
      const bMat = new THREE.MeshStandardMaterial({ color: 0x64748b });
      const b = new THREE.Mesh(bGeo, bMat);
      b.position.set(i * 0.1, 0.5, i * 0.25);
      group.add(b);
    }
  }

  private static buildReverseOsmosis(group: THREE.Group, w: number, l: number) {
    const frameGeo = new THREE.BoxGeometry(w * 0.8, 0.9, l * 0.7);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x0f172a });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.y = 0.6;
    group.add(frame);

    // High-Pressure Spiral Membrane Pressure Vessels (White Cylinders)
    for (let y = 0.4; y <= 1.0; y += 0.3) {
      for (let z = -0.2; z <= 0.2; z += 0.4) {
        const vesselGeo = new THREE.CylinderGeometry(0.09, 0.09, w * 0.7, 12);
        const vesselMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.7 });
        const vessel = new THREE.Mesh(vesselGeo, vesselMat);
        vessel.rotation.z = Math.PI / 2;
        vessel.position.set(0, y, z);
        group.add(vessel);
      }
    }
  }

  private static buildAOP(group: THREE.Group, _w: number, _l: number) {
    // Ozone Reaction Towers
    for (let i = -1; i <= 1; i += 2) {
      const towerGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.4, 16);
      const towerMat = new THREE.MeshStandardMaterial({ color: 0x0369a1, metalness: 0.5, roughness: 0.3 });
      const tower = new THREE.Mesh(towerGeo, towerMat);
      tower.position.set(i * 0.5, 0.85, 0);
      group.add(tower);
    }
  }

  private static buildSludgeThickener(group: THREE.Group, w: number, l: number) {
    this.buildCircularClarifier(group, w, l, 0x3b1c04);
  }

  private static buildAnaerobicDigester(group: THREE.Group, w: number, l: number) {
    const radius = Math.min(w, l) * 0.42;
    // Egg-shaped / Domed Digester Tank
    const cylGeo = new THREE.CylinderGeometry(radius, radius * 0.9, 1.2, 24);
    const cylMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4, metalness: 0.3 });
    const cyl = new THREE.Mesh(cylGeo, cylMat);
    cyl.position.y = 0.8;
    group.add(cyl);

    // Domed Roof
    const domeGeo = new THREE.SphereGeometry(radius, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.6, roughness: 0.2 });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.position.y = 1.4;
    group.add(dome);

    // Biogas Safety Flare Stack & Flame
    const flareGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8);
    const flareMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8 });
    const flare = new THREE.Mesh(flareGeo, flareMat);
    flare.position.set(radius * 0.6, 1.7, 0);
    group.add(flare);

    const flameGeo = new THREE.ConeGeometry(0.12, 0.3, 8);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(radius * 0.6, 2.2, 0);
    group.add(flame);
  }

  private static buildDewateringPress(group: THREE.Group, w: number, l: number) {
    const houseGeo = new THREE.BoxGeometry(w * 0.8, 0.8, l * 0.8);
    const houseMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
    const house = new THREE.Mesh(houseGeo, houseMat);
    house.position.y = 0.55;
    group.add(house);

    // Cake Discharge Conveyor Belt
    const convGeo = new THREE.BoxGeometry(w * 0.4, 0.1, 0.3);
    const convMat = new THREE.MeshStandardMaterial({ color: 0x111827 });
    const conv = new THREE.Mesh(convGeo, convMat);
    conv.position.set(w * 0.4, 0.4, 0);
    group.add(conv);
  }

  private static buildSolarDryingBed(group: THREE.Group, w: number, l: number) {
    const bedGeo = new THREE.BoxGeometry(w * 0.9, 0.2, l * 0.85);
    const bedMat = new THREE.MeshStandardMaterial({ color: 0x292524 });
    const bed = new THREE.Mesh(bedGeo, bedMat);
    bed.position.y = 0.2;
    group.add(bed);

    // Glass Greenhouse Frame
    const frameGeo = new THREE.BoxGeometry(w * 0.88, 0.8, l * 0.83);
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.35,
      roughness: 0.1
    });
    const glass = new THREE.Mesh(frameGeo, glassMat);
    glass.position.y = 0.65;
    group.add(glass);
  }

  private static buildPumpStation(group: THREE.Group, w: number, l: number) {
    const baseGeo = new THREE.BoxGeometry(w * 0.7, 0.5, l * 0.7);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.4;
    group.add(base);

    // Electric Motors (Blue)
    for (let i = -1; i <= 1; i += 2) {
      const motorGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.4, 12);
      const motorMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.3 });
      const motor = new THREE.Mesh(motorGeo, motorMat);
      motor.position.set(i * 0.3, 0.8, 0);
      group.add(motor);
    }
  }

  private static buildJunction(group: THREE.Group, w: number, l: number) {
    const jGeo = new THREE.BoxGeometry(w * 0.8, 0.4, l * 0.8);
    const jMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.7 });
    const j = new THREE.Mesh(jGeo, jMat);
    j.position.y = 0.35;
    group.add(j);
  }

  private static buildInfluentInlet(group: THREE.Group, w: number, l: number) {
    const baseGeo = new THREE.BoxGeometry(w * 0.8, 0.6, l * 0.8);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.45;
    group.add(base);

    // Inflow conduit pipe
    const pipeGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.8, 16);
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(-0.2, 0.6, 0);
    group.add(pipe);

    // Sign / Indicator Pillar
    const signGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.2, 8);
    const signMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b });
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0.4, 0.9, 0.4);
    group.add(sign);
  }

  private static buildEffluentOutfall(group: THREE.Group, w: number, l: number) {
    const baseGeo = new THREE.BoxGeometry(w * 0.8, 0.6, l * 0.8);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.45;
    group.add(base);

    // Outfall Waterfall Cascade (Sparkling Cyan)
    const fallGeo = new THREE.PlaneGeometry(0.6, 0.6);
    const fallMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.8 });
    const fall = new THREE.Mesh(fallGeo, fallMat);
    fall.position.set(0.4, 0.4, 0);
    fall.rotation.y = Math.PI / 2;
    group.add(fall);
  }

  private static buildDefaultTank(group: THREE.Group, w: number, l: number, color: number = 0x334155) {
    const tankGeo = new THREE.BoxGeometry(w * 0.8, 0.8, l * 0.8);
    const tankMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.y = 0.55;
    group.add(tank);
  }

  /**
   * Updates dynamic animations like rotating clarifier arms or aerator bubble colors
   */
  public static updateUnitAnimation(group: THREE.Group, timeSec: number) {
    const rotatingBridge = group.getObjectByName('rotating_bridge');
    if (rotatingBridge) {
      rotatingBridge.rotation.y = timeSec * 0.2; // Slow realistic scraper rotation
    }
  }
}
