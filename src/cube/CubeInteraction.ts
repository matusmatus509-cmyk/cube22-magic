import * as THREE from 'three';
import { RubiksCube, AxisKey } from './RubiksCube';

/**
 * Drag-to-rotate interaction for the Rubik's Cube.
 *
 * Algorithm:
 *  1. On pointer-down: raycast to find the hit point on the cube.
 *  2. From the hit normal, determine the two candidate rotation axes.
 *  3. For each candidate, compute screen-space swipe direction.
 *  4. While dragging, whichever candidate first exceeds threshold wins.
 *  5. The layer follows the finger in real time.
 *  6. On pointer-up, snap to nearest 90°.
 *  7. Drags that start outside the cube rotate the whole cube group.
 */

interface CandidateDrag {
  swipeAxis: THREE.Vector3;
  rotAxis: THREE.Vector3;
  screenDir: { x: number; y: number };
}

interface DragState {
  screenDir: { x: number; y: number };
  angle: number;
}

interface PointerState {
  down: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  hitPoint: THREE.Vector3 | null;
  hitNormalLocal: THREE.Vector3 | null;
  hitCubiePos: THREE.Vector3 | null;
  onCube: boolean;
  candidates: CandidateDrag[] | null;
  drag: DragState | null;
  cubeGroupRotating: boolean;
  // Force trigger
  forceTriggerTimer: number | null;
  forceTriggerStart: { x: number; y: number } | null;
}

export class CubeInteraction {
  private cube: RubiksCube;
  private camera: THREE.PerspectiveCamera;
  private raycaster: THREE.Raycaster;
  private renderer: THREE.WebGLRenderer;
  private cubeGroup: THREE.Group;
  private ptr: PointerState;

  private readonly MIN_DRAG_PX = 8;
  private readonly SENSITIVITY = 0.0105;
  private readonly ORBIT_SENSITIVITY = 0.008;
  private readonly FORCE_TRIGGER_DELAY = 300; // ms
  private readonly CORNER_THRESHOLD = 50; // px from corner

  // Callback for force trigger
  onForceTrigger?: () => void;

  constructor(
    cube: RubiksCube,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    cubeGroup: THREE.Group,
  ) {
    this.cube = cube;
    this.camera = camera;
    this.renderer = renderer;
    this.cubeGroup = cubeGroup;
    this.raycaster = new THREE.Raycaster();
    this.ptr = this.fresh();
    this.bindEvents();
  }

  /* ── helpers ── */

  private fresh(): PointerState {
    return {
      down: false, startX: 0, startY: 0, lastX: 0, lastY: 0,
      hitPoint: null, hitNormalLocal: null, hitCubiePos: null,
      onCube: false, candidates: null, drag: null, cubeGroupRotating: false,
      forceTriggerTimer: null,
      forceTriggerStart: null,
    };
  }

  private pos(e: MouseEvent | TouchEvent): { x: number; y: number } {
    if (e instanceof TouchEvent) {
      const t = e.touches[0] ?? e.changedTouches[0];
      return { x: t.clientX, y: t.clientY };
    }
    return { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((x - r.left) / r.width) * 2 - 1,
      -((y - r.top) / r.height) * 2 + 1,
    );
  }

