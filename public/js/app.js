// App: wires the engine, scenes and renderer to the page.
// The PhysicsSimulator + main() half of simulation.py, with a UI.

import { World, INTEGRATORS, INTEGRATOR_ORDER } from './engine.js'
import { SCENES, DEFAULT_SCENE, sceneById, knobDefaults, buildScene } from './scenes.js'
import { Renderer, SERIES_DASH, drawThumbnail, niceStep } from './render.js'

const $ = id => document.getElementById(id)
const canvas = $('sim')
const renderer = new Renderer(canvas)

// ---------- small helpers ----------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'style') el.style.cssText = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c))
  return el
}

const minus = s => String(s).replace(/-/g, '−')

function fmt(v, digits = 3) {
  if (!isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e5 || a < 1e-3) {
    const [m, e] = v.toExponential(1).split('e')
    return minus(`${m}×10${sup(+e)}`)
  }
  return minus(String(+v.toPrecision(digits)))
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }
const sup = n => String(n).split('').map(c => SUP[c] ?? c).join('')
const fmtFixed = (v, d) => minus((Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d))
const fmtMs = s => `${+(s * 1000).toPrecision(3)} ms`
const signed = (v, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`
// percentages: tiny values read as 0.000% rather than 1.0×10⁻⁶%
const pctText = v => Math.abs(v) < 0.0005 ? '0.000' : Math.abs(v) < 1 ? `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}` : signed(v)

const store = {
  get(k) { try { return localStorage.getItem('newton-sim:' + k) } catch { return null } },
  set(k, v) { try { localStorage.setItem('newton-sim:' + k, v) } catch {} },
}

const coarse = matchMedia('(pointer: coarse)').matches
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const darkQuery = matchMedia('(prefers-color-scheme: dark)')
const phone = () => innerWidth < 900

const MAX_BODIES = 300
const MAX_SPRINGS = 1500

// ---------- state ----------

const DEFAULT_DISPLAY = {
  grid: true, stress: true, trails: false, trailLen: 4, arrows: 'selected', velocity: true, forces: true,
  com: false, ghost: false, catenary: false, follow: false, springStyle: 'auto', colorBy: 'none',
}

const S = {
  scene: null,
  knobs: {},
  world: null,
  ghost: null,
  running: true,
  speed: 1,
  tool: 'grab',
  grip: 1,
  display: { ...DEFAULT_DISPLAY },
  build: { mass: 1, spring: 1, charge: 0, pinned: false },
  selected: null,
  hover: null,
  tab: 'scene',
  chart: 'energy',
  panelOpen: true,
  sheetOpen: false,
  theme: 'auto',
  runStart: null,
  startOnPlay: false,
  undo: [],
  redo: [],
  hiddenSeries: new Set(),
  edited: false,      // masses or springs changed since the scene loaded
  acc: 0,
  simRate: 1,
  lagging: false,
  userCamera: false,
  camAnim: null,
}

// ---------- settings schema ----------
// one table drives the Forces and Solver tabs, quick controls and share links

const P = (key, label, o) => ({ key, label, ...o })
const CONTROLS = {
  gravity: P('gravity', 'Gravity g', { min: 0, max: 25, step: 0.01, unit: 'm/s²', presets: [['Moon', 1.62], ['Earth', 9.81], ['Jupiter', 24.8]], rebase: true, help: 'Uniform pull downward.' }),
  drag: P('drag', 'Drag γ', { min: 0, max: 2, step: 0.01, unit: '1/s', help: 'Air resistance. Turns motion into heat.' }),
  damping: P('damping', 'Damping ζ', { min: 0, max: 2, step: 0.01, help: '0 = springs ring forever · 1 = critically damped. Resists stretching, not swinging.' }),
  stiffness: P('stiffness', 'Stiffness ×', { log: true, min: 0.1, max: 10, unit: '×', rebase: true, help: 'Multiplies every spring’s k. Stiffer springs need a smaller Δt.' }),
  tearStrain: P('tearStrain', 'Break at stretch', { tear: true, min: 0.1, max: 2, step: 0.05, help: 'Springs snap when stretched past this. Their stored energy goes to heat.' }),
  G: P('G', 'G', { min: 0, max: 5, step: 0.01, rebase: true, help: 'Scaled units: G = 1.' }),
  softening: P('softening', 'Softening ε', { min: 0, max: 0.5, step: 0.005, unit: 'm', rebase: true, help: 'Keeps close passes finite. Shared with Coulomb.' }),
  coulomb: P('coulomb', 'kₑ', { min: 0, max: 5, step: 0.01, rebase: true }),
  temperature: P('temperature', 'Temperature T', { min: 0, max: 2, step: 0.01, unit: 'J', help: 'Like the Python ThermalForce, plus the friction that lets it settle (k_B = 1).' }),
  thermostat: P('thermostat', 'Coupling γ_T', { log: true, min: 0.1, max: 5, unit: '1/s', help: 'How quickly the heat bath pulls toward T.' }),
  restitution: P('restitution', 'Bounciness e', { min: 0, max: 1, step: 0.05, help: '1 bounces forever, 0 sticks.' }),
  friction: P('friction', 'Wall friction μ', { min: 0, max: 1, step: 0.05 }),
  dt: P('dt', 'Time step Δt', { snaps: [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05], ms: true, min: 0.0001, max: 0.05, help: 'How far the simulation jumps each step. Smaller = more accurate, slower.' }),
}

const SWITCHES = [
  ['walls', 'Walls', 'A box at the scene’s edges.'],
  ['bodyCollisions', 'Ball–ball collisions', 'Sequential impulses, so a hit can run down a row of balls.'],
  ['springCollisions', 'Mass–spring collisions', 'The Python version’s collision check, now with proper impulses.'],
]

const FORCE_ROWS = [
  { id: 'springs', label: 'Springs', code: 'SpringForce', formula: 'F = k(|r| − L₀) along the spring, plus damping', always: true, controls: ['stiffness', 'damping', 'tearStrain'] },
  { id: 'gravity', label: 'Uniform gravity', code: 'GravityForce', formula: 'F = m·g, downward', key: 'gravity', onValue: 9.81, controls: ['gravity'] },
  { id: 'drag', label: 'Air drag', code: 'DragForce', formula: 'F = −γ·m·v', key: 'drag', onValue: 0.2, controls: ['drag'] },
  { id: 'gravitation', label: 'Gravitation', code: 'GravitationForce', formula: 'F = G·m₁m₂ / r², every pair attracts', key: 'G', onValue: 1, controls: ['G'], more: ['softening'] },
  { id: 'electric', label: 'Electric', code: 'CoulombForce', formula: 'F = kₑ·q₁q₂ / r², likes repel', key: 'coulomb', onValue: 1, controls: ['coulomb'], more: ['softening'] },
  { id: 'thermal', label: 'Thermostat', code: 'ThermalForce', formula: 'Random kicks plus friction that settle at temperature T', key: 'temperature', onValue: 0.2, controls: ['temperature'], more: ['thermostat'] },
]

const SHORT = {
  integrator: 'int', dt: 'dt', gravity: 'g', drag: 'drag', damping: 'zeta', stiffness: 'stiff', tearStrain: 'brk',
  G: 'G', softening: 'eps', coulomb: 'ke', temperature: 'T', thermostat: 'gT', walls: 'wall', restitution: 'e',
  friction: 'mu', bodyCollisions: 'ball', springCollisions: 'ms',
}
const LONG = Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [v, k]))

const SPEEDS = [0.25, 0.5, 1, 2, 4]
const speedLabel = v => v === 0.25 ? '¼×' : v === 0.5 ? '½×' : `${v}×`
const GRIPS = [[0.3, 'Soft'], [1, 'Normal'], [3, 'Firm']]

// ---------- scene loading, snapshots, undo ----------

function worldMeta(w) {
  return { tracked: w.tracked || null, catenary: w.catenary || null, tearAfter: w.tearAfter || 0 }
}

function applyMeta(w, m) {
  w.tracked = m?.tracked || null
  w.catenary = m?.catenary || null
  w.tearAfter = m?.tearAfter || 0
}

function snapshot(label) {
  return {
    label,
    sceneId: S.scene.id,
    knobs: { ...S.knobs },
    world: S.world.toJSON(17),
    meta: worldMeta(S.world),
    display: { ...S.display },
    edited: S.edited,
    runStart: S.runStart,
  }
}

function pushUndo(label) {
  if (!S.world) return
  S.undo.push(snapshot(label))
  if (S.undo.length > 100) S.undo.shift()
  S.redo.length = 0
  updateUndoButton()
}

function restore(snap) {
  const scene = sceneById(snap.sceneId) || S.scene
  const sceneChanged = scene !== S.scene
  S.scene = scene
  S.knobs = { ...snap.knobs }
  // view settings aren't undoable; only a scene switch brings its own back
  if (sceneChanged) S.display = { ...snap.display }
  const w = World.fromJSON(snap.world)
  w.params.grabK = presetGrab(scene)
  setWorld(w, snap.meta, { keepChart: !sceneChanged })
  S.edited = snap.edited
  S.runStart = snap.runStart || { world: snap.world, meta: snap.meta }
  if (!sceneChanged) { chart.trim(S.world.time); chart.marker('undo') }
  afterWorldChange({ refit: sceneChanged })
  if (sceneChanged) history.replaceState(null, '', '#' + scene.id)
}

function undo() {
  const snap = S.undo.pop()
  if (!snap) return
  S.redo.push(snapshot(snap.label))
  restore(snap)
  toast(`Undid: ${snap.label}`, 'Redo', redo)
  updateUndoButton()
}

function redo() {
  const snap = S.redo.pop()
  if (!snap) return
  S.undo.push(snapshot(snap.label))
  restore(snap)
  toast(`Redid: ${snap.label}`, 'Undo', undo)
  updateUndoButton()
}

function updateUndoButton() { $('undoBtn').disabled = !S.undo.length }

function setWorld(w, meta, { keepChart = false } = {}) {
  if (meta) applyMeta(w, meta)
  if (S.world) abandonGesture()
  S.world = w
  S.selected = null
  S.hover = null
  S.acc = 0
  w.rebase()
  S.ghost = S.display.ghost ? makeGhost() : null
  renderer.clearTrails()
  renderer.resetArrows()
  if (keepChart) chart.sample(true); else chart.reset()
}

function presetGrab(scene) { return (scene.params.grabK ?? 50) * S.grip }

function loadScene(id, knobs = {}, { undoable = true, label } = {}) {
  const scene = sceneById(id) || sceneById(DEFAULT_SCENE)
  if (undoable && S.world) pushUndo(label || `Switched to ${scene.name}`)
  const sceneChanged = scene !== S.scene
  S.scene = scene
  S.knobs = { ...knobDefaults(scene), ...knobs }
  S.display = { ...DEFAULT_DISPLAY, ...scene.display }
  if (sceneChanged) {
    S.chart = scene.chart || 'energy'
    S.hiddenSeries.clear()
    if (S.world) S.speed = 1
  }
  setTool('grab')
  const w = buildScene(scene, S.knobs)
  w.params.grabK = presetGrab(scene)
  S.sceneSize = { bodies: w.bodies.length, springs: w.springs.length }
  setWorld(w)
  S.edited = false
  S.startOnPlay = false
  markRunStart()
  afterWorldChange({ refit: true })
  if (sceneChanged) {
    canvas.classList.remove('fade'); void canvas.offsetWidth; canvas.classList.add('fade')
    history.replaceState(null, '', '#' + scene.id)
  }
}

function rebuildWithKnobs(knobs, label) {
  pushUndo(label || 'Changed setup')
  const params = { ...S.world.params }
  S.knobs = { ...S.knobs, ...knobs }
  const w = buildScene(S.scene, S.knobs)
  // keep the visitor's physics settings across a rebuild
  w.params = { ...params, bounds: w.params.bounds }
  S.sceneSize = { bodies: w.bodies.length, springs: w.springs.length }
  setWorld(w)
  S.edited = false
  markRunStart()
  afterWorldChange({})
  if (!S.running && !w.exploded && !reducedMotion) setRunning(true)
}

function markRunStart() {
  S.runStart = { world: S.world.toJSON(17), meta: worldMeta(S.world) }
}

// Restart: back to where this run began, keeping current settings
function restart() {
  if (!S.runStart) return
  if (!S.world.exploded) pushUndo('Restart')
  const params = { ...S.world.params }
  const w = World.fromJSON({ ...S.runStart.world, params })
  setWorld(w, S.runStart.meta)
  hideBlowup()
  afterWorldChange({})
}

function reloadPreset() {
  loadScene(S.scene.id, {}, { label: `Restored ${S.scene.name}` })
  toast(`Restored ${S.scene.name} with its own settings`, 'Undo', undo)
}

// a change to masses or springs: fresh energy account and a chart marker
function edited(label) {
  S.edited = true
  S.world.rebase()
  chart.marker(label)
  chart.lastMeasure = S.world.measure()
  if (S.display.ghost) S.ghost = makeGhost()
  // edits made while paused become the start of the next run
  if (!S.running) S.startOnPlay = true
  refreshEmpty()
  updateAria()
}

function afterWorldChange({ refit }) {
  if (refit) fitView(true)
  updateHeader()
  renderTab()
  renderInspector()
  refreshEmpty()
  updateLegend()
  hideBlowup()
  updateAria()
  updateHud()
}

// ---------- ghost twin (chaos) ----------

function makeGhost() {
  const g = World.fromJSON(S.world.toJSON(17))
  applyMeta(g, worldMeta(S.world))
  // nudge the last free mass by 1 mm
  const free = g.bodies.filter(b => !b.pinned)
  if (free.length) free[free.length - 1].x += 0.001
  g.rebase()
  return g
}

function setGhost(on) {
  S.display.ghost = on
  S.ghost = on ? makeGhost() : null
  if (on) setChart('gap')
  else if (S.chart === 'gap') setChart('energy')
  else updateLegend()
}

// ---------- camera ----------

const landscapePhone = () => phone() && innerHeight < 520 && innerWidth > innerHeight

function insets() {
  if (landscapePhone()) return { top: 10, right: 60, bottom: 40, left: 64 }
  // phones: the tool pill and HUD overlap the edges; give back room when
  // the open settings sheet leaves only a short stage
  if (phone()) return { top: Math.min(54, renderer.h * 0.12), right: 12, bottom: Math.min(66, renderer.h * 0.2), left: 12 }
  return { top: 40, right: 14, bottom: 40, left: 78 }
}

function fitView(instant) {
  const from = { cx: renderer.cx, cy: renderer.cy, scale: renderer.scale }
  renderer.fit(S.scene.view, insets())
  S.userCamera = false
  S.fitScale = renderer.scale
  if (!instant && !reducedMotion) {
    const to = { cx: renderer.cx, cy: renderer.cy, scale: renderer.scale }
    Object.assign(renderer, from)
    S.camAnim = { from, to, t0: performance.now() }
  }
}

function stepCamera(now) {
  const a = S.camAnim
  if (!a) return
  const t = Math.min(1, (now - a.t0) / 250), e = 1 - (1 - t) ** 3
  renderer.cx = a.from.cx + (a.to.cx - a.from.cx) * e
  renderer.cy = a.from.cy + (a.to.cy - a.from.cy) * e
  renderer.scale = a.from.scale * Math.pow(a.to.scale / a.from.scale, e)
  if (t >= 1) S.camAnim = null
}

// ---------- header, aria ----------

function updateHeader() {
  $('sceneTitle').textContent = S.scene.name
  $('sceneCaption').textContent = S.scene.blurb
  document.title = `${S.scene.name} · Newton sim`
  $('speedBtn').textContent = speedLabel(S.speed)
  $('speedBtn').setAttribute('aria-label', `Speed ${speedLabel(S.speed)}, click to change`)
  $('speedSeg').replaceChildren(...SPEEDS.map(v => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(v === S.speed), onclick: () => setSpeed(v),
  }, speedLabel(v))))
  updatePlay()
}

function updatePlay() {
  document.body.classList.toggle('paused', !S.running)
  $('playLabel').textContent = S.running ? 'Pause' : 'Play'
  $('playBtn').setAttribute('aria-label', S.running ? 'Pause' : 'Play')
  $('hudPaused').hidden = S.running
  updateAria()
}

function updateAria() {
  if (!S.world) return
  canvas.setAttribute('aria-label', `${S.scene.name}: ${S.world.bodies.length} masses, ${S.world.springs.length} springs, ${S.running ? 'running' : 'paused'}`)
}

function setRunning(on) {
  if (on && S.world.exploded) return
  if (on && S.startOnPlay) { markRunStart(); S.startOnPlay = false }
  S.running = on
  $('bigPlay').hidden = true
  updatePlay()
}

function setSpeed(v) {
  S.speed = v
  rate = { sim: 0, real: 0 }
  S.lagging = false
  updateHeader()
  if (S.tab === 'solver') renderTab()
}

function cycleSpeed() {
  const order = [1, 2, 4, 0.25, 0.5]
  setSpeed(order[(order.indexOf(S.speed) + 1) % order.length])
}

// ---------- tools ----------

const TOOL_HINTS = {
  build: ['Build', 'tap to add a mass · drag from empty space to throw one · drag from a mass to attach a spring'],
  pin: ['Pin', 'tap a mass to pin or unpin · tap empty space to add an anchor'],
  snip: ['Snip', 'swipe across springs to cut · tap a mass to delete it'],
}

function setTool(t) {
  S.tool = t
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t))
  canvas.className = 'tool-' + t
  const hint = TOOL_HINTS[t]
  const chip = $('modeChip')
  chip.hidden = !hint
  if (hint) {
    $('modeName').textContent = hint[0]
    $('modeHint').textContent = ' · ' + hint[1]
    chip.classList.add('long')
    clearTimeout(S.modeTimer)
    S.modeTimer = setTimeout(() => chip.classList.remove('long'), 4000)
  }
  $('buildBar').hidden = t !== 'build'
  if (t === 'build' && S.world) syncBuildBar()
  if (t !== 'grab' && tips.step === 1) tips.next()
}

function toolDefaults() {
  const sc = S.scene.tools || {}
  const free = S.world.bodies.filter(b => !b.pinned)
  const median = (arr, f) => { const v = arr.map(f).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
  return {
    mass: sc.mass ?? median(free, b => b.m) ?? 1,
    radius: sc.radius ?? median(free, b => b.r) ?? 0.1,
    k: sc.k ?? median(S.world.springs, s => s.k) ?? 50,
    launch: sc.launch ?? 2,
  }
}

function syncBuildBar() {
  for (const seg of $('buildBar').querySelectorAll('.seg')) {
    const opt = seg.dataset.opt
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(+b.dataset.v === S.build[opt]))
    }
  }
  $('chargeSeg').hidden = !S.world.params.coulomb
  $('buildPinned').checked = S.build.pinned
}

function newBodyOpts(x, y) {
  const d = toolDefaults()
  return { x, y, m: d.mass * S.build.mass, r: d.radius * Math.cbrt(S.build.mass), q: S.world.params.coulomb ? S.build.charge : 0, pinned: S.build.pinned }
}

function roomFor(masses, springs) {
  const maxB = Math.max(MAX_BODIES, (S.sceneSize?.bodies || 0) + 100)
  const maxS = Math.max(MAX_SPRINGS, (S.sceneSize?.springs || 0) + 400)
  if (S.world.bodies.length + masses > maxB) { toast(`That’s the limit: ${maxB} masses`); return false }
  if (S.world.springs.length + springs > maxS) { toast(`That’s the limit: ${maxS} springs`); return false }
  return true
}

function snapPoint(x, y, on) {
  if (!on) return [x, y]
  const s = niceStep(80 / renderer.scale) / 5
  return [Math.round(x / s) * s, Math.round(y / s) * s]
}

// ---------- pointer input ----------

const ptr = {
  down: new Map(),   // pointerId → {x, y}
  mode: null,        // 'grab' | 'pan' | 'place' | 'pinTap' | 'spring' | 'launch' | 'cut' | 'pinch'
  grab: null,
  start: null,
  pinch: null,
  cut: null,
  preview: null,
  picked: null,
  lastWorld: null,
}

function eventPos(e) {
  const r = canvas.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}

const isTouch = e => e.pointerType === 'touch' || e.pointerType === 'pen' || coarse

// nearest mass centre wins; then the nearest spring
function pick(px, py, e) {
  const tol = isTouch(e) ? 24 : 14
  let best = null, bd = Infinity
  for (const b of S.world.bodies) {
    const [sx, sy] = renderer.toScreen(b.x, b.y)
    const d = Math.hypot(sx - px, sy - py)
    if (d <= Math.max(b.r * renderer.scale + 6, tol) && d <= bd) { best = b; bd = d }
  }
  if (best) return { body: best }
  const [x, y] = renderer.toWorld(px, py)
  const spring = S.world.springAt(x, y, (isTouch(e) ? 16 : 8) / renderer.scale)
  return spring ? { spring } : {}
}

canvas.addEventListener('pointerdown', e => {
  canvas.focus({ preventScroll: true })
  const [px, py] = eventPos(e)
  // while a mass is held, extra fingers are ignored entirely
  if (ptr.down.size && (ptr.mode === 'grab' || ptr.mode === 'place')) return
  ptr.down.set(e.pointerId, { x: px, y: py })
  canvas.setPointerCapture(e.pointerId)
  S.camAnim = null

  if (ptr.down.size === 2) {
    // a second finger turns any other gesture into pinch and pan
    cancelGesture()
    const [a, b] = [...ptr.down.values()]
    ptr.mode = 'pinch'
    ptr.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
    return
  }
  if (ptr.down.size > 2) return

  const [wx, wy] = renderer.toWorld(px, py)
  ptr.primary = e.pointerId
  ptr.start = { px, py, wx, wy, t: performance.now(), hit: pick(px, py, e), shift: e.shiftKey, button: e.button }
  ptr.lastWorld = { x: wx, y: wy, t: performance.now() }
  if (e.button === 1 || e.button === 2) { ptr.mode = 'pan'; return }

  const hit = ptr.start.hit
  switch (S.tool) {
    case 'grab':
      if (hit.body) startGrab(hit.body, wx, wy)
      else ptr.mode = 'pan'
      break
    case 'build':
      if (hit.body) { ptr.mode = 'spring'; ptr.picked = hit.body; ptr.preview = { x0: hit.body.x, y0: hit.body.y, x1: wx, y1: wy, ok: false, from: hit.body } }
      else ptr.mode = 'launch'
      break
    case 'pin':
      ptr.mode = 'pinTap'
      break
    case 'snip':
      ptr.mode = 'cut'
      ptr.cut = { pts: [[wx, wy]], count: 0, snapped: false }
      break
  }
})

function startGrab(body, wx, wy) {
  ptr.picked = body
  if (body.pinned || !S.running) {
    // pins move directly; so do masses while paused (undo once it moves)
    ptr.placed = false
    ptr.mode = 'place'
    ptr.offset = [body.x - wx, body.y - wy]
  } else {
    ptr.mode = 'grab'
    ptr.grab = { body, x: wx, y: wy, vx: 0, vy: 0, hist: [[wx, wy, performance.now()]] }
    S.world.setGrab(ptr.grab)
    chart.hand = true
  }
  canvas.classList.add('dragging')
}

canvas.addEventListener('pointermove', e => {
  const [px, py] = eventPos(e)
  const p = ptr.down.get(e.pointerId)
  if (!p) { hoverAt(px, py, e); return }
  const dxp = px - p.x, dyp = py - p.y
  p.x = px; p.y = py

  if (ptr.mode === 'pinch' && ptr.down.size >= 2) {
    const [a, b] = [...ptr.down.values()]
    const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
    renderer.panBy(cx - ptr.pinch.cx, cy - ptr.pinch.cy)
    if (ptr.pinch.d > 10) zoomAt(cx, cy, d / ptr.pinch.d)
    ptr.pinch = { d, cx, cy }
    S.userCamera = true
    return
  }
  if (e.pointerId !== ptr.primary) return
  const [wx, wy] = renderer.toWorld(px, py)
  const now = performance.now()
  const moved = ptr.start && Math.hypot(px - ptr.start.px, py - ptr.start.py) > 6

  switch (ptr.mode) {
    case 'pan':
      renderer.panBy(dxp, dyp)
      S.userCamera = true
      break
    case 'grab': {
      // pointer velocity over the last 50 ms, in simulated seconds
      const g = ptr.grab
      g.hist.push([wx, wy, now])
      while (g.hist.length > 2 && now - g.hist[0][2] > 50) g.hist.shift()
      const [ox, oy, ot] = g.hist[0]
      const dt = Math.max(0.008, (now - ot) / 1000)
      g.vx = (wx - ox) / dt / S.speed
      g.vy = (wy - oy) / dt / S.speed
      g.x = wx; g.y = wy
      g.movedAt = now
      break
    }
    case 'place': {
      const b = ptr.picked
      if (!moved && !ptr.placed) break
      if (!ptr.placed) { ptr.placed = true; pushUndo(b.pinned ? 'Moved a pin' : 'Moved a mass') }
      const nx = wx + ptr.offset[0], ny = wy + ptr.offset[1]
      const dt = Math.max(0.008, (now - ptr.lastWorld.t) / 1000)
      // a moving pin's speed matters to dashpots; a placed mass stays still
      b.vx = b.pinned && S.running ? (nx - b.x) / dt / S.speed : 0
      b.vy = b.pinned && S.running ? (ny - b.y) / dt / S.speed : 0
      b.x = nx; b.y = ny
      break
    }
    case 'spring': {
      const target = pick(px, py, e).body
      const [sx, sy] = snapPoint(wx, wy, e.shiftKey)
      const ok = target && target !== ptr.preview.from
      ptr.preview = { ...ptr.preview, x1: ok ? target.x : sx, y1: ok ? target.y : sy, ok: !!ok, target: ok ? target : null, ghostR: ok ? 0 : newBodyOpts(0, 0).r }
      S.hover = ok ? target : null
      break
    }
    case 'launch':
      if (moved && !S.build.pinned) {
        const [sx, sy] = snapPoint(ptr.start.wx, ptr.start.wy, ptr.start.shift)
        let dx = wx - sx, dy = wy - sy
        const cap = renderer.w / 2 / renderer.scale, L = Math.hypot(dx, dy)
        if (L > cap) { dx *= cap / L; dy *= cap / L }
        const k = toolDefaults().launch
        ptr.preview = { kind: 'launch', x0: sx, y0: sy, x1: sx + dx, y1: sy + dy, r: newBodyOpts(0, 0).r, vx: dx * k, vy: dy * k, label: `${fmt(Math.hypot(dx, dy) * k, 2)} m/s` }
      }
      break
    case 'pinTap':
      if (moved) ptr.mode = 'pan'
      break
    case 'cut': {
      const c = ptr.cut, last = c.pts[c.pts.length - 1]
      c.pts.push([wx, wy])
      const hits = S.world.springsCrossing(last[0], last[1], wx, wy)
      if (hits.length) {
        if (!c.snapped) { pushUndo('Cut springs'); c.snapped = true }
        for (const s of hits) S.world.removeSpring(s)
        if (!c.count && navigator.vibrate) navigator.vibrate(10)
        c.count += hits.length
      }
      break
    }
  }
  ptr.lastWorld = { x: wx, y: wy, t: now }
})

function hoverAt(px, py, e) {
  if (isTouch(e)) return
  const hit = pick(px, py, e)
  S.hover = hit.body || hit.spring || null
  canvas.classList.toggle('over', !!S.hover)
}

function endPointer(e) {
  if (!ptr.down.has(e.pointerId)) return
  ptr.down.delete(e.pointerId)
  if (ptr.mode === 'pinch') {
    if (ptr.down.size === 0) ptr.mode = null
    return
  }
  if (e.pointerId !== ptr.primary) return
  ptr.down.clear()
  const st = ptr.start
  const [px, py] = eventPos(e)
  const tap = st && Math.hypot(px - st.px, py - st.py) < 6 && performance.now() - st.t < 400
  const [wx, wy] = renderer.toWorld(px, py)
  const w = S.world

  switch (ptr.mode) {
    case 'grab': {
      w.setGrab(null)
      chart.hand = false
      if (tap) select(ptr.grab.body)
      else if (tips.step === 0) tips.next()
      break
    }
    case 'place': {
      const b = ptr.picked
      if (b.pinned) { b.vx = 0; b.vy = 0 }
      if (!ptr.placed) select(b)
      else edited(b.pinned ? 'pin moved' : 'mass moved')
      ptr.placed = false
      break
    }
    case 'pan':
      if (tap && st.button === 0) select(st.hit.body || st.hit.spring || null)
      break
    case 'spring': {
      const pv = ptr.preview
      if (tap) { select(pv.from); break }
      if (pv.target) {
        if (w.springBetween(pv.from, pv.target)) { toast('Already connected'); break }
        if (!roomFor(0, 1)) break
        pushUndo('Added a spring')
        w.addSpring(pv.from, pv.target, { k: toolDefaults().k * S.build.spring })
        edited('+ spring')
      } else {
        if (!roomFor(1, 1)) break
        pushUndo('Added a mass and spring')
        const [sx, sy] = snapPoint(wx, wy, e.shiftKey)
        const b = w.addBody(newBodyOpts(sx, sy))
        w.addSpring(pv.from, b, { k: toolDefaults().k * S.build.spring })
        edited('+ mass')
      }
      break
    }
    case 'launch': {
      if (!roomFor(1, 0)) break
      const [sx, sy] = snapPoint(st.wx, st.wy, st.shift)
      pushUndo(tap ? 'Added a mass' : 'Threw a mass')
      const b = w.addBody(newBodyOpts(sx, sy))
      if (!tap && ptr.preview && !b.pinned) { b.vx = ptr.preview.vx; b.vy = ptr.preview.vy }
      edited(tap ? '+ mass' : '+ thrown mass')
      break
    }
    case 'pinTap': {
      const hit = st.hit
      if (hit.body) {
        pushUndo(hit.body.pinned ? 'Unpinned a mass' : 'Pinned a mass')
        hit.body.pinned = !hit.body.pinned
        hit.body.vx = 0; hit.body.vy = 0
        edited(hit.body.pinned ? 'pinned' : 'unpinned')
      } else {
        if (!roomFor(1, 0)) break
        pushUndo('Added an anchor')
        const [sx, sy] = snapPoint(wx, wy, e.shiftKey)
        const d = toolDefaults()
        w.addBody({ x: sx, y: sy, m: d.mass, r: d.radius, pinned: true })
        edited('+ anchor')
      }
      break
    }
    case 'cut': {
      const c = ptr.cut
      if (tap && !c.count) {
        const hit = st.hit
        if (hit.body) {
          pushUndo('Deleted a mass')
          w.removeBody(hit.body)
          edited('cut')
          toast('Deleted a mass', 'Undo', undo)
        } else if (hit.spring) {
          pushUndo('Cut 1 spring')
          w.removeSpring(hit.spring)
          edited('cut')
          toast('Cut 1 spring', 'Undo', undo)
        }
      } else if (c.count) {
        S.undo[S.undo.length - 1].label = `Cut ${c.count} spring${c.count === 1 ? '' : 's'}`
        edited('cut')
        toast(`Cut ${c.count} spring${c.count === 1 ? '' : 's'}`, 'Undo', undo)
      }
      S.fadingCut = { pts: c.pts, until: performance.now() + 250 }
      break
    }
  }
  cancelGesture()
}

// Esc, pointercancel or a second finger: keep what the gesture already
// changed, but account for it
function cancelGesture() {
  if (ptr.mode === 'place' && ptr.placed) { ptr.placed = false; edited(ptr.picked.pinned ? 'pin moved' : 'mass moved') }
  if (ptr.mode === 'cut' && ptr.cut.count) {
    const c = ptr.cut
    ptr.cut = null
    S.undo[S.undo.length - 1].label = `Cut ${c.count} spring${c.count === 1 ? '' : 's'}`
    edited('cut')
  }
  abandonGesture()
}

// drop gesture state without booking anything (the world is being replaced)
function abandonGesture() {
  if (ptr.grab) { S.world.setGrab(null); chart.hand = false }
  ptr.placed = false
  ptr.mode = null
  ptr.grab = null
  ptr.preview = null
  ptr.cut = null
  ptr.picked = null
  canvas.classList.remove('dragging')
}

canvas.addEventListener('pointerup', endPointer)
canvas.addEventListener('pointercancel', e => {
  if (!ptr.down.has(e.pointerId)) return
  ptr.down.delete(e.pointerId)
  if (ptr.mode === 'pinch' ? !ptr.down.size : e.pointerId === ptr.primary) { ptr.down.clear(); cancelGesture() }
})
canvas.addEventListener('pointerleave', () => { if (!ptr.down.size) S.hover = null })
canvas.addEventListener('contextmenu', e => e.preventDefault())

function zoomAt(px, py, f) {
  const fit = S.fitScale || renderer.scale
  renderer.zoomAt(px, py, f, fit * 0.1, fit * 20)
  S.userCamera = true
  S.camAnim = null
}

canvas.addEventListener('wheel', e => {
  e.preventDefault()
  const [px, py] = eventPos(e)
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
  zoomAt(px, py, Math.pow(1.0015, -dy))
}, { passive: false })

function select(thing) {
  S.selected = thing
  renderInspector()
  if (thing && phone() && !S.sheetOpen) setSheet(true)
}

// ---------- the main loop ----------

let last = performance.now()
let rate = { sim: 0, real: 0 }
let hudAt = 0, slowAt = 0

function frame(now) {
  const real = Math.min(0.1, (now - last) / 1000)
  last = now
  const w = S.world
  // a pointer that has stopped moving has stopped: don't keep its old speed
  if (ptr.grab && now - (ptr.grab.movedAt || 0) > 60) { ptr.grab.vx = 0; ptr.grab.vy = 0 }
  if (S.running && !w.exploded) {
    const dt = w.params.dt
    S.acc += real * S.speed
    const want = Math.floor(S.acc / dt + 1e-9)
    // the ghost twin steps in lockstep, so the two share one 12 ms budget
    const done = w.advance(Math.min(want, 4000), dt, S.ghost ? 6 : 12)
    if (S.ghost) S.ghost.advance(done, dt)
    S.acc -= done * dt
    if (done < want) S.acc = 0 // can't keep up: drop the backlog
    rate.sim += done * dt
    rate.real += real
    if (rate.real > 1) {
      S.simRate = rate.sim / rate.real
      rate = { sim: 0, real: 0 }
      S.lagging = S.simRate < 0.85 * S.speed
    }
    if (done) {
      if (S.display.trails) renderer.recordTrails(w)
      chart.sample()
    }
    if (w.exploded) showBlowup()
  } else {
    rate = { sim: 0, real: 0 }
    S.lagging = false
  }
  stepCamera(now)
  if (S.display.follow) {
    const c = w.centerOfMass()
    if (c) { renderer.cx += (c.x - renderer.cx) * 0.1; renderer.cy += (c.y - renderer.cy) * 0.1 }
  }
  draw(now)
  chart.draw()
  if (now - hudAt > 100) { hudAt = now; updateHud(); liveInspector(); chart.legendValues(); drawSpark() }
  if (now - slowAt > 500) { slowAt = now; liveReadouts() }
  requestAnimationFrame(frame)
}

function draw(now) {
  const sel = S.selected
  const isBody = x => x && x.r !== undefined
  const s = {
    display: S.display,
    selectedBody: isBody(sel) ? sel : null,
    selectedSpring: sel && !isBody(sel) ? sel : null,
    hoverBody: isBody(S.hover) ? S.hover : null,
    hoverSpring: S.hover && !isBody(S.hover) ? S.hover : null,
    picked: ptr.picked,
    preview: ptr.preview,
    ghost: S.ghost,
    cut: ptr.cut || (S.fadingCut && now < S.fadingCut.until ? { pts: S.fadingCut.pts, alpha: (S.fadingCut.until - now) / 250 } : null),
    grabLine: ptr.grab ? grabLine() : null,
    scaleBarAt: phone() && !landscapePhone() ? [14, 30] : null,
    underlay: S.display.catenary && S.world.catenary ? () => drawCatenary(S.world.catenary) : null,
  }
  renderer.draw(S.world, s)
  if (isBody(sel) && S.world.bodies.includes(sel) && S.display.arrows !== 'off') labelSelected(sel)
}

function grabLine() {
  const g = ptr.grab, b = g.body
  const f = S.world.forcesOn(b).find(x => x.kind === 'Your hand')
  return { x0: b.x, y0: b.y, x1: g.x, y1: g.y, label: f ? `${fmt(Math.hypot(f.fx, f.fy), 2)} N` : '' }
}

// the ideal hanging-chain curve: solve L = 2a·sinh(d/2a) for a
function drawCatenary(c) {
  const d = c.x1 - c.x0
  // the chain stretches a little under load; use its length right now
  const len = S.world.springs.reduce((a, s) => a + s.length(), 0) || c.len
  if (len <= d) return
  let lo = 1e-3, hi = 1e3
  for (let i = 0; i < 80; i++) {
    const a = Math.sqrt(lo * hi)
    if (2 * a * Math.sinh(d / (2 * a)) > len) lo = a; else hi = a
  }
  const a = Math.sqrt(lo * hi), mid = (c.x0 + c.x1) / 2
  const ctx = renderer.ctx
  ctx.setLineDash([7, 5])
  ctx.strokeStyle = renderer.theme.accent
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i <= 80; i++) {
    const x = c.x0 + d * i / 80
    const y = c.y + a * (Math.cosh((x - mid) / a) - Math.cosh(d / (2 * a)))
    const [px, py] = renderer.toScreen(x, y)
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py)
  }
  ctx.stroke()
  ctx.setLineDash([])
}

// v and F labels next to the selected mass
function labelSelected(b) {
  if (b.pinned) return
  const [x, y] = renderer.toScreen(b.x, b.y)
  const r = Math.max(5, b.r * renderer.scale) + 12
  if (S.display.velocity) renderer.tag(`v ${fmt(Math.hypot(b.vx, b.vy), 2)} m/s`, x + r, y - 9)
  if (S.display.forces) {
    const net = S.world.forcesOn(b).reduce((a, f) => [a[0] + f.fx, a[1] + f.fy], [0, 0])
    renderer.tag(`F ${fmt(Math.hypot(...net), 2)} N`, x + r, y + 9)
  }
}

// ---------- HUD and checks ----------

function dtCheck() {
  const w = S.world
  const om = w.omegaMax()
  const spw = om > 0 ? 2 * Math.PI / (om * w.params.dt) : Infinity
  const out = { spw, level: spw >= 20 ? 'ok' : spw >= 6 ? 'amber' : 'red' }
  out.damping = w.params.damping > 0 && 2 * w.params.damping * om * w.params.dt > 1
  out.tunnel = w.tunnelling()
  return out
}

function updateHud() {
  const w = S.world
  $('hudTime').textContent = `t ${fmtFixed(w.time, 2)} s`
  $('hudSolver').textContent = `${INTEGRATORS[w.params.integrator].label} · Δt ${fmtMs(w.params.dt)}`
  const chk = dtCheck()
  S.check = chk
  const warn = $('hudWarn')
  let text = ''
  if (chk.level === 'red') text = `⚠ ${stepsText(chk.spw)} per wobble · lower Δt`
  else if (chk.level === 'amber') text = `⚠ ${stepsText(chk.spw)} per wobble · rough`
  else if (chk.tunnel) text = '⚠ Fast masses may pass through each other'
  warn.hidden = !text
  warn.textContent = text
  warn.classList.toggle('bad', chk.level === 'red')
  const lag = $('hudLag')
  lag.hidden = !S.lagging
  if (S.lagging) lag.textContent = `Running at ${fmt(S.simRate, 2)}× · device can’t keep up`

  if (!S.running || !chart.lastMeasure) chart.lastMeasure = w.measure()
  const m = chart.lastMeasure
  const pct = m.errorPct
  const big = Math.abs(pct) > 1
  const chip = $('errChip')
  chip.textContent = big ? `${pct > 0 ? '▲' : '▼'} ${signed(pct)}% ${pct > 0 ? 'gaining' : 'losing'} energy` : `Energy error ${pctText(pct)}%`
  chip.classList.toggle('bad', big)
  $('peekE').textContent = `E ${fmt(m.total, 4)} J`
  $('peekErr').textContent = `err ${pctText(pct)}%`
  $('peekErr').classList.toggle('bad', big)

  // recenter pill when most masses are out of view
  const free = w.bodies.filter(b => !b.pinned)
  let on = 0
  for (const b of free) {
    const [x, y] = renderer.toScreen(b.x, b.y)
    if (x >= 0 && x <= renderer.w && y >= 0 && y <= renderer.h) on++
  }
  $('recenterBtn').hidden = !free.length || on >= free.length / 2
  if (S.tab === 'solver') paintDtCheck()
}

const stepsText = spw => { const n = Math.max(0, Math.round(spw)); return `${n} step${n === 1 ? '' : 's'}` }

function paintDtCheck() {
  const el = $('dtCheck')
  if (!el || !S.check) return
  const { spw, level, damping, tunnel } = S.check
  const per = (1 / 60) * S.speed / S.world.params.dt
  const lines = []
  if (!isFinite(spw)) lines.push(['help', 'Δt check: nothing oscillates yet'])
  else if (level === 'ok') lines.push(['help ok', `Δt check: ${Math.round(spw)} steps per fastest wobble ✓`])
  else if (level === 'amber') lines.push(['help amber', `Δt check: ${stepsText(spw)} per wobble · results will be rough`])
  else lines.push(['warnNote', `Δt check: ${stepsText(spw)} per wobble · about to blow up: lower Δt or stiffness`])
  if (damping) lines.push(['help amber', 'Damping is too strong for this Δt'])
  if (tunnel) lines.push(['help amber', 'Fast masses may pass through each other'])
  lines.push(['help', `≈ ${fmt(per, 2)} steps per frame`])
  el.replaceChildren(...lines.map(([cls, t]) => h('p', { class: cls, text: t })))
}

// ---------- blow-up and empty states ----------

function showBlowup() {
  S.running = false
  updatePlay()
  const it = S.world.params.integrator
  $('useVerlet').hidden = !(it === 'euler' || it === 'python')
  $('blowup').hidden = false
  $('fixSteps').focus()
}

function hideBlowup() { $('blowup').hidden = true }

$('fixSteps').addEventListener('click', () => {
  const params = S.world.params
  const before = params.dt
  // halve Δt until the check shows at least 20 steps per wobble
  const probe = World.fromJSON({ ...S.runStart.world, params })
  applyMeta(probe, S.runStart.meta)
  const om = probe.omegaMax()
  let dt = before / 2
  while (om > 0 && 2 * Math.PI / (om * dt) < 20 && dt > 1e-4) dt /= 2
  params.dt = Math.max(1e-4, dt)
  restart()
  setRunning(true)
  chart.marker(`Δt ${fmtMs(params.dt)}`)
  toast(`Δt ${fmtMs(before)} → ${fmtMs(params.dt)}`)
})
$('useVerlet').addEventListener('click', () => {
  const params = S.world.params
  params.integrator = 'verlet'
  // Verlet is stable below ωΔt = 2; lower Δt too if it's past that
  const probe = World.fromJSON({ ...S.runStart.world, params })
  applyMeta(probe, S.runStart.meta)
  const om = probe.omegaMax(), before = params.dt
  while (om > 0 && 2 * Math.PI / (om * params.dt) < 6 && params.dt > 1e-4) params.dt = Math.max(1e-4, params.dt / 2)
  restart()
  setRunning(true)
  chart.marker('→ Velocity Verlet')
  toast(params.dt !== before ? `Velocity Verlet, Δt ${fmtMs(before)} → ${fmtMs(params.dt)}` : 'Integrator: Velocity Verlet')
})
$('blowRestart').addEventListener('click', () => { restart(); setRunning(true) })

function refreshEmpty() {
  const empty = !S.world.bodies.length
  $('empty').hidden = !empty
  if (empty) {
    const fresh = S.scene.id === 'sandbox' && !S.edited
    $('emptyTitle').textContent = fresh ? 'Empty sandbox' : 'Nothing left.'
    $('emptyText').textContent = fresh ? 'Pick ＋ Build and tap the paper to add a mass.' : 'Undo, restart, or add masses with ＋ Build.'
    $('emptyUndo').hidden = fresh || !S.undo.length
  }
}

$('emptyBuild').addEventListener('click', () => setTool('build'))
$('emptyUndo').addEventListener('click', undo)
$('emptyScenes').addEventListener('click', openPicker)

// ---------- toast ----------

function toast(text, actionLabel, action) {
  const el = $('toast')
  $('toastText').textContent = text
  const btn = $('toastAction')
  btn.hidden = !actionLabel
  btn.textContent = actionLabel || ''
  btn.onclick = () => { el.hidden = true; action && action() }
  el.hidden = false
  $('tip').hidden = true
  clearTimeout(S.toastTimer)
  S.toastTimer = setTimeout(() => { el.hidden = true; tips.show() }, 4000)
}

// ---------- tips ----------

const tips = {
  step: 0,
  texts: [
    () => coarse ? 'Drag any mass to fling it · tap one to see its forces' : 'Drag any mass to fling it · click one to see the forces on it · scroll to zoom',
    () => 'Build, pin and snip with these tools. Undo is right below them.',
    () => 'Eleven more scenes in here. Tap the title to switch.',
  ],
  init() {
    const v = parseInt(store.get('tips') ?? '0', 10)
    this.step = isNaN(v) ? 0 : v
    this.show()
    setTimeout(() => { if (this.step === 0 && !$('tip').hidden) this.next() }, 12000)
    setTimeout(() => { if (this.step < 2 && $('picker').hidden && !this.seenPicker) { this.step = 2; this.show() } }, 20000)
  },
  show() {
    const el = $('tip')
    if (this.step >= this.texts.length || !$('toast').hidden) { el.hidden = true; return }
    $('tipText').textContent = this.texts[this.step]()
    $('tipOk').textContent = this.step === 0 ? 'Got it' : this.step === 1 ? 'Next' : 'Done'
    el.hidden = false
    if (this.step === 2 && !reducedMotion) {
      $('scenePick').classList.remove('pulse'); void $('scenePick').offsetWidth
      $('scenePick').classList.add('pulse')
    }
  },
  next() {
    this.step++
    store.set('tips', String(this.step))
    this.show()
  },
  skip() {
    this.step = this.texts.length
    store.set('tips', String(this.step))
    $('tip').hidden = true
  },
}

$('tipOk').addEventListener('click', () => tips.next())
// × closes this tip; the next one waits for a later moment
$('tipX').addEventListener('click', () => { tips.step++; store.set('tips', String(tips.step)); $('tip').hidden = true })
$('tipSkip').addEventListener('click', () => tips.skip())

// ---------- inspector (free-body diagram) ----------

const isBody = x => x && x.r !== undefined

function renderInspector() {
  const el = $('inspector')
  const sel = S.selected
  const w = S.world
  if (!sel || (isBody(sel) ? !w.bodies.includes(sel) : !w.springs.includes(sel))) {
    S.selected = null
    el.hidden = true
    el.replaceChildren()
    return
  }
  el.hidden = false
  if (!S.panelOpen && !phone()) togglePanel(true, false)
  const close = h('button', { class: 'iconBtn', type: 'button', 'aria-label': 'Close inspector', onclick: () => select(null) }, '×')
  const commit = label => () => edited(label)
  if (isBody(sel)) {
    const idx = w.bodies.indexOf(sel) + 1
    el.replaceChildren(
      h('div', { class: 'inspHead' }, h('h3', { text: `Mass #${idx}` }), sel.pinned ? h('span', { class: 'badge', text: 'Pinned' }) : null, close),
      h('p', { class: 'inspLive', id: 'inspLive' }),
      h('div', { id: 'fbd' }),
      h('p', { class: 'help', text: 'Collisions act as instant kicks and aren’t listed.' }),
      slider({ label: 'Mass', log: true, min: 0.01, max: 100, unit: 'kg' }, () => sel.m, v => { sel.m = v }, 'Changed a mass', { commit: commit('mass') }),
      w.params.coulomb
        ? slider({ label: 'Charge q', min: -3, max: 3, step: 0.5 }, () => sel.q, v => { sel.q = v }, 'Changed a charge', { commit: commit('charge') })
        : null,
      toggleRow('Pinned', () => sel.pinned, v => { pushUndo(v ? 'Pinned a mass' : 'Unpinned a mass'); sel.pinned = v; sel.vx = 0; sel.vy = 0; edited(v ? 'pinned' : 'unpinned'); renderInspector() }),
      h('div', { class: 'inspBtns' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { pushUndo('Stopped a mass'); sel.vx = 0; sel.vy = 0; edited('stopped') } }, 'Stop it'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { pushUndo('Deleted a mass'); w.removeBody(sel); edited('cut'); select(null) } }, 'Delete')),
    )
  } else {
    const ia = w.bodies.indexOf(sel.a) + 1, ib = w.bodies.indexOf(sel.b) + 1
    const name = sel.kind === 'rope' ? 'Rope' : sel.kind === 'rod' ? 'Rod' : 'Spring'
    el.replaceChildren(
      h('div', { class: 'inspHead' }, h('h3', { text: `${name} #${ia}–#${ib}` }), close),
      h('p', { class: 'inspLive', id: 'inspLive' }),
      slider({ label: 'Stiffness k', log: true, min: 0.1, max: 50000, unit: 'N/m' }, () => sel.k, v => { sel.k = v }, 'Changed stiffness', { commit: commit('k') }),
      slider({ label: 'Rest length L₀', log: true, min: 0.01, max: 5, unit: 'm' }, () => sel.rest, v => { sel.rest = v }, 'Changed rest length', { commit: commit('L₀') }),
      segRow('Kind', [['spring', 'Spring'], ['rope', 'Rope'], ['rod', 'Rod']], () => sel.kind, v => { pushUndo('Changed spring kind'); sel.kind = v; edited(v); renderInspector() }),
      h('p', { class: 'help', text: 'A rope only pulls: it goes slack when shorter than L₀. A rod is a stiff spring drawn as a bar.' }),
      h('div', { class: 'inspBtns' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { pushUndo('Reset rest length'); sel.rest = sel.length(); edited('L₀'); renderInspector() } }, 'Use current length'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { pushUndo('Cut a spring'); w.removeSpring(sel); edited('cut'); select(null) } }, 'Delete')),
    )
  }
  liveInspector()
}

