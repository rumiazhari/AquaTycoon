import * as THREE from 'three';
import { PipeConnection } from '../types/simulation';
import { calcWaterColorHex } from '../sim/WaterStream';

/**
 * Renders the pipe network as real process piping:
 *  - steel segments + flanges between waypoints
 *  - a train of directional chevron arrows inside each pipe that travel
 *    with the fluid — speed and marker density scale with the TRUE flow of
 *    the selected source port (liquid m³/d or gas Nm³/d)
 *  - fluid tint is unambiguous per stream class:
 *      liquid (quality-tinted) · sludge (dark brown) · RAS (dark amber)
 *      recycle (violet) · gas (yellow, thin & translucent)
 *  - zero-flow streams visibly stop (particles hidden + dimmed dry pipe)
 */

const ARROW_SPACING = 2.4; // world units between direction markers

const PIPE_STYLE: Record<string, { color: string; radius: number; opacity?: number }> = {
  liquid: { color: '', radius: 0.09 },            // quality-tinted at runtime
  sludge: { color: '#3b1c04', radius: 0.11 },
  ras: { color: '#7c4a12', radius: 0.10 },
  recycle: { color: '#7c3aed', radius: 0.085 },
  gas: { color: '#eab308', radius: 0.07, opacity: 0.55 },
  chemical: { color: '#a3e635', radius: 0.06 }
};

interface PipeVisual {
  group: THREE.Group;
  fluidMat: THREE.MeshStandardMaterial;
  arrowMat: THREE.MeshBasicMaterial;
  arrows: THREE.InstancedMesh | null;
  pathLen: number;
  cumLens: number[];
}

function styleFor(pipe: PipeConnection) {
  return PIPE_STYLE[pipe.pipeType] ?? PIPE_STYLE.liquid;
}

/** Runtime fluid color: fixed for process lines, quality-tinted for liquids. */
function colorFor(pipe: PipeConnection): string {
  if (pipe.pipeType === 'gas') return PIPE_STYLE.gas.color;
  if (pipe.pipeType === 'sludge') return PIPE_STYLE.sludge.color;
  if (pipe.pipeType === 'ras') return PIPE_STYLE.ras.color;
  if (pipe.pipeType === 'recycle') return PIPE_STYLE.recycle.color;
  if (pipe.pipeType === 'chemical') return PIPE_STYLE.chemical.color;
  return calcWaterColorHex(pipe.quality);
}

/** True volumetric flow driving the particle animation for this pipe. */
function flowOf(pipe: PipeConnection): number {
  if (pipe.pipeType === 'gas') return Math.max(0, pipe.gasFlowRate ?? 0);
  return Math.max(0, pipe.flowRate);
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
      const style = styleFor(pipe);

      // Rebuild when the semantic type changes (e.g. legacy auto-sludge line
      // reclassified from 'liquid' to its true sludge/RAS/gas identity).
      if (vis && (vis as PipeVisual & { builtType?: string }).builtType !== pipe.pipeType) {
        this.group.remove(vis.group);
        this._disposeGroup(vis.group);
        this.visuals.delete(pipe.id);
        vis = undefined;
      }
      if (!vis) {
        vis = this._build(pipe);
        (vis as PipeVisual & { builtType?: string }).builtType = pipe.pipeType;
        this.visuals.set(pipe.id, vis);
        this.group.add(vis.group);
      }

      // Live fluid color
      const colorHex = colorFor(pipe);
      vis.fluidMat.color.set(colorHex);
      vis.arrowMat.color.set(colorHex);

      // Zero-flow streams visibly stop: particles off, pipe dims to a dry hue
      const hasFlow = flowOf(pipe) > 1;
      if (vis.arrows) vis.arrows.visible = hasFlow;
      vis.fluidMat.transparent = !!style.opacity || !hasFlow;
      vis.fluidMat.opacity = style.opacity ?? (hasFlow ? 1 : 0.35);
      vis.fluidMat.needsUpdate = true;

      if (hasFlow && vis.arrows && vis.pathLen > 0) {
        // Flow → visual tiles/sec (gas flows are numerically smaller; scale up)
        const raw = flowOf(pipe);
        const scaled = pipe.pipeType === 'gas' ? raw / 40 : raw;
        const speed = THREE.MathUtils.clamp(scaled / 900, 0.35, 5.5);
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

    const style = styleFor(pipe);
    const colorHex = colorFor(pipe);
    const fluidMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.3,
      metalness: 0.6,
      transparent: !!style.opacity,
      opacity: style.opacity ?? 1,
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

      const segGeo = new THREE.CylinderGeometry(style.radius, style.radius, dist, 10);
      const segMesh = new THREE.Mesh(segGeo, fluidMat);
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      segMesh.position.copy(mid);
      segMesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().subVectors(p2, p1).normalize()
      );
      group.add(segMesh);

      const flangeGeo = new THREE.CylinderGeometry(style.radius + 0.04, style.radius + 0.04, 0.06, 10);
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
