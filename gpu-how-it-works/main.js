import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const STEPS = [
  {
    id: "input",
    title: "Input Data",
    kicker: "Step 1 · Arrival",
    body: "A program on the CPU sends work to the GPU. Batches of numbers land in VRAM first — video memory that sits close to thousands of tiny cores.",
    points: [
      "CPU issues a kernel / draw call",
      "Payload streams across the bus into VRAM",
      "Memory controller fans data out to cores",
    ],
    focus: { name: "VRAM", desc: "High-bandwidth memory feeding the shader cores." },
    meters: { bandwidth: 78, cores: 18, efficiency: 54 },
    camera: { x: 7.4, y: 5.8, z: 8.2 },
    target: { x: -1.2, y: 0.4, z: 0.2 },
    labels: ["VRAM", "Memory Controller"],
    threads: 8,
    phase: "input",
  },
  {
    id: "idea",
    title: "The Core Idea",
    kicker: "Step 2 · Parallelism",
    body: "A CPU is a few strong workers. A GPU is a stadium of simpler workers. Same instruction, many pieces of data — that is the trade that makes graphics and AI fast.",
    points: [
      "Serial thinking becomes massively parallel",
      "Latency hiding via huge thread counts",
      "Throughput over single-thread speed",
    ],
    focus: { name: "Shader Cores", desc: "Thousands of lightweight ALUs marching in lockstep." },
    meters: { bandwidth: 55, cores: 64, efficiency: 72 },
    camera: { x: 0.4, y: 8.6, z: 7.4 },
    target: { x: 0.2, y: 0.6, z: -0.4 },
    labels: ["SIMD Unit", "ALU"],
    threads: 24,
    phase: "idea",
  },
  {
    id: "simd",
    title: "SIMD Press",
    kicker: "Step 3 · Same op, many values",
    body: "Single Instruction, Multiple Data. One instruction stamp comes down — and every lane under the press transforms its own number at the same instant.",
    points: [
      "One opcode broadcast to a warp / wavefront",
      "Each lane owns a different element",
      "Divergence hurts; coherent work flies",
    ],
    focus: { name: "SIMD Unit", desc: "A mechanical metaphor for lockstep vector execution." },
    meters: { bandwidth: 48, cores: 92, efficiency: 88 },
    camera: { x: 4.8, y: 4.2, z: 5.1 },
    target: { x: 1.1, y: 1.1, z: -0.8 },
    labels: ["SIMD Unit", "INSTRUCTION"],
    threads: 48,
    phase: "simd",
  },
  {
    id: "pipeline",
    title: "The Pipeline",
    kicker: "Step 4 · Stages",
    body: "Work slides through stations: fetch, decode, execute, write-back. While one batch is pressed, the next is already lining up — keeping silicon busy.",
    points: [
      "Input assembly → shader stages → ROP / write",
      "Overlapped batches hide memory wait time",
      "Depth and color resolve at the end of the line",
    ],
    focus: { name: "Pipeline", desc: "Conveyor stages that keep the machine saturated." },
    meters: { bandwidth: 67, cores: 81, efficiency: 79 },
    camera: { x: -5.6, y: 5.2, z: 6.8 },
    target: { x: -0.4, y: 0.5, z: 1.4 },
    labels: ["Pipeline", "Memory Controller"],
    threads: 36,
    phase: "pipeline",
  },
  {
    id: "alu",
    title: "ALU & Instruction",
    kicker: "Step 5 · The math",
    body: "The instruction block holds the opcode. ALUs do the arithmetic — add, multiply, fused multiply-add — millions of times per millisecond.",
    points: [
      "FMA is the workhorse of modern GPUs",
      "Special function units handle sin / rsqrt / etc.",
      "Results spill back toward registers or VRAM",
    ],
    focus: { name: "ALU", desc: "Arithmetic Logic Units that crunch each lane’s value." },
    meters: { bandwidth: 41, cores: 96, efficiency: 91 },
    camera: { x: 2.2, y: 3.6, z: 4.4 },
    target: { x: 1.5, y: 1.0, z: -1.5 },
    labels: ["ALU", "INSTRUCTION"],
    threads: 56,
    phase: "alu",
  },
  {
    id: "threads",
    title: "Thread Execution",
    kicker: "Step 6 · Occupancy",
    body: "Warps fill the board. When one group stalls on memory, another is ready. Occupancy is how full you keep that grid without starving registers.",
    points: [
      "Scheduler swaps ready warps instantly",
      "More threads can hide latency — until registers run out",
      "The grid on the right mirrors live lane activity",
    ],
    focus: { name: "Thread Grid", desc: "A live map of which lanes are executing right now." },
    meters: { bandwidth: 73, cores: 100, efficiency: 84 },
    camera: { x: 0.2, y: 9.5, z: 0.1 },
    target: { x: 0.2, y: 0.2, z: -0.2 },
    labels: ["SIMD Unit", "VRAM"],
    threads: 64,
    phase: "threads",
  },
  {
    id: "together",
    title: "All Together",
    kicker: "Step 7 · The machine",
    body: "VRAM feeds the controller, the press stamps SIMD work, the pipeline keeps stages overlapping, and results stream out. That is a GPU, in one looping breath.",
    points: [
      "Bandwidth + parallelism + occupancy",
      "Graphics, compute, and AI share this pattern",
      "Orbit freely — the story keeps playing",
    ],
    focus: { name: "Full GPU", desc: "Memory, control, SIMD, and pipeline in sync." },
    meters: { bandwidth: 88, cores: 94, efficiency: 90 },
    camera: { x: 8.5, y: 6.4, z: 9.2 },
    target: { x: 0, y: 0.8, z: 0 },
    labels: ["VRAM", "SIMD Unit", "Pipeline", "Memory Controller"],
    threads: 60,
    phase: "together",
  },
];