function arrowGlyph(fx, fy) {
  const a = Math.atan2(-fy, fx) * 180 / Math.PI
  return h('span', { class: 'dir', style: `transform:rotate(${a.toFixed(0)}deg)`, 'aria-hidden': 'true' }, '→')
}

function forceRow(label, fx, fy, extra, cls) {
  const mag = Math.hypot(fx, fy)
  return h('tr', { class: cls }, h('td', { text: label }), h('td', { class: 'num' }, `${fmt(mag, 3)} N `, mag > 1e-9 ? arrowGlyph(fx, fy) : h('span', { class: 'dir' })), h('td', { class: 'muted', text: extra || '' }))
}

function liveInspector() {
  const sel = S.selected
  const live = $('inspLive')
  if (!sel || !live) return
  const w = S.world
  if (isBody(sel)) {
    if (!w.bodies.includes(sel)) { renderInspector(); return }
    live.textContent = `${fmt(sel.m, 3)} kg · speed ${fmt(Math.hypot(sel.vx, sel.vy), 3)} m/s · at (${fmtFixed(sel.x, 2)}, ${fmtFixed(sel.y, 2)}) m`
    const forces = w.forcesOn(sel)
    const springs = forces.filter(f => f.spring), others = forces.filter(f => !f.spring)
    let nx = 0, ny = 0
    const rows = []
    if (springs.length) {
      const sx = springs.reduce((a, f) => a + f.fx, 0), sy = springs.reduce((a, f) => a + f.fy, 0)
      rows.push(forceRow(`Springs (${springs.length})`, sx, sy))
      for (const f of springs.slice(0, 6)) {
        const what = f.kind === 'rope' && f.ext <= 0 ? 'slack' : `${f.ext >= 0 ? 'stretched' : 'squashed'} ${fmt(Math.abs(f.ext) * 100, 2)} cm`
        rows.push(forceRow(`→ #${w.bodies.indexOf(f.other) + 1}`, f.fx, f.fy, what, 'sub'))
      }
      nx += sx; ny += sy
    }
    for (const f of others) {
      rows.push(forceRow(f.kind, f.fx, f.fy))
      nx += f.fx; ny += f.fy
    }
    const net = Math.hypot(nx, ny)
    rows.push(forceRow('Net', nx, ny, sel.pinned ? 'held by the pin' : `a = F/m = ${fmt(net / sel.m, 3)} m/s²`, 'net'))
    $('fbd').replaceChildren(h('table', { class: 'fbdTable' }, h('caption', { text: sel.pinned ? 'Forces on this pin (the pin pushes back with the opposite)' : 'Forces on this mass, F = ma' }), rows))
  } else {
    if (!w.springs.includes(sel)) { renderInspector(); return }
    const L = sel.length(), ext = L - sel.rest
    if (sel.kind === 'rope' && ext <= 0) { live.textContent = `length ${fmt(L, 3)} m · slack`; return }
    const f = sel.k * w.params.stiffness * ext
    live.textContent = ext >= 0
      ? `length ${fmt(L, 3)} m · stretch ${signed(ext / sel.rest * 100)}% · tension ${fmt(f, 3)} N`
      : `length ${fmt(L, 3)} m · compressed ${fmt(ext / sel.rest * 100, 2)}% · push ${fmt(-f, 3)} N`
  }
}

