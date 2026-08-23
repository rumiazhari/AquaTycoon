import * as THREE from 'three';
import { PipeConnection } from '../types/simulation';
import { calcWaterColorHex } from '../sim/WaterStream';

export class PipeRenderer {
  public group: THREE.Group;
  private pipeMeshes: Map<string, THREE.Group> = new Map();
  private flowParticles: Map<string, THREE.Mesh[]> = new Map();

  constructor() {
    this.group = new THREE.Group();
  }

  /**
   * Synchronizes 3D pipe models and flow animations with current simulation pipe connections
   */
  public updatePipes(pipes: PipeConnection[], timeSec: number) {
    const activeIds = new Set(pipes.map(p => p.id));

    // Remove obsolete pipes (BUG FIX: dispose geometries/materials — they used to leak)
    for (const [id, pipeGroup] of this.pipeMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.group.remove(pipeGroup);
        this._disposeGroup(pipeGroup);
        this.pipeMeshes.delete(id);
        this.flowParticles.delete(id);
      }
    }

    // Add or update pipes
    for (const pipe of pipes) {
      let pipeGroup = this.pipeMeshes.get(pipe.id);
      if (!pipeGroup) {
        pipeGroup = this.buildPipeMesh(pipe);
        this.pipeMeshes.set(pipe.id, pipeGroup);
        this.group.add(pipeGroup);
      }

      // Update fluid color
      const colorHex = pipe.pipeType === 'sludge' 
        ? '#3b1c04' 
        : (pipe.pipeType === 'gas' ? '#eab308' : calcWaterColorHex(pipe.quality));
      
      const fluidMat = pipeGroup.userData.fluidMat as THREE.MeshStandardMaterial;
      if (fluidMat) {
        fluidMat.color.set(colorHex);
      }

      // Animate flowing pulses along pipe path
      this.animatePipeParticles(pipe, timeSec);
    }
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

  private buildPipeMesh(pipe: PipeConnection): THREE.Group {
    const group = new THREE.Group();
    group.name = `pipe_${pipe.id}`;

    const colorHex = pipe.pipeType === 'sludge' ? '#3b1c04' : calcWaterColorHex(pipe.quality);
    const fluidMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.3,
      metalness: 0.6
    });
    group.userData.fluidMat = fluidMat;

    const points = pipe.pathPoints;
    const particles: THREE.Mesh[] = [];

    // Create cylinder pipe segments between adjacent waypoints
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = new THREE.Vector3(...points[i]);
      const p2 = new THREE.Vector3(...points[i + 1]);
      const dist = p1.distanceTo(p2);
      if (dist < 0.05) continue;

      const segGeo = new THREE.CylinderGeometry(0.09, 0.09, dist, 12);
      const segMesh = new THREE.Mesh(segGeo, fluidMat);

      // Position and orient cylinder along segment
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      segMesh.position.copy(mid);
      segMesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().subVectors(p2, p1).normalize()
      );
      group.add(segMesh);

      // Flange rings at joints
      const flangeGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.06, 12);
      const flangeMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8 });
      const flange = new THREE.Mesh(flangeGeo, flangeMat);
      flange.position.copy(p1);
      group.add(flange);
    }

    // Glowing flow particle — BUG FIX: tint matches the pipe's fluid type
    const particleColor = pipe.pipeType === 'sludge'
      ? 0x8a5a20
      : (pipe.pipeType === 'gas' ? 0xfde047 : 0x38bdf8);
    const particleGeo = new THREE.SphereGeometry(0.12, 8, 8);
    const particleMat = new THREE.MeshBasicMaterial({ color: particleColor });
    const particle = new THREE.Mesh(particleGeo, particleMat);
    group.add(particle);
    particles.push(particle);

    this.flowParticles.set(pipe.id, particles);
    return group;
  }

  private animatePipeParticles(pipe: PipeConnection, timeSec: number) {
    const particles = this.flowParticles.get(pipe.id);
    if (!particles || particles.length === 0 || pipe.pathPoints.length < 2) return;

    // Only animate if there is active fluid flow
    const hasFlow = pipe.flowRate > 1;
    particles[0].visible = hasFlow;
    if (!hasFlow) return;

    // Calculate total path length
    let totalLen = 0;
    const dists: number[] = [];
    for (let i = 0; i < pipe.pathPoints.length - 1; i++) {
      const d = new THREE.Vector3(...pipe.pathPoints[i]).distanceTo(
        new THREE.Vector3(...pipe.pathPoints[i + 1])
      );
      dists.push(d);
      totalLen += d;
    }
    if (totalLen <= 0) return;

    // Progress along path based on flow rate & time
    const speed = Math.max(0.5, Math.min(3.0, pipe.flowRate / 2000));
    const progress = (timeSec * speed) % 1.0;
    let targetDist = progress * totalLen;

    // Find segment
    for (let i = 0; i < pipe.pathPoints.length - 1; i++) {
      const segLen = dists[i];
      if (targetDist <= segLen || i === pipe.pathPoints.length - 2) {
        const t = Math.max(0, Math.min(1, targetDist / Math.max(0.001, segLen)));
        const p1 = new THREE.Vector3(...pipe.pathPoints[i]);
        const p2 = new THREE.Vector3(...pipe.pathPoints[i + 1]);
        particles[0].position.lerpVectors(p1, p2, t);
        break;
      }
      targetDist -= segLen;
    }
  }
}
