import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URL = './robot.glb';

// ====== Fixed groups per your request ======
const GROUPS = {
  leftArm: ['tripo_part_13', 'tripo_part_16'],
  rightArm: ['tripo_part_1', 'tripo_part_11'],
  head: ['tripo_part_7', 'tripo_part_5'],
};

const $ = (id) => document.getElementById(id);
const rad = (deg) => (deg * Math.PI) / 180;
const lerp = (a, b, t) => a + (b - a) * t;

function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

// ---------- THREE setup ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.setClearAlpha(0);

const scene = new THREE.Scene();

// Camera
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(2.0, 1.5, 3.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

// Lights
const keyLight = new THREE.DirectionalLight(0xffffff, 5.5);
keyLight.position.set(3.0, 4.0, 2.5);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 1.1);
fillLight.position.set(-3.0, 1.5, -2.0);
scene.add(fillLight);

const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.0);
scene.add(hemi);

const ambient = new THREE.AmbientLight(0xffffff, 1.35);
scene.add(ambient);

// Grey checkerboard floor
function makeCheckerTexture(size = 512, squares = 10) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  const s = size / squares;
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      const dark = (x + y) % 2 === 0;
      ctx.fillStyle = dark ? '#bfc4cc' : '#e7eaee';
      ctx.fillRect(x * s, y * s, s, s);
    }
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= squares; i++) {
    ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * s); ctx.lineTo(size, i * s); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), metalness: 0.0, roughness: 1.0 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

// ---------- Model state ----------
let modelRoot = null;
let modelGroup = new THREE.Group();
scene.add(modelGroup);

let meshes = [];
let meshByName = new Map();
const defaultRot = new Map(); // name -> Euler

const groupMeshes = { leftArm: [], rightArm: [], head: [] };
// 각 그룹별 X/Y/Z 회전 목표 (도 단위)
// Z: 슬라이더 제어 | X: 앞뒤 스윙 | Y: 좌우 회전
const groupTargets = {
  leftArm:  { x: 0, y: 0, z: 0 },
  rightArm: { x: 0, y: 0, z: 0 },
  head:     { x: 0, y: 0, z: 0 },
};

let edgesGroup = new THREE.Group();
edgesGroup.visible = false;
scene.add(edgesGroup);

let selectedMesh = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let autoRotate = false;
let baseCam = null;

// ---------- UI refs ----------
const ui = {
  exposure: $('exposure'),
  keyLight: $('keyLight'),
  ambient: $('ambient'),
  showParts: $('showParts'),
  selectedPart: $('selectedPart'),
  btnResetPose: $('btnResetPose'),
  btnResetView: $('btnResetView'),
  btnResetAll: $('btnResetAll'),
  btnAutoRotate: $('btnAutoRotate'),
  btnFront: $('btnFront'),
  btnSide: $('btnSide'),
  btnTop: $('btnTop'),
  sliders: { leftArm: $('leftArm'), rightArm: $('rightArm'), head: $('head') },
  vals: {
    exposure: $('exposureVal'),
    keyLight: $('keyLightVal'),
    ambient: $('ambientVal'),
    leftArm: $('leftArmVal'),
    rightArm: $('rightArmVal'),
    head: $('headVal'),
  }
};

function setVal(id, value, suffix='') { ui.vals[id].textContent = `${value}${suffix}`; }

// ============================================================================
// ✅ 1도씩 천천히 목표값까지 바꾸는 “슬라이더 애니메이션”
// ============================================================================
/**
 * mode: "step" => 1도씩 이동(요청대로)
 * fps: 이동 속도 제어 (60이면 빠름, 30이면 더 천천히)
 */
const sliderAnim = {
  // key: leftArm/rightArm/head
  running: { leftArm: false, rightArm: false, head: false },
  target: { leftArm: 0, rightArm: 0, head: 0 },
  fps: 60,
  lastTick: 0,
  stepDeg: 1,
};