// ---------- generic controls ----------

function sliderValue(c, s) {
  if (c.snaps) return c.snaps[Math.round(s)]
  if (c.log) return c.min * Math.pow(c.max / c.min, s / 1000)
  return +s
}

function sliderPos(c, v) {
  if (c.snaps) {
    let best = 0
    c.snaps.forEach((x, i) => { if (Math.abs(Math.log(x / v)) < Math.abs(Math.log(c.snaps[best] / v))) best = i })
    return best
  }
  if (c.log) return Math.round(1000 * Math.log(Math.max(c.min, Math.min(c.max, v)) / c.min) / Math.log(c.max / c.min))
  return v
}

function fmtValue(c, v) {
  if (c.ms) return fmtMs(v)
  if (c.tear) return `${Math.round(v * 100)}%`
  const u = c.unit ? (c.unit === '×' ? '×' : ' ' + c.unit) : ''
  return `${fmt(v, 3)}${u}`
}

// a labelled slider row: label, tappable value, reset, range input, help
function slider(c, get, set, undoLabel, opts = {}) {
  const lo = c.snaps ? 0 : c.log ? 0 : c.min
  const hi = c.snaps ? c.snaps.length - 1 : c.log ? 1000 : c.max
  const input = h('input', { type: 'range', min: lo, max: hi, step: c.snaps ? 1 : c.log ? 1 : (c.step || 0.01), 'aria-label': c.label })
  input.value = sliderPos(c, get())
  const val = h('button', { class: 'val', type: 'button', title: 'Type a value', 'aria-label': `${c.label}: type a value` })
  const reset = opts.reset != null ? h('button', { class: 'reset', type: 'button', title: 'Back to the scene’s value', 'aria-label': `Reset ${c.label}` }, '↺') : null
  const paint = () => {
    const v = get()
    val.textContent = fmtValue(c, v)
    input.setAttribute('aria-valuetext', fmtValue(c, v))
    input.style.setProperty('--fill', `${100 * (input.value - lo) / (hi - lo)}%`)
    if (reset) reset.hidden = Math.abs(v - opts.reset) <= 1e-9 * Math.max(1, Math.abs(v))
  }
  let editing = false
  const begin = () => { if (!editing) { editing = true; pushUndo(undoLabel) } }
  const commit = () => { if (editing) { editing = false; opts.commit?.(get()) } }
  const apply = v => { set(v); input.value = sliderPos(c, v); paint() }
  input.addEventListener('input', () => { begin(); set(sliderValue(c, input.value)); paint() })
  input.addEventListener('change', commit)
  input.addEventListener('blur', commit)
  if (reset) reset.addEventListener('click', () => { pushUndo(undoLabel); apply(opts.reset); opts.commit?.(opts.reset) })
  val.addEventListener('click', () => {
    const shown = c.ms ? get() * 1000 : c.tear ? get() * 100 : get()
    const box = h('input', { class: 'val', type: 'number', step: 'any', value: +shown.toPrecision(4), 'aria-label': `${c.label}${c.ms ? ' in ms' : c.tear ? ' in %' : ''}` })
    val.replaceWith(box)
    box.focus(); box.select()
    let finished = false
    const done = ok => {
      if (finished) return
      finished = true
      if (ok) {
        let v = parseFloat(box.value)
        if (isFinite(v)) {
          if (c.ms) v /= 1000
          if (c.tear) v /= 100
          v = Math.max(c.min ?? -Infinity, Math.min(c.max ?? Infinity, v))
          if (v !== get()) { pushUndo(undoLabel); apply(v); opts.commit?.(v) }
        }
      }
      box.replaceWith(val); paint()
    }
    box.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false) } })
    box.addEventListener('blur', () => done(true))
  })
  paint()
  return h('div', { class: 'row' },
    h('div', { class: 'rowTop' }, h('span', { class: 'lbl', text: c.label }), reset, val),
    input,
    c.presets ? h('div', { class: 'presets' }, c.presets.map(([n, v]) => h('button', { class: 'chipBtn', type: 'button', onclick: () => { pushUndo(undoLabel); apply(v); opts.commit?.(v) } }, `${n} ${v}`))) : null,
    c.help ? h('p', { class: 'help', text: c.help }) : null)
}

