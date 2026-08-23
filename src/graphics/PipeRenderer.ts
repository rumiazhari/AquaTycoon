import * as THREE from 'three';
import { PipeConnection } from '../types/simulation';
import { calcWaterColorHex } from '../sim/WaterStream';

/**
 * Renders the pipe network as real process piping:
 *  - steel segments + flanges between waypoints
 *  - a train of directional chevron arrows inside each pipe that travel
 *    with the water — speed and marker density scale with flow rate
 *  - fluid tint reflects live water quality (murky → teal → cyan)
 */

const ARROW_SPACING = 2.4; // world units between direction markers

interface PipeVisual {
  group: THREE.Group;
  fluidMat: THREE.MeshStandardMaterial;
  arrowMat: THREE.MeshBasicMaterial;
  arrows: THREE.InstancedMesh | null;
  pathLen: number;
  cumLens: number[];
}

export class PipeRenderer {
  public group: THREE.Group;
  private visuals: Map<string, PipeVisual> = new Map();

  constructor() {
    this.group = new THREE.Group();
  }

  /** Synchronizes pipe models + flow animation with simulation state */
  public updatePipes(pipes: PipeConnection[], timeSec: number) {
    const activeIds = new Set(pipes.map(p => p.id));

    for (const [id, vis] of this.visuals.entries()) {
      if (!activeIds.has(id)) {
        this.group.remove(vis.group);
        this._disposeGroup(vis.group);
        this.visuals.delete(id);
      }
    }

    for (const pipe of pipes) {
      let vis = this.visuals.get(pipe.id);
      if (!vis) {
        vis = this._build(pipe);
        this.visuals.set(pipe.id, vis);
        this.group.add(vis.group);
      }

      // Live fluid color
      const colorHex = pipe.pipeType === 'sludge'
        ? '#3b1c04'
        : (pipe.pipeType === 'gas' ? '#eab308' : calcWaterColorHex(pipe.quality));
      vis.fluidMat.color.set(colorHex);
      vis.arrowMat.color.set(colorHex);

      // Directional flow animation — speed follows the actual flow rate
      const hasFlow = pipe.flowRate > 1;
      if (vis.arrows) vis.arrows.visible = hasFlow;
      if (hasFlow && vis.arrows && vis.pathLen > 0) {
        // m³/day → visual tiles/sec (0.35 slow trickle … 5.5 torrent)
        const speed = THREE.MathUtils.clamp(pipe.flowRate / 900, 0.35, 5.5);
        const offset = ((timeSec * speed) % ARROW_SPACING);
        const count = vis.arrows.count;
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const up = new THREE.Vector3(0, 1, 0);
        const pos = new THREE.Vector3();
        const dir = new THREE.Vector3();
        for (let i = 0; i < count; i++) {
          let d = i * ARROW_SPACING + offset;
          if (d > vis.pathLen) continue;
          // locate segment containing distance d
          let segIdx = 0;
          while (segIdx < vis.cumLens.length - 1 && vis.cumLens[segIdx + 1] < d) segIdx++;
          const segStart = vis.cumLens[segIdx];
          const t = (d - segStart) / Math.max(0.001, vis.cumLens[segIdx + 1] - segStart);
          const p1 = new THREE.Vector3(...pipe.pathPoints[segIdx]);
          const p2 = new THREE.Vector3(...pipe.pathPoints[Math.min(segIdx + 1, pipe.pathPoints.length - 1)]);
          dir.subVectors(p2, p1).normalize();
          q.setFromUnitVectors(up, dir);
          pos.lerpVectors(p1, p2, t);
          pos.y += 0.16; // ride on top of the pipe so arrows are visible
          m.compose(pos, q, new THREE.Vector3(1, 1, 1));
          vis.arrows.setMatrixAt(i, m);
        }
        vis.arrows.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private _build(pipe: PipeConnection): PipeVisual {
    const group = new THREE.Group();
    group.name = `pipe_${pipe.id}`;

    const colorHex = pipe.pipeType === 'sludge' ? '#3b1c04' : calcWaterColorHex(pipe.quality);
    const fluidMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.3,
      metalness: 0.6,
    });
    const arrowMat = new THREE.MeshBasicMaterial({ color: colorHex });

    const points = pipe.pathPoints.map(p => new THREE.Vector3(...p));
    const cumLens: number[] = [0];
    let pathLen = 0;

    // Steel segments + flanges
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dist = p1.distanceTo(p2);
      if (dist < 0.05) { cumLens.push(pathLen); continue; }
      pathLen += dist;
      cumLens.push(pathLen);

      const segGeo = new THREE.CylinderGeometry(0.09, 0.09, dist, 10);
      const segMesh = new THREE.Mesh(segGeo, fluidMat);
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      segMesh.position.copy(mid);
      segMesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().subVectors(p2, p1).normalize()
      );
      group.add(segMesh);

      const flangeGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.06, 10);
      const flangeMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8 });
      const flange = new THREE.Mesh(flangeGeo, flangeMat);
      flange.position.copy(points[i]);
      group.add(flange);
    }

    // Directional chevron markers (instanced cones pointing along the flow)
    let arrows: THREE.InstancedMesh | null = null;
    if (pathLen > 0.6) {
      const count = Math.max(1, Math.floor(pathLen / ARROW_SPACING));
      // Cone pointing +Y; quaternion orients it along each segment tangent
      const coneGeo = new THREE.ConeGeometry(0.14, 0.34, 5);
      arrows = new THREE.InstancedMesh(coneGeo, arrowMat, count);
      arrows.frustumCulled = false;
      arrows.visible = false;
      group.add(arrows);
    }

    return { group, fluidMat, arrowMat, arrows, pathLen, cumLens };
  }

  private _disposeGroup(group: THREE.Group) {
    group.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach(m => m.dispose());
      }
    });
  }
}