function clampDeg(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function stopSliderAnim(key) {
  sliderAnim.running[key] = false;
}

function animateSliderTo(key, targetDeg, { stepDeg = 1, fps = 60 } = {}) {
  const slider = ui.sliders[key];
  if (!slider) return;

  sliderAnim.stepDeg = Math.max(1, Math.floor(stepDeg));
  sliderAnim.fps = Math.max(10, Math.min(120, Math.floor(fps)));

  const min = Number(slider.min);
  const max = Number(slider.max);
  const tgt = clampDeg(Math.round(targetDeg), min, max);

  sliderAnim.target[key] = tgt;
  sliderAnim.running[key] = true;

  // 즉시 UI에 “목표”를 보여주는 게 아니라, 현재값부터 1도씩 이동하면서 갱신
}

function tickSliderAnim(ts) {
  const interval = 1000 / sliderAnim.fps;
  if (ts - sliderAnim.lastTick < interval) return;
  sliderAnim.lastTick = ts;

  let changed = false;

  for (const key of Object.keys(sliderAnim.running)) {
    if (!sliderAnim.running[key]) continue;

    const slider = ui.sliders[key];
    const cur = Number(slider.value);
    const tgt = Number(sliderAnim.target[key]);

    if (cur === tgt) {
      sliderAnim.running[key] = false;
      continue;
    }

    const dir = cur < tgt ? 1 : -1;
    const next = cur + dir * sliderAnim.stepDeg;

    // overshoot 방지
    const finalVal = dir === 1 ? Math.min(next, tgt) : Math.max(next, tgt);

    slider.value = String(finalVal);

    // 표시값 갱신
    setVal(key, finalVal, '°');

    changed = true;
  }

  if (changed) {
    applyTargetsFromUI();
    save3DState();
  }
}

// ============================================================================

function save3DState() {
  const data = {
    angles: {
      leftArm: Number(ui.sliders.leftArm.value),
      rightArm: Number(ui.sliders.rightArm.value),
      head: Number(ui.sliders.head.value),
    },
    lighting: {
      exposure: Number(ui.exposure.value),
      keyLight: Number(ui.keyLight.value),
      ambient: Number(ui.ambient.value),
    }
  };
  localStorage.setItem('robot-dashboard-v6', JSON.stringify(data));
}

function load3DState() {
  try {
    const raw = localStorage.getItem('robot-dashboard-v6');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function applyLightingUI() {
  renderer.toneMappingExposure = Number(ui.exposure.value);
  keyLight.intensity = Number(ui.keyLight.value);
  ambient.intensity = Number(ui.ambient.value);

  setVal('exposure', Number(ui.exposure.value).toFixed(2));
  setVal('keyLight', Number(ui.keyLight.value).toFixed(1));
  setVal('ambient', Number(ui.ambient.value).toFixed(2));
}

function buildEdges() {
  edgesGroup.clear();
  for (const m of meshes) {
    const edges = new THREE.EdgesGeometry(m.geometry, 25);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })
    );
    line.userData._follow = m;
    edgesGroup.add(line);
  }
}

function syncEdges() {
  if (!edgesGroup.visible) return;
  edgesGroup.children.forEach(line => {
    const m = line.userData._follow;
    if (!m) return;
    line.position.copy(m.getWorldPosition(new THREE.Vector3()));
    line.quaternion.copy(m.getWorldQuaternion(new THREE.Quaternion()));
    line.scale.copy(m.getWorldScale(new THREE.Vector3()));
  });
}

function resetModelToDefaultRotation() {
  for (const m of meshes) {
    const e = defaultRot.get(m.name);
    if (!e) continue;
    m.rotation.set(e.x, e.y, e.z);
  }
}

function applyTargetsFromUI() {
  // 슬라이더는 Z축만 제어 (도 단위로 저장)
  groupTargets.leftArm.z  = Number(ui.sliders.leftArm.value);
  groupTargets.rightArm.z = Number(ui.sliders.rightArm.value);
  groupTargets.head.z     = Number(ui.sliders.head.value);
}

function resetPoseUI() {
  cancelMotion(); // X/Y 축도 함께 리셋
  animateSliderTo('leftArm',  0, { stepDeg: 1, fps: 60 });
  animateSliderTo('rightArm', 0, { stepDeg: 1, fps: 60 });
  animateSliderTo('head',     0, { stepDeg: 1, fps: 60 });
}