function toggleRow(label, get, set, help) {
  const btn = h('button', { class: 'switchRow', type: 'button', role: 'switch', 'aria-checked': String(!!get()) },
    h('span', { class: 'lbl', text: label }), h('span', { class: 'switch', 'aria-hidden': 'true' }))
  btn.addEventListener('click', () => { set(!get()); btn.setAttribute('aria-checked', String(!!get())) })
  return h('div', { class: 'row' }, btn, help ? h('p', { class: 'help', text: help }) : null)
}

function segRow(label, options, get, set, help) {
  return h('div', { class: 'row' },
    label ? h('div', { class: 'rowTop' }, h('span', { class: 'lbl', text: label })) : null,
    h('div', { class: 'segRow', role: 'radiogroup', 'aria-label': label || 'Options' },
      options.map(([v, text]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(get() === v), onclick: () => set(v) }, text))),
    help ? h('p', { class: 'help', text: help }) : null)
}

function presetParams() { return new World(S.scene.params).params }

// a physics param: undo on first move, marker (and rebaseline) on release
function paramControl(key, opts = {}) {
  if (key === 'tearStrain') return tearControl()
  const c = CONTROLS[key]
  return slider(c, () => S.world.params[key], v => {
    S.world.params[key] = v
    if (S.ghost) S.ghost.params[key] = v
  }, `Changed ${c.label}`, {
    reset: presetParams()[key],
    commit: v => {
      if (c.rebase) { S.world.rebase(); S.ghost?.rebase() }
      chart.marker(`${shortName(key)} ${fmtValue(c, v)}`)
      updateHud()
      if (key === 'coulomb' && S.tool === 'build') syncBuildBar()
      opts.after?.()
    },
  })
}