const state = {
  step: 0,
  playing: true,
  speed: 1,
  autoOrbit: true,
  t: 0,
  stepT: 0,
  data: [],
  pistons: [],
  packets: [],
  vram: [],
  labels: {},
  highlight: null,
};

const els = {
  chip: document.getElementById("stepChip"),
  title: document.getElementById("lessonTitle"),
  kicker: document.getElementById("lessonKicker"),
  body: document.getElementById("lessonBody"),
  points: document.getElementById("lessonPoints"),
  focusName: document.getElementById("focusName"),
  focusDesc: document.getElementById("focusDesc"),
  prev: document.getElementById("prevBtn"),
  next: document.getElementById("nextBtn"),
  play: document.getElementById("playBtn"),
  rewind: document.getElementById("rewindBtn"),
  speed: document.getElementById("speedBtn"),
  timeline: document.getElementById("timeline"),
  timelineFill: document.getElementById("timelineFill"),
  transportStep: document.getElementById("transportStep"),
  threadGrid: document.getElementById("threadGrid"),
  meterBandwidth: document.getElementById("meterBandwidth"),
  meterCores: document.getElementById("meterCores"),
  meterEfficiency: document.getElementById("meterEfficiency"),
  meterBandwidthVal: document.getElementById("meterBandwidthVal"),
  meterCoresVal: document.getElementById("meterCoresVal"),
  meterEfficiencyVal: document.getElementById("meterEfficiencyVal"),
  autoOrbit: document.getElementById("autoOrbitBtn"),
  fullscreen: document.getElementById("fullscreenBtn"),
  hud: document.getElementById("hudLabels"),
  lesson: document.getElementById("lessonPanel"),
};

const canvas = document.getElementById("gpu-canvas");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c0e);
scene.fog = new THREE.Fog(0x0b0c0e, 18, 42);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(7.4, 5.8, 8.2);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 3.5;
controls.maxDistance = 18;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(-1.2, 0.4, 0.2);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.68, 0.42, 0.72);
composer.addPass(bloom);

const matMetal = new THREE.MeshStandardMaterial({
  color: 0x8d949e,
  metalness: 0.72,
  roughness: 0.38,
});
const matDark = new THREE.MeshStandardMaterial({
  color: 0x1c1f24,
  metalness: 0.45,
  roughness: 0.55,
});
const matBase = new THREE.MeshStandardMaterial({
  color: 0x2a2e35,
  metalness: 0.35,
  roughness: 0.7,
});
const matAccent = new THREE.MeshStandardMaterial({
  color: 0xff8a1f,
  emissive: 0xff6a00,
  emissiveIntensity: 0.85,
  metalness: 0.2,
  roughness: 0.35,
});
const matGlow = new THREE.MeshStandardMaterial({
  color: 0xffc14d,
  emissive: 0xff8a1f,
  emissiveIntensity: 1.35,
  metalness: 0.1,
  roughness: 0.25,
});
const matLabelBlock = new THREE.MeshStandardMaterial({
  color: 0x3a404a,
  metalness: 0.5,
  roughness: 0.45,
});

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(rTop, rBot, h, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, 20), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const root = new THREE.Group();
scene.add(root);