// ============================================================================
// Motion Library — 챗봇 명령에 반응하는 자연스러운 다축 시퀀스 동작
//
// 키프레임 형식: { t: ms, [group]: {x, y, z} }
//   - Z: 좌우 올리기/내리기 (슬라이더와 공유)
//   - X: 앞뒤 스윙 (+ = 앞으로)
//   - Y: 회전 (머리 좌우 돌리기 등)
//
// 왼팔 대칭 규칙: leftArm Z는 rightArm Z 반대 부호
//   (rightArm z:+55 = 오른팔 위  ↔  leftArm z:-55 = 왼팔 위)
// ============================================================================
const MOTIONS = {
  neutral: [
    { t: 0,
      leftArm:  { x: 0,  y: 0, z: 0  },
      rightArm: { x: 0,  y: 0, z: 0  },
      head:     { x: 0,  y: 0, z: 0  } },
  ],

  wave: [                                      // 오른팔 흔들기 + 왼팔 균형
    { t: 0,
      rightArm: { z: 28, x:  8 },
      leftArm:  { z: -5, x:  3 },
      head:     { z:  3 } },
    { t: 350,
      rightArm: { z: 55, x: 12 },
      head:     { z:  8 } },
    { t: 650,
      rightArm: { z: 40, x: 10 },
      leftArm:  { z: -8 } },
    { t: 950,
      rightArm: { z: 55, x: 12 } },
    { t: 1250,
      rightArm: { z: 40, x: 10 } },
    { t: 1550,
      rightArm: { z: 55, x: 12 } },
    { t: 1900,
      leftArm:  { x: 0,  y: 0, z: 0 },
      rightArm: { x: 0,  y: 0, z: 0 },
      head:     { x: 0,  y: 0, z: 0 } },
  ],

  greet: [                                     // 인사 (손 흔들고 X축으로 고개 숙임)
    { t: 0,
      rightArm: { z: 28, x:  8 },
      leftArm:  { z: -5, x:  3 },
      head:     { z:  3 } },
    { t: 400,
      rightArm: { z: 55, x: 12 },
      head:     { z:  8 } },
    { t: 700,  rightArm: { z: 42, x: 10 } },
    { t: 1000, rightArm: { z: 55, x: 12 } },
    { t: 1300, rightArm: { z: 42, x: 10 } },
    { t: 1700,
      head:     { z: 0, x: -22 } },           // X축: 고개 앞으로 숙임
    { t: 2200,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  think: [                                     // 생각 (팔 앞으로 + 머리 Y축 돌림)
    { t: 0,
      rightArm: { z: 18, x: 18 },
      head:     { z:  5 } },
    { t: 600,
      rightArm: { z: 30, x: 28 },
      head:     { z: 18, y: 8 } },
    { t: 1200, head: { z: 22, y: 10 } },
    { t: 1900, head: { z: 16, y:  6 } },
    { t: 2600, head: { z: 22, y: 10 } },
    { t: 3200,
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  point: [                                     // 가리키기 (팔 앞으로 뻗기 + 머리 Y)
    { t: 0,
      rightArm: { z: 12, x: 15 },
      head:     { z: -2, y: -5 } },
    { t: 400,
      rightArm: { z: 28, x: 28 },
      head:     { z: -5, y: -8 } },
    { t: 2000,
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  nod: [                                       // 고개 끄덕이기 (X축 = 실제 끄덕임)
    { t: 0,    head: { x:   0 } },
    { t: 280,  head: { x: -20 } },
    { t: 560,  head: { x:  -4 } },
    { t: 840,  head: { x: -20 } },
    { t: 1120, head: { x:  -4 } },
    { t: 1400, head: { x:   0 } },
  ],

  shake: [                                     // 고개 젓기 (Y축 = 실제 좌우 회전)
    { t: 0,    head: { y:   0 } },
    { t: 220,  head: { y: -22 } },
    { t: 440,  head: { y:  22 } },
    { t: 660,  head: { y: -22 } },
    { t: 880,  head: { y:  22 } },
    { t: 1100, head: { y:   0 } },
  ],

  shrug: [                                     // 어깨 으쓱 (양팔 X + Z + 머리 기울)
    { t: 0,
      leftArm:  { x: 0,  z:   0 },
      rightArm: { x: 0,  z:   0 },
      head:     { z:   0 } },
    { t: 400,
      leftArm:  { x: 10, z: -25 },
      rightArm: { x: 10, z:  25 },
      head:     { z:  15 } },
    { t: 1200, head: { z: 12 } },
    { t: 1700,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  cheer: [                                     // 환호/만세 (양팔 X 뒤로 + Z 위)
    { t: 0,
      leftArm:  { x:   0, z:   0 },
      rightArm: { x:   0, z:   0 },
      head:     { z:   0 } },
    { t: 300,
      leftArm:  { x:  -5, z: -42 },
      rightArm: { x:  -5, z:  42 },
      head:     { z:   8 } },
    { t: 600,
      leftArm:  { x: -10, z: -62 },
      rightArm: { x: -10, z:  62 },
      head:     { z:  15 } },
    { t: 1000,
      leftArm:  { z: -52 },
      rightArm: { z:  52 } },
    { t: 1400,
      leftArm:  { z: -62 },
      rightArm: { z:  62 } },
    { t: 1800,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  dance: [                                     // 춤추기 (양팔 X/Z 교차 + 머리 Y/Z)
    { t: 0,
      leftArm:  { x:   0, z:   0 },
      rightArm: { x:   0, z:   0 },
      head:     { z:   0, y:  0 } },
    { t: 250,
      leftArm:  { x:   8, z: -32 },
      rightArm: { x:  -5, z:  30 },
      head:     { z:  10, y:  5 } },
    { t: 500,
      leftArm:  { x:  -5, z:  25 },
      rightArm: { x:   8, z: -30 },
      head:     { z: -10, y: -5 } },
    { t: 750,
      leftArm:  { x:  10, z: -38 },
      rightArm: { x:  -8, z:  35 },
      head:     { z:  12, y:  8 } },
    { t: 1000,
      leftArm:  { x:  -8, z:  30 },
      rightArm: { x:  10, z: -35 },
      head:     { z: -12, y: -8 } },
    { t: 1250,
      leftArm:  { x:  12, z: -50 },
      rightArm: { x: -10, z:  50 },
      head:     { z:  15, y: 10 } },
    { t: 1500,
      leftArm:  { x: -10, z:  42 },
      rightArm: { x:  12, z: -42 },
      head:     { z: -15, y: -10 } },
    { t: 1750,
      leftArm:  { x:   8, z: -32 },
      rightArm: { x:  -5, z:  30 },
      head:     { z:   8, y:  5 } },
    { t: 2000,
      leftArm:  { x:  -5, z:  25 },
      rightArm: { x:   8, z: -28 },
      head:     { z:  -8, y: -5 } },
    { t: 2300,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  stretch: [                                   // 스트레칭 (양팔 뒤로 X + Z 위)
    { t: 0,
      leftArm:  { x:   0, z:   0 },
      rightArm: { x:   0, z:   0 },
      head:     { z:   0 } },
    { t: 700,
      leftArm:  { x:  -8, z: -48 },
      rightArm: { x:  -8, z:  48 },
      head:     { z:   8 } },
    { t: 1500,
      leftArm:  { x: -15, z: -68 },
      rightArm: { x: -15, z:  68 },
      head:     { z:  18 } },
    { t: 2500,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  bow: [                                       // 절 (머리 X로 앞으로 숙임)
    { t: 0,   head: { x:   0, z:  0 } },
    { t: 500, head: { x: -25, z: -5 } },
    { t: 1400, head: { x:  0, z:  0 } },
  ],

  clap: [                                      // 박수 (양팔 X 앞으로 + Z 교차)
    { t: 0,
      leftArm:  { x:  0,  z:   0 },
      rightArm: { x:  0,  z:   0 } },
    { t: 160,
      leftArm:  { x: 12,  z:  18 },
      rightArm: { x: 12,  z: -18 } },
    { t: 320,
      leftArm:  { x: 12,  z: -18 },
      rightArm: { x: 12,  z:  18 } },
    { t: 480,
      leftArm:  { x: 12,  z:  18 },
      rightArm: { x: 12,  z: -18 } },
    { t: 640,
      leftArm:  { x: 12,  z: -18 },
      rightArm: { x: 12,  z:  18 } },
    { t: 800,
      leftArm:  { x: 12,  z:  18 },
      rightArm: { x: 12,  z: -18 } },
    { t: 960,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 } },
  ],

  excited: [                                   // 신남 (양팔 뒤로 위로 빠르게)
    { t: 0,
      leftArm:  { x:   0, z:   0 },
      rightArm: { x:   0, z:   0 },
      head:     { z:   0 } },
    { t: 200,
      leftArm:  { x:  -5, z: -28 },
      rightArm: { x:  -5, z:  28 },
      head:     { z:   8 } },
    { t: 400,
      leftArm:  { x: -10, z: -48 },
      rightArm: { x: -10, z:  48 },
      head:     { z:  12 } },
    { t: 600,
      leftArm:  { x:  -5, z: -28 },
      rightArm: { x:  -5, z:  28 },
      head:     { z:   6 } },
    { t: 800,
      leftArm:  { x: -10, z: -48 },
      rightArm: { x: -10, z:  48 },
      head:     { z:  12 } },
    { t: 1050,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],

  sad: [                                       // 슬픔 (팔 앞으로 처지고 머리 숙임)
    { t: 0,
      leftArm:  { x:  0,  z:   0 },
      rightArm: { x:  0,  z:   0 },
      head:     { x:  0,  z:   0 } },
    { t: 700,
      leftArm:  { x:  5,  z:  12 },
      rightArm: { x:  5,  z: -12 },
      head:     { x: -10, z: -18 } },
    { t: 1600,
      leftArm:  { x: 0, y: 0, z: 0 },
      rightArm: { x: 0, y: 0, z: 0 },
      head:     { x: 0, y: 0, z: 0 } },
  ],
};

// 진행 중인 모션 타이머 관리
let motionTimers = [];

function cancelMotion() {
  for (const id of motionTimers) clearTimeout(id);
  motionTimers = [];
  // X/Y 축은 모션 전용 — 중단 시 중립으로 즉시 복귀
  for (const tgt of Object.values(groupTargets)) { tgt.x = 0; tgt.y = 0; }
  // Z 축은 슬라이더 현재값으로 복원
  applyTargetsFromUI();
}

function playMotion(name) {
  const frames = MOTIONS[name];
  if (!frames?.length) return;
  cancelMotion();
  for (const frame of frames) {
    const id = setTimeout(() => {
      for (const [key, val] of Object.entries(frame)) {
        if (key === 't') continue;
        const tgt = groupTargets[key];
        if (!tgt || typeof val !== 'object') continue;
        if (val.x !== undefined) tgt.x = val.x;
        if (val.y !== undefined) tgt.y = val.y;
        if (val.z !== undefined) tgt.z = val.z;
      }
    }, frame.t);
    motionTimers.push(id);
  }
}

function applyGesture(name) {
  const G = {
    neutral: { leftArm: 0, rightArm: 0, head: 0 },
    wave:    { leftArm: 0, rightArm: 55, head: 8 },
    point:   { leftArm: -10, rightArm: 35, head: -5 },
    think:   { leftArm: 0, rightArm: 0, head: 25 },
  };
  if (!G[name]) return;

  cancelMotion();
  animateSliderTo('leftArm', G[name].leftArm, { stepDeg: 1, fps: 60 });
  animateSliderTo('rightArm', G[name].rightArm, { stepDeg: 1, fps: 60 });
  animateSliderTo('head', G[name].head, { stepDeg: 1, fps: 60 });

  toast(`제스처 적용: ${name}`);
}

function resolveGroupMeshes() {
  groupMeshes.leftArm = [];
  groupMeshes.rightArm = [];
  groupMeshes.head = [];

  const missing = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const n of names) {
      const m = meshByName.get(n);
      if (m) groupMeshes[group].push(m);
      else missing.push(n);
    }
  }
  if (missing.length) toast(`주의: 일부 파트를 찾지 못했습니다: ${missing.join(', ')}`, 4200);
}

async function loadModel() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);

  modelRoot = gltf.scene;
  modelGroup.add(modelRoot);

  meshes = [];
  meshByName.clear();
  defaultRot.clear();

  modelRoot.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = false;
      obj.receiveShadow = false;
      if (!obj.name || obj.name.trim().length === 0) obj.name = `mesh_${meshes.length}`;
      meshes.push(obj);
      meshByName.set(obj.name, obj);
      defaultRot.set(obj.name, obj.rotation.clone());
    }
  });

  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  modelRoot.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const targetSize = 1.65;
  const scale = targetSize / maxDim;
  modelRoot.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(modelRoot);
  modelRoot.position.y -= box2.min.y;

  const size2 = new THREE.Vector3();
  box2.getSize(size2);
  const radius = Math.max(size2.x, size2.y, size2.z) * 0.7;

  camera.near = Math.max(0.01, radius / 200);
  camera.far = radius * 200;
  camera.updateProjectionMatrix();

  const dist = radius * 2.6;
  camera.position.set(dist * 0.9, dist * 0.65, dist * 1.1);
  controls.target.set(0, radius * 0.9, 0);
  controls.minDistance = radius * 0.6;
  controls.maxDistance = radius * 18;
  controls.update();

  baseCam = { pos: camera.position.clone(), target: controls.target.clone() };

  buildEdges();
  resolveGroupMeshes();

  const saved = load3DState();
  if (saved?.lighting) {
    ui.exposure.value = saved.lighting.exposure ?? ui.exposure.value;
    ui.keyLight.value = saved.lighting.keyLight ?? ui.keyLight.value;
    ui.ambient.value = saved.lighting.ambient ?? ui.ambient.value;
  }
  applyLightingUI();

  // ✅ 저장된 각도도 점프하지 않고 "천천히" 복원
  const savedLeft = saved?.angles?.leftArm ?? 0;
  const savedRight = saved?.angles?.rightArm ?? 0;
  const savedHead = saved?.angles?.head ?? 0;

  // 초기 표시값은 0으로 시작하고, 애니메이션으로 복원
  ui.sliders.leftArm.value = 0;
  ui.sliders.rightArm.value = 0;
  ui.sliders.head.value = 0;

  setVal('leftArm', 0, '°');
  setVal('rightArm', 0, '°');
  setVal('head', 0, '°');
  applyTargetsFromUI();

  animateSliderTo('leftArm', savedLeft, { stepDeg: 1, fps: 60 });
  animateSliderTo('rightArm', savedRight, { stepDeg: 1, fps: 60 });
  animateSliderTo('head', savedHead, { stepDeg: 1, fps: 60 });

  toast('모델 로딩 완료!');
}
loadModel().catch(err => { console.error(err); toast('모델 로딩 실패: 콘솔 확인', 4000); });

// Picking
function pickMesh(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(meshes, true);
  return hits[0]?.object ?? null;
}
canvas.addEventListener('pointerdown', (e) => {
  const hit = pickMesh(e.clientX, e.clientY);
  if (!hit) return;

  if (selectedMesh && selectedMesh.material && selectedMesh.material.emissive) {
    selectedMesh.material.emissive.setHex(0x000000);
  }
  selectedMesh = hit;
  ui.selectedPart.textContent = selectedMesh.name;

  if (selectedMesh.material && selectedMesh.material.emissive) {
    selectedMesh.material.emissive.setHex(0x1144ff);
  }
});

// UI wiring
function wireSlider(id) {
  const slider = ui.sliders[id];

  // 사용자가 직접 드래그하면 진행 중 모션 + 슬라이더 애니메이션 중단 (사용자 우선)
  slider.addEventListener('pointerdown', () => { cancelMotion(); stopSliderAnim(id); });
  slider.addEventListener('touchstart', () => { cancelMotion(); stopSliderAnim(id); }, { passive: true });

  slider.addEventListener('input', () => {
    setVal(id, slider.value, '°');
    applyTargetsFromUI();
    save3DState();
  });
}
wireSlider('leftArm');
wireSlider('rightArm');
wireSlider('head');

ui.exposure.addEventListener('input', () => { applyLightingUI(); save3DState(); });
ui.keyLight.addEventListener('input', () => { applyLightingUI(); save3DState(); });
ui.ambient.addEventListener('input', () => { applyLightingUI(); save3DState(); });

ui.showParts.addEventListener('change', () => { edgesGroup.visible = ui.showParts.checked; });

ui.btnResetPose.addEventListener('click', () => {
  resetModelToDefaultRotation();
  resetPoseUI();
  toast('포즈 리셋 완료');
});

ui.btnResetView.addEventListener('click', () => {
  if (!baseCam) return;
  camera.position.copy(baseCam.pos);
  controls.target.copy(baseCam.target);
  controls.update();
  toast('뷰 리셋 완료');
});

ui.btnResetAll.addEventListener('click', () => {
  ui.exposure.value = 1.35;
  ui.keyLight.value = 5.5;
  ui.ambient.value = 1.35;
  applyLightingUI();

  resetModelToDefaultRotation();
  resetPoseUI();

  if (baseCam) {
    camera.position.copy(baseCam.pos);
    controls.target.copy(baseCam.target);
    controls.update();
  }
  toast('전체 리셋 완료');
});

ui.btnAutoRotate.addEventListener('click', () => {
  autoRotate = !autoRotate;
  ui.btnAutoRotate.textContent = `Auto Rotate: ${autoRotate ? 'ON' : 'OFF'}`;
  ui.btnAutoRotate.setAttribute('aria-pressed', String(autoRotate));
});

ui.btnFront.addEventListener('click', () => {
  const d = camera.position.length();
  camera.position.set(0, d * 0.6, d);
  controls.update();
});
ui.btnSide.addEventListener('click', () => {
  const d = camera.position.length();
  camera.position.set(d, d * 0.6, 0);
  controls.update();
});
ui.btnTop.addEventListener('click', () => {
  const d = camera.position.length();
  camera.position.set(0, d, 0.001);
  controls.update();
});

// gestures
document.querySelectorAll('[data-gesture]').forEach(btn => {
  btn.addEventListener('click', () => applyGesture(btn.dataset.gesture));
});

// Resize
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * devicePixelRatio) || canvas.height !== Math.floor(h * devicePixelRatio)) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
window.addEventListener('resize', resize);

// Animate loop
const SMOOTH = 0.14;
function animate(ts) {
  resize();

  // ✅ 슬라이더 애니메이션(1도씩 이동) 틱
  tickSliderAnim(ts || performance.now());

  if (autoRotate && modelGroup) modelGroup.rotation.y += 0.006;

  // X/Y/Z 3축 부드러운 회전 (슬라이더=Z, 모션=X/Y/Z)
  for (const [group, arr] of Object.entries(groupMeshes)) {
    const tgt = groupTargets[group];
    for (const m of arr) {
      const base = defaultRot.get(m.name);
      if (!base) continue;
      m.rotation.x = lerp(m.rotation.x, base.x + rad(tgt.x), SMOOTH);
      m.rotation.y = lerp(m.rotation.y, base.y + rad(tgt.y), SMOOTH);
      m.rotation.z = lerp(m.rotation.z, base.z + rad(tgt.z), SMOOTH);
    }
  }

  syncEdges();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ============================================================================
// Chatbot UI (6 o'clock bar)
// ============================================================================
const chat = {
  panel: $('chatPanel'),
  messages: $('chatMessages'),
  input: $('chatInput'),
  send: $('chatSend'),
  expand: $('chatExpand'),
  collapse: $('chatCollapse'),
  clear: $('chatClear'),
  meta: $('chatMeta'),
};

const CHAT_KEY = 'robot-chat-history-v6';
let chatHistory = [];

function loadChat() {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    chatHistory = raw ? JSON.parse(raw) : [];
  } catch { chatHistory = []; }
}
function saveChat() {
  localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-30)));
}

function addMsg(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'msg--user' : 'msg--assistant'}`;
  div.textContent = content;
  chat.messages.appendChild(div);
  chat.messages.scrollTop = chat.messages.scrollHeight;
}

function renderChat() {
  chat.messages.innerHTML = '';
  if (chatHistory.length === 0) {
    addMsg('assistant', '안녕하세요! 저는 로봇 컨트롤러 AI입니다. "오른팔 흔들어봐", "인사해봐", "생각해봐" 처럼 명령해 보세요!');
    return;
  }
  for (const m of chatHistory) addMsg(m.role, m.content);
}

function setChatOpen(open) {
  chat.panel.hidden = !open;
  if (open) chat.input.focus();
}

async function fetchHealth() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    if (j?.ok) {
      chat.meta.textContent = `${j.model} @ ${j.host}`;
    } else {
      chat.meta.textContent = 'Ollama 연결 실패';
    }
  } catch {
    chat.meta.textContent = '서버 연결 실패';
  }
}

function applyActions(actions) {
  if (!actions?.length) return;
  cancelMotion();
  for (const a of actions) {
    const tgt = groupTargets[a.group];
    if (!tgt) continue;
    const axis = a.axis ?? 'z';
    if (axis === 'z' && ui.sliders[a.group]) {
      // Z축은 슬라이더 애니메이션으로 처리 (UI와 동기화)
      animateSliderTo(a.group, a.angle, { stepDeg: 1, fps: 60 });
    } else if (axis === 'x' || axis === 'y') {
      tgt[axis] = a.angle;
    } else {
      tgt.z = a.angle;
    }
  }
}

async function sendMessage() {
  const text = (chat.input.value || '').trim();
  if (!text) return;
  chat.input.value = '';

  setChatOpen(true);

  chatHistory.push({ role: 'user', content: text });
  addMsg('user', text);
  saveChat();

  const placeholder = document.createElement('div');
  placeholder.className = 'msg msg--assistant';
  placeholder.textContent = '생각 중...';
  chat.messages.appendChild(placeholder);
  chat.messages.scrollTop = chat.messages.scrollHeight;

  // LLM이 느릴 수 있으므로 90초 타임아웃 적용
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: chatHistory.slice(-10),
        discount: 0
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || '요청 실패');

    const answer = (j?.content || '').trim();
    placeholder.textContent = answer || '(빈 응답)';

    chatHistory.push({ role: 'assistant', content: placeholder.textContent });
    saveChat();

    // motion(이름 시퀀스) 우선, 없으면 actions(각도) 적용
    if (j?.motion) {
      playMotion(j.motion);
    } else {
      applyActions(j.actions);
    }

    // 복명복창 — 로봇이 응답 텍스트를 음성으로 읽음
    if (answer) speakResponse(answer);
  } catch (e) {
    clearTimeout(timeoutId);
    console.error(e);
    placeholder.textContent = e?.name === 'AbortError'
      ? '응답 시간 초과 (90초). 서버/모델 상태를 확인해 주세요.'
      : `오류: ${e?.message || e}`;
  }
}

chat.expand.addEventListener('click', () => setChatOpen(true));
chat.collapse.addEventListener('click', () => setChatOpen(false));
chat.clear.addEventListener('click', () => {
  chatHistory = [];
  saveChat();
  renderChat();
  toast('챗봇 대화를 초기화했습니다.');
});
chat.send.addEventListener('click', sendMessage);
chat.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ============================================================================
// STT (Web Speech API) — 브라우저 내장 음성 인식
// ============================================================================
(function initSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('chatMic');

  if (!SpeechRecognition) {
    // 지원하지 않는 브라우저 → 버튼 숨김
    if (micBtn) micBtn.hidden = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.interimResults = true;   // 실시간 중간 결과 표시
  recognition.maxAlternatives = 1;
  recognition.continuous = false;      // 발화 1회 후 자동 종료

  let isListening = false;
  let baseText = '';   // 음성 시작 전 입력창에 있던 텍스트 보존

  function startSTT() {
    baseText = chat.input.value;
    try {
      recognition.start();
    } catch (e) {
      // 이미 실행 중이면 무시
    }
    isListening = true;
    micBtn.classList.add('listening');
    micBtn.textContent = '●';
    micBtn.title = '음성 입력 중... (클릭해서 중지)';
  }

  function stopSTT() {
    try { recognition.stop(); } catch (_) {}
    isListening = false;
    micBtn.classList.remove('listening');
    micBtn.textContent = '음성';
    micBtn.title = '음성 입력 (클릭해서 시작)';
  }

  micBtn.addEventListener('click', () => {
    if (isListening) stopSTT();
    else startSTT();
  });

  // 인식 결과 — 실시간으로 입력창에 반영
  recognition.addEventListener('result', (e) => {
    let interim = '';
    let final = '';
    for (const result of e.results) {
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
    chat.input.value = baseText + final + interim;
  });

  // 발화 종료 — 텍스트가 있으면 자동 전송
  recognition.addEventListener('end', () => {
    stopSTT();
    if (chat.input.value.trim()) sendMessage();
  });

  recognition.addEventListener('error', (e) => {
    stopSTT();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('마이크 권한이 없습니다. 브라우저 주소창의 허용 버튼을 확인하세요.', 4500);
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      toast(`음성 인식 오류: ${e.error}`, 3000);
    }
  });
})();

// ============================================================================
// TTS (Web Speech API) — 브라우저 내장 음성 합성 (로봇 남성 목소리)
// ============================================================================
let _ttsVoices = [];
if ('speechSynthesis' in window) {
  const _loadVoices = () => {
    _ttsVoices = speechSynthesis.getVoices();
    // 개발 참고: 사용 가능한 한국어 목소리 목록 출력
    const koList = _ttsVoices.filter(v => v.lang.startsWith('ko'));
    if (koList.length) console.log('[TTS] 한국어 목소리:', koList.map(v => v.name));
  };
  _loadVoices();
  speechSynthesis.addEventListener('voiceschanged', _loadVoices);
}

function _getRobotVoice() {
  // Windows Chrome 남성 한국어 목소리 이름 목록 (알려진 것들)
  const MALE_KO = ['injoon', 'heechul', 'sejun', 'hyunsu', 'male', '남성'];
  const koMale = _ttsVoices.find(v =>
    v.lang.startsWith('ko') && MALE_KO.some(k => v.name.toLowerCase().includes(k))
  );
  if (koMale) return koMale;
  // 매칭 없으면 한국어 아무 목소리 (pitch로 남성/로봇 효과)
  return _ttsVoices.find(v => v.lang.startsWith('ko')) ?? null;
}

function speakResponse(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voice = _getRobotVoice();
  if (voice) utter.voice = voice;
  utter.lang   = 'ko-KR';
  utter.pitch  = 0.1;   // 매우 낮은 피치 → 로봇/남성
  utter.rate   = 0.85;  // 느리게
  utter.volume = 1.0;
  speechSynthesis.speak(utter);
}

// init
loadChat();
renderChat();
setChatOpen(false);
fetchHealth();