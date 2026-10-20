import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PRESETS, RANGE_MM } from './model.ts';
import type { Preset, Sample } from './model.ts';

const material = (color: string, metalness = 0, roughness = 0.55) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness });

export class LabScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.01, 40);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private head = new THREE.Group();
  private obstacles = new THREE.Group();
  private currentAngle = 90;
  private targetAngle = 90;
  private rayGeometry = new THREE.BufferGeometry();
  private rayPositions = new Float32Array(13 * 6);
  private markers: THREE.Mesh[] = [];
  private beam: THREE.Mesh;
  private beamPositions = new Float32Array(9);
  private wave: THREE.Line;
  private wavePositions = new Float32Array(33 * 3);
  private measurement: Sample | null = null;
  private nearestHalo: THREE.Mesh;

  constructor(container: HTMLElement) {
    this.scene.background = new THREE.Color('#eef3ee');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '三维舵机与超声扫描装置，可拖动旋转视角');
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.minDistance = 3.4; this.controls.maxDistance = 10;
    this.controls.minPolarAngle = 0.22; this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.resetCamera();
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#91a99b', 2.9));
    const key = new THREE.DirectionalLight('#fff8ec', 4.2);
    key.position.set(-2, 7, 4); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -4; key.shadow.camera.right = 4;
    key.shadow.camera.top = 4; key.shadow.camera.bottom = -4; key.shadow.normalBias = 0.025;
    key.shadow.bias = -0.0001; key.shadow.radius = 4;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#e3f0ff', 1.8); rim.position.set(3, 2, -4); this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), material('#edf2ed'));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = -0.015; this.scene.add(floor);
    const grid = new THREE.GridHelper(6, 20, '#d7e2d8', '#e1e9df');
    grid.position.z = 0.8; grid.position.y = -0.008; this.scene.add(grid);
    for (let i = 1; i <= 5; i++) {
      const pts = Array.from({ length: 81 }, (_, j) => {
        const a = j / 80 * Math.PI;
        return new THREE.Vector3(Math.cos(a) * i * 0.5, 0.001, Math.sin(a) * i * 0.5);
      });
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: i === 5 ? '#afc6b6' : '#cadace', transparent: true, opacity: 0.8 })));
    }
    this.buildDevice(); this.scene.add(this.obstacles);
    this.rayGeometry.setAttribute('position', new THREE.BufferAttribute(this.rayPositions, 3));
    this.rayGeometry.setDrawRange(0, 0);
    const rays = new THREE.LineSegments(this.rayGeometry, new THREE.LineBasicMaterial({ color: '#49a28a', transparent: true, opacity: 0.4 }));
    rays.frustumCulled = false; this.scene.add(rays);
    for (let i = 0; i < 13; i++) {
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.015, 20), material('#198d70'));
      marker.visible = false; this.markers.push(marker); this.scene.add(marker);
    }
    this.nearestHalo = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.072, 40), new THREE.MeshBasicMaterial({ color: '#159577', side: THREE.DoubleSide }));
    this.nearestHalo.rotation.x = -Math.PI / 2; this.nearestHalo.visible = false; this.scene.add(this.nearestHalo);
    const beamGeo = new THREE.BufferGeometry(); beamGeo.setAttribute('position', new THREE.BufferAttribute(this.beamPositions, 3));
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: '#209977', transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }));
    this.beam.frustumCulled = false; this.scene.add(this.beam);
    const waveGeo = new THREE.BufferGeometry(); waveGeo.setAttribute('position', new THREE.BufferAttribute(this.wavePositions, 3));
    this.wave = new THREE.Line(waveGeo, new THREE.LineBasicMaterial({ color: '#e3a04e', transparent: true, opacity: 0.95 }));
    this.wave.frustumCulled = false; this.wave.visible = false; this.scene.add(this.wave);
    new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }).observe(container);
  }

  private buildDevice(): void {
    const steel = material('#bfcbd0', 0.78, 0.26);
    const darkSteel = material('#435561', 0.5, 0.45);
    const blue = material('#397e99', 0.28, 0.32);
    const pcb = material('#246f7e', 0.18, 0.4);
    const black = material('#263b43', 0.15, 0.58);
    const white = material('#eef1e8', 0.2, 0.35);
    const brass = material('#c5a567', 0.65, 0.32);
    const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number]) => {
      const m = new THREE.Mesh(geometry, mat); m.position.set(...pos); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
    };
    const base = new THREE.Group();
    add(base, new THREE.CylinderGeometry(0.37, 0.39, 0.065, 64), white, [0, 0.035, 0]);
    add(base, new THREE.CylinderGeometry(0.29, 0.31, 0.025, 64), steel, [0, 0.08, 0]);
    add(base, new THREE.BoxGeometry(0.4, 0.3, 0.29), blue, [0, 0.245, 0]);
    add(base, new THREE.BoxGeometry(0.53, 0.045, 0.3), blue, [0, 0.15, 0]);
    add(base, new THREE.BoxGeometry(0.4, 0.055, 0.29), darkSteel, [0, 0.4, 0]);
    add(base, new THREE.CylinderGeometry(0.12, 0.12, 0.035, 40), black, [0, 0.445, 0]);
    for (const x of [-0.23, 0.23]) {
      for (const z of [-0.095, 0.095]) add(base, new THREE.CylinderGeometry(0.021, 0.021, 0.012, 16), steel, [x, 0.182, z]);
    }
    // Three short wire runs leave the fixed servo housing.
    ['#d29b65', '#963f43', '#414644'].forEach((color, i) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.2, 0.22 + i * 0.025, -0.02),
        new THREE.Vector3(0.38, 0.12, -0.08 - i * 0.02),
        new THREE.Vector3(0.48, 0.025, -0.27 - i * 0.015),
        new THREE.Vector3(0.63, 0.02, -0.31 - i * 0.015),
      ]);
      add(base, new THREE.TubeGeometry(curve, 18, 0.008, 6, false), material(color), [0, 0, 0]);
    });
    base.scale.setScalar(1.35);
    this.scene.add(base);
    this.head.position.y = 0.47;
    add(this.head, new THREE.CylinderGeometry(0.16, 0.16, 0.025, 48), white, [0, 0, 0]);
    add(this.head, new THREE.BoxGeometry(0.07, 0.18, 0.07), darkSteel, [0, 0.095, 0]);
    add(this.head, new THREE.BoxGeometry(0.59, 0.27, 0.035), pcb, [0, 0.255, 0]);
    for (const x of [-0.26, 0.26]) for (const y of [0.155, 0.355]) {
      const screw = add(this.head, new THREE.CylinderGeometry(0.014, 0.014, 0.047, 12), brass, [x, y, 0]);
      screw.rotation.x = Math.PI / 2;
    }
    for (const x of [-0.145, 0.145]) {
      const cylinder = add(this.head, new THREE.CylinderGeometry(0.108, 0.108, 0.13, 64), steel, [x, 0.255, 0.078]);
      cylinder.rotation.x = Math.PI / 2;
      const face = add(this.head, new THREE.CylinderGeometry(0.094, 0.094, 0.006, 48), darkSteel, [x, 0.255, 0.147]);
      face.rotation.x = Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.008, 10, 48), steel); ring.position.set(x, 0.255, 0.15); this.head.add(ring);
      for (let row = -3; row <= 3; row++) for (let col = -3; col <= 3; col++) {
        if (row * row + col * col > 11) continue;
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 7), black);
        dot.position.set(x + col * 0.023, 0.255 + row * 0.023, 0.152); this.head.add(dot);
      }
    }
    for (let i = 0; i < 4; i++) add(this.head, new THREE.BoxGeometry(0.014, 0.065, 0.014), brass, [-0.06 + i * 0.04, 0.1, -0.025]);
    this.head.scale.setScalar(1.35); this.head.position.y *= 1.35;
    this.scene.add(this.head);
  }

  resetCamera(): void {
    this.camera.position.set(2.9, 2.8, 4.3);
    this.controls.target.set(0, 0.18, 0.9); this.controls.update();
  }
  setPreset(preset: Preset, show: boolean): void {
    for (const child of [...this.obstacles.children]) {
      this.obstacles.remove(child);
      child.traverse(node => {
        if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
          node.geometry.dispose();
          (node.material as THREE.Material).dispose();
        }
      });
    }
    if (!show) return;
    PRESETS[preset].forEach(o => {
      const geo = o.kind === 'box' ? new THREE.BoxGeometry(o.width, o.height, o.depth) : new THREE.CylinderGeometry(o.radius, o.radius, o.height, 64);
      const mesh = new THREE.Mesh(geo, material(o.kind === 'box' ? '#cbbca5' : '#80a99c', 0.05, 0.52));
      mesh.position.set(o.x, o.height / 2, o.z); mesh.castShadow = true; mesh.receiveShadow = true; this.obstacles.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ color: o.kind === 'box' ? '#b6a589' : '#739b8e', transparent: true, opacity: 0.5 }));
      mesh.add(edges);
    });
  }
  setMeasurement(s: Sample | null, trail: Sample[]): void {
    this.measurement = s;
    if (s) this.targetAngle = s.angle;
    this.rayPositions.fill(0);
    this.markers.forEach(m => m.visible = false);
    trail.forEach((p, i) => {
      const a = p.angle * Math.PI / 180, d = (p.distanceMm ?? RANGE_MM) / 1000;
      this.rayPositions.set([0, 0.017, 0, Math.cos(a) * d, 0.017, Math.sin(a) * d], i * 6);
      if (p.distanceMm !== null) {
        this.markers[i].visible = true;
        this.markers[i].position.set(Math.cos(a) * d, 0.025, Math.sin(a) * d);
      }
    });
    this.rayGeometry.attributes.position.needsUpdate = true; this.rayGeometry.setDrawRange(0, trail.length * 2);
    this.nearestHalo.visible = s?.distanceMm != null;
    if (s?.distanceMm != null) {
      const a = s.angle * Math.PI / 180;
      this.nearestHalo.position.set(Math.cos(a) * s.distanceMm / 1000, 0.035, Math.sin(a) * s.distanceMm / 1000);
    }
  }
  setAngle(angle: number, immediate = false): void {
    this.targetAngle = angle;
    if (immediate) this.currentAngle = angle;
  }
  render(dt: number, paused: boolean, wave: { stage: number; progress: number; sample: Sample } | null): void {
    if (!paused) this.currentAngle += (this.targetAngle - this.currentAngle) * Math.min(1, dt / 42);
    this.head.rotation.y = (90 - this.currentAngle) * Math.PI / 180;
    const a = this.currentAngle * Math.PI / 180;
    const dist = ((this.measurement?.distanceMm) ?? RANGE_MM) / 1000;
    this.beamPositions.set([0, 0.009, 0, Math.cos(a - 0.065) * dist, 0.009, Math.sin(a - 0.065) * dist,
      Math.cos(a + 0.065) * dist, 0.009, Math.sin(a + 0.065) * dist]);
    this.beam.geometry.attributes.position.needsUpdate = true;
    this.wave.visible = wave !== null && (wave.stage === 1 || wave.stage === 2);
    if (this.wave.visible && wave) {
      const reach = (wave.sample.distanceMm ?? RANGE_MM) / 1000;
      const radius = Math.max(0.03, reach * (wave.stage === 2 ? wave.sample.status === 'OK' ? 1 - wave.progress : 1 : wave.progress));
      const angle = wave.sample.angle * Math.PI / 180;
      for (let i = 0; i <= 32; i++) {
        const t = angle - 0.2 + i / 32 * 0.4;
        this.wavePositions.set([Math.cos(t) * radius, 0.05, Math.sin(t) * radius], i * 3);
      }
      this.wave.geometry.attributes.position.needsUpdate = true;
      (this.wave.material as THREE.LineBasicMaterial).color.set(wave.stage === 2 && wave.sample.status === 'OK' ? '#259b80' : '#e0a044');
    }
    this.renderer.render(this.scene, this.camera);
  }
}