// Lights
const hemi = new THREE.HemisphereLight(0xffe6c8, 0x141210, 0.48);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xfff0d8, 1.45);
key.position.set(6, 12, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.camera.left = -12;
key.shadow.camera.right = 12;
key.shadow.camera.top = 12;
key.shadow.camera.bottom = -12;
scene.add(key);
const fill = new THREE.DirectionalLight(0xc4b49a, 0.28);
fill.position.set(-8, 4, -4);
scene.add(fill);
const accentLight = new THREE.PointLight(0xff8a1f, 22, 16, 2);
accentLight.position.set(1.2, 3.2, -0.6);
scene.add(accentLight);

// Platform
const platform = box(16, 0.35, 10, matBase, 0, -0.175, 0);
root.add(platform);
const platformLip = box(16.3, 0.12, 10.3, matMetal, 0, -0.4, 0);
root.add(platformLip);

const gridHelper = new THREE.GridHelper(16, 32, 0x3a414c, 0x232830);
gridHelper.position.y = 0.01;
gridHelper.material.transparent = true;
gridHelper.material.opacity = 0.35;
root.add(gridHelper);

// VRAM bank
const vramGroup = new THREE.Group();
vramGroup.position.set(-5.2, 0, -1.4);
root.add(vramGroup);
for (let i = 0; i < 8; i++) {
  const chip = new THREE.Group();
  const body = box(0.85, 0.28, 1.5, matDark, 0, 0.14, 0);
  const rim = box(0.9, 0.05, 1.55, matAccent.clone(), 0, 0.3, 0);
  rim.material.emissiveIntensity = 0.15;
  chip.add(body, rim);
  for (let p = 0; p < 6; p++) {
    chip.add(box(0.06, 0.08, 0.08, matMetal, -0.32 + p * 0.13, 0.04, 0.82));
    chip.add(box(0.06, 0.08, 0.08, matMetal, -0.32 + p * 0.13, 0.04, -0.82));
  }
  chip.position.set((i % 4) * 1.05, 0, Math.floor(i / 4) * 1.9);
  vramGroup.add(chip);
  state.vram.push(rim);
}
state.labels.VRAM = new THREE.Vector3(-4.0, 0.9, -1.4);

// Memory controller
const memCtrl = new THREE.Group();
memCtrl.position.set(-1.4, 0, -1.2);
root.add(memCtrl);
memCtrl.add(box(2.2, 0.45, 2.0, matLabelBlock, 0, 0.225, 0));
memCtrl.add(box(1.6, 0.2, 1.4, matMetal, 0, 0.5, 0));
memCtrl.add(box(0.35, 0.12, 0.35, matGlow, -0.5, 0.62, 0.35));
memCtrl.add(box(0.35, 0.12, 0.35, matGlow, 0.5, 0.62, -0.25));
state.labels["Memory Controller"] = new THREE.Vector3(-1.4, 1.3, -1.2);

// Bus traces from VRAM to controller
const traces = new THREE.Group();
root.add(traces);
for (let i = 0; i < 5; i++) {
  const trace = box(2.6, 0.03, 0.08, matAccent.clone(), -3.3, 0.04, -2.0 + i * 0.35);
  trace.material.emissiveIntensity = 0.25 + i * 0.05;
  traces.add(trace);
}

// Instruction + ALU blocks
const instr = new THREE.Group();
instr.position.set(2.4, 0, -2.4);
root.add(instr);
instr.add(box(2.0, 0.55, 1.1, matLabelBlock, 0, 0.275, 0));
instr.add(box(1.7, 0.12, 0.8, matAccent, 0, 0.6, 0));
state.labels.INSTRUCTION = new THREE.Vector3(2.4, 1.2, -2.4);

const alu = new THREE.Group();
alu.position.set(4.4, 0, -2.2);
root.add(alu);
alu.add(box(1.6, 0.7, 1.4, matMetal, 0, 0.35, 0));
for (let i = 0; i < 4; i++) {
  alu.add(box(0.28, 0.18, 0.28, matGlow, -0.45 + (i % 2) * 0.55, 0.78, -0.3 + Math.floor(i / 2) * 0.55));
}
state.labels.ALU = new THREE.Vector3(4.4, 1.35, -2.2);

// SIMD press gantry
const simd = new THREE.Group();
simd.position.set(1.2, 0, 0.6);
root.add(simd);
simd.add(box(5.2, 0.22, 0.55, matMetal, 0, 2.55, 0));
simd.add(box(0.35, 2.4, 0.35, matMetal, -2.3, 1.2, 0));
simd.add(box(0.35, 2.4, 0.35, matMetal, 2.3, 1.2, 0));
simd.add(box(5.4, 0.18, 2.4, matDark, 0, 0.09, 0));

for (let i = 0; i < 6; i++) {
  const x = -1.9 + i * 0.76;
  const pillar = cyl(0.12, 0.14, 1.4, matMetal, x, 1.85, 0);
  const piston = cyl(0.16, 0.18, 0.7, matLabelBlock, x, 1.15, 0);
  const head = box(0.42, 0.16, 0.55, matAccent, x, 0.72, 0);
  const spring = cyl(0.08, 0.08, 0.55, matGlow, x, 1.55, 0);
  simd.add(pillar, piston, head, spring);
  state.pistons.push({ piston, head, spring, baseY: 1.15, headY: 0.72, phase: i * 0.45 });
}
state.labels["SIMD Unit"] = new THREE.Vector3(1.2, 3.0, 0.6);

// Data blocks under the press (instanced-ish group)
const dataGroup = new THREE.Group();
simd.add(dataGroup);
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 10; col++) {
    const cell = box(0.28, 0.22, 0.28, matGlow.clone(), -1.9 + col * 0.42, 0.28, -0.55 + row * 0.5);
    cell.material.emissiveIntensity = 0.4;
    dataGroup.add(cell);
    state.data.push({ mesh: cell, row, col, baseY: 0.28 });
  }
}