function tearControl() {
  const p = S.world.params
  const on = p.tearStrain > 0
  const wrap = h('div', {},
    toggleRow('Springs can break', () => p.tearStrain > 0, v => {
      if (!v) S.lastTear = p.tearStrain
      setParam('tearStrain', v ? (S.lastTear || presetParams().tearStrain || 0.5) : 0, v ? 'Tearing on' : 'Tearing off')
    }))
  if (on) {
    const c = CONTROLS.tearStrain
    wrap.append(slider(c, () => p.tearStrain, v => { p.tearStrain = v; if (S.ghost) S.ghost.params.tearStrain = v }, `Changed ${c.label}`, {
      reset: presetParams().tearStrain || null,
      commit: v => chart.marker(`break ${fmtValue(c, v)}`),
    }))
  }
  return wrap
}

function shortName(key) {
  return { gravity: 'g', drag: 'γ', damping: 'ζ', stiffness: 'k×', tearStrain: 'break', G: 'G', softening: 'ε', coulomb: 'kₑ', temperature: 'T', thermostat: 'γ_T', restitution: 'e', friction: 'μ', dt: 'Δt' }[key] || key
}

function setParam(key, value, label, { quiet } = {}) {
  pushUndo(label || `Changed ${key}`)
  S.world.params[key] = value
  if (S.ghost) S.ghost.params[key] = value
  if (CONTROLS[key]?.rebase) { S.world.rebase(); S.ghost?.rebase() }
  chart.marker(key === 'integrator' ? `→ ${INTEGRATORS[value].label}` : typeof value === 'boolean' ? `${label}` : `${shortName(key)} ${CONTROLS[key] ? fmtValue(CONTROLS[key], value) : value}`)
  if (!quiet) renderTab()
  updateHud()
  updateLegend()
}

// ---------- tabs ----------

const energyEl = $('energy')

function placeEnergy() {
  if (phone() && S.tab === 'chart') {
    if (energyEl.parentElement !== $('tabBody')) $('tabBody').replaceChildren(energyEl)
  } else if (energyEl.parentElement !== $('cardBody')) {
    $('cardBody').insertBefore(energyEl, $('panel'))
  }
}

function renderTab() {
  if (S.tab === 'chart' && !phone()) S.tab = 'scene'
  for (const b of document.querySelectorAll('.tabs [role="tab"]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === S.tab))
    b.tabIndex = b.dataset.tab === S.tab ? 0 : -1
  }
  const body = $('tabBody')
  body.setAttribute('aria-labelledby', 'tab-' + S.tab)
  const keep = body.scrollTop
  // remember which control had focus, by position, to restore it
  const focusables = () => [...body.querySelectorAll('button, input, select, summary, a[href]')]
  const had = body.contains(document.activeElement) ? focusables().indexOf(document.activeElement) : -1
  if (S.tab === 'chart') placeEnergy()
  else { body.replaceChildren(...TABS[S.tab]()); placeEnergy() }
  body.scrollTop = keep
  if (had >= 0) focusables()[had]?.focus({ preventScroll: true })
}

const TABS = {
  scene() {
    const sc = S.scene
    const [first, ...rest] = sc.try || []
    const actionChips = t => t.actions ? h('div', { class: 'chips' }, t.actions.slice(0, 2).map(a => h('button', { class: 'chipBtn', type: 'button', onclick: () => runAction(a) }, a.label))) : null
    const out = [
      h('div', { class: 'sceneHead' }, h('h2', { class: 'sceneName', text: sc.name }), h('span', { class: 'badge', text: sc.tag })),
      h('p', { class: 'sceneBlurb', text: sc.blurb }),
    ]
    if (first) {
      out.push(h('div', { class: 'try' },
        h('span', { class: 'tryLabel', text: 'Try this' }),
        h('p', { text: first.text }),
        actionChips(first),
        rest.length ? h('details', { class: 'more' }, h('summary', { text: 'More to try' }),
          h('ul', {}, rest.map(t => h('li', {}, t.text, actionChips(t))))) : null))
    }
    if (sc.knobs?.length) {
      out.push(h('h3', { text: 'Scene setup' }), h('p', { class: 'help', text: 'Changing these rebuilds the scene.' }))
      for (const kn of sc.knobs) out.push(knobControl(kn))
    }
    if (sc.featured?.length) {
      out.push(h('h3', { text: 'Quick controls' }))
      for (const id of sc.featured) out.push(id === 'integrator' ? integratorSelect() : paramControl(id))
    }
    out.push(h('ul', { class: 'readouts', id: 'readouts' }))
    out.push(h('p', { class: 'panelFoot' },
      h('button', { class: 'linkBtn', type: 'button', onclick: reloadPreset }, 'Restore preset settings (Shift+R)'), ' · ',
      h('a', { href: 'https://github.com/real-shafe/newton-force-law-sim', target: '_blank', rel: 'noopener noreferrer' }, 'Source on GitHub ↗')))
    return out
  },

  forces() {
    const w = S.world
    const out = []
    for (const row of FORCE_ROWS) {
      if (row.id === 'springs' && !w.springs.length) continue
      const on = row.always ? true : !!w.params[row.key]
      const head = row.always
        ? h('div', { class: 'switchRow' }, h('span', { class: 'lbl', text: row.label }))
        : h('button', {
          class: 'switchRow', type: 'button', role: 'switch', 'aria-checked': String(on),
          onclick: () => {
            const now = !!w.params[row.key]
            if (now) S.lastOn = { ...S.lastOn, [row.key]: w.params[row.key] }
            setParam(row.key, now ? 0 : (S.lastOn?.[row.key] || row.onValue), `${row.label} ${now ? 'off' : 'on'}`)
            if (row.key === 'coulomb' && S.tool === 'build') syncBuildBar()
          },
        }, h('span', { class: 'switch', 'aria-hidden': 'true' }), h('span', { class: 'lbl', text: row.label }))
      const notes = []
      if (row.id === 'gravitation' && on && w.params.gravity) notes.push('Using both uniform g and G between masses.')
      if (row.id === 'electric' && on && !w.bodies.some(b => b.q)) notes.push('No masses are charged yet. Use Build’s charge chips or the inspector.')
      const body = on ? h('div', { class: 'forceBody', style: row.always ? 'margin-left:0' : '' },
        row.controls.map(k => paramControl(k)),
        notes.map(n => h('p', { class: 'help', text: n })),
        row.more ? h('details', { class: 'adv' }, h('summary', { text: 'More' }), row.more.map(k => paramControl(k))) : null) : null
      out.push(h('div', { class: 'force' }, head,
        h('p', { class: 'formula', style: row.always ? 'margin-left:0' : '' }, h('code', { text: row.code }), ' · ', row.formula), body))
    }
    out.push(h('div', { class: 'force' },
      h('div', { class: 'switchRow' }, h('span', { class: 'lbl', text: 'Your hand' })),
      h('p', { class: 'formula', style: 'margin-left:0' }, h('code', { text: 'MouseSpring' }), ' · F = −k(x − x_pointer), critically damped'),
      segRow('Grip', GRIPS, () => S.grip, v => {
        S.grip = v
        S.world.params.grabK = presetGrab(S.scene)
        renderTab()
      }, 'How hard the pointer pulls. The pull counts as work in.')))
    return out
  },

  solver() {
    const w = S.world
    const out = [
      h('h3', { text: 'Integrator' }),
      integratorCards(),
      h('h3', { text: 'Time' }),
      paramControl('dt', { after: paintDtCheck }),
      h('div', { id: 'dtCheck' }),
      segRow('Speed', SPEEDS.map(v => [v, speedLabel(v)]), () => S.speed, v => setSpeed(v), 'Changes how fast time runs on screen, never Δt.'),
      h('div', { class: 'inspBtns' }, h('button', { class: 'btn small', type: 'button', onclick: () => stepOnce(false) }, 'Step once (.)')),
      h('h3', { text: 'Collisions' }),
    ]
    for (const [key, label, help] of SWITCHES) {
      let note = help
      if (key === 'springCollisions' && w.params.springCollisions && w.springs.length && !w.springCollisionsActive()) note = 'Too many pairs for real time, so this is paused here.'
      out.push(toggleRow(label, () => w.params[key], v => setParam(key, v, `${label} ${v ? 'on' : 'off'}`), note))
    }
    if (w.params.walls || w.params.bodyCollisions || w.springCollisionsActive()) out.push(paramControl('restitution'))
    if (w.params.walls) out.push(paramControl('friction'))
    out.push(h('h3', { text: 'This scene as code' }), h('pre', { class: 'code', text: sceneAsCode() }))
    queueMicrotask(paintDtCheck)
    return out
  },

  view() {
    const d = S.display
    const set = (key, v, after) => { d[key] = v; after?.(v); renderTab() }
    const kScale = renderer.arrowK
    const out = [
      h('h3', { text: 'Show' }),
      segRow('Trails (T)', [[false, 'Off'], [true, 'On']], () => d.trails, v => set('trails', v, on => { if (!on) renderer.clearTrails() })),
    ]
    if (d.trails) out.push(slider({ label: 'Trail length', min: 1, max: 20, step: 0.5, unit: 's' }, () => d.trailLen, v => { d.trailLen = v }, 'Changed trail length'))
    out.push(
      segRow('Arrows (A)', [['off', 'Off'], ['selected', 'Selected'], ['all', 'All']], () => d.arrows, v => set('arrows', v)),
      h('div', { class: 'subChecks' },
        h('label', {}, h('input', { type: 'checkbox', checked: d.velocity, onchange: e => set('velocity', e.target.checked) }), 'Velocity'),
        h('label', {}, h('input', { type: 'checkbox', checked: d.forces, onchange: e => set('forces', e.target.checked) }), 'Net force')),
      h('p', { class: 'help', text: kScale.vel || kScale.force
        ? `Scale: ${kScale.vel ? `1 m/s = ${fmt(kScale.vel, 2)} px` : ''}${kScale.vel && kScale.force ? ' · ' : ''}${kScale.force ? `1 N = ${fmt(kScale.force, 2)} px` : ''}. Fixed until restart.`
        : 'Velocity has an open head, force a filled one.' }),
      toggleRow('Colour springs by stretch', () => d.stress, v => set('stress', v), 'Blue squashed, grey at rest, orange stretched. Coils also bunch and spread.'),
      toggleRow('Graph paper', () => d.grid, v => set('grid', v)),
      toggleRow('Centre of mass', () => d.com, v => set('com', v)),
      segRow('Camera', [[false, 'Fixed'], [true, 'Follow centre of mass']], () => d.follow, v => set('follow', v)),
      toggleRow('Ghost twin (G)', () => d.ghost, v => { setGhost(v); renderTab() }, 'A copy started 1 mm away, to see chaos.'),
    )
    if (S.world.catenary) out.push(toggleRow('Ideal catenary', () => d.catenary, v => set('catenary', v), 'The cosh curve a perfect chain of this length would make.'))
    out.push(
      segRow('Theme', [['auto', 'Auto'], ['paper', 'Paper'], ['blueprint', 'Blueprint']], () => S.theme, v => { setTheme(v, true); renderTab() }),
      h('h3', { text: 'Drawing' }),
      segRow('Springs', [['auto', 'Auto'], ['coil', 'Coils'], ['line', 'Lines']], () => d.springStyle === 'string' ? 'auto' : d.springStyle, v => set('springStyle', v)),
      segRow('Colour masses by', [['none', 'Their colour'], ['speed', 'Speed']], () => d.colorBy, v => set('colorBy', v)),
    )
    return out
  },

  chart() { return [energyEl] },
}

function integratorCards() {
  const cur = S.world.params.integrator
  const cards = h('div', { class: 'radioCards', role: 'radiogroup', 'aria-label': 'Integrator' },
    INTEGRATOR_ORDER.map((id, i) => {
      const it = INTEGRATORS[id]
      return h('button', { class: 'radioCard', type: 'button', role: 'radio', 'aria-checked': String(cur === id), onclick: () => { if (cur !== id) setParam('integrator', id, `Switched to ${it.label}`) } },
        h('span', { class: 'key', text: String(i + 1) }), h('strong', { text: it.label }), h('span', { class: 'badge', text: it.order }), h('span', { class: 'note', text: it.note }))
    }))
  const warn = cur === 'euler' || cur === 'python' ? h('p', { class: 'warnNote', text: 'Expect energy to grow. Stiff scenes may blow up.' }) : null
  return h('div', {}, cards, warn)
}

function integratorSelect() {
  const sel = h('select', { class: 'select', 'aria-label': 'Integrator', onchange: e => setParam('integrator', e.target.value, `Switched to ${INTEGRATORS[e.target.value].label}`) },
    INTEGRATOR_ORDER.map((id, i) => h('option', { value: id, selected: S.world.params.integrator === id }, `${i + 1} · ${INTEGRATORS[id].label}`)))
  return h('div', { class: 'row' }, h('div', { class: 'rowTop' }, h('span', { class: 'lbl', text: 'Integrator' })), sel,
    h('p', { class: 'help', text: INTEGRATORS[S.world.params.integrator].note }))
}

function knobControl(kn) {
  const get = () => S.knobs[kn.id]
  const apply = v => { if (v !== get()) rebuildWithKnobs({ [kn.id]: v }, `Changed ${kn.label}`) }
  if (kn.type === 'select') return segRow(kn.label, kn.options, () => get(), v => apply(v))
  if (kn.type === 'reroll') {
    return h('div', { class: 'row' }, h('div', { class: 'rowTop' }, h('span', { class: 'lbl', text: kn.label }),
      h('button', { class: 'btn small', type: 'button', style: 'margin-left:auto', onclick: () => apply((get() || 1) + 1) }, 'Reroll')))
  }
  const c = { label: kn.label, min: kn.min, max: kn.max, step: kn.type === 'int' ? (kn.step || 1) : kn.step, log: kn.type === 'log', unit: kn.unit }
  let pending = get()
  return slider(c, () => pending, v => { pending = kn.type === 'int' ? Math.round(v) : v }, `Changed ${kn.label}`, {
    reset: kn.value,
    // the rebuild records its own undo step
    commit: v => { S.undo.pop(); updateUndoButton(); apply(kn.type === 'int' ? Math.round(v) : v) },
  })
}

function runAction(a) {
  if (a.params) {
    pushUndo(a.label)
    for (const [k, v] of Object.entries(a.params)) {
      S.world.params[k] = v
      if (S.ghost) S.ghost.params[k] = v
    }
    if (Object.keys(a.params).some(k => CONTROLS[k]?.rebase)) S.world.rebase()
    chart.marker(a.params.integrator ? `→ ${INTEGRATORS[a.params.integrator].label}` : a.label)
    toast(a.label, 'Undo', undo)
  }
  if (a.knobs) rebuildWithKnobs(a.knobs, a.label)
  if (a.display) {
    if ('ghost' in a.display) setGhost(a.display.ghost)
    Object.assign(S.display, a.display)
  }
  if (a.tool) setTool(a.tool)
  if (a.speed) { setSpeed(a.speed); toast(`Speed ${speedLabel(a.speed)}`) }
  if (a.chart) setChart(a.chart)
  if (!S.running && !S.world.exploded && (a.params || a.knobs) && !reducedMotion) setRunning(true)
  renderTab()
  updateHud()
  updateLegend()
}

function sceneAsCode() {
  const p = S.world.params
  const forces = []
  if (S.world.springs.length) forces.push(`SpringForce(stiffness=${fmt(p.stiffness)}, zeta=${fmt(p.damping)})`)
  if (p.gravity) forces.push(`GravityForce(g=${fmt(p.gravity)})`)
  if (p.drag) forces.push(`DragForce(gamma=${fmt(p.drag)})`)
  if (p.G) forces.push(`GravitationForce(G=${fmt(p.G)}, eps=${fmt(p.softening)})`)
  if (p.coulomb) forces.push(`CoulombForce(k=${fmt(p.coulomb)}, eps=${fmt(p.softening)})`)
  if (p.temperature) forces.push(`ThermalForce(T=${fmt(p.temperature)}, gamma=${fmt(p.thermostat)})`)
  const cols = []
  if (p.walls) cols.push(`Walls(e=${fmt(p.restitution)}, mu=${fmt(p.friction)})`)
  if (p.bodyCollisions) cols.push(`BallBall(e=${fmt(p.restitution)})`)
  if (p.springCollisions) cols.push('LineSegmentCollisionDetector()')
  const lines = [
    `# ${S.scene.name}: ${S.world.bodies.length} masses, ${S.world.springs.length} springs`,
    'force = CompositeForce([',
    ...forces.map(f => `    ${f},`),
    '])',
    `integrator = ${INTEGRATORS[p.integrator].code}`,
  ]
  if (cols.length) lines.push(`collisions = [${cols.join(', ')}]`)
  lines.push(`simulator = PhysicsSimulator(initializer, force, integrator, dt=${+p.dt.toPrecision(3)})`)
  return lines.join('\n').replace(/−/g, '-')
}

// "." steps 1/60 s of sim time; Shift+. exactly one Δt
function stepOnce(single) {
  if (S.running) setRunning(false)
  const w = S.world
  if (w.exploded) return
  const n = single ? 1 : Math.max(1, Math.round((1 / 60) / w.params.dt))
  w.advance(n)
  S.ghost?.advance(n)
  if (S.display.trails) renderer.recordTrails(w)
  chart.sample(true)
  if (w.exploded) showBlowup()
  updateHud()
}

for (const b of document.querySelectorAll('.tabs [role="tab"]')) {
  b.addEventListener('click', () => {
    S.tab = b.dataset.tab
    if (S.tab !== 'chart') store.set('tab', S.tab)
    renderTab()
    if (S.tab === 'chart') updateLegend()
    if (phone() && !S.sheetOpen) setSheet(true)
  })
  b.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const tabs = [...document.querySelectorAll('.tabs [role="tab"]')].filter(t => t.offsetParent)
    const i = (tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
    tabs[i].focus(); tabs[i].click()
  })
}

