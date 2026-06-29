import * as THREE from 'three';
import { CubeStateData, FACE_COLORS, applyMove, MoveType, FaceKey, setFaceColors, getFaceColors } from './CubeState';

export const CUBIE_SIZE = 1;
export const GAP = 0.05;
export const TOTAL = CUBIE_SIZE + GAP;
const STICKER_SCALE = 0.86;
const STICKER_DEPTH = 0.005;
const SNAP_ANIM_DURATION = 280; // ms for snap animation after release

export interface Cubie {
  mesh: THREE.Group;
  logicalPos: THREE.Vector3;
}

export type AxisKey = 'x' | 'y' | 'z';

export interface DragSession {
  axis: AxisKey;
  layer: number;
  axisVec: THREE.Vector3;
  pivot: THREE.Group;
  cubies: Cubie[];
  targetAngle: number;   // where the user is pulling toward
  currentAngle: number;  // actual displayed angle (chases target)
}

export class RubiksCube {
  scene: THREE.Scene;
  cubeGroup: THREE.Group;
  cubies: Cubie[] = [];
  private isAnimating = false;
  private animQueue: Array<() => void> = [];
  private onStateChangeCb?: (state: CubeStateData) => void;
  private cubeState: CubeStateData;
  private activeDrag: DragSession | null = null;
  private moveHistory: MoveType[] = [];

  constructor(scene: THREE.Scene, cubeGroup: THREE.Group, initialState: CubeStateData) {
    this.scene = scene;
    this.cubeGroup = cubeGroup;
    this.cubeState = initialState;
    this.buildCube(initialState);
  }

  setOnStateChange(fn: (state: CubeStateData) => void) {
    this.onStateChangeCb = fn;
  }

  getState() { return this.cubeState; }
  isCurrentlyAnimating() { return this.isAnimating; }
  isDragging() { return this.activeDrag !== null; }