// Pipeline conveyor
const pipeline = new THREE.Group();
pipeline.position.set(-0.6, 0, 2.6);
root.add(pipeline);
pipeline.add(box(8.5, 0.18, 1.3, matDark, 0, 0.09, 0));
const stageNames = ["IA", "VS", "RS", "PS", "ROP"];
stageNames.forEach((name, i) => {
  const x = -3.2 + i * 1.6;
  pipeline.add(box(1.1, 0.55, 1.0, matLabelBlock, x, 0.45, 0));
  pipeline.add(box(0.85, 0.1, 0.75, i % 2 ? matAccent : matGlow, x, 0.78, 0));
});
state.labels.Pipeline = new THREE.Vector3(-0.6, 1.3, 2.6);

// Moving packets on pipeline
for (let i = 0; i < 10; i++) {
  const pkt = box(0.22, 0.22, 0.22, matGlow.clone(), -4 + i * 0.85, 1.05, 2.6);
  pkt.material.emissiveIntensity = 1.1;
  root.add(pkt);
  state.packets.push({ mesh: pkt, offset: i * 0.85, lane: (i % 3) - 1 });
}

// Floating particles for data flow
const particleGeo = new THREE.SphereGeometry(0.06, 10, 10);
const particles = [];
for (let i = 0; i < 40; i++) {
  const p = new THREE.Mesh(particleGeo, matAccent.clone());
  p.material.emissiveIntensity = 1.2;
  p.position.set(-5 + Math.random() * 10, 0.4 + Math.random() * 2, -3 + Math.random() * 6);
  root.add(p);
  particles.push({
    mesh: p,
    speed: 0.4 + Math.random() * 0.8,
    phase: Math.random() * Math.PI * 2,
    path: Math.floor(Math.random() * 3),
  });
}

// Thread grid UI
const THREAD_COUNT = 64;
for (let i = 0; i < THREAD_COUNT; i++) {
  const cell = document.createElement("div");
  cell.className = "thread-cell";
  els.threadGrid.appendChild(cell);
}
const threadCells = [...els.threadGrid.children];

// HUD labels
const hudNodes = {};
Object.keys(state.labels).forEach((name) => {
  const el = document.createElement("div");
  el.className = "hud-label";
  el.textContent = name;
  els.hud.appendChild(el);
  hudNodes[name] = el;
});

const camFrom = new THREE.Vector3();
const camTo = new THREE.Vector3();
const targetFrom = new THREE.Vector3();
const targetTo = new THREE.Vector3();
let camBlend = 1;