// live lines under the Scene tab
function liveReadouts() {
  const ul = $('readouts')
  if (!ul) return
  const w = S.world, lines = []
  const free = w.bodies.filter(b => !b.pinned)
  const m = chart.lastMeasure
  if (w.params.temperature > 0 && free.length && m) lines.push(`T_kin ${fmt(m.kinetic / free.length, 3)} (target ${fmt(w.params.temperature, 3)})`)
  const pins = w.bodies.filter(b => b.pinned && w.springs.some(s => s.a === b || s.b === b))
  if (pins.length && pins.length <= 8 && w.params.gravity) {
    const loads = pins.map(p => { const f = w.forcesOn(p).filter(x => x.spring).reduce((a, x) => [a[0] + x.fx, a[1] + x.fy], [0, 0]); return Math.hypot(...f) })
    lines.push(`Anchors: ${loads.map(v => fmt(v, 3)).join(', ')} N`)
  }
  if (S.ghost) {
    const g = chart.samples[chart.samples.length - 1]?.gap
    if (g != null) lines.push(`Ghost gap ${fmt(g, 3)} m`)
  }
  if (w.snapped) lines.push(`${w.snapped} spring${w.snapped === 1 ? '' : 's'} snapped`)
  ul.replaceChildren(...lines.map(t => h('li', { text: t })))
}

// ---------- energy chart ----------

const SERIES = [
  ['total', 'Total'], ['kinetic', 'Kinetic'], ['spring', 'Spring'],
  ['gravity', 'Gravity'], ['gravitation', 'Gravitational'], ['electric', 'Electric'], ['heat', 'Heat'],
]
const WINDOW = 20 // seconds of sim time shown

const chart = {
  samples: [],
  markers: [],
  hand: false,
  lastMeasure: null,
  range: null,
  hist: null,
  reset() {
    this.samples = []
    this.markers = []
    this.range = null
    this.hist = null
    this.lastMeasure = null
    this.sample(true)
  },
  trim(t) {
    this.samples = this.samples.filter(s => s.t <= t + 1e-9)
    this.markers = this.markers.filter(m => m.t <= t + 1e-9)
    this.range = null
    this.sample(true)
  },
  marker(label) {
    if (!S.world) return
    this.markers.push({ t: S.world.time, label })
    if (this.markers.length > 40) this.markers.shift()
  },
  sample(force) {
    const w = S.world
    const m = w.measure()
    this.lastMeasure = m
    const prev = this.samples[this.samples.length - 1]
    if (!force && prev && w.time - prev.t < 1 / 120) return
    const s = { t: w.time, ...m, hand: this.hand }
    if (w.tracked) {
      const tr = w.tracked
      s.track = tr.idx.map((i, k) => { const b = w.bodies[i]; return b ? (tr.axis === 'x' ? b.x : b.y) - tr.home[k] : 0 })
    }
    if (S.ghost) {
      let gap = 0
      const n = Math.min(w.bodies.length, S.ghost.bodies.length)
      for (let i = 0; i < n; i++) gap = Math.max(gap, Math.hypot(w.bodies[i].x - S.ghost.bodies[i].x, w.bodies[i].y - S.ghost.bodies[i].y))
      s.gap = gap
    }
    if (prev && s.t < prev.t) this.samples = this.samples.filter(x => x.t <= s.t)
    this.samples.push(s)
    while (this.samples.length > 1200 || (this.samples.length && this.samples[0].t < s.t - WINDOW - 1)) this.samples.shift()
    if (S.chart === 'speeds') this.accumulateSpeeds()
  },
  accumulateSpeeds() {
    const free = S.world.bodies.filter(b => !b.pinned)
    if (free.length < 2) return
    const T = this.lastMeasure.kinetic / free.length // 2D, k_B = 1
    const mMean = free.reduce((a, b) => a + b.m, 0) / free.length
    const vrms = Math.sqrt(2 * T / mMean) || 1
    const bins = 20, vmax = 3 * vrms
    if (!this.hist || Math.abs(this.hist.vmax - vmax) / vmax > 0.25) this.hist = { counts: new Float64Array(bins), vmax, total: 0 }
    const H = this.hist, decay = Math.exp(-(1 / 60) / 5)
    for (let i = 0; i < bins; i++) H.counts[i] *= decay
    H.total *= decay
    for (const b of free) {
      const k = Math.floor(Math.hypot(b.vx, b.vy) / H.vmax * bins)
      if (k < bins) H.counts[k] += 1
      H.total += 1
    }
    H.T = T
    H.m = mMean
  },
  views() {
    const v = [['energy', 'Energy'], ['error', 'Error'], ['momentum', 'Momentum']]
    if (S.world.tracked) v.push(['tracked', 'Tracked'])
    if (S.world.bodies.filter(b => !b.pinned).length >= 12) v.push(['speeds', 'Speeds'])
    if (S.ghost) v.push(['gap', 'Ghost gap'])
    return v
  },
  activeSeries() {
    const w = S.world, p = w.params
    const on = {
      total: true, kinetic: true, spring: w.springs.length > 0, gravity: !!p.gravity, gravitation: !!p.G,
      electric: !!p.coulomb && w.bodies.some(b => b.q), heat: w.sinks().filter(x => x !== 'your hand' && x !== 'heat bath').length > 0 || Math.abs(this.lastMeasure?.heat || 0) > 1e-9,
    }
    return SERIES.filter(([k]) => on[k])
  },
  draw() {
    const cv = $('chart')
    if (!cv.offsetParent) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const W = cv.clientWidth, H = cv.clientHeight
    if (W < 10 || H < 10) return
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
    const ctx = cv.getContext('2d'), th = renderer.theme
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = th.sheet
    ctx.fillRect(0, 0, W, H)
    const padL = 48, padR = 10, padT = 8, padB = 18
    const pw = W - padL - padR, ph = H - padT - padB
    ctx.font = '11px "Bricolage Grotesque", system-ui, sans-serif'
    if (S.chart === 'speeds') return this.drawSpeeds(ctx, padL, padT, pw, ph, th)
    const sm = this.samples
    if (sm.length < 2) {
      ctx.fillStyle = th.muted
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(S.running ? 'Recording…' : 'Press Play to record energy.', W / 2, H / 2)
      ctx.textAlign = 'left'
      return
    }
    // the window fills from the left for the first 20 s, then scrolls
    const tStart = Math.max(sm[0].t, sm[sm.length - 1].t - WINDOW), tEnd = tStart + WINDOW
    let lines = []
    let logY = false
    const dashFor = k => SERIES_DASH[k] || [3, 3]
    if (S.chart === 'energy') {
      lines = this.activeSeries().filter(([k]) => !S.hiddenSeries.has(k)).map(([k]) => ({ key: k, color: k === 'heat' ? th.muted : th.series[k], dash: k === 'heat' ? [3, 3] : dashFor(k), width: k === 'total' ? 2.5 : 2, get: s => s[k] }))
      lines.reverse() // total drawn last
    } else if (S.chart === 'error') {
      lines = [{ key: 'error', color: th.series.total, dash: [], width: 2.5, get: s => s.errorPct }]
    } else if (S.chart === 'momentum') {
      lines = [
        { key: 'px', color: th.series.kinetic, dash: [], width: 2, get: s => s.px },
        { key: 'py', color: th.series.spring, dash: [6, 3], width: 2, get: s => s.py },
      ]
    } else if (S.chart === 'tracked') {
      lines = [
        { key: 'x1', color: th.tints[1], dash: [], width: 2, get: s => s.track?.[0] ?? 0 },
        { key: 'x2', color: th.tints[2], dash: [6, 3], width: 2, get: s => s.track?.[1] ?? 0 },
      ]
    } else if (S.chart === 'gap') {
      logY = true
      lines = [{ key: 'gap', color: th.series.total, dash: [], width: 2.5, get: s => s.gap ?? 1e-4 }]
    }
    // y range: includes 0 and everything seen, only ever grows until reset
    let lo = Infinity, hi = -Infinity
    for (const s of sm) {
      if (s.t < tStart) continue
      for (const l of lines) { const v = l.get(s); if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
    }
    if (logY) { lo = 1e-4; hi = Math.max(10, hi) }
    else {
      if (!isFinite(lo)) { lo = 0; hi = 1 }
      lo = Math.min(lo, 0); hi = Math.max(hi, 0)
      if (S.chart === 'error') { lo = Math.min(lo, -1.5); hi = Math.max(hi, 1.5) }
      if (this.range && this.range.key === S.chart) { lo = Math.min(lo, this.range.lo); hi = Math.max(hi, this.range.hi) }
      if (hi - lo < 1e-9) { hi += 1; lo -= 1 }
      const pad = (hi - lo) * 0.06
      this.range = { key: S.chart, lo, hi }
      lo -= lo < 0 ? pad : 0
      hi += pad
    }
    const X = t => padL + (t - tStart) / WINDOW * pw
    const Y = logY
      ? v => padT + ph - (Math.log10(Math.max(v, 1e-4)) + 4) / (Math.log10(hi) + 4) * ph
      : v => padT + ph - (v - lo) / (hi - lo) * ph
    if (S.chart === 'error') {
      ctx.fillStyle = th.minor
      ctx.fillRect(padL, Y(1), pw, Y(-1) - Y(1))
    }
    // shade the moments your hand was pulling
    ctx.fillStyle = th.minor
    let firstBand = null
    for (let i = 1; i < sm.length; i++) {
      if (!sm[i].hand || sm[i].t < tStart) continue
      const x0 = X(sm[i - 1].t)
      ctx.fillRect(x0, padT, Math.max(1, X(sm[i].t) - x0), ph)
      if (firstBand == null) firstBand = x0
    }
    // grid and ticks
    ctx.strokeStyle = th.minor
    ctx.fillStyle = th.muted
    ctx.lineWidth = 1
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    const ticks = logY ? [1e-4, 1e-3, 1e-2, 0.1, 1, 10].filter(v => v <= hi) : niceTicks(lo, hi, 4)
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke()
      ctx.fillText(logY ? (v >= 1 ? `${v} m` : v >= 0.01 ? `${+(v * 100).toPrecision(2)} cm` : `${+(v * 1000).toPrecision(2)} mm`) : fmt(v, 3), padL - 5, y)
    }
    if (!logY && lo < 0 && hi > 0) {
      ctx.strokeStyle = th.axis
      ctx.beginPath(); ctx.moveTo(padL, Math.round(Y(0)) + 0.5); ctx.lineTo(padL + pw, Math.round(Y(0)) + 0.5); ctx.stroke()
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let t = Math.ceil(tStart / 5) * 5; t <= tEnd; t += 5) if (t >= 0) ctx.fillText(`${t} s`, X(t), padT + ph + 4)
    ctx.textAlign = 'left'
    if (firstBand != null) { ctx.fillStyle = th.muted; ctx.fillText('your hand', firstBand + 3, padT + ph - 14) }
    // setting-change markers; when labels crowd, only the newest shows
    let lastLabelX = Infinity
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const mk = this.markers[i]
      if (mk.t < tStart) continue
      const x = Math.round(X(mk.t)) + 0.5
      ctx.strokeStyle = th.muted
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke()
      ctx.setLineDash([])
      if (lastLabelX - x < 40) continue
      const tw = ctx.measureText(mk.label).width
      const lx = Math.min(x + 3, padL + pw - tw - 2)
      ctx.fillStyle = th.sheet
      ctx.fillRect(lx - 2, padT, tw + 4, 14)
      ctx.fillStyle = th.text
      ctx.fillText(mk.label, lx, padT + 1)
      lastLabelX = x
    }
    // lines
    ctx.save()
    ctx.beginPath(); ctx.rect(padL, padT - 2, pw, ph + 4); ctx.clip()
    ctx.lineJoin = 'round'
    for (const l of lines) {
      ctx.strokeStyle = l.color
      ctx.lineWidth = l.width
      ctx.setLineDash(l.dash)
      ctx.beginPath()
      let started = false
      for (const s of sm) {
        if (s.t < tStart - 0.1) continue
        const v = l.get(s)
        if (!isFinite(v)) continue
        const x = X(s.t), y = Y(v)
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true }
      }
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  },
  drawSpeeds(ctx, x0, y0, pw, ph, th) {
    const H = this.hist
    if (!H || H.total < 1) {
      ctx.fillStyle = th.muted
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(S.running ? 'Collecting speeds…' : 'Press Play to collect speeds.', x0 + pw / 2, y0 + ph / 2)
      ctx.textAlign = 'left'
      return
    }
    const bins = H.counts.length, bw = H.vmax / bins
    const dens = Array.from(H.counts, c => c / (H.total * bw))
    // 2D Maxwell–Boltzmann at the current kinetic temperature
    const mb = v => (H.m * v / H.T) * Math.exp(-H.m * v * v / (2 * H.T))
    let top = Math.max(...dens)
    for (let i = 0; i <= 60; i++) top = Math.max(top, mb(H.vmax * i / 60))
    top = top * 1.1 || 1
    ctx.fillStyle = th.series.kinetic
    ctx.globalAlpha = 0.45
    dens.forEach((d, i) => {
      const hgt = d / top * ph
      ctx.fillRect(x0 + i / bins * pw + 1, y0 + ph - hgt, pw / bins - 2, hgt)
    })
    ctx.globalAlpha = 1
    ctx.strokeStyle = th.series.total
    ctx.lineWidth = 2.5
    ctx.beginPath()
    for (let i = 0; i <= 60; i++) {
      const v = H.vmax * i / 60
      const x = x0 + i / 60 * pw, y = y0 + ph - mb(v) / top * ph
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y)
    }
    ctx.stroke()
    ctx.fillStyle = th.muted
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let i = 0; i <= 3; i++) ctx.fillText(`${fmt(H.vmax * i / 3, 2)} m/s`, x0 + i / 3 * pw, y0 + ph + 4)
    ctx.textAlign = 'left'
    ctx.fillStyle = th.text
    ctx.fillText(`Maxwell–Boltzmann (2D) at T = ${fmt(H.T, 2)}`, x0 + 6, y0 + 2)
  },
  legendValues() {
    const m = this.lastMeasure
    if (!m) return
    for (const b of $('legend').querySelectorAll('[data-k]')) {
      const span = b.querySelector('.v')
      const v = m[b.dataset.k]
      if (span && v != null) span.textContent = `${fmt(v, 4)} J`
    }
    const work = $('legend').querySelector('.work')
    if (work) { work.hidden = Math.abs(m.work) < 1e-9; work.textContent = `Work in ${fmt(m.work, 3)} J` }
    const note = $('energyNote')
    let text = ''
    if (S.chart === 'momentum') {
      const out = S.world.momentumOutside()
      text = `L ${fmtFixed(m.Lz, 3)} kg·m²/s · ${out.length ? `not conserved: ${out.join(' · ')}` : 'conserved: nothing outside pushes'}.`
    } else if (S.chart === 'tracked') {
      text = 'How far the first two masses are from where they rest (m).'
    } else if (S.chart === 'gap') {
      text = 'Largest distance between a mass and its ghost, on a log scale. In chaos it grows exponentially.'
    } else if (S.chart === 'speeds') {
      text = 'Speeds (bars) against the 2D Maxwell–Boltzmann curve for the current temperature.'
    } else if (S.chart === 'error') {
      text = 'Total energy now against the start, after taking off heat and work. Only the solver can move this line.'
    } else {
      const sinks = S.world.sinks()
      if (sinks.length) text = `Not conserved here: ${sinks.join(', ')}. The Heat line and Work in keep the books.`
    }
    note.textContent = text
    note.hidden = !text
  },
}

