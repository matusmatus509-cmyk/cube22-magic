import * as THREE from 'three';
import { RubiksCube } from './RubiksCube';
import { CubeInteraction } from './CubeInteraction';
import { CubeStateData, createSolvedState, MoveType, inverseMove, FaceKey, setFaceColors, getFaceColors } from './CubeState';

export class CubeScene {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private cube: RubiksCube;
  private cubeGroup: THREE.Group;
  private interaction: CubeInteraction;
  private animFrameId: number = 0;
  private container: HTMLElement;

  // Force mode
  private forceState: CubeStateData | null = null;
  private forceModeArmed = false;    // checkbox - ready to activate
  private forceModeActive = false;   // actually applying force (after corner trigger)
  private prevVisibility: Map<FaceKey, boolean> = new Map();
  onForceActiveChange?: (active: boolean) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = null;

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, 0, 7.5);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Lighting
    this.setupLights();

    // Cube group (for whole-cube rotation by dragging)
    this.cubeGroup = new THREE.Group();
    this.scene.add(this.cubeGroup);

    // Initial isometric-like tilt
    this.cubeGroup.rotation.x = 0.35;
    this.cubeGroup.rotation.y = 0.65;

    // Create cube
    const initialState = createSolvedState();
    this.cube = new RubiksCube(this.scene, this.cubeGroup, initialState);

    // Interaction
    this.interaction = new CubeInteraction(
      this.cube,
      this.camera,
      this.renderer,
      this.cubeGroup
    );

    // Connect force trigger
    this.interaction.onForceTrigger = () => this.activateForceMode();

    // Resize handler
    window.addEventListener('resize', this.onResize);

    // Start render loop
    this.startRenderLoop();

    // Initialize visibility tracking
    this.resetVisibilityTracking();
  }

  private setupLights() {
    // Ambient
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    // Main directional light (top-right-front)
    const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
    dir1.position.set(5, 8, 6);
    this.scene.add(dir1);

    // Fill light (bottom-left-back)
    const dir2 = new THREE.DirectionalLight(0x8899ff, 0.3);
    dir2.position.set(-4, -3, -4);
    this.scene.add(dir2);

    // Rim light
    const dir3 = new THREE.DirectionalLight(0xffeecc, 0.2);
    dir3.position.set(0, 0, -5);
    this.scene.add(dir3);
  }

  private startRenderLoop() {
    const animate = () => {
      this.animFrameId = requestAnimationFrame(animate);
      // Smoothly interpolate any in-progress drag
      this.cube.tickDragSmoothing();

      // Force mode: visibility tracking (only when ACTIVE, not just armed)
      if (this.forceModeActive && this.forceState) {
        this.updateForceVisibility();
      }

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  private onResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  setOnStateChange(fn: (state: CubeStateData) => void) {
    this.cube.setOnStateChange(fn);
  }

  reset() {
    const solved = createSolvedState();
    this.cube.setState(solved);
    this.forceModeArmed = false;
    this.forceModeActive = false;
    this.onForceActiveChange?.(false);
    this.resetVisibilityTracking();
  }

  executeMove(move: MoveType) {
    this.cube.executeMove(move);
  }

  resetRotation() {
    this.cubeGroup.rotation.x = 0.35;
    this.cubeGroup.rotation.y = 0.65;
    this.cubeGroup.rotation.z = 0;
  }

  getState(): CubeStateData {
    return this.cube.getState();
  }

  /** Get the sequence of inverse moves that will solve the cube (reverse of history) */
  getSolveSequence(): MoveType[] {
    const history = this.cube.getMoveHistory();
    // Reverse the history and invert each move
    const solution: MoveType[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      solution.push(inverseMove(history[i]));
    }
    return solution;
  }

  /** Execute a move without recording it in the history (used for solving) */
  executeSolveMove(move: MoveType) {
    this.cube.executeMove(move, undefined, true);
  }

  clearHistory() {
    this.cube.clearHistory();
  }

  // ─── Force Mode ──────────────────────────────────────────────

  setForceState(state: CubeStateData) {
    this.forceState = state;
  }

  getForceState(): CubeStateData | null {
    return this.forceState;
  }

  /** Enable force mode (arm it) - called from checkbox */
  armForceMode() {
    this.forceModeArmed = true;
  }

  /** Disable force mode completely */
  disarmForceMode() {
    this.forceModeArmed = false;
    this.forceModeActive = false;
    this.onForceActiveChange?.(false);
  }

  /** Toggle armed state (for checkbox) */
  toggleForceModeArmed() {
    if (this.forceModeArmed) {
      this.disarmForceMode();
    } else {
      this.armForceMode();
    }
  }

  /** Check if force mode is armed (checkbox state) */
  isForceModeArmed(): boolean {
    return this.forceModeArmed;
  }

  /** Activate force mode - called from corner long-press trigger */
  activateForceMode() {
    if (!this.forceModeArmed || this.forceModeActive) return;
    this.forceModeActive = true;
    this.applyForceToCurrentlyHiddenFaces();
    this.resetVisibilityTracking();
    this.onForceActiveChange?.(true);
  }

  /** Deactivate force mode */
  deactivateForceMode() {
    this.forceModeActive = false;
    this.onForceActiveChange?.(false);
  }

  /** Toggle active state (for testing) */
  toggleForceMode() {
    if (this.forceModeActive) {
      this.deactivateForceMode();
    } else {
      this.activateForceMode();
    }
  }

  isForceModeActive(): boolean {
    return this.forceModeActive;
  }

  /** Immediately apply force to faces currently hidden */
  private applyForceToCurrentlyHiddenFaces() {
    if (!this.forceState) return;
    const currentVis = this.computeFaceVisibility();
    const facesToForce: FaceKey[] = [];
    for (const [face, isVisible] of Object.entries(currentVis)) {
      if (!isVisible) {
        facesToForce.push(face as FaceKey);
      }
    }
    if (facesToForce.length > 0) {
      this.cube.applyForceToFaces(facesToForce, this.forceState);
    }
  }

  private resetVisibilityTracking() {
    const vis = this.computeFaceVisibility();
    for (const [face, visible] of Object.entries(vis)) {
      this.prevVisibility.set(face as FaceKey, visible);
    }
  }

  private computeFaceVisibility(): Record<FaceKey, boolean> {
    const camForward = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld).normalize();

    const faceNormals: Record<FaceKey, THREE.Vector3> = {
      U: new THREE.Vector3(0, 1, 0),
      D: new THREE.Vector3(0, -1, 0),
      F: new THREE.Vector3(0, 0, 1),
      B: new THREE.Vector3(0, 0, -1),
      L: new THREE.Vector3(-1, 0, 0),
      R: new THREE.Vector3(1, 0, 0),
    };

    const result: Record<FaceKey, boolean> = {} as any;
    for (const [face, localNormal] of Object.entries(faceNormals)) {
      const worldNormal = localNormal.clone().transformDirection(this.cubeGroup.matrixWorld).normalize();
      result[face as FaceKey] = worldNormal.dot(camForward) > 0;
    }
    return result;
  }

  private updateForceVisibility() {
    const currentVis = this.computeFaceVisibility();

    const facesToForce: FaceKey[] = [];

    for (const [face, isVisible] of Object.entries(currentVis)) {
      const wasVisible = this.prevVisibility.get(face as FaceKey) ?? false;
      const isNowHidden = wasVisible && !isVisible; // transition visible -> hidden

      if (isNowHidden) {
        facesToForce.push(face as FaceKey);
      }
    }

    if (facesToForce.length > 0) {
      this.cube.applyForceToFaces(facesToForce, this.forceState!);
    }

    // Update prevVisibility
    for (const [face, isVisible] of Object.entries(currentVis)) {
      this.prevVisibility.set(face as FaceKey, isVisible);
    }
  }

  destroy() {
    cancelAnimationFrame(this.animFrameId);
    this.interaction.destroy();
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}