function applyStep(index, animateCamera = true) {
  state.step = (index + STEPS.length) % STEPS.length;
  state.stepT = 0;
  const step = STEPS[state.step];

  els.chip.textContent = `Step ${state.step + 1} / ${STEPS.length}`;
  els.kicker.textContent = step.kicker;
  els.title.textContent = step.title;
  els.body.textContent = step.body;
  els.points.innerHTML = step.points.map((p) => `<li>${p}</li>`).join("");
  els.focusName.textContent = step.focus.name;
  els.focusDesc.textContent = step.focus.desc;
  els.transportStep.textContent = `${String(state.step + 1).padStart(2, "0")} — ${step.title}`;
  els.prev.disabled = state.step === 0;
  els.next.textContent = state.step === STEPS.length - 1 ? "Replay" : "Next";

  setMeters(step.meters);
  updateThreadGrid(step.threads, true);

  Object.entries(hudNodes).forEach(([name, el]) => {
    el.classList.toggle("visible", step.labels.includes(name));
  });

  els.lesson.style.animation = "none";
  void els.lesson.offsetWidth;
  els.lesson.style.animation = "rise-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both";

  if (animateCamera) {
    camFrom.copy(camera.position);
    targetFrom.copy(controls.target);
    camTo.set(step.camera.x, step.camera.y, step.camera.z);
    targetTo.set(step.target.x, step.target.y, step.target.z);
    camBlend = 0;
  }
}

function setMeters({ bandwidth, cores, efficiency }) {
  els.meterBandwidth.style.width = `${bandwidth}%`;
  els.meterCores.style.width = `${cores}%`;
  els.meterEfficiency.style.width = `${efficiency}%`;
  els.meterBandwidthVal.textContent = `${bandwidth}%`;
  els.meterCoresVal.textContent = `${cores}%`;
  els.meterEfficiencyVal.textContent = `${efficiency}%`;
}

function updateThreadGrid(activeCount, scramble = false) {
  const order = [...threadCells.keys()];
  if (scramble) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  threadCells.forEach((cell, i) => {
    const on = order.indexOf(i) < activeCount;
    cell.classList.toggle("on", on);
  });
}

function projectLabels() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  Object.entries(state.labels).forEach(([name, world]) => {
    const el = hudNodes[name];
    if (!el.classList.contains("visible")) return;
    const v = world.clone().project(camera);
    const x = (v.x * 0.5 + 0.5) * width;
    const y = (-v.y * 0.5 + 0.5) * height;
    const behind = v.z > 1;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.opacity = behind ? "0" : "";
  });
}

function animateScene(dt) {
  const step = STEPS[state.step];
  const t = state.t;
  const phase = step.phase;

  // Pistons
  state.pistons.forEach((p, i) => {
    const pulse =
      phase === "simd" || phase === "together" || phase === "threads"
        ? (Math.sin(t * 3.2 * state.speed + p.phase) + 1) * 0.5
        : phase === "alu"
          ? (Math.sin(t * 2.2 * state.speed + i) + 1) * 0.25
          : 0.15;
    const drop = pulse * 0.55;
    p.piston.position.y = p.baseY - drop;
    p.head.position.y = p.headY - drop;
    p.spring.scale.y = 1 - drop * 0.7;
  });

  // Data bricks under press
  state.data.forEach((d, i) => {
    const active = phase === "simd" || phase === "idea" || phase === "together" || phase === "threads";
    const wave = Math.sin(t * 2.8 * state.speed + d.col * 0.35 + d.row) * 0.5 + 0.5;
    d.mesh.position.y = d.baseY + (active ? wave * 0.12 : 0);
    d.mesh.material.emissiveIntensity = active ? 0.55 + wave * 0.9 : 0.25;
    d.mesh.visible = !(phase === "input" && d.row > 0);
  });

  // VRAM glow
  state.vram.forEach((rim, i) => {
    const on =
      phase === "input" || phase === "together" || phase === "pipeline"
        ? (Math.sin(t * 2.5 * state.speed + i * 0.7) + 1) * 0.5
        : phase === "threads"
          ? 0.7
          : 0.2;
    rim.material.emissiveIntensity = 0.15 + on * 1.1;
  });

  // Pipeline packets
  state.packets.forEach((pkt) => {
    const span = 8.2;
    let x = ((-4 + pkt.offset + t * 1.35 * state.speed) % span) - 4;
    if (x < -4) x += span;
    pkt.mesh.position.x = x;
    pkt.mesh.position.z = 2.6 + pkt.lane * 0.22;
    pkt.mesh.position.y = 1.05 + Math.sin(t * 4 + pkt.offset) * 0.05;
    pkt.mesh.visible = phase === "pipeline" || phase === "together" || phase === "input";
    pkt.mesh.material.emissiveIntensity =
      phase === "pipeline" || phase === "together" ? 1.35 : 0.45;
  });

  // Floating particles along paths
  particles.forEach((p) => {
    const u = (t * p.speed * state.speed + p.phase) % (Math.PI * 2);
    if (p.path === 0) {
      // VRAM → controller
      p.mesh.position.set(-5.2 + ((u / (Math.PI * 2)) * 4.2), 0.55 + Math.sin(u * 2) * 0.15, -1.6 + Math.sin(u) * 0.4);
    } else if (p.path === 1) {
      // controller → SIMD
      p.mesh.position.set(-1.2 + ((u / (Math.PI * 2)) * 2.8), 0.7 + Math.sin(u * 3) * 0.2, -0.8 + ((u / (Math.PI * 2)) * 1.4));
    } else {
      // SIMD → pipeline
      p.mesh.position.set(1.0 - ((u / (Math.PI * 2)) * 1.5), 0.85 + Math.sin(u) * 0.25, 0.8 + ((u / (Math.PI * 2)) * 1.8));
    }
    const show =
      phase === "together" ||
      phase === "input" ||
      (phase === "pipeline" && p.path !== 1) ||
      (phase === "simd" && p.path === 1) ||
      phase === "idea";
    p.mesh.visible = show;
  });

  accentLight.intensity = 12 + Math.sin(t * 2.2) * 4;

  // Flicker thread grid gently while playing
  if (state.playing && Math.floor(t * 8) !== Math.floor((t - dt) * 8)) {
    const base = step.threads;
    const jitter = Math.max(4, base - 8 + Math.floor(Math.random() * 12));
    updateThreadGrid(Math.min(THREAD_COUNT, jitter));
  }
}