  private buildCube(state: CubeStateData) {
    this.cubies.forEach(c => this.cubeGroup.remove(c.mesh));
    this.cubies = [];

    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const cubie = this.createCubie(x, y, z, state);
          this.cubies.push(cubie);
          this.cubeGroup.add(cubie.mesh);
        }
      }
    }
  }

  private getStickerColor(x: number, y: number, z: number, face: string, state: CubeStateData): string {
    // Map cubie position + face to sticker index
    const faceKey = face as keyof CubeStateData;
    let row: number, col: number;

    switch (face) {
      case 'U': // top face: looking down, front row is bottom
        row = 1 - z; col = x + 1;
        break;
      case 'D': // bottom face: looking up, front row is top
        row = z + 1; col = x + 1;
        break;
      case 'F': // front face: looking at it
        row = 1 - y; col = x + 1;
        break;
      case 'B': // back face: looking at it (mirrored x)
        row = 1 - y; col = 1 - x;
        break;
      case 'L': // left face: looking at it
        row = 1 - y; col = z + 1;
        break;
      case 'R': // right face: looking at it
        row = 1 - y; col = 1 - z;
        break;
      default:
        return FACE_COLORS.X;
    }

    const index = row * 3 + col;
    const colorKey = state[faceKey][index];
    return FACE_COLORS[colorKey] || FACE_COLORS.X;
  }

  private createCubieBody(): THREE.Group {
    const group = new THREE.Group();

    // Black body
    const bodyGeo = new THREE.BoxGeometry(CUBIE_SIZE, CUBIE_SIZE, CUBIE_SIZE);
    const bodyMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(FACE_COLORS.X),
      shininess: 30,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);

    return group;
  }

  private createCubieStickers(group: THREE.Group, x: number, y: number, z: number, state: CubeStateData) {
    const half = CUBIE_SIZE / 2 + STICKER_DEPTH;

    type FaceConfig = { face: string; condition: boolean; pos: [number, number, number]; rot: [number, number, number] };
    const faceConfigs: FaceConfig[] = [
      { face: 'R', condition: x === 1,  pos: [half, 0, 0],     rot: [0, Math.PI / 2, 0] },
      { face: 'L', condition: x === -1, pos: [-half, 0, 0],    rot: [0, -Math.PI / 2, 0] },
      { face: 'U', condition: y === 1,  pos: [0, half, 0],     rot: [-Math.PI / 2, 0, 0] },
      { face: 'D', condition: y === -1, pos: [0, -half, 0],    rot: [Math.PI / 2, 0, 0] },
      { face: 'F', condition: z === 1,  pos: [0, 0, half],     rot: [0, 0, 0] },
      { face: 'B', condition: z === -1, pos: [0, 0, -half],    rot: [0, Math.PI, 0] },
    ];

    for (const { face, condition, pos, rot } of faceConfigs) {
      if (!condition) continue;
      const color = this.getStickerColor(x, y, z, face, state);
      const geo = new THREE.PlaneGeometry(STICKER_SCALE, STICKER_SCALE);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(color),
        shininess: 100,
        specular: new THREE.Color(0x888888),
      });
      const sticker = new THREE.Mesh(geo, mat);
      sticker.position.set(...pos);
      sticker.rotation.set(...rot);
      sticker.userData.isSticker = true;
      sticker.userData.face = face;
      // Store local normal for world-space face detection
      const localNormal = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...rot));
      sticker.userData.normal = localNormal;
      group.add(sticker);
    }
  }

  private createCubie(x: number, y: number, z: number, state: CubeStateData): Cubie {
    const group = new THREE.Group();
    group.position.set(x * TOTAL, y * TOTAL, z * TOTAL);

    // Create body
    const body = this.createCubieBody();
    group.add(body);

    // Create stickers
    this.createCubieStickers(group, x, y, z, state);

    return { mesh: group, logicalPos: new THREE.Vector3(x, y, z) };
  }

  private updateCubieStickers(cubie: Cubie) {
    const { x, y, z } = cubie.logicalPos;

    // Remove old stickers
    const stickersToRemove: THREE.Mesh[] = [];
    cubie.mesh.traverse(child => {
      if (child instanceof THREE.Mesh && child.userData.isSticker) {
        stickersToRemove.push(child);
      }
    });
    stickersToRemove.forEach(s => {
      cubie.mesh.remove(s);
      s.geometry.dispose();
      if (s.material instanceof THREE.Material) s.material.dispose();
    });

    // Create new stickers
    this.createCubieStickers(cubie.mesh, x, y, z, this.cubeState);
  }

  getCubiesInLayer(axis: AxisKey, value: number): Cubie[] {
    return this.cubies.filter(c => Math.round(c.logicalPos[axis]) === value);
  }

  // ─── Interactive drag API ────────────────────────────

  /** Begin a drag: detach the layer into a pivot so it can be rotated freely */
  beginDrag(axis: AxisKey, layer: number, axisVec: THREE.Vector3): DragSession | null {
    if (this.isAnimating || this.activeDrag) return null;
    const cubies = this.getCubiesInLayer(axis, layer);
    if (cubies.length === 0) return null;

    const pivot = new THREE.Group();
    this.cubeGroup.add(pivot);
    for (const cubie of cubies) {
      const lp = cubie.mesh.position.clone();
      const lq = cubie.mesh.quaternion.clone();
      this.cubeGroup.remove(cubie.mesh);
      pivot.add(cubie.mesh);
      cubie.mesh.position.copy(lp);
      cubie.mesh.quaternion.copy(lq);
    }

    this.activeDrag = {
      axis, layer,
      axisVec: axisVec.clone(),
      pivot, cubies,
      targetAngle: 0,
      currentAngle: 0,
    };

    return this.activeDrag;
  }

  /**
   * Called every animation frame while dragging.
   * Smoothly interpolates `currentAngle` toward `targetAngle`.
   */
  tickDragSmoothing() {
    if (!this.activeDrag) return;
    const drag = this.activeDrag;
    const diff = drag.targetAngle - drag.currentAngle;
    if (Math.abs(diff) < 0.001) {
      drag.currentAngle = drag.targetAngle;
    } else {
      drag.currentAngle += diff * 0.35; // smoothing factor
    }
    drag.pivot.quaternion.setFromAxisAngle(drag.axisVec, drag.currentAngle);
  }

  /** Finish a drag: snap to nearest 90° and apply the move (or cancel) */
  finishDrag() {
    if (!this.activeDrag) return;
    const drag = this.activeDrag;
    this.activeDrag = null;

    const halfPi = Math.PI / 2;
    const snapped = Math.round(drag.targetAngle / halfPi);

    if (snapped === 0) {
      // Snap back to 0 — no move
      this.snapDragTo(drag, 0, null);
    } else {
      const direction = snapped > 0 ? 1 : -1;
      const targetAngle = direction * halfPi;
      const move = this.getMoveFromDrag(drag.axis, drag.layer, direction);
      this.snapDragTo(drag, targetAngle, move);
    }
  }

  /** Cancel drag (snap back to 0, no move applied) */
  cancelDrag() {
    if (!this.activeDrag) return;
    const drag = this.activeDrag;
    this.activeDrag = null;
    this.snapDragTo(drag, 0, null);
  }

  private getMoveFromDrag(axis: AxisKey, layer: number, steps: number): MoveType | null {
    const dir = steps > 0 ? 1 : -1;

    type MoveInfo = { pos: MoveType; neg: MoveType };
    const layerMoves: Record<string, MoveInfo> = {
      'x_1':  { pos: "R'", neg: 'R' },
      'x_-1': { pos: 'L',  neg: "L'" },
      'x_0':  { pos: 'M',  neg: "M'" },
      'y_1':  { pos: "U'", neg: 'U' },
      'y_-1': { pos: 'D',  neg: "D'" },
      'y_0':  { pos: 'E',  neg: "E'" },
      'z_1':  { pos: "F'", neg: 'F' },
      'z_-1': { pos: 'B',  neg: "B'" },
      'z_0':  { pos: "S'", neg: 'S' },
    };

    const key = `${axis}_${layer}`;
    const info = layerMoves[key];
    if (!info) return null;
    return dir > 0 ? info.pos : info.neg;
  }

  private snapDragTo(drag: DragSession, targetAngle: number, move: MoveType | null) {
    const startAngle = drag.currentAngle;
    const startQuat = new THREE.Quaternion().setFromAxisAngle(drag.axisVec, startAngle);
    const targetQuat = new THREE.Quaternion().setFromAxisAngle(drag.axisVec, targetAngle);

    // If already at target, finalize immediately
    const diff = Math.abs(targetAngle - startAngle);
    if (diff < 0.01) {
      this.finalizeDragSnap(drag, move, targetAngle);
      return;
    }

    const duration = SNAP_ANIM_DURATION * Math.min(diff / (Math.PI / 2), 1);
    const startTime = performance.now();

    const tick = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - (1 - t) * (1 - t);
      drag.pivot.quaternion.slerpQuaternions(startQuat, targetQuat, eased);
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        this.finalizeDragSnap(drag, move, targetAngle);
      }
    };
    requestAnimationFrame(tick);
  }

  private finalizeDragSnap(drag: DragSession, move: MoveType | null, angle: number) {
    // Apply the rotation to each cubie's logical position
    if (move) {
      const q = new THREE.Quaternion().setFromAxisAngle(drag.axisVec, angle);
      for (const cubie of drag.cubies) {
        cubie.logicalPos.applyQuaternion(q);
        cubie.logicalPos.x = Math.round(cubie.logicalPos.x);
        cubie.logicalPos.y = Math.round(cubie.logicalPos.y);
        cubie.logicalPos.z = Math.round(cubie.logicalPos.z);
      }
      this.cubeState = applyMove(this.cubeState, move);
      this.moveHistory.push(move);
    }

    // Re-parent cubies back to cubeGroup
    for (const cubie of drag.cubies) {
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      cubie.mesh.getWorldPosition(worldPos);
      cubie.mesh.getWorldQuaternion(worldQuat);
      drag.pivot.remove(cubie.mesh);

      // Convert world position/quat to cubeGroup-local
      const invMatrix = new THREE.Matrix4().copy(this.cubeGroup.matrixWorld).invert();
      const localPos = worldPos.applyMatrix4(invMatrix);
      const invGroupQuat = this.cubeGroup.quaternion.clone().invert();
      const localQuat = invGroupQuat.multiply(worldQuat);

      cubie.mesh.position.copy(localPos);
      cubie.mesh.quaternion.copy(localQuat);
      this.cubeGroup.add(cubie.mesh);
    }

    // Remove pivot
    this.cubeGroup.remove(drag.pivot);

    if (move) {
      this.onStateChangeCb?.(this.cubeState);
    }

    // Process queued animations
    if (this.animQueue.length > 0) {
      const next = this.animQueue.shift()!;
      next();
    }
  }

  // ─── Programmatic move (for scramble, button presses) ────────

  private animateLayer(
    cubies: Cubie[],
    axisVec: THREE.Vector3,
    totalAngle: number,
    duration: number,
    onComplete: () => void
  ) {
    const pivot = new THREE.Group();
    this.cubeGroup.add(pivot);

    for (const cubie of cubies) {
      const lp = cubie.mesh.position.clone();
      const lq = cubie.mesh.quaternion.clone();
      this.cubeGroup.remove(cubie.mesh);
      pivot.add(cubie.mesh);
      cubie.mesh.position.copy(lp);
      cubie.mesh.quaternion.copy(lq);
    }

    const startTime = performance.now();
    const startQuat = new THREE.Quaternion();
    const targetQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, totalAngle);

    const tick = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = t < 1 ? 1 - Math.pow(1 - t, 3) : 1; // ease-out cubic
      pivot.quaternion.slerpQuaternions(startQuat, targetQuat, eased);

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        // Re-parent back
        for (const cubie of cubies) {
          const wp = new THREE.Vector3();
          const wq = new THREE.Quaternion();
          cubie.mesh.getWorldPosition(wp);
          cubie.mesh.getWorldQuaternion(wq);
          pivot.remove(cubie.mesh);

          const invM = new THREE.Matrix4().copy(this.cubeGroup.matrixWorld).invert();
          cubie.mesh.position.copy(wp.applyMatrix4(invM));
          const invQ = this.cubeGroup.quaternion.clone().invert();
          cubie.mesh.quaternion.copy(invQ.multiply(wq));

          this.cubeGroup.add(cubie.mesh);
        }
        this.cubeGroup.remove(pivot);
        onComplete();
      }
    };
    requestAnimationFrame(tick);
  }

  executeMove(move: MoveType, callback?: () => void, skipHistory = false) {
    const ANIM_DURATION = 160;

    const moveMap: Record<MoveType, { axis: AxisKey; layer: number; dir: number }> = {
      'R':  { axis: 'x', layer: 1, dir: -1 },
      "R'": { axis: 'x', layer: 1, dir: 1 },
      'L':  { axis: 'x', layer: -1, dir: 1 },
      "L'": { axis: 'x', layer: -1, dir: -1 },
      'U':  { axis: 'y', layer: 1, dir: -1 },
      "U'": { axis: 'y', layer: 1, dir: 1 },
      'D':  { axis: 'y', layer: -1, dir: 1 },
      "D'": { axis: 'y', layer: -1, dir: -1 },
      'F':  { axis: 'z', layer: 1, dir: -1 },
      "F'": { axis: 'z', layer: 1, dir: 1 },
      'B':  { axis: 'z', layer: -1, dir: 1 },
      "B'": { axis: 'z', layer: -1, dir: -1 },
      'M':  { axis: 'x', layer: 0, dir: 1 },
      "M'": { axis: 'x', layer: 0, dir: -1 },
      'E':  { axis: 'y', layer: 0, dir: 1 },
      "E'": { axis: 'y', layer: 0, dir: -1 },
      'S':  { axis: 'z', layer: 0, dir: -1 },
      "S'": { axis: 'z', layer: 0, dir: 1 },
    };

    const doMove = () => {
      const { axis, layer, dir } = moveMap[move];
      const axisVec = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
      );
      const angle = (Math.PI / 2) * dir;
      const cubies = this.getCubiesInLayer(axis, layer);

      const q = new THREE.Quaternion().setFromAxisAngle(axisVec, angle);
      for (const cubie of cubies) {
        cubie.logicalPos.applyQuaternion(q);
        cubie.logicalPos.x = Math.round(cubie.logicalPos.x);
        cubie.logicalPos.y = Math.round(cubie.logicalPos.y);
        cubie.logicalPos.z = Math.round(cubie.logicalPos.z);
      }

      this.cubeState = applyMove(this.cubeState, move);
      if (!skipHistory) {
        this.moveHistory.push(move);
      }

      this.isAnimating = true;
      this.animateLayer(cubies, axisVec, angle, ANIM_DURATION, () => {
        this.isAnimating = false;
        this.onStateChangeCb?.(this.cubeState);
        callback?.();
        if (this.animQueue.length > 0) {
          const next = this.animQueue.shift()!;
          next();
        }
      });
    };

    if (this.isAnimating || this.activeDrag) {
      this.animQueue.push(doMove);
    } else {
      doMove();
    }
  }

  // ─── Force Mode ─────────────────────────────────────────────

  applyForceToFaces(faces: FaceKey[], forceState: CubeStateData) {
    if (!forceState) return;

    // For each face being forced, find the 9 cubies that have this face visible
    // and set their sticker color directly from forceState based on logical position
    for (const face of faces) {
      const forceColors = getFaceColors(forceState, face);
      
      // Find cubies that have this face on the outside
      const targetCubies = this.cubies.filter(cubie => this.cubieHasFace(cubie, face));
      
      for (const cubie of targetCubies) {
        this.updateCubieFaceSticker(cubie, face, forceColors);
      }
      
      // Also update cubeState for consistency
      this.cubeState = setFaceColors(this.cubeState, face, forceColors);
    }

    // Notify listeners
    this.onStateChangeCb?.(this.cubeState);
  }

  /** Check if a cubie has the given face on its exterior */
  private cubieHasFace(cubie: Cubie, face: FaceKey): boolean {
    const { x, y, z } = cubie.logicalPos;
    switch (face) {
      case 'U': return y === 1;
      case 'D': return y === -1;
      case 'F': return z === 1;
      case 'B': return z === -1;
      case 'L': return x === -1;
      case 'R': return x === 1;
    }
  }

  /** Update a specific face sticker on a cubie with force colors */
  private updateCubieFaceSticker(cubie: Cubie, face: FaceKey, forceColors: FaceColor[]) {
    const { x, y, z } = cubie.logicalPos;
    
    // Calculate sticker index using same logic as getStickerColor
    let row: number, col: number;
    switch (face) {
      case 'U': row = 1 - z; col = x + 1; break;
      case 'D': row = z + 1; col = x + 1; break;
      case 'F': row = 1 - y; col = x + 1; break;
      case 'B': row = 1 - y; col = 1 - x; break;
      case 'L': row = 1 - y; col = z + 1; break;
      case 'R': row = 1 - y; col = 1 - z; break;
      default: return;
    }
    const index = row * 3 + col;
    const colorKey = forceColors[index];
    const color = FACE_COLORS[colorKey] || FACE_COLORS.X;

    // Face normals in local cubie space
    const faceNormals: Record<FaceKey, THREE.Vector3> = {
      U: new THREE.Vector3(0, 1, 0),
      D: new THREE.Vector3(0, -1, 0),
      F: new THREE.Vector3(0, 0, 1),
      B: new THREE.Vector3(0, 0, -1),
      L: new THREE.Vector3(-1, 0, 0),
      R: new THREE.Vector3(1, 0, 0),
    };
    const targetNormal = faceNormals[face];

    // Find and update the sticker by matching world normal
    let stickerFound = false;
    cubie.mesh.traverse(child => {
      if (child instanceof THREE.Mesh && child.userData.isSticker && child.userData.normal) {
        // Transform local normal to world space
        const worldNormal = child.userData.normal.clone().transformDirection(child.matrixWorld).normalize();
        if (worldNormal.dot(targetNormal) > 0.99) { // same direction
          if (child.material instanceof THREE.MeshPhongMaterial) {
            child.material.color.set(color);
          }
          stickerFound = true;
        }
      }
    });

    // If sticker doesn't exist, recreate all
    if (!stickerFound) {
      this.updateCubieStickers(cubie);
    }
  }

  setState(state: CubeStateData) {
    this.cubeState = { ...state };
    this.isAnimating = false;
    this.activeDrag = null;
    this.animQueue = [];
    this.moveHistory = [];
    this.buildCube(state);
  }

  getMoveHistory(): MoveType[] {
    return [...this.moveHistory];
  }

  clearHistory() {
    this.moveHistory = [];
  }

  clearQueue() {
    this.animQueue = [];
  }
}