function niceTicks(lo, hi, n) {
  const step = niceStep((hi - lo) / n)
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

function setChart(view) {
  S.chart = view
  chart.range = null
  chart.hist = null
  updateLegend()
}

function swatch(color, dash, width = 2) {
  const sw = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  sw.setAttribute('viewBox', '0 0 16 6')
  sw.setAttribute('aria-hidden', 'true')
  sw.innerHTML = `<line x1="0" y1="3" x2="16" y2="3" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" />`
  return sw
}

function updateLegend() {
  if (!S.world) return
  const views = chart.views()
  if (!views.some(([v]) => v === S.chart)) S.chart = 'energy'
  $('chartView').replaceChildren(...views.map(([v, label]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(S.chart === v), onclick: () => setChart(v) }, label)))
  const leg = $('legend'), th = renderer.theme
  if (S.chart === 'energy') {
    leg.replaceChildren(...chart.activeSeries().map(([k, label]) => h('button', {
      type: 'button', 'data-k': k, 'aria-pressed': String(!S.hiddenSeries.has(k)),
      onclick: e => {
        if (S.hiddenSeries.has(k)) S.hiddenSeries.delete(k); else S.hiddenSeries.add(k)
        e.currentTarget.setAttribute('aria-pressed', String(!S.hiddenSeries.has(k)))
        chart.range = null
      },
    }, swatch(k === 'heat' ? th.muted : th.series[k], (k === 'heat' ? [3, 3] : SERIES_DASH[k]).join(' '), k === 'total' ? 3 : 2), label, ' ', h('span', { class: 'v' }))),
    h('span', { class: 'lg work', hidden: true }))
  } else if (S.chart === 'momentum' || S.chart === 'tracked') {
    const items = S.chart === 'momentum' ? [['pₓ', th.series.kinetic, ''], ['p_y', th.series.spring, '6 3']] : [['Mass 1', th.tints[1], ''], ['Mass 2', th.tints[2], '6 3']]
    leg.replaceChildren(...items.map(([label, color, dash]) => h('span', { class: 'lg' }, swatch(color, dash), label)))
  } else leg.replaceChildren()
  chart.legendValues()
}

// the peek bar's sparkline of total energy (phones)
function drawSpark() {
  const cv = $('spark')
  if (!cv.offsetParent) return
  const dpr = Math.min(devicePixelRatio || 1, 2), W = 96, H = 28
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const sm = chart.samples
  if (sm.length < 2) return
  let lo = Infinity, hi = -Infinity
  for (const s of sm) { lo = Math.min(lo, s.total); hi = Math.max(hi, s.total) }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1 }
  const t0 = sm[0].t, t1 = sm[sm.length - 1].t || 1
  ctx.strokeStyle = renderer.theme.series.total
  ctx.lineWidth = 1.5
  ctx.beginPath()
  sm.forEach((s, i) => {
    const x = (s.t - t0) / Math.max(1e-9, t1 - t0) * (W - 2) + 1, y = H - 2 - (s.total - lo) / (hi - lo) * (H - 4)
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y)
  })
  ctx.stroke()
}

// ---------- phone sheet ----------

function setSheet(open) {
  S.sheetOpen = open
  $('panel').classList.toggle('open', open)
  $('peek').setAttribute('aria-expanded', String(open))
  document.querySelector('.peekCaret').textContent = open ? '▾' : '▴'
}

$('peek').addEventListener('click', () => setSheet(!S.sheetOpen))

// ---------- scene picker ----------

function openPicker() {
  const grid = $('pickerGrid')
  if (!grid.childElementCount) {
    const groups = new Map()
    for (const sc of SCENES) {
      if (!groups.has(sc.group)) groups.set(sc.group, [])
      groups.get(sc.group).push(sc)
    }
    for (const [name, scenes] of groups) {
      grid.append(h('h3', { text: name }), h('div', { class: 'pickerRow' }, scenes.map(sc =>
        h('button', { class: 'sceneCard', type: 'button', 'data-id': sc.id, onclick: () => { closePicker(); if (sc !== S.scene) { loadScene(sc.id); toast(`Switched to ${sc.name}`, 'Undo', undo) } } },
          h('canvas', { 'aria-hidden': 'true' }), h('strong', { text: sc.name }), h('span', { text: sc.tag })))))
    }
  }
  for (const c of grid.querySelectorAll('.sceneCard')) c.setAttribute('aria-current', String(c.dataset.id === S.scene.id))
  S.pickerFrom = document.activeElement
  $('picker').hidden = false
  $('scenePick').setAttribute('aria-expanded', 'true')
  tips.seenPicker = true
  if (tips.step === 2) tips.next()
  // phones pause while the full-screen picker covers the sim
  if (phone() && S.running) { S.resumeAfterPicker = true; setRunning(false) }
  requestAnimationFrame(() => {
    for (const c of grid.querySelectorAll('.sceneCard')) {
      const cv = c.querySelector('canvas')
      if (cv.dataset.theme === renderer.themeName) continue
      const sc = sceneById(c.dataset.id)
      drawThumbnail(cv, buildScene(sc), sc.view, renderer.themeName)
      cv.dataset.theme = renderer.themeName
    }
    grid.querySelector('[aria-current="true"]')?.focus()
  })
}

function closePicker() {
  if ($('picker').hidden) return
  $('picker').hidden = true
  $('scenePick').setAttribute('aria-expanded', 'false')
  if (S.resumeAfterPicker) { S.resumeAfterPicker = false; setRunning(true) }
  S.pickerFrom?.focus?.()
}

$('scenePick').addEventListener('click', openPicker)
$('pickerClose').addEventListener('click', closePicker)
$('picker').addEventListener('click', e => { if (e.target === $('picker')) closePicker() })

// ---------- modals: help, share ----------

function openModal(id) {
  S.modalFrom = document.activeElement
  $(id).hidden = false
  $(id).querySelector('.iconBtn')?.focus()
}

function closeModal(id) {
  if ($(id).hidden) return
  $(id).hidden = true
  S.modalFrom?.focus?.()
}

// keep Tab inside an open dialog
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return
  const open = ['help', 'shareBox', 'picker'].map($).find(el => !el.hidden)
  if (!open) return
  const items = [...open.querySelectorAll('button, a[href], input, select')].filter(el => el.offsetParent)
  if (!items.length) return
  const first = items[0], lastEl = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus() }
  else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus() }
})

$('helpBtn').addEventListener('click', () => openModal('help'))
$('helpClose').addEventListener('click', () => closeModal('help'))
$('help').addEventListener('click', e => { if (e.target === $('help')) closeModal('help') })
$('tipsAgain').addEventListener('click', () => { tips.step = 0; store.set('tips', '0'); closeModal('help'); tips.show() })

async function shareLink() {
  const base = location.href.split('#')[0]
  let hash, what
  if (!S.edited) {
    const parts = [S.scene.id]
    const kd = knobDefaults(S.scene)
    for (const [k, v] of Object.entries(S.knobs)) if (kd[k] !== v) parts.push(`${k}=${encodeURIComponent(v)}`)
    const pd = presetParams()
    for (const [k, short] of Object.entries(SHORT)) {
      const v = S.world.params[k]
      if (pd[k] === v) continue
      parts.push(`${short}=${typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? +v.toPrecision(4) : v}`)
    }
    const dd = { ...DEFAULT_DISPLAY, ...S.scene.display }
    if (dd.trails !== S.display.trails) parts.push(`trails=${S.display.trails ? 1 : 0}`)
    if (dd.arrows !== S.display.arrows) parts.push(`arrows=${S.display.arrows}`)
    if (S.speed !== 1) parts.push(`speed=${S.speed}`)
    hash = parts.join('&')
    what = `Opens ${S.scene.name} from the start with your settings.`
  } else {
    const data = JSON.stringify({ s: S.scene.id, k: S.knobs, w: S.world.toJSON(4), m: worldMeta(S.world), d: S.display })
    hash = await packState(data)
    what = 'Opens your edited scene exactly as it is right now.'
  }
  const url = `${base}#${hash}`
  if (url.length > 6000) what += ` This link is long (${Math.round(url.length / 1024)} KB). Some chat apps may cut it off.`
  return { url, what }
}

async function packState(text) {
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return 's=' + b64url(new Uint8Array(await new Response(stream).arrayBuffer()))
  } catch {
    return 'j=' + b64url(new TextEncoder().encode(text))
  }
}

async function unpackState(hash) {
  const kind = hash.slice(0, 2), bytes = unb64url(hash.slice(2))
  if (kind === 'j=') return JSON.parse(new TextDecoder().decode(bytes))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return JSON.parse(await new Response(stream).text())
}

function b64url(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

$('shareBtn').addEventListener('click', async () => {
  const { url, what } = await shareLink()
  if (navigator.share && coarse) {
    try { await navigator.share({ title: `Newton sim: ${S.scene.name}`, url }); return } catch (e) { if (e.name === 'AbortError') return }
  }
  $('shareUrl').value = url
  $('shareWhat').textContent = what
  $('shareCopy').textContent = 'Copy again'
  openModal('shareBox')
  try { await navigator.clipboard.writeText(url); $('shareWhat').textContent = `Link copied. ${what}` }
  catch { $('shareUrl').select(); $('shareWhat').textContent = `${what} Press Ctrl+C to copy.` }
})
$('shareCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('shareUrl').value); $('shareCopy').textContent = 'Copied ✓' }
  catch { $('shareUrl').focus(); $('shareUrl').select() }
})
$('shareClose').addEventListener('click', () => closeModal('shareBox'))
$('shareBox').addEventListener('click', e => { if (e.target === $('shareBox')) closeModal('shareBox') })

// values from a link are untrusted: clamp numbers, accept only known options
function validKnob(kn, v) {
  if (kn.type === 'select') return kn.options.find(([val]) => String(val) === v)?.[0]
  const n = +v
  if (v === '' || !isFinite(n)) return undefined
  if (kn.type === 'reroll') return Math.max(1, Math.min(1e6, Math.round(n)))
  const c = Math.max(kn.min, Math.min(kn.max, n))
  return kn.type === 'int' ? Math.round(c) : c
}

function validParam(scene, key, v) {
  const kind = typeof new World(scene.params).params[key]
  if (kind === 'boolean') return v === '1' || v === 'true'
  if (key === 'integrator') return INTEGRATORS[v] ? v : undefined
  const n = +v
  if (v === '' || !isFinite(n)) return undefined
  const c = CONTROLS[key]
  return c ? Math.max(c.min ?? 0, Math.min(c.max ?? Infinity, n)) : Math.max(0, n)
}