function easeInOut(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

const clock = new THREE.Clock();

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.playing) {
    state.t += dt;
    state.stepT += dt * state.speed;
  }

  if (camBlend < 1) {
    camBlend = Math.min(1, camBlend + dt * 1.15);
    const e = easeInOut(camBlend);
    camera.position.lerpVectors(camFrom, camTo, e);
    controls.target.lerpVectors(targetFrom, targetTo, e);
  } else if (state.autoOrbit && state.playing) {
    const step = STEPS[state.step];
    const radius = camera.position.distanceTo(controls.target);
    const angle = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) + dt * 0.12 * state.speed;
    camera.position.x = controls.target.x + Math.sin(angle) * radius;
    camera.position.z = controls.target.z + Math.cos(angle) * radius;
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, step.camera.y, 0.02);
  }

  // Auto-advance timeline within a step (visual only) then nudge next after long dwell
  const stepDuration = 12;
  const progress = (state.stepT % stepDuration) / stepDuration;
  els.timeline.value = String(Math.floor(progress * 1000));
  els.timelineFill.style.width = `${progress * 100}%`;
  if (state.playing && state.stepT > stepDuration) {
    state.stepT = 0;
    applyStep(state.step + 1);
  }

  animateScene(dt);
  controls.update();
  composer.render();
  projectLabels();
  requestAnimationFrame(frame);
}

// Events
els.prev.addEventListener("click", () => applyStep(state.step - 1));
els.next.addEventListener("click", () => applyStep(state.step === STEPS.length - 1 ? 0 : state.step + 1));
els.play.addEventListener("click", () => {
  state.playing = !state.playing;
  els.play.textContent = state.playing ? "❚❚" : "▶";
  els.play.setAttribute("aria-pressed", String(state.playing));
});
els.rewind.addEventListener("click", () => {
  state.stepT = 0;
  state.t = 0;
  applyStep(state.step, false);
});
els.speed.addEventListener("click", () => {
  const speeds = [1, 1.5, 2, 0.5];
  const idx = speeds.indexOf(state.speed);
  state.speed = speeds[(idx + 1) % speeds.length];
  els.speed.textContent = `${state.speed}×`.replace(".0", "");
});
els.timeline.addEventListener("input", () => {
  const v = Number(els.timeline.value) / 1000;
  state.stepT = v * 12;
  els.timelineFill.style.width = `${v * 100}%`;
});
els.autoOrbit.addEventListener("click", () => {
  state.autoOrbit = !state.autoOrbit;
  els.autoOrbit.setAttribute("aria-pressed", String(state.autoOrbit));
});
els.fullscreen.addEventListener("click", async () => {
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  else await document.exitFullscreen();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") applyStep(state.step + 1);
  if (e.key === "ArrowLeft") applyStep(state.step - 1);
  if (e.key === " ") {
    e.preventDefault();
    els.play.click();
  }
});

window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
});

applyStep(0, false);
frame();
