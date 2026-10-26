// Scene presets: the SystemInitializer half of simulation.py.
// Each scene sets physics params, a view rectangle (metres), optional knobs
// that rebuild it, and "Try this" prompts whose buttons change the setup.

import { World, mulberry32 } from './engine.js'

const TAU = Math.PI * 2
const deg = d => d * Math.PI / 180

// try-this actions are plain data the app applies:
//   { label, params: {...} }   set physics params
//   { label, knobs: {...} }    rebuild with these knob values
//   { label, display: {...} }  change the view
//   { label, tool: 'snip' }    pick a tool
//   { label, speed: 0.25 }     change speed
//   { label, chart: 'speeds' } switch the chart
// tools: defaults for masses and springs added with Build in this scene

export const SCENES = [
  {
    id: 'hexagon',
    name: 'Original hexagon',
    group: 'Start here',
    tag: 'simulation.py',
    blurb: 'The setup from simulation.py, running live: six 1 kg masses on a ring of 1 N/m springs, with one corner nudged. It even uses the Python’s own integrator.',
    try: [
      { text: 'The Python “RK4” holds the force fixed through all four stages, so total energy creeps up. Switch to Velocity Verlet and the line goes flat.', actions: [{ label: 'Use Verlet', params: { integrator: 'verlet' } }, { label: 'Back to the Python step', params: { integrator: 'python' } }] },
      { text: 'A bigger time step makes the drift faster.', actions: [{ label: 'Δt 50 ms', params: { dt: 0.05 } }] },
      { text: 'A ring of six springs is floppy: a rigid 2D shape needs 2N − 3 = 9. Pick Build and add three diagonals.', actions: [{ label: 'Pick Build', tool: 'build' }] },
    ],
    featured: ['integrator', 'dt', 'temperature'],
    view: { x0: -2, x1: 2, y0: -2, y1: 2 },
    params: { integrator: 'python', dt: 0.01, springCollisions: true, restitution: 1, grabK: 5 },
    tools: { mass: 1, radius: 0.06, k: 1 },
    knobs: [
      { id: 'sides', label: 'Sides', type: 'int', min: 3, max: 12, value: 6 },
      { id: 'nudge', label: 'Nudge', type: 'num', min: 0, max: 0.5, step: 0.01, value: 0.28, unit: 'm' },
    ],
    build(w, k) {
      const n = k.sides, bs = []
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU
        bs.push(w.addBody({ x: Math.cos(a), y: Math.sin(a), m: 1, r: 0.06 }))
      }
      // simulation.py nudges the last mass by (0.2, -0.2)
      bs[n - 1].x += k.nudge / Math.SQRT2
      bs[n - 1].y -= k.nudge / Math.SQRT2
      const side = 2 * Math.sin(Math.PI / n)
      for (let i = 0; i < n; i++) w.addSpring(bs[i], bs[(i + 1) % n], { k: 1, rest: side })
    },
  },

  {
    id: 'cloth',
    name: 'Tearable cloth',
    group: 'Start here',
    tag: 'Tearing',
    blurb: 'A net of light masses and rope springs hanging from pins. Pull hard enough and it rips; every snapped spring turns its stored energy into heat.',
    try: [
      { text: 'Grab the cloth and yank it down until it tears.' },
      { text: 'Or swipe through it with Snip.', actions: [{ label: 'Pick Snip', tool: 'snip' }] },
      { text: 'Unpin a corner and watch it peel away.', actions: [{ label: 'Pick Pin', tool: 'pin' }] },
    ],
    featured: ['tearStrain', 'gravity', 'damping'],
    view: { x0: -1.45, x1: 1.45, y0: -1.0, y1: 1.15 },
    params: { gravity: 9.81, drag: 0.3, damping: 0.1, tearStrain: 0.35, integrator: 'symplectic', dt: 0.0005, grabK: 50 },
    display: { springStyle: 'line' },
    tools: { mass: 0.01, radius: 0.012, k: 500 },
    knobs: [
      { id: 'cols', label: 'Columns', type: 'int', min: 10, max: 40, value: 25 },
      { id: 'pins', label: 'Pin every', type: 'select', options: [[1, '1 node'], [2, '2 nodes'], [4, '4 nodes']], value: 4 },
    ],
    build(w, k) {
      const cols = k.cols, s = 0.1, rows = 17
      const x0 = -(cols - 1) * s / 2
      const grid = []
      for (let j = 0; j < rows; j++) {
        const row = []
        for (let i = 0; i < cols; i++) row.push(w.addBody({ x: x0 + i * s, y: 1 - j * s, m: 0.01, r: 0.012 }))
        grid.push(row)
      }
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if (i + 1 < cols) w.addSpring(grid[j][i], grid[j][i + 1], { k: 500, kind: 'rope' })
          if (j + 1 < rows) w.addSpring(grid[j][i], grid[j + 1][i], { k: 500, kind: 'rope' })
        }
      }
      for (let i = 0; i < cols; i += +k.pins) grid[0][i].pinned = true
      grid[0][cols - 1].pinned = true
      // let it settle for a second before springs may snap
      w.tearAfter = 1
    },
  },

  {
    id: 'pendulum',
    name: 'Double pendulum',
    group: 'Start here',
    tag: 'Chaos',
    blurb: 'Two 1 kg bobs on stiff 1 m arms. Simple rules, unpredictable motion: a tiny change in the start grows until the paths share nothing.',
    try: [
      { text: 'Turn on the ghost twin: a copy started 1 mm away keeps pace for a few seconds, then goes its own way.', actions: [{ label: 'Ghost twin on', display: { ghost: true } }] },
      { text: 'Drag the lower bob up high and let go.' },
    ],
    featured: ['gravity', 'dt'],
    view: { x0: -2.3, x1: 2.3, y0: -2.3, y1: 2.3 },
    params: { gravity: 9.81, integrator: 'verlet', dt: 0.0005, grabK: 200 },
    display: { trails: true, trailLen: 6 },
    tools: { mass: 1, radius: 0.09, k: 1000 },
    knobs: [
      { id: 'angle', label: 'Start angle', type: 'int', min: 0, max: 180, value: 90, unit: '°' },
      { id: 'm2', label: 'Lower bob', type: 'log', min: 0.1, max: 10, value: 1, unit: 'kg' },
    ],
    build(w, k) {
      const a = deg(k.angle)
      const pivot = w.addBody({ x: 0, y: 0, pinned: true, r: 0.05 })
      const b1 = w.addBody({ x: Math.sin(a), y: -Math.cos(a), m: 1, r: 0.09, tint: 1 })
      const b2 = w.addBody({ x: 2 * Math.sin(a), y: -2 * Math.cos(a), m: k.m2, r: 0.09 * Math.cbrt(k.m2), tint: 2 })
      w.addSpring(pivot, b1, { k: 10000, rest: 1, kind: 'rod' })
      w.addSpring(b1, b2, { k: 10000, rest: 1, kind: 'rod' })
    },
  },

  {
    id: 'cradle',
    name: 'Newton’s cradle',
    group: 'Collisions',
    tag: 'Momentum',
    blurb: 'Five steel balls on strings. Momentum and energy both have to come out the other side, and only one way manages both.',
    try: [
      { text: 'Lift two and exactly two swing out: nothing else conserves both momentum and energy.', actions: [{ label: 'Lift 2', knobs: { lift: 2 } }, { label: 'Lift 3', knobs: { lift: 3 } }] },
      { text: 'Make the balls a little less bouncy and the whole row ends up swinging together.', actions: [{ label: 'Bounciness 0.9', params: { restitution: 0.9 } }] },
      { text: 'Watch a collision in slow motion.', actions: [{ label: 'Slow motion ¼×', speed: 0.25 }] },
    ],
    featured: ['restitution', 'gravity'],
    view: { x0: -1.6, x1: 1.6, y0: -1.3, y1: 0.3 },
    params: { gravity: 9.81, bodyCollisions: true, restitution: 1, integrator: 'verlet', dt: 0.0005, grabK: 100 },
    display: { springStyle: 'string' },
    tools: { mass: 1, radius: 0.1, k: 20000 },
    knobs: [
      { id: 'lift', label: 'Balls lifted', type: 'int', min: 1, max: 4, value: 1 },
      { id: 'balls', label: 'Balls', type: 'int', min: 3, max: 7, value: 5 },
    ],
    build(w, k) {
      const r = 0.1, n = k.balls, gap = 0.201
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * gap
        const anchor = w.addBody({ x, y: 0, pinned: true, r: 0.025 })
        const a = i < Math.min(k.lift, n - 1) ? -deg(40) : 0
        const ball = w.addBody({ x: x + Math.sin(a), y: -Math.cos(a), m: 1, r })
        w.addSpring(anchor, ball, { k: 20000, rest: 1, kind: 'rope' })
      }
    },
  },

  {
    id: 'charges',
    name: 'Charges in a box',
    group: 'Collisions',
    tag: 'Electrostatics',
    blurb: 'Positive and negative charges bouncing in a box under Coulomb’s law. Opposites attract and likes repel.',
    try: [
      { text: 'Add drag: as the ions lose energy they lock into chains of alternating charge, like salt.', actions: [{ label: 'Drag 0.5', params: { drag: 0.5 } }] },
      { text: 'Switch the charge off and add more balls: an ideal gas. Collisions spread the speeds into the Maxwell–Boltzmann curve.', actions: [{ label: 'Ideal gas', params: { drag: 0 }, knobs: { n: 48, q: 0 }, chart: 'speeds' }] },
    ],
    featured: ['coulomb', 'drag', 'restitution'],
    view: { x0: -2.2, x1: 2.2, y0: -2.2, y1: 2.2 },
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    params: { coulomb: 1, softening: 0.05, walls: true, restitution: 1, friction: 0, bodyCollisions: true, integrator: 'verlet', dt: 0.002, grabK: 10 },
    tools: { mass: 1, radius: 0.12, k: 20 },
    knobs: [
      { id: 'n', label: 'Particles', type: 'int', min: 8, max: 48, step: 2, value: 16 },
      { id: 'q', label: 'Charge', type: 'num', min: 0, max: 2, step: 0.1, value: 1 },
      { id: 'seed', label: 'Layout', type: 'reroll', value: 1 },
    ],
    build(w, k) {
      const rng = mulberry32(k.seed * 7919)
      const n = k.n, side = Math.ceil(Math.sqrt(n)), gap = 3.6 / side
      const charges = Array.from({ length: n }, (_, i) => i % 2 ? 1 : -1)
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [charges[i], charges[j]] = [charges[j], charges[i]] }
      let mx = 0, my = 0
      const bs = []
      for (let i = 0; i < n; i++) {
        const a = rng() * TAU
        const b = w.addBody({
          x: -1.8 + gap * (i % side + 0.5) + (rng() - 0.5) * gap / 3,
          y: -1.8 + gap * (Math.floor(i / side) + 0.5) + (rng() - 0.5) * gap / 3,
          vx: Math.cos(a), vy: Math.sin(a), m: 1, r: Math.min(0.12, gap * 0.3), q: charges[i] * k.q,
        })
        mx += b.vx; my += b.vy
        bs.push(b)
      }
      for (const b of bs) { b.vx -= mx / n; b.vy -= my / n }
    },
  },

  {
    id: 'jelly',
    name: 'Jelly',
    group: 'Soft bodies',
    tag: 'Soft body',
    blurb: 'A braced grid of springs dropped on the floor: squish, wobble, settle. Spring damping turns the wobble into heat.',
    try: [
      { text: 'Take away the diagonals: with nothing to stop it shearing, the square folds flat.', actions: [{ label: 'No bracing', knobs: { brace: 'none' } }, { label: 'Both diagonals', knobs: { brace: 'both' } }] },
      { text: 'Set damping to 0 and the landing turns into endless wobble.', actions: [{ label: 'Damping 0', params: { damping: 0 } }] },
      { text: 'Fling it at a wall.' },
    ],
    featured: ['stiffness', 'damping', 'gravity'],
    view: { x0: -3.1, x1: 3.1, y0: -0.2, y1: 4.1 },
    bounds: { minX: -3, maxX: 3, minY: 0, maxY: 4 },
    params: { gravity: 9.81, damping: 0.2, walls: true, restitution: 0.2, friction: 0.6, integrator: 'verlet', dt: 0.001, grabK: 100 },
    tools: { mass: 0.05, radius: 0.04, k: 200 },
    knobs: [
      { id: 'brace', label: 'Bracing', type: 'select', options: [['both', 'Both diagonals'], ['one', 'One diagonal'], ['none', 'None']], value: 'both' },
      { id: 'size', label: 'Size', type: 'int', min: 4, max: 8, value: 6 },
    ],
    build(w, k) {
      const n = k.size, s = 1 / (n - 1)
      const rot = deg(20)
      // lowest corner of the rotated metre square sits 1 m above the floor
      const cx = -1, cy = 1 + 0.5 * (Math.cos(rot) + Math.sin(rot))
      const grid = []
      for (let j = 0; j < n; j++) {
        const row = []
        for (let i = 0; i < n; i++) {
          const lx = i * s - 0.5, ly = j * s - 0.5
          row.push(w.addBody({
            x: cx + lx * Math.cos(rot) - ly * Math.sin(rot),
            y: cy + lx * Math.sin(rot) + ly * Math.cos(rot),
            vx: 1, m: 0.05, r: 0.04,
          }))
        }
        grid.push(row)
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if (i + 1 < n) w.addSpring(grid[j][i], grid[j][i + 1], { k: 200 })
          if (j + 1 < n) w.addSpring(grid[j][i], grid[j + 1][i], { k: 200 })
          if (i + 1 < n && j + 1 < n) {
            if (k.brace !== 'none') w.addSpring(grid[j][i], grid[j + 1][i + 1], { k: 200 })
            if (k.brace === 'both') w.addSpring(grid[j][i + 1], grid[j + 1][i], { k: 200 })
          }
        }
      }
    },
  },

  {
    id: 'chain',
    name: 'Hanging chain',
    group: 'Soft bodies',
    tag: 'Catenary',
    blurb: 'A chain hung between two pins settles into a cosh curve, a catenary, not a parabola. Drop balls on it and they bounce off the links.',
    try: [
      { text: 'Turn on the ideal catenary: once settled, the chain lies right on the dashed curve for its length.', actions: [{ label: 'Show catenary', display: { catenary: true } }] },
      { text: 'Drop some balls onto it.', actions: [{ label: 'Drop balls', knobs: { balls: 3 } }] },
      { text: 'Grab the middle and pull: the strain colours jump near the anchors.' },
    ],
    featured: ['gravity', 'tearStrain'],
    view: { x0: -2.6, x1: 2.6, y0: -2.0, y1: 1.6 },
    params: { gravity: 9.81, drag: 0.5, damping: 0.1, integrator: 'verlet', dt: 0.0004, grabK: 100, restitution: 0.6, bodyCollisions: true, springCollisions: true },
    tools: { mass: 0.5, radius: 0.1, k: 11200 },
    knobs: [
      { id: 'links', label: 'Links', type: 'int', min: 10, max: 40, value: 20 },
      { id: 'slack', label: 'Length ÷ span', type: 'num', min: 1.05, max: 2, step: 0.05, value: 1.25 },
      { id: 'balls', label: 'Balls', type: 'select', options: [[0, 'None'], [3, 'Three']], value: 0 },
    ],
    build(w, k) {
      // a 2 kg chain; each link's stiffness scales with 1/length (a fixed EA)
      // so the whole chain stretches only about 0.5% under its own weight
      const n = k.links, span = 4, len = span * k.slack, rest = len / n
      const ea = 2800, mass = 2 / n
      let prev = w.addBody({ x: -2, y: 1, pinned: true, r: 0.05 })
      for (let i = 1; i <= n; i++) {
        const b = w.addBody({ x: -2 + span * i / n, y: 1, m: mass, r: 0.03, pinned: i === n })
        w.addSpring(prev, b, { k: ea / rest, rest, kind: 'rope' })
        prev = b
      }
      if (+k.balls) {
        [[-0.9, 1.4, 0.5, 1], [0.2, 1.7, 1, 2], [1.0, 1.2, 0.3, 3]].forEach(([x, y, m, tint]) =>
          w.addBody({ x, y, m, r: 0.12 * Math.cbrt(m), tint }))
      }
      w.catenary = { x0: -2, x1: 2, y: 1, len }
    },
  },

  {
    id: 'orbits',
    name: 'Orbits',
    group: 'Gravity',
    tag: 'Gravitation',
    blurb: 'A sun and three planets pulling on each other with Newton’s inverse-square law of gravitation (G = 1 units).',
    try: [
      { text: 'Switch to Explicit Euler and the inner planet spirals outward. Switch back to Verlet and the orbits close again.', actions: [{ label: 'Use Euler', params: { integrator: 'euler' } }, { label: 'Use Verlet', params: { integrator: 'verlet' } }] },
      { text: 'Pick Build and drag in empty space to launch a moon of your own.', actions: [{ label: 'Pick Build', tool: 'build' }] },
    ],
    featured: ['integrator', 'G', 'dt'],
    view: { x0: -6.5, x1: 6.5, y0: -6.5, y1: 6.5 },
    params: { G: 1, softening: 0.02, integrator: 'verlet', dt: 0.005, grabK: 50 },
    display: { trails: true, trailLen: 10 },
    tools: { mass: 0.02, radius: 0.1, k: 5, launch: 1.5 },
    knobs: [
      { id: 'sun', label: 'Sun mass', type: 'log', min: 10, max: 100, value: 40, unit: 'kg' },
      { id: 'planets', label: 'Planets', type: 'int', min: 1, max: 5, value: 3 },
    ],
    build(w, k) {
      const M = k.sun
      const sun = w.addBody({ m: M, r: 0.25 })
      const orbits = [[1.5, 0.02, 0, 1, 1], [3, 0.05, 120, 2, 1], [5.5, 0.02, 240, 3, 0.894], [2.2, 0.01, 60, 0, 1], [4.2, 0.03, 300, 0, 1]]
      for (const [r, m, at, tint, f] of orbits.slice(0, k.planets)) {
        const a = deg(at), v = f * Math.sqrt(M / r)
        w.addBody({ x: r * Math.cos(a), y: r * Math.sin(a), vx: -v * Math.sin(a), vy: v * Math.cos(a), m, r: 0.1 * Math.cbrt(m / 0.02), tint })
      }
      // the sun moves too, so total momentum is zero and nothing drifts
      let px = 0, py = 0
      for (const b of w.bodies) if (b !== sun) { px += b.m * b.vx; py += b.m * b.vy }
      sun.vx = -px / M
      sun.vy = -py / M
    },
  },

  {
    id: 'figure8',
    name: 'Figure-eight',
    group: 'Gravity',
    tag: 'Three-body',
    blurb: 'Three equal masses chasing each other along a single figure-eight, a rare stable three-body orbit. Total momentum and angular momentum stay exactly zero.',
    try: [
      { text: 'Give one body a small flick: the eight wobbles but survives. Flick harder and one body is thrown out.' },
      { text: 'Switch to Explicit Euler with a 10 ms step and the dance falls apart within a few loops.', actions: [{ label: 'Euler, Δt 10 ms', params: { integrator: 'euler', dt: 0.01 } }, { label: 'Back to Verlet', params: { integrator: 'verlet', dt: 0.001 } }] },
    ],
    featured: ['integrator', 'dt'],
    view: { x0: -1.4, x1: 1.4, y0: -0.8, y1: 0.8 },
    params: { G: 1, softening: 0, integrator: 'verlet', dt: 0.001, grabK: 5 },
    display: { trails: true, trailLen: 6.5 },
    tools: { mass: 0.05, radius: 0.04, k: 5, launch: 1 },
    build(w) {
      const vx = -0.93240737, vy = -0.86473146
      w.addBody({ x: 0.97000436, y: -0.24308753, vx: -vx / 2, vy: -vy / 2, m: 1, r: 0.05, tint: 1 })
      w.addBody({ x: -0.97000436, y: 0.24308753, vx: -vx / 2, vy: -vy / 2, m: 1, r: 0.05, tint: 2 })
      w.addBody({ x: 0, y: 0, vx, vy, m: 1, r: 0.05, tint: 3 })
    },
  },

  {
    id: 'coupled',
    name: 'Coupled oscillators',
    group: 'Waves & heat',
    tag: 'Waves',
    blurb: 'Masses on springs joined by a weaker spring. Energy sloshes from one to the next and back. Add more masses and it becomes a wave.',
    try: [
      { text: 'Watch the chart: the left mass slows as the right one picks up, then they swap back. Those are beats.' },
      { text: 'Start them both the same way and the beats vanish: that is a normal mode, which never trades energy.', actions: [{ label: 'Both same way', knobs: { start: 'same' } }, { label: 'Opposite', knobs: { start: 'opposite' } }] },
      { text: 'With 20 masses, flick the first one sideways and a pulse runs down the line and back, upside down.', actions: [{ label: '20 masses', knobs: { n: 20 } }] },
    ],
    featured: ['damping', 'stiffness'],
    view: { x0: -3.4, x1: 3.4, y0: -1.2, y1: 1.2 },
    params: { integrator: 'verlet', dt: 0.002, grabK: 20 },
    chart: 'tracked',
    tools: { mass: 1, radius: 0.09, k: 10 },
    knobs: [
      { id: 'n', label: 'Masses', type: 'int', min: 2, max: 24, value: 2 },
      { id: 'kc', label: 'Coupling', type: 'log', min: 0.5, max: 10, value: 2, unit: 'N/m' },
      { id: 'start', label: 'Start', type: 'select', options: [['left', 'Left only'], ['same', 'Both same way'], ['opposite', 'Opposite']], value: 'left' },
    ],
    build(w, k) {
      const n = k.n, d = 6 / (n + 1), kc = k.kc
      const left = w.addBody({ x: -3, y: 0, pinned: true, r: 0.06 })
      const right = w.addBody({ x: 3, y: 0, pinned: true, r: 0.06 })
      // two or three masses: heavy, with stiffer wall springs, for beats.
      // Four or more: a light string under tension, so waves travel quickly.
      const sideways = n >= 4
      const m = sideways ? 0.05 : 1
      const kw = sideways ? kc : 10
      const ms = []
      for (let i = 0; i < n; i++) ms.push(w.addBody({ x: -3 + d * (i + 1), y: 0, m, r: Math.min(0.09, d * 0.3), tint: i === 0 ? 1 : i === 1 ? 2 : 0 }))
      const chain = [left, ...ms, right]
      // equal tension everywhere so the line starts in equilibrium
      const t0 = sideways ? kc * d / 2 : 0.2 * Math.min(kw, kc) * d
      for (let i = 0; i + 1 < chain.length; i++) {
        const kk = i === 0 || i === chain.length - 2 ? kw : kc
        w.addSpring(chain[i], chain[i + 1], { k: kk, rest: d - t0 / kk })
      }
      const push = (b, s) => { if (sideways) b.y += 0.4 * s; else b.x += 0.4 * s }
      push(ms[0], 1)
      if (k.start === 'same') push(ms[1], 1)
      if (k.start === 'opposite') push(ms[1], -1)
      // bodies[2] and bodies[3] are the first two masses (after the anchors)
      w.tracked = { axis: sideways ? 'y' : 'x', idx: [2, 3], home: sideways ? [0, 0] : [-3 + d, -3 + 2 * d] }
    },
  },

  {
    id: 'lattice',
    name: 'Thermal lattice',
    group: 'Waves & heat',
    tag: 'Equipartition',
    blurb: 'An 8 × 8 crystal of springs held at a temperature by a heat bath: random kicks plus matching friction, the corrected form of the Python ThermalForce.',
    try: [
      { text: 'Raise the temperature: kinetic and spring energy climb together and settle close to each other, the heat shared between motion and stretch. That is equipartition.', actions: [{ label: 'Temperature 1', params: { temperature: 1 } }] },
      { text: 'Let bonds break at 50% stretch, then turn up the heat until the crystal shakes itself apart.', actions: [{ label: 'Breakable bonds', params: { tearStrain: 0.5, temperature: 0.6 } }] },
    ],
    featured: ['temperature', 'tearStrain'],
    view: { x0: -3.2, x1: 3.2, y0: -3.2, y1: 3.2 },
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    params: { temperature: 0.2, thermostat: 1, walls: true, restitution: 1, friction: 0, integrator: 'verlet', dt: 0.005, grabK: 20 },
    display: { colorBy: 'speed', springStyle: 'line' },
    tools: { mass: 1, radius: 0.09, k: 20 },
    knobs: [
      { id: 'size', label: 'Size', type: 'int', min: 4, max: 12, value: 8 },
      { id: 'brace', label: 'Diagonals', type: 'select', options: [[1, 'On'], [0, 'Off']], value: 1 },
    ],
    build(w, k) {
      const n = k.size, s = 0.5, off = (n - 1) * s / 2
      const grid = []
      for (let j = 0; j < n; j++) {
        const row = []
        for (let i = 0; i < n; i++) row.push(w.addBody({ x: i * s - off, y: j * s - off, m: 1, r: 0.09 }))
        grid.push(row)
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if (i + 1 < n) w.addSpring(grid[j][i], grid[j][i + 1], { k: 20 })
          if (j + 1 < n) w.addSpring(grid[j][i], grid[j + 1][i], { k: 20 })
          if (+k.brace && i + 1 < n && j + 1 < n) {
            w.addSpring(grid[j][i], grid[j + 1][i + 1], { k: 10 })
            w.addSpring(grid[j][i + 1], grid[j + 1][i], { k: 10 })
          }
        }
      }
    },
  },

  {
    id: 'sandbox',
    name: 'Sandbox',
    group: 'Build',
    tag: 'Your own',
    blurb: 'An empty box with gravity. Add masses, tie them together with springs, pin some down and see what you get.',
    try: [
      { text: 'Pick Pin and tap to place an anchor. Then pick Build and drag from the anchor to hang a mass on a spring.', actions: [{ label: 'Pick Pin', tool: 'pin' }, { label: 'Pick Build', tool: 'build' }] },
      { text: 'In Build, drag from empty space to throw a ball.' },
    ],
    featured: ['gravity', 'restitution', 'integrator'],
    view: { x0: -4.2, x1: 4.2, y0: -0.2, y1: 5.2 },
    bounds: { minX: -4, maxX: 4, minY: 0, maxY: 5 },
    params: { gravity: 9.81, drag: 0.05, damping: 0.1, walls: true, restitution: 0.8, friction: 0.3, bodyCollisions: true, integrator: 'verlet', dt: 0.002, grabK: 100 },
    tools: { mass: 1, radius: 0.12, k: 100, launch: 2 },
    build() {},
  },
]

export const DEFAULT_SCENE = 'hexagon'

export function sceneById(id) {
  return SCENES.find(s => s.id === id) || null
}

export function knobDefaults(scene) {
  const k = {}
  for (const kn of scene.knobs || []) k[kn.id] = kn.value
  return k
}

// a fresh World for a scene; bounds default to the view so walls frame it
export function buildScene(scene, knobs) {
  const v = scene.view
  const bounds = scene.bounds || { minX: v.x0, maxX: v.x1, minY: v.y0, maxY: v.y1 }
  const w = new World({ ...scene.params, bounds })
  w.tearAfter = 0
  scene.build(w, { ...knobDefaults(scene), ...knobs }, v)
  return w
}