  private raycast(x: number, y: number): THREE.Intersection | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const meshes: THREE.Object3D[] = [];
    this.cubeGroup.traverse(o => { if (o instanceof THREE.Mesh) meshes.push(o); });
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length > 0 ? hits[0] : null;
  }

  private snapNormal(worldN: THREE.Vector3): THREE.Vector3 {
    const inv = new THREE.Matrix4().copy(this.cubeGroup.matrixWorld).invert();
    const loc = worldN.clone().transformDirection(inv).normalize();
    const ax = Math.abs(loc.x), ay = Math.abs(loc.y), az = Math.abs(loc.z);
    if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(loc.x), 0, 0);
    if (ay >= ax && ay >= az) return new THREE.Vector3(0, Math.sign(loc.y), 0);
    return new THREE.Vector3(0, 0, Math.sign(loc.z));
  }

  private candidateAxes(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (ay >= ax && ay >= az) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
    if (ax >= ay && ax >= az) return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  }

  private computeScreenDir(
    _hitPointWorld: THREE.Vector3,
    hitPointLocal: THREE.Vector3,
    swipeAxisLocal: THREE.Vector3,
    rotAxisLocal: THREE.Vector3,
  ): { x: number; y: number } {
    const swipeAxisWorld = swipeAxisLocal.clone().transformDirection(this.cubeGroup.matrixWorld).normalize();
    const camMatrix = this.camera.matrixWorld;
    const camRight = new THREE.Vector3().setFromMatrixColumn(camMatrix, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(camMatrix, 1);

    const screenX = swipeAxisWorld.dot(camRight);
    const screenY = -swipeAxisWorld.dot(camUp);

    const len = Math.sqrt(screenX * screenX + screenY * screenY);
    if (len < 0.0001) return { x: 1, y: 0 };
    let dx = screenX / len;
    let dy = screenY / len;

    const velocityLocal = new THREE.Vector3().crossVectors(rotAxisLocal, hitPointLocal);
    const sign = velocityLocal.dot(swipeAxisLocal) > 0 ? 1 : -1;

    return { x: dx * sign, y: dy * sign };
  }

  private signedDist(start: { x: number; y: number }, cur: { x: number; y: number }, dir: { x: number; y: number }): number {
    return (cur.x - start.x) * dir.x + (cur.y - start.y) * dir.y;
  }

  /** Find the logical cubie position from a hit intersection */
  private getCubieLogicalPos(hit: THREE.Intersection): THREE.Vector3 | null {
    // Walk up to find the cubie group
    let obj: THREE.Object3D | null = hit.object;
    while (obj && obj.parent !== this.cubeGroup) {
      obj = obj.parent;
    }
    if (!obj) return null;
    // Find matching cubie
    const cubie = this.cube.cubies.find(c => c.mesh === obj);
    return cubie ? cubie.logicalPos.clone() : null;
  }

  /** Get the layer value for a given axis from a cubie position */
  private getLayer(cubiePos: THREE.Vector3, axis: AxisKey): number {
    return Math.round(cubiePos[axis]);
  }

  /**
   * Rotate the whole cube in screen-space so dragging right moves the cube right,
   * dragging up moves it up, etc. This uses camera axes instead of local Euler
   * rotations, so the control stays intuitive even after many turns.
   */
  private rotateCubeByScreenDelta(dx: number, dy: number) {
    this.camera.updateMatrixWorld();

    const camMatrix = this.camera.matrixWorld;
    const camRight = new THREE.Vector3().setFromMatrixColumn(camMatrix, 0).normalize();
    const camUp = new THREE.Vector3().setFromMatrixColumn(camMatrix, 1).normalize();

    const yaw = dx * this.ORBIT_SENSITIVITY;
    const pitch = dy * this.ORBIT_SENSITIVITY;

    const qYaw = new THREE.Quaternion().setFromAxisAngle(camUp, yaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(camRight, pitch);

    this.cubeGroup.quaternion.premultiply(qYaw);
    this.cubeGroup.quaternion.premultiply(qPitch);
    this.cubeGroup.quaternion.normalize();
  }

  /* ── Event binding ── */

  private onPointerDown = (e: MouseEvent | TouchEvent) => {
    if (this.cube.isCurrentlyAnimating() || this.cube.isDragging()) return;
    e.preventDefault();

    const p = this.pos(e);
    this.ptr = this.fresh();
    this.ptr.down = true;
    this.ptr.startX = p.x;
    this.ptr.startY = p.y;
    this.ptr.lastX = p.x;
    this.ptr.lastY = p.y;

    // Check for corner long-press (force trigger)
    const rect = this.renderer.domElement.getBoundingClientRect();
    const isInCorner =
      (p.x - rect.left < this.CORNER_THRESHOLD || rect.right - p.x < this.CORNER_THRESHOLD) &&
      (p.y - rect.top < this.CORNER_THRESHOLD || rect.bottom - p.y < this.CORNER_THRESHOLD);

    if (isInCorner) {
      this.ptr.forceTriggerStart = { x: p.x, y: p.y };
      this.ptr.forceTriggerTimer = window.setTimeout(() => {
        this.onForceTrigger?.();
        this.ptr.forceTriggerTimer = null;
        this.ptr.forceTriggerStart = null;
        // Subtle haptic feedback
        navigator.vibrate?.([30]);
      }, this.FORCE_TRIGGER_DELAY);
    }

    // Raycast
    const hit = this.raycast(p.x, p.y);
    if (hit && hit.face) {
      this.ptr.onCube = true;
      this.ptr.hitPoint = hit.point.clone();
      this.ptr.hitNormalLocal = this.snapNormal(hit.face.normal.clone().transformDirection(hit.object.matrixWorld));
      this.ptr.hitCubiePos = this.getCubieLogicalPos(hit);

      if (this.ptr.hitNormalLocal && this.ptr.hitPoint && this.ptr.hitCubiePos) {
        // Compute hit point in cube-local space
        const invMatrix = new THREE.Matrix4().copy(this.cubeGroup.matrixWorld).invert();
        const hitLocal = this.ptr.hitPoint.clone().applyMatrix4(invMatrix);

        const [axis1, axis2] = this.candidateAxes(this.ptr.hitNormalLocal);

        // For each candidate: the swipe axis is axis1/axis2, the rotation axis is the other
        this.ptr.candidates = [
          {
            swipeAxis: axis1.clone(),
            rotAxis: axis2.clone(),
            screenDir: this.computeScreenDir(this.ptr.hitPoint, hitLocal, axis1, axis2),
          },
          {
            swipeAxis: axis2.clone(),
            rotAxis: axis1.clone(),
            screenDir: this.computeScreenDir(this.ptr.hitPoint, hitLocal, axis2, axis1),
          },
        ];
      }
    } else {
      this.ptr.onCube = false;
      this.ptr.cubeGroupRotating = true;
    }
  };

  private onPointerMove = (e: MouseEvent | TouchEvent) => {
    if (!this.ptr.down) return;
    e.preventDefault();

    const p = this.pos(e);
    const dx = p.x - this.ptr.lastX;
    const dy = p.y - this.ptr.lastY;
    this.ptr.lastX = p.x;
    this.ptr.lastY = p.y;

    // Cancel force trigger if moved too far
    if (this.ptr.forceTriggerTimer && this.ptr.forceTriggerStart) {
      const moveDx = p.x - this.ptr.forceTriggerStart.x;
      const moveDy = p.y - this.ptr.forceTriggerStart.y;
      if (Math.sqrt(moveDx * moveDx + moveDy * moveDy) > 10) {
        clearTimeout(this.ptr.forceTriggerTimer);
        this.ptr.forceTriggerTimer = null;
        this.ptr.forceTriggerStart = null;
      }
    }

    // Whole-cube rotation
    if (this.ptr.cubeGroupRotating) {
      this.rotateCubeByScreenDelta(dx, dy);
      return;
    }

    // On-cube drag: pick direction or continue dragging
    if (this.ptr.onCube && this.ptr.candidates && !this.ptr.drag) {
      // Check which candidate wins
      const cur = { x: p.x, y: p.y };
      const start = { x: this.ptr.startX, y: this.ptr.startY };

      for (const candidate of this.ptr.candidates) {
        const dist = Math.abs(this.signedDist(start, cur, candidate.screenDir));
        if (dist >= this.MIN_DRAG_PX) {
          // This candidate wins - the ROTATION axis is the one perpendicular to the swipe
          const rotAxis = candidate.rotAxis;
          const axisKey: AxisKey =
            Math.abs(rotAxis.x) > 0.5 ? 'x' :
            Math.abs(rotAxis.y) > 0.5 ? 'y' : 'z';

          if (this.ptr.hitCubiePos) {
            const layer = this.getLayer(this.ptr.hitCubiePos, axisKey);
            const axisVec = rotAxis.clone();
            const session = this.cube.beginDrag(axisKey, layer, axisVec);

            if (session) {
              const initialAngle = this.signedDist(start, cur, candidate.screenDir) * this.SENSITIVITY;
              session.targetAngle = initialAngle;

              this.ptr.drag = {
                screenDir: candidate.screenDir,
                angle: initialAngle,
              };
            }
          }
          break;
        }
      }
    } else if (this.ptr.drag && this.cube.isDragging()) {
      // Continue dragging
      const cur = { x: p.x, y: p.y };
      const start = { x: this.ptr.startX, y: this.ptr.startY };
      const dist = this.signedDist(start, cur, this.ptr.drag.screenDir);
      const angle = dist * this.SENSITIVITY;

      // Clamp to ±90°
      const maxAngle = Math.PI / 2;
      const clampedAngle = Math.max(-maxAngle, Math.min(maxAngle, angle));

      this.ptr.drag.angle = clampedAngle;
      // Update the drag session's target angle
      // Access the active drag through the cube (we know it's active)
      const session = (this.cube as any).activeDrag;
      if (session) {
        session.targetAngle = clampedAngle;
      }
    }
  };

  private onPointerUp = (e: MouseEvent | TouchEvent) => {
    if (!this.ptr.down) return;
    e.preventDefault();

    // Cancel force trigger timer
    if (this.ptr.forceTriggerTimer) {
      clearTimeout(this.ptr.forceTriggerTimer);
      this.ptr.forceTriggerTimer = null;
      this.ptr.forceTriggerStart = null;
    }

    if (this.cube.isDragging()) {
      this.cube.finishDrag();
    }

    this.ptr = this.fresh();
  };

  private bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('mousedown', this.onPointerDown);
    window.addEventListener('mousemove', this.onPointerMove);
    window.addEventListener('mouseup', this.onPointerUp);
    el.addEventListener('touchstart', this.onPointerDown, { passive: false });
    window.addEventListener('touchmove', this.onPointerMove, { passive: false });
    window.addEventListener('touchend', this.onPointerUp, { passive: false });
    window.addEventListener('touchcancel', this.onPointerUp, { passive: false });
  }

  destroy() {
    if (this.ptr.forceTriggerTimer) {
      clearTimeout(this.ptr.forceTriggerTimer);
    }
    const el = this.renderer.domElement;
    el.removeEventListener('mousedown', this.onPointerDown);
    window.removeEventListener('mousemove', this.onPointerMove);
    window.removeEventListener('mouseup', this.onPointerUp);
    el.removeEventListener('touchstart', this.onPointerDown);
    window.removeEventListener('touchmove', this.onPointerMove);
    window.removeEventListener('touchend', this.onPointerUp);
    window.removeEventListener('touchcancel', this.onPointerUp);
  }
}