async function loadFromHash() {
  const raw = location.hash.slice(1)
  if (!raw) return false
  try {
    if (raw.startsWith('s=') || raw.startsWith('j=')) {
      const o = await unpackState(raw)
      const scene = sceneById(o.s)
      if (!scene) throw new Error('unknown scene')
      S.scene = scene
      S.knobs = { ...knobDefaults(scene), ...o.k }
      S.display = { ...DEFAULT_DISPLAY, ...scene.display, ...o.d }
      S.chart = scene.chart || 'energy'
      const w = World.fromJSON(o.w)
      if (!w.bodies.every(b => isFinite(b.x + b.y + b.vx + b.vy + b.m + b.r) && b.m > 0 && b.r > 0)) throw new Error('bad bodies')
      S.sceneSize = { bodies: w.bodies.length, springs: w.springs.length }
      setWorld(w, o.m)
      S.edited = true
      markRunStart()
      afterWorldChange({ refit: true })
      return true
    }
    const [id, ...rest] = raw.split('&')
    const scene = sceneById(decodeURIComponent(id))
    if (!scene) throw new Error('unknown scene')
    const knobs = {}, params = {}
    let display = {}
    for (const part of rest) {
      const [k, rawV] = part.split('=')
      const v = decodeURIComponent(rawV ?? '')
      const num = v === '' || isNaN(+v) ? v : +v
      const kn = scene.knobs?.find(x => x.id === k)
      if (LONG[k]) {
        const val = validParam(scene, LONG[k], v)
        if (val !== undefined) params[LONG[k]] = val
      } else if (kn) {
        const val = validKnob(kn, v)
        if (val !== undefined) knobs[kn.id] = val
      }
      else if (k === 'trails') display.trails = v === '1'
      else if (k === 'arrows' && ['off', 'selected', 'all'].includes(v)) display.arrows = v
      else if (k === 'speed' && SPEEDS.includes(num)) S.speed = num
    }
    loadScene(scene.id, knobs, { undoable: false })
    Object.assign(S.world.params, params)
    S.world.rebase()
    chart.reset()
    markRunStart()
    Object.assign(S.display, display)
    afterWorldChange({})
    // keep the settings in the address bar so a reload gets them too
    history.replaceState(null, '', '#' + raw)
    return true
  } catch (e) {
    console.warn('Could not read the link', e)
    loadScene(DEFAULT_SCENE, {}, { undoable: false })
    toast(`That link couldn’t be read, so here’s the ${S.scene.name.replace(/^Original /, '')}.`)
    return true
  }
}

// ---------- theme ----------

function setTheme(choice, save) {
  S.theme = choice
  const name = choice === 'auto' ? (darkQuery.matches ? 'blueprint' : 'paper') : choice
  renderer.setTheme(name)
  document.documentElement.dataset.theme = name === 'blueprint' ? 'dark' : 'light'
  $('themeLabel').textContent = name === 'blueprint' ? 'Paper' : 'Blueprint'
  $('themeBtn').setAttribute('aria-label', `Switch to the ${name === 'blueprint' ? 'paper' : 'blueprint'} theme`)
  document.querySelector('meta[name="theme-color"]').content = name === 'blueprint' ? '#0E1638' : '#1E2A5A'
  if (save) store.set('theme', choice)
  paintKey()
  updateLegend()
}

darkQuery.addEventListener('change', () => { if (S.theme === 'auto') setTheme('auto') })
$('themeBtn').addEventListener('click', () => setTheme(renderer.themeName === 'paper' ? 'blueprint' : 'paper', true))

// ---------- key card ----------

function paintKey() {
  const th = renderer.theme
  $('keyRamp').style.background = `linear-gradient(to right, ${th.ramp.join(', ')})`
  const arrow = (color, open) => `<svg viewBox="0 0 26 14"><line x1="1" y1="7" x2="${open ? 24 : 18}" y2="7" stroke="${color}" stroke-width="2"/>${open ? `<polyline points="18,3 24,7 18,11" fill="none" stroke="${color}" stroke-width="2"/>` : `<polygon points="17,3 25,7 17,11" fill="${color}" stroke="none"/>`}</svg>`
  $('keyList').innerHTML = `
    <li>${arrow(th.vel, true)} Velocity</li>
    <li>${arrow(th.force, false)} Net force</li>
    <li><svg viewBox="0 0 26 14"><circle cx="13" cy="7" r="5" fill="${th.pinFill}" stroke="${th.pinStroke}" stroke-width="2"/><circle cx="13" cy="7" r="1.4" fill="${th.pinStroke}" stroke="none"/></svg> Pinned in place</li>
    <li><svg viewBox="0 0 26 14"><circle cx="7" cy="7" r="6" fill="${th.qPos}" stroke="none"/><path d="M4 7h6M7 4v6" stroke="${th.qGlyph}" stroke-width="1.6"/><circle cx="19" cy="7" r="6" fill="${th.qNeg}" stroke="none"/><path d="M16 7h6" stroke="${th.qGlyph}" stroke-width="1.6"/></svg> Positive and negative charge</li>`
}

$('keyBtn').addEventListener('click', () => {
  const open = $('keyCard').hidden
  $('keyCard').hidden = !open
  $('keyBtn').setAttribute('aria-expanded', String(open))
})

// ---------- panel ----------

function togglePanel(open = !S.panelOpen, save = true) {
  S.panelOpen = open
  $('card').classList.toggle('panelClosed', !open)
  $('panelBtn').setAttribute('aria-expanded', String(open))
  if (save) store.set('panel', open ? '1' : '0')
}

$('panelBtn').addEventListener('click', () => togglePanel())

// ---------- header buttons ----------

$('playBtn').addEventListener('click', () => setRunning(!S.running))
$('bigPlay').addEventListener('click', () => setRunning(true))
$('restartBtn').addEventListener('click', e => (e.shiftKey ? reloadPreset() : restart()))
$('stepBtn').addEventListener('click', e => stepOnce(e.shiftKey))
$('speedBtn').addEventListener('click', cycleSpeed)
$('fitBtn').addEventListener('click', () => fitView())
$('recenterBtn').addEventListener('click', () => fitView())
$('undoBtn').addEventListener('click', undo)
$('modeChip').addEventListener('click', () => setTool('grab'))
for (const b of document.querySelectorAll('.tool[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool))
for (const seg of $('buildBar').querySelectorAll('.seg')) {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b) return
    S.build[seg.dataset.opt] = +b.dataset.v
    syncBuildBar()
  })
}
$('buildPinned').addEventListener('change', e => { S.build.pinned = e.target.checked })

// ---------- keyboard ----------

// after a mouse click, give Space back to play/pause (keyboard focus stays put)
document.addEventListener('click', e => {
  if (e.detail === 0) return
  const b = e.target.closest?.('button')
  if (b && !b.closest('.modal, .picker') && document.activeElement === b) b.blur()
})

// arrow keys move between options in a radio group, as in native radios
document.addEventListener('keydown', e => {
  const t = e.target
  if (t.getAttribute?.('role') !== 'radio' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
  const group = t.closest('[role="radiogroup"]')
  if (!group) return
  const radios = [...group.querySelectorAll('[role="radio"]')]
  const i = radios.indexOf(t) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)
  const next = radios[(i + radios.length) % radios.length]
  e.preventDefault()
  e.stopPropagation()
  next.click()
  // the group may have re-rendered; focus the option now checked
  requestAnimationFrame(() => {
    const live = document.querySelector(`[role="radiogroup"][aria-label="${group.getAttribute('aria-label')}"] [role="radio"][aria-checked="true"]`)
    ;(live || next).focus()
  })
}, true)

// one tab stop per radio group: the checked option
function rovingRadios(root = document) {
  for (const g of root.querySelectorAll('[role="radiogroup"]')) {
    const radios = [...g.querySelectorAll('[role="radio"]')]
    const on = radios.find(r => r.getAttribute('aria-checked') === 'true') || radios[0]
    for (const r of radios) r.tabIndex = r === on ? 0 : -1
  }
}
let rovingQueued = false
new MutationObserver(() => {
  if (rovingQueued) return
  rovingQueued = true
  requestAnimationFrame(() => { rovingQueued = false; rovingRadios() })
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked'] })

function cycleArrows() {
  const order = ['off', 'selected', 'all']
  S.display.arrows = order[(order.indexOf(S.display.arrows) + 1) % 3]
  toast(`Arrows: ${{ off: 'off', selected: 'selected mass', all: 'all masses' }[S.display.arrows]}`)
  if (S.tab === 'view') renderTab()
}

function selectNext(dir) {
  const bodies = S.world.bodies
  if (!bodies.length) return
  const i = bodies.indexOf(S.selected)
  select(bodies[(i + dir + bodies.length + (i < 0 && dir < 0 ? 1 : 0)) % bodies.length])
}

document.addEventListener('keydown', e => {
  const t = e.target
  const typing = t.closest?.('input, textarea, select') && t.type !== 'range' && t.type !== 'checkbox'
  const modal = !$('help').hidden || !$('shareBox').hidden || !$('picker').hidden
  if (e.key === 'Escape') {
    if (modal) { closeModal('help'); closeModal('shareBox'); closePicker(); return }
    if (!$('keyCard').hidden) { $('keyCard').hidden = true; return }
    if (ptr.mode) { cancelGesture(); return }
    if (S.selected) { select(null); return }
    if (S.tool !== 'grab') { setTool('grab'); return }
    if (phone() && S.sheetOpen) setSheet(false)
    return
  }
  if (typing || modal) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
  if (mod && e.key === 'y') { e.preventDefault(); redo(); return }
  if (mod || e.altKey) return
  const k = e.key
  if (k === ' ') {
    if (t !== canvas && t.closest?.('button, a[href], summary, select, [role], input:not([type="range"])')) return
    e.preventDefault(); setRunning(!S.running); return
  }
  if (t.type === 'range' && (k.startsWith('Arrow') || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown')) return
  switch (k) {
    case '.': stepOnce(false); break
    case '>': stepOnce(true); break
    case 'r': restart(); break
    case 'R': reloadPreset(); break
    case 'v': case 'V': setTool('grab'); break
    case 'b': case 'B': setTool('build'); break
    case 'p': case 'P': setTool('pin'); break
    case 'x': case 'X': setTool('snip'); break
    case '1': case '2': case '3': case '4': case '5': {
      const id = INTEGRATOR_ORDER[+k - 1]
      if (S.world.params.integrator !== id) { setParam('integrator', id, `Switched to ${INTEGRATORS[id].label}`); toast(`Integrator: ${INTEGRATORS[id].label}`, 'Undo', undo) }
      break
    }
    case '[': case ']': {
      const i = SCENES.indexOf(S.scene)
      loadScene(SCENES[(i + (k === ']' ? 1 : SCENES.length - 1)) % SCENES.length].id)
      toast(`Switched to ${S.scene.name}`, 'Undo', undo)
      break
    }
    case '-': case '_': setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(S.speed) - 1)]); break
    case '=': case '+': setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + 1)]); break
    case 'f': case 'F': fitView(); break
    case 't': case 'T':
      S.display.trails = !S.display.trails
      if (!S.display.trails) renderer.clearTrails()
      toast(`Trails ${S.display.trails ? 'on' : 'off'}`)
      if (S.tab === 'view') renderTab()
      break
    case 'a': case 'A': cycleArrows(); break
    case 'g': case 'G':
      setGhost(!S.display.ghost)
      toast(S.display.ghost ? 'Ghost twin on: a copy started 1 mm away' : 'Ghost twin off')
      if (S.tab === 'view') renderTab()
      break
    case 'n': selectNext(1); break
    case 'N': selectNext(-1); break
    case '?': openModal('help'); break
    case '\\': togglePanel(); break
    case 'Delete': case 'Backspace':
      if (S.selected) {
        e.preventDefault()
        const body = isBody(S.selected)
        if (body) { pushUndo('Deleted a mass'); S.world.removeBody(S.selected) }
        else { pushUndo('Cut a spring'); S.world.removeSpring(S.selected) }
        edited('cut')
        select(null)
        toast(body ? 'Deleted a mass' : 'Cut 1 spring', 'Undo', undo)
      }
      break
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      if (t !== canvas && t !== document.body) return
      e.preventDefault()
      const dx = renderer.w * 0.1, dy = renderer.h * 0.1
      renderer.panBy(k === 'ArrowLeft' ? dx : k === 'ArrowRight' ? -dx : 0, k === 'ArrowUp' ? dy : k === 'ArrowDown' ? -dy : 0)
      S.userCamera = true
      break
    }
    default: return
  }
})

// ---------- resize, visibility ----------

function onResize() {
  renderer.resize()
  renderer.avoid = phone()
    ? [[0, 0, 140, 50], [renderer.w - 130, 0, 130, 60], [0, renderer.h - 64, 300, 64], [renderer.w - 60, renderer.h - 60, 60, 60]]
    : [[0, 0, 74, 310], [renderer.w - 230, 0, 230, 120], [renderer.w - 200, renderer.h - 56, 200, 56], [0, renderer.h - 44, 150, 44]]
  if (!S.scene) return
  // a fitted view refits; a panned one keeps its centre and scale
  if (!S.userCamera) fitView(true)
  placeEnergy()
}

new ResizeObserver(onResize).observe($('stage'))
let wasPhone = phone()
addEventListener('resize', () => {
  if (phone() !== wasPhone) {
    wasPhone = phone()
    if (S.tab === 'chart' && !wasPhone) S.tab = 'scene'
    renderTab()
  }
})

// pause in a background tab and pick up again on return; browsers can
// report "hidden" twice, so only a running sim arms the resume
let resumeOnShow = false
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (S.running) { resumeOnShow = true; setRunning(false) }
  } else if (resumeOnShow) {
    resumeOnShow = false
    last = performance.now()
    setRunning(true)
  }
})

// for the curious: poke at the running sim from the console
window.sim = { state: S, renderer, scenes: SCENES, load: id => loadScene(id) }

// ---------- start ----------

async function start() {
  setTheme(store.get('theme') || 'auto')
  const savedTab = store.get('tab')
  if (savedTab && TABS[savedTab] && savedTab !== 'chart') S.tab = savedTab
  togglePanel(store.get('panel') !== '0')
  onResize()
  const fromLink = await loadFromHash()
  if (!fromLink) loadScene(DEFAULT_SCENE, {}, { undoable: false })
  if (reducedMotion) {
    S.running = false
    updatePlay()
    $('bigPlay').hidden = false
    $('bigPlay').querySelector('span').textContent = `Paused because your system asks for reduced motion. Press Play${coarse ? '' : ' or Space'} to start.`
  }
  addEventListener('hashchange', () => {
    const raw = location.hash.slice(1)
    if (raw && raw !== S.scene.id) loadFromHash()
  })
  tips.init()
  requestAnimationFrame(t => { last = t; requestAnimationFrame(frame) })
}

start()
