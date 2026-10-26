// Physics core: a JavaScript port of simulation.py.
// As in the Python, forces, integrators and collision handlers are separate,
// swappable pieces; a World wires together the ones its params switch on.
// Units are SI (metres, kilograms, seconds) with +y pointing up.

const EXPLODE_LIMIT = 1e6        // metres or m/s past which we call it a blow-up
const SPRING_COLLISION_PAIRS = 5000

let nextId = 1

export function defaultParams() {
  return {
    gravity: 0,          // m/s², uniform, toward -y
    drag: 0,             // 1/s, linear air drag F = -drag·m·v
    damping: 0,          // spring damping ratio ζ (1 = critical)
    stiffness: 1,        // multiplies every spring constant
    tearStrain: 0,       // springs snap past this strain; 0 never snaps
    G: 0,                // universal gravitation constant
    coulomb: 0,          // Coulomb constant
    softening: 0.05,     // m, keeps 1/r² forces finite at close range
    temperature: 0,      // J (k_B = 1), heat bath target
    thermostat: 1,       // 1/s, how strongly the heat bath couples
    walls: false,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    restitution: 0.9,    // walls and mass-mass contacts
    friction: 0.3,       // walls
    bodyCollisions: false,
    springCollisions: false,
    grabK: 50,           // N/m, stiffness of the pointer's spring
    integrator: 'verlet',
    dt: 1 / 500,
  }
}

export const defaultRadius = m => 0.08 * Math.cbrt(Math.max(m, 1e-6))

export class Body {
  constructor(o = {}) {
    this.id = nextId++
    this.x = o.x ?? 0
    this.y = o.y ?? 0
    this.vx = o.vx ?? 0
    this.vy = o.vy ?? 0
    this.m = o.m ?? 1
    this.r = o.r ?? defaultRadius(this.m)
    this.q = o.q ?? 0
    this.pinned = !!o.pinned
    this.tint = o.tint ?? 0
    this.i = -1 // index in the packed arrays, set every step
  }
}

// kind: 'spring' pushes and pulls, 'rope' only pulls (slack when short),
// 'rod' is a very stiff spring drawn as a bar
export class Spring {
  constructor(a, b, o = {}) {
    this.id = nextId++
    this.a = a
    this.b = b
    this.k = o.k ?? 50
    this.rest = o.rest ?? Math.hypot(b.x - a.x, b.y - a.y)
    this.kind = o.kind || 'spring'
    this.c = 0 // dashpot coefficient, derived from the damping ratio each step
  }
  get rope() { return this.kind === 'rope' }
  length() { return Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) }
  strain() { return this.rest > 0 ? (this.length() - this.rest) / this.rest : 0 }
}

// ============= Forces =============
// accumulate() adds forces (N) into fx, fy for a trial state x, y, vx, vy.
// Forces are pure: no randomness, no breaking, so RK4 stages stay honest.
// energy() returns the matching potential energy of conservative forces.

function pairPotential(w, P, x, y, coef, weight) {
  const n = P.n, eps2 = Math.max(w.params.softening ** 2, 1e-12)
  let e = 0
  for (let i = 0; i < n; i++) {
    const wi = weight[i]
    if (!wi) continue
    for (let j = i + 1; j < n; j++) {
      if (!weight[j]) continue
      const dx = x[j] - x[i], dy = y[j] - y[i]
      e += coef * wi * weight[j] / Math.sqrt(dx * dx + dy * dy + eps2)
    }
  }
  return e
}

function pairForce(w, P, x, y, fx, fy, coef, weight, list) {
  // coef > 0 attracts (gravitation), coef < 0 pushes like charges apart
  const eps2 = Math.max(w.params.softening ** 2, 1e-12)
  const n = list.length
  for (let a = 0; a < n; a++) {
    const i = list[a], wi = weight[i]
    for (let b = a + 1; b < n; b++) {
      const j = list[b]
      const dx = x[j] - x[i], dy = y[j] - y[i]
      const r2 = dx * dx + dy * dy + eps2
      const f = coef * wi * weight[j] / (r2 * Math.sqrt(r2))
      fx[i] += f * dx; fy[i] += f * dy
      fx[j] -= f * dx; fy[j] -= f * dy
    }
  }
}

function springTerms(s, x, y, vx, vy, stiff) {
  const a = s.a.i, b = s.b.i
  const dx = x[b] - x[a], dy = y[b] - y[a]
  const L = Math.sqrt(dx * dx + dy * dy)
  if (L < 1e-12 || (s.rope && L <= s.rest)) return null
  const ux = dx / L, uy = dy / L
  const vrel = (vx[b] - vx[a]) * ux + (vy[b] - vy[a]) * uy
  return { a, b, ux, uy, elastic: s.k * stiff * (L - s.rest), damp: s.c * vrel, vrel }
}

export const FORCES = {
  spring: {
    label: 'Springs',
    on: w => w.springs.length > 0,
    accumulate(w, P, x, y, vx, vy, fx, fy) {
      // hot loop: kept free of allocations
      const stiff = w.params.stiffness, springs = w.springs
      for (let k = 0; k < springs.length; k++) {
        const s = springs[k], a = s.a.i, b = s.b.i
        const dx = x[b] - x[a], dy = y[b] - y[a]
        const L = Math.sqrt(dx * dx + dy * dy)
        if (L < 1e-12 || (s.rope && L <= s.rest)) continue
        const ux = dx / L, uy = dy / L
        let f = s.k * stiff * (L - s.rest)
        if (s.c) f += s.c * ((vx[b] - vx[a]) * ux + (vy[b] - vy[a]) * uy)
        fx[a] += f * ux; fy[a] += f * uy
        fx[b] -= f * ux; fy[b] -= f * uy
      }
    },
    energy(w, P, x, y) {
      const stiff = w.params.stiffness
      let e = 0
      for (const s of w.springs) {
        const dx = x[s.b.i] - x[s.a.i], dy = y[s.b.i] - y[s.a.i]
        const ext = Math.sqrt(dx * dx + dy * dy) - s.rest
        if (s.rope && ext <= 0) continue
        e += 0.5 * s.k * stiff * ext * ext
      }
      return e
    },
  },

  gravity: {
    label: 'Gravity',
    on: w => w.params.gravity !== 0,
    accumulate(w, P, x, y, vx, vy, fx, fy) {
      const g = w.params.gravity
      for (let i = 0; i < P.n; i++) fy[i] -= P.m[i] * g
    },
    energy(w, P, x, y) {
      // measured from the floor so the number stays readable
      const g = w.params.gravity, y0 = w.params.bounds.minY
      let e = 0
      for (let i = 0; i < P.n; i++) if (P.free[i]) e += P.m[i] * g * (y[i] - y0)
      return e
    },
  },

  drag: {
    label: 'Air drag',
    on: w => w.params.drag > 0,
    accumulate(w, P, x, y, vx, vy, fx, fy) {
      const d = w.params.drag
      for (let i = 0; i < P.n; i++) {
        fx[i] -= d * P.m[i] * vx[i]
        fy[i] -= d * P.m[i] * vy[i]
      }
    },
  },

  // Newton's law of universal gravitation, softened: F = G·m1·m2 / (r² + ε²)
  gravitation: {
    label: 'Gravitation',
    on: w => w.params.G !== 0 && w.bodies.length > 1,
    accumulate(w, P, x, y, vx, vy, fx, fy) {
      pairForce(w, P, x, y, fx, fy, w.params.G, P.m, P.all)
    },
    energy(w, P, x, y) { return pairPotential(w, P, x, y, -w.params.G, P.m) },
  },

  // Coulomb's law between charges: like charges repel
  electric: {
    label: 'Electric',
    on: w => w.params.coulomb !== 0 && w.bodies.some(b => b.q),
    accumulate(w, P, x, y, vx, vy, fx, fy) {
      pairForce(w, P, x, y, fx, fy, -w.params.coulomb, P.q, P.charged)
    },
    energy(w, P, x, y) { return pairPotential(w, P, x, y, w.params.coulomb, P.q) },
  },

  // a critically damped spring from the pointer to the grabbed mass
  grab: {
    label: 'Your hand',
    on: w => !!(w.grab && w.grab.body.i >= 0 && !w.grab.body.pinned),
    accumulate(w, P, x, y, vx, vy, fx, fy) {
      const [gx, gy] = grabForce(w, P, x, y, vx, vy)
      fx[w.grab.body.i] += gx
      fy[w.grab.body.i] += gy
    },
  },
}

const FORCE_LIST = Object.values(FORCES)

// stiff enough to feel firm, soft enough to stay stable at this step size
export function grabSpring(w, m) {
  const k = Math.min(w.params.grabK, m * (0.5 / w.params.dt) ** 2)
  return { k, c: 2 * Math.sqrt(k * m) }
}

function grabForce(w, P, x, y, vx, vy) {
  const g = w.grab, i = g.body.i
  const { k, c } = grabSpring(w, P.m[i])
  return [k * (g.x - x[i]) + c * ((g.vx || 0) - vx[i]), k * (g.y - y[i]) + c * ((g.vy || 0) - vy[i])]
}

// Non-conservative forces, split by who pays: dissipation (drag and spring
// dashpots) and your hand. The ledger multiplies them by each step's
// displacement, so a contact that stops a mass dead can't fool it.
function ncForces(w, P, hx, hy, wx, wy) {
  const { n, x, y, vx, vy, m } = P
  hx.fill(0, 0, n); hy.fill(0, 0, n); wx.fill(0, 0, n); wy.fill(0, 0, n)
  const d = w.params.drag
  if (d > 0) {
    for (let i = 0; i < n; i++) { hx[i] = -d * m[i] * vx[i]; hy[i] = -d * m[i] * vy[i] }
  }
  if (w.params.damping) {
    for (const s of w.springs) {
      if (!s.c) continue
      const a = s.a.i, b = s.b.i
      const dx = x[b] - x[a], dy = y[b] - y[a]
      const L = Math.sqrt(dx * dx + dy * dy)
      if (L < 1e-12 || (s.rope && L <= s.rest)) continue
      const ux = dx / L, uy = dy / L
      const f = s.c * ((vx[b] - vx[a]) * ux + (vy[b] - vy[a]) * uy)
      hx[a] += f * ux; hy[a] += f * uy
      hx[b] -= f * ux; hy[b] -= f * uy
    }
  }
  if (FORCES.grab.on(w)) {
    const [gx, gy] = grabForce(w, P, x, y, vx, vy)
    wx[w.grab.body.i] += gx
    wy[w.grab.body.i] += gy
  }
}

// ============= Integrators =============

function accel(w, P, x, y, vx, vy, ax, ay) {
  const n = P.n
  ax.fill(0, 0, n)
  ay.fill(0, 0, n)
  for (const f of w._forces) f.accumulate(w, P, x, y, vx, vy, ax, ay)
  const invM = P.invM
  for (let i = 0; i < n; i++) { ax[i] *= invM[i]; ay[i] *= invM[i] }
}

export const INTEGRATORS = {
  euler: {
    label: 'Explicit Euler',
    order: '1st order',
    note: 'Moves with the old velocity and speeds up with the old force. The simplest method; on anything that swings it always gains energy.',
    code: 'ExplicitEuler',
    step(w, P, h) {
      const { n, x, y, vx, vy, invM, ax, ay } = P
      accel(w, P, x, y, vx, vy, ax, ay)
      for (let i = 0; i < n; i++) {
        if (!invM[i]) continue
        x[i] += h * vx[i]; y[i] += h * vy[i]
        vx[i] += h * ax[i]; vy[i] += h * ay[i]
      }
    },
  },

  symplectic: {
    label: 'Semi-implicit Euler',
    order: '1st order · symplectic',
    note: 'Updates velocity first, then moves with the new one. One line different from Euler, but energy stays bounded. Most game engines use it.',
    code: 'SemiImplicitEuler',
    step(w, P, h) {
      const { n, x, y, vx, vy, invM, ax, ay } = P
      accel(w, P, x, y, vx, vy, ax, ay)
      for (let i = 0; i < n; i++) {
        if (!invM[i]) continue
        vx[i] += h * ax[i]; vy[i] += h * ay[i]
        x[i] += h * vx[i]; y[i] += h * vy[i]
      }
    },
  },

  verlet: {
    label: 'Velocity Verlet',
    order: '2nd order · symplectic',
    note: 'Half kick, drift, half kick. Time-reversible, and energy stays bounded over very long runs. The usual choice here.',
    code: 'VelocityVerlet',
    step(w, P, h) {
      const { n, x, y, vx, vy, invM, ax, ay } = P
      accel(w, P, x, y, vx, vy, ax, ay)
      for (let i = 0; i < n; i++) {
        if (!invM[i]) continue
        vx[i] += 0.5 * h * ax[i]; vy[i] += 0.5 * h * ay[i]
        x[i] += h * vx[i]; y[i] += h * vy[i]
      }
      accel(w, P, x, y, vx, vy, ax, ay)
      for (let i = 0; i < n; i++) {
        if (!invM[i]) continue
        vx[i] += 0.5 * h * ax[i]; vy[i] += 0.5 * h * ay[i]
      }
    },
  },

  rk4: {
    label: 'Runge–Kutta 4',
    order: '4th order',
    note: 'Four force evaluations per step. Very accurate over short runs, but over long runs it slowly bleeds energy, and it costs 4× as much.',
    code: 'RK4Integrator',
    step(w, P, h) {
      const { n, x, y, vx, vy, invM, ax, ay, x0, y0, vx0, vy0, sx, sy, svx, svy } = P
      for (let i = 0; i < n; i++) {
        x0[i] = x[i]; y0[i] = y[i]; vx0[i] = vx[i]; vy0[i] = vy[i]
        sx[i] = 0; sy[i] = 0; svx[i] = 0; svy[i] = 0
      }
      // each stage: derivative at the trial state held in x, y, vx, vy
      const reach = [0.5, 0.5, 1, 0]
      const weight = [1, 2, 2, 1]
      for (let s = 0; s < 4; s++) {
        accel(w, P, x, y, vx, vy, ax, ay)
        const wgt = weight[s], c = reach[s] * h
        for (let i = 0; i < n; i++) {
          const kx = vx[i], ky = vy[i]
          sx[i] += wgt * kx; sy[i] += wgt * ky
          svx[i] += wgt * ax[i]; svy[i] += wgt * ay[i]
          if (s < 3 && invM[i]) {
            x[i] = x0[i] + c * kx; y[i] = y0[i] + c * ky
            vx[i] = vx0[i] + c * ax[i]; vy[i] = vy0[i] + c * ay[i]
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (!invM[i]) { x[i] = x0[i]; y[i] = y0[i]; vx[i] = vx0[i]; vy[i] = vy0[i]; continue }
        x[i] = x0[i] + h / 6 * sx[i]; y[i] = y0[i] + h / 6 * sy[i]
        vx[i] = vx0[i] + h / 6 * svx[i]; vy[i] = vy0[i] + h / 6 * svy[i]
      }
    },
  },

  // simulation.py's RK4Integrator holds the force fixed across its stages,
  // which collapses to x += v·h + ½a·h², v += a·h: a Taylor step, not RK4
  python: {
    label: 'simulation.py “RK4”',
    order: 'original · 1st order',
    note: 'The method from the original Python. It computes the force once and holds it across all four stages, which reduces to x += v·Δt + ½a·Δt², v += a·Δt. It gains energy.',
    code: 'RK4Integrator()  # as written in simulation.py',
    step(w, P, h) {
      const { n, x, y, vx, vy, invM, ax, ay } = P
      accel(w, P, x, y, vx, vy, ax, ay)
      for (let i = 0; i < n; i++) {
        if (!invM[i]) continue
        x[i] += h * vx[i] + 0.5 * h * h * ax[i]; y[i] += h * vy[i] + 0.5 * h * h * ay[i]
        vx[i] += h * ax[i]; vy[i] += h * ay[i]
      }
    },
  },
}

export const INTEGRATOR_ORDER = ['euler', 'symplectic', 'verlet', 'rk4', 'python']

// ============= Collisions =============

// below this approach speed a contact rests instead of bouncing: about what
// one step of the body's own acceleration (gravity, springs, charges, your
// hand) builds up, so pressed and stacked bodies settle
function restingSpeed(h, ax, ay) {
  return Math.max(0.01, 2 * h * Math.sqrt(ax * ax + ay * ay))
}

function bounceWall(w, P, i, h, alongY, sign, depth) {
  // sign = +1 for a wall whose inward normal points along +x or +y
  const v = alongY ? P.vy : P.vx, t = alongY ? P.vx : P.vy
  let vn = v[i] * sign
  if (vn >= 0) return
  // the mass sank `depth` past the wall, speeding up as it went; take the
  // speed it had at the surface, so clamping it back adds no energy
  const an = -(alongY ? P.ay[i] : P.ax[i]) * sign
  if (an > 0) vn = -Math.sqrt(Math.max(0, vn * vn - 2 * an * depth))
  const e = -vn < restingSpeed(h, P.ax[i], P.ay[i]) ? 0 : w.params.restitution
  v[i] = -e * vn * sign
  const jn = (1 + e) * -vn
  const dv = Math.min(Math.abs(t[i]), w.params.friction * jn)
  t[i] -= Math.sign(t[i]) * dv
  w.contacts++
}

function collideWalls(w, P, h) {
  const { minX, maxX, minY, maxY } = w.params.bounds
  const { n, x, y, r, invM } = P
  for (let i = 0; i < n; i++) {
    if (!invM[i]) continue
    const ri = r[i]
    if (y[i] - ri < minY) { bounceWall(w, P, i, h, true, 1, minY + ri - y[i]); y[i] = minY + ri }
    if (y[i] + ri > maxY) { bounceWall(w, P, i, h, true, -1, y[i] + ri - maxY); y[i] = maxY - ri }
    if (x[i] - ri < minX) { bounceWall(w, P, i, h, false, 1, minX + ri - x[i]); x[i] = minX + ri }
    if (x[i] + ri > maxX) { bounceWall(w, P, i, h, false, -1, x[i] + ri - maxX); x[i] = maxX - ri }
  }
}

// Sweep and prune on x, then sequential impulse passes so a hit can travel
// down a row of balls within one step (Newton's cradle).
function collideBodies(w, P, h) {
  const { n, x, y, vx, vy, r, invM } = P
  const order = P.order
  for (let i = 0; i < n; i++) order[i] = i
  for (let a = 1; a < n; a++) {
    // insertion sort: the order barely changes between steps
    const v = order[a], key = x[v] - r[v]
    let b = a - 1
    while (b >= 0 && x[order[b]] - r[order[b]] > key) { order[b + 1] = order[b]; b-- }
    order[b + 1] = v
  }
  const slop = 0.0015 // m: contacts this close count, so impulses cross small gaps
  const pairs = P.pairs
  pairs.length = 0
  for (let a = 0; a < n; a++) {
    const i = order[a], right = x[i] + r[i] + slop
    for (let b = a + 1; b < n; b++) {
      const j = order[b]
      if (x[j] - r[j] > right) break
      if (!invM[i] && !invM[j]) continue
      const dx = x[j] - x[i], dy = y[j] - y[i]
      const reach = r[i] + r[j] + slop
      if (dx * dx + dy * dy < reach * reach) pairs.push(i, j)
    }
  }
  if (!pairs.length) return

  const e = w.params.restitution, ax = P.ax, ay = P.ay
  // velocity impulses, repeated until nothing is approaching
  const passes = Math.max(10, Math.min(40, pairs.length))
  for (let it = 0; it < passes; it++) {
    let any = false
    for (let p = 0; p < pairs.length; p += 2) {
      const i = pairs[p], j = pairs[p + 1]
      const dx = x[j] - x[i], dy = y[j] - y[i]
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < 1e-12) continue
      const nx = dx / d, ny = dy / d
      const vn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny
      if (vn >= -1e-9) continue
      const bounce = -vn < restingSpeed(h, ax[j] - ax[i], ay[j] - ay[i]) ? 0 : e
      const jmag = -(1 + bounce) * vn / (invM[i] + invM[j])
      vx[i] -= jmag * invM[i] * nx; vy[i] -= jmag * invM[i] * ny
      vx[j] += jmag * invM[j] * nx; vy[j] += jmag * invM[j] * ny
      any = true
      if (it === 0) w.contacts++
    }
    if (!any) break
  }
  // then push overlapping pairs apart by inverse mass. A pair already
  // separating fast enough to clear its overlap this step is left alone:
  // pushing it would add energy against any attraction between them.
  for (let p = 0; p < pairs.length; p += 2) {
    const i = pairs[p], j = pairs[p + 1]
    const dx = x[j] - x[i], dy = y[j] - y[i]
    const d = Math.sqrt(dx * dx + dy * dy)
    const overlap = r[i] + r[j] - d - 0.0005
    if (overlap <= 0) continue
    const nx = d > 1e-12 ? dx / d : 1, ny = d > 1e-12 ? dy / d : 0
    if (((vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny) * h >= overlap) continue
    const corr = overlap / (invM[i] + invM[j])
    x[i] -= nx * corr * invM[i]; y[i] -= ny * corr * invM[i]
    x[j] += nx * corr * invM[j]; y[j] += ny * corr * invM[j]
  }
}

// The original LineSegmentCollisionDetector, with a real impulse at the
// contact point in place of ElasticCollisionHandler's velocity flip.
function collideSprings(w, P, h) {
  const { n, x, y, vx, vy, r, invM } = P
  const e = w.params.restitution
  for (const s of w.springs) {
    const a = s.a.i, b = s.b.i
    const ax = x[a], ay = y[a], bx = x[b], by = y[b]
    const ex = bx - ax, ey = by - ay
    const len2 = ex * ex + ey * ey
    if (len2 < 1e-12) continue
    const loX = Math.min(ax, bx), hiX = Math.max(ax, bx)
    const loY = Math.min(ay, by), hiY = Math.max(ay, by)
    for (let i = 0; i < n; i++) {
      if (i === a || i === b) continue
      const ri = r[i]
      if (x[i] + ri < loX || x[i] - ri > hiX || y[i] + ri < loY || y[i] - ri > hiY) continue
      const t = Math.max(0, Math.min(1, ((x[i] - ax) * ex + (y[i] - ay) * ey) / len2))
      const cx = ax + t * ex, cy = ay + t * ey
      let nx = x[i] - cx, ny = y[i] - cy
      const d = Math.sqrt(nx * nx + ny * ny)
      if (d >= ri) continue
      if (d > 1e-12) { nx /= d; ny /= d } else { const L = Math.sqrt(len2); nx = -ey / L; ny = ex / L }
      const wa = (1 - t) * invM[a], wb = t * invM[b]
      const wsum = invM[i] + (1 - t) * wa + t * wb
      if (wsum <= 0) continue
      const corr = (ri - d) / wsum
      x[i] += nx * corr * invM[i]; y[i] += ny * corr * invM[i]
      x[a] -= nx * corr * wa; y[a] -= ny * corr * wa
      x[b] -= nx * corr * wb; y[b] -= ny * corr * wb
      const svx = (1 - t) * vx[a] + t * vx[b], svy = (1 - t) * vy[a] + t * vy[b]
      const vn = (vx[i] - svx) * nx + (vy[i] - svy) * ny
      if (vn >= 0) continue
      const jmag = -(1 + e) * vn / wsum
      vx[i] += jmag * invM[i] * nx; vy[i] += jmag * invM[i] * ny
      vx[a] -= jmag * wa * nx; vy[a] -= jmag * wa * ny
      vx[b] -= jmag * wb * nx; vy[b] -= jmag * wb * ny
      w.contacts++
    }
  }
}

// ============= World =============

function gaussian(rng) {
  let u = 0
  while (u === 0) u = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PACKED = ['x', 'y', 'vx', 'vy', 'm', 'invM', 'free', 'r', 'q', 'ax', 'ay',
  'x0', 'y0', 'vx0', 'vy0', 'sx', 'sy', 'svx', 'svy',
  'h0x', 'h0y', 'w0x', 'w0y', 'h1x', 'h1y', 'w1x', 'w1y', 'px', 'py']

function kineticOf(P) {
  let e = 0
  for (let i = 0; i < P.n; i++) if (P.invM[i]) e += 0.5 * P.m[i] * (P.vx[i] ** 2 + P.vy[i] ** 2)
  return e
}

export class World {
  constructor(params = {}) {
    this.bodies = []
    this.springs = []
    this.time = 0
    this.params = { ...defaultParams(), ...params }
    this.params.bounds = { ...defaultParams().bounds, ...params.bounds }
    this.grab = null      // { body, x, y, vx, vy } while the pointer holds a mass
    this.exploded = false
    this.contacts = 0     // collisions resolved, for the readout
    this.snapped = 0      // springs broken by tearing
    this.tearAfter = 0    // springs may only snap after this time (s)
    this.seed = 12345
    this.rng = mulberry32(this.seed)
    // energy ledger since the last rebaseline
    this.ledger = { e0: 0, heat: 0, work: 0, scale: 1, ready: false }
    this._P = { n: 0, cap: 0, order: new Int32Array(0), pairs: [], all: [], charged: [] }
    this._forces = []
  }

  addBody(o) { const b = new Body(o); this.bodies.push(b); return b }

  // grab = { body, x, y, vx, vy } or null; the pointer spring starts or stops
  setGrab(g) {
    this.grab = g
  }

  addSpring(a, b, o) {
    if (!a || !b || a === b) return null
    const s = new Spring(a, b, o)
    this.springs.push(s)
    return s
  }

  springBetween(a, b) {
    return this.springs.find(s => (s.a === a && s.b === b) || (s.a === b && s.b === a)) || null
  }

  removeSpring(s) {
    const i = this.springs.indexOf(s)
    if (i >= 0) this.springs.splice(i, 1)
  }

  removeBody(body) {
    const i = this.bodies.indexOf(body)
    if (i < 0) return
    this.bodies.splice(i, 1)
    this.springs = this.springs.filter(s => s.a !== body && s.b !== body)
    if (this.grab && this.grab.body === body) this.grab = null
  }

  // copy bodies into flat arrays the forces and integrators work on
  _pack() {
    const P = this._P, n = this.bodies.length
    if (n > P.cap || !P.x) {
      const cap = Math.max(16, n * 2)
      for (const k of PACKED) P[k] = new Float64Array(cap)
      P.order = new Int32Array(cap)
      P.cap = cap
    }
    P.n = n
    if (P.all.length !== n) P.all = Array.from({ length: n }, (_, i) => i)
    P.charged.length = 0
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]
      b.i = i
      P.x[i] = b.x; P.y[i] = b.y; P.vx[i] = b.vx; P.vy[i] = b.vy
      P.m[i] = b.m
      P.free[i] = b.pinned ? 0 : 1
      P.invM[i] = b.pinned || !(b.m > 0) ? 0 : 1 / b.m
      P.r[i] = b.r; P.q[i] = b.q
      if (b.q) P.charged.push(i)
    }
    // dashpot coefficient from the damping ratio: c = 2ζ√(k·μ), cached until
    // the damping, stiffness or the springs change (edits call rebase())
    const zeta = this.params.damping, stiff = this.params.stiffness
    const key = `${zeta}|${stiff}|${this.springs.length}|${n}`
    if (key !== this._cKey) {
      this._cKey = key
      for (const s of this.springs) {
        if (!zeta) { s.c = 0; continue }
        const ma = s.a.pinned ? Infinity : s.a.m, mb = s.b.pinned ? Infinity : s.b.m
        const mu = ma === Infinity ? mb : mb === Infinity ? ma : ma * mb / (ma + mb)
        s.c = mu === Infinity ? 0 : 2 * zeta * Math.sqrt(s.k * stiff * mu)
      }
    }
    const forces = this._forces
    forces.length = 0
    for (const f of FORCE_LIST) if (f.on(this)) forces.push(f)
    return P
  }

  _unpack() {
    const P = this._P
    let bad = false
    for (let i = 0; i < P.n; i++) {
      const b = this.bodies[i]
      b.x = P.x[i]; b.y = P.y[i]; b.vx = P.vx[i]; b.vy = P.vy[i]
      if (!(Math.abs(b.x) + Math.abs(b.y) + Math.abs(b.vx) + Math.abs(b.vy) < EXPLODE_LIMIT)) bad = true
    }
    if (bad) this.exploded = true
  }

  _energyOf(P) {
    let e = kineticOf(P)
    for (const f of this._forces) if (f.energy) e += f.energy(this, P, P.x, P.y)
    return e
  }

  springCollisionsActive() {
    return this.params.springCollisions && this.springs.length > 0 &&
      this.bodies.length * this.springs.length <= SPRING_COLLISION_PAIRS
  }

  step(h = this.params.dt) { return this.advance(1, h) }

  // Run up to `count` fixed steps on the packed arrays, copying back to the
  // bodies once at the end. Stops early past `budgetMs` of wall time.
  advance(count, h = this.params.dt, budgetMs = Infinity) {
    if (this.exploded || count < 1) return 0
    if (!this.ledger.ready) this.rebase()
    const P = this._pack()
    this._ncFresh = false // bodies may have been edited since the last batch
    const t0 = budgetMs < Infinity ? performance.now() : 0
    let done = 0
    while (done < count) {
      this._stepPacked(P, h)
      done++
      if ((done & 7) === 0 && budgetMs < Infinity && performance.now() - t0 > budgetMs) break
    }
    this._unpack()
    return done
  }

  // One fixed time step: integrate the pure forces, then contacts, the heat
  // bath and tearing, keeping the energy ledger as we go.
  _stepPacked(P, h) {
    const L = this.ledger
    const prm = this.params

    // work of drag, dashpots and your hand: average force × displacement
    const n = P.n
    const nc = prm.drag > 0 || (prm.damping > 0 && this.springs.length > 0) || FORCES.grab.on(this)
    if (nc) {
      if (this._ncFresh) {
        // nothing touched the state since last step's end: reuse its forces
        ;[P.h0x, P.h1x] = [P.h1x, P.h0x]; [P.h0y, P.h1y] = [P.h1y, P.h0y]
        ;[P.w0x, P.w1x] = [P.w1x, P.w0x]; [P.w0y, P.w1y] = [P.w1y, P.w0y]
      } else ncForces(this, P, P.h0x, P.h0y, P.w0x, P.w0y)
    }
    const { x, y, px, py, h0x, h0y, w0x, w0y, h1x, h1y, w1x, w1y } = P
    if (nc) for (let i = 0; i < n; i++) { px[i] = x[i]; py[i] = y[i] }
    const integ = INTEGRATORS[prm.integrator] || INTEGRATORS.rk4
    integ.step(this, P, h)
    if (nc) {
      ncForces(this, P, h1x, h1y, w1x, w1y)
      let heat = 0, work = 0
      for (let i = 0; i < n; i++) {
        const dx = x[i] - px[i], dy = y[i] - py[i]
        heat -= 0.5 * ((h0x[i] + h1x[i]) * dx + (h0y[i] + h1y[i]) * dy)
        work += 0.5 * ((w0x[i] + w1x[i]) * dx + (w0y[i] + w1y[i]) * dy)
      }
      L.heat += heat
      L.work += work
    }

    const contacts = this.springCollisionsActive() || prm.bodyCollisions || prm.walls
    this._ncFresh = nc && !contacts && !(prm.temperature > 0)
    if (contacts) {
      // impulses and overlap fixes both move energy; book it as heat, except
      // where a contact pushed a mass against your hand or the air: that's
      // work done by those forces over the push
      const before = this._energyOf(P)
      if (nc) for (let i = 0; i < n; i++) { px[i] = x[i]; py[i] = y[i] }
      if (this.springCollisionsActive()) collideSprings(this, P, h)
      if (prm.bodyCollisions) collideBodies(this, P, h)
      if (prm.walls) collideWalls(this, P, h)
      let wc = 0
      if (nc) for (let i = 0; i < n; i++) wc += w1x[i] * (x[i] - px[i]) + w1y[i] * (y[i] - py[i])
      L.work += wc
      L.heat += before - this._energyOf(P) + wc
    }

    if (prm.temperature > 0) {
      // exact Ornstein–Uhlenbeck step: friction plus matching random kicks
      const ke0 = kineticOf(P)
      const decay = Math.exp(-prm.thermostat * h)
      const spread = Math.sqrt(1 - decay * decay)
      for (let i = 0; i < P.n; i++) {
        if (!P.invM[i]) continue
        const s = spread * Math.sqrt(prm.temperature / P.m[i])
        P.vx[i] = P.vx[i] * decay + s * gaussian(this.rng)
        P.vy[i] = P.vy[i] * decay + s * gaussian(this.rng)
      }
      L.work += kineticOf(P) - ke0
    }

    this.time += h
    if (prm.tearStrain > 0 && this.time >= this.tearAfter) this._tear(P)
  }

  _tear(P) {
    const limit = this.params.tearStrain, stiff = this.params.stiffness
    const springs = this.springs, x = P.x, y = P.y
    let broken = null
    for (let k = 0; k < springs.length; k++) {
      const s = springs[k]
      const dx = x[s.b.i] - x[s.a.i], dy = y[s.b.i] - y[s.a.i]
      if (s.rest > 0 && Math.sqrt(dx * dx + dy * dy) > s.rest * (1 + limit)) (broken ||= []).push(s)
    }
    if (!broken) return
    const gone = new Set(broken)
    for (const s of broken) {
      const ext = Math.hypot(x[s.b.i] - x[s.a.i], y[s.b.i] - y[s.a.i]) - s.rest
      this.ledger.heat += 0.5 * s.k * stiff * ext * ext
    }
    this.springs = springs.filter(s => !gone.has(s))
    this.snapped += broken.length
    this._ncFresh = false
    if (!this.springs.length) this._forces.splice(this._forces.indexOf(FORCES.spring), 1)
  }

  // start a fresh energy account from the current state (after any edit)
  rebase() {
    this._cKey = null
    const m = this.measure(true)
    // the scale errors are measured against: the energy in play at the start
    const scale = Math.max(Math.abs(m.total), m.kinetic + Math.abs(m.spring) + Math.abs(m.gravity) + Math.abs(m.gravitation) + Math.abs(m.electric), 1e-9)
    Object.assign(this.ledger, { e0: m.total, heat: 0, work: 0, scale, ready: true })
  }

  // energies (J), momentum and the ledger
  measure(raw = false) {
    const P = this._pack()
    const forces = this._forces
    let kinetic = 0, px = 0, py = 0, mt = 0, cx = 0, cy = 0
    for (let i = 0; i < P.n; i++) {
      if (!P.free[i]) continue
      const m = P.m[i]
      kinetic += 0.5 * m * (P.vx[i] ** 2 + P.vy[i] ** 2)
      px += m * P.vx[i]; py += m * P.vy[i]
      mt += m; cx += m * P.x[i]; cy += m * P.y[i]
    }
    // angular momentum about the centre of mass
    let Lz = 0
    if (mt > 0) {
      cx /= mt; cy /= mt
      const ux = px / mt, uy = py / mt
      for (let i = 0; i < P.n; i++) {
        if (!P.free[i]) continue
        Lz += P.m[i] * ((P.x[i] - cx) * (P.vy[i] - uy) - (P.y[i] - cy) * (P.vx[i] - ux))
      }
    }
    const pot = f => forces.includes(f) ? f.energy(this, P, P.x, P.y) : 0
    const spring = pot(FORCES.spring), gravity = pot(FORCES.gravity)
    const gravitation = pot(FORCES.gravitation), electric = pot(FORCES.electric)
    const total = kinetic + spring + gravity + gravitation + electric
    const out = { kinetic, spring, gravity, gravitation, electric, total, px, py, Lz }
    if (raw) return out
    const L = this.ledger
    // relative to what the books say should be in play now
    const denom = Math.max(L.scale, Math.abs(L.work), Math.abs(L.heat), Math.abs(L.e0 + L.work - L.heat))
    out.heat = L.heat
    out.work = L.work
    // what the integrator alone has added or lost
    out.error = total - L.e0 - L.work + L.heat
    out.errorPct = 100 * out.error / denom
    return out
  }

  // which non-conservative effects are active, for honest captions
  sinks() {
    const p = this.params, out = []
    if (p.drag > 0) out.push('drag')
    if (p.damping > 0 && this.springs.length) out.push('spring damping')
    if (p.walls && (p.restitution < 1 || p.friction > 0)) out.push('walls')
    if (p.bodyCollisions && p.restitution < 1) out.push('collisions')
    if (p.tearStrain > 0) out.push('tearing')
    if (p.temperature > 0) out.push('heat bath')
    if (this.grab) out.push('your hand')
    return out
  }

  // why momentum may change
  momentumOutside() {
    const p = this.params, out = []
    if (p.walls) out.push('walls')
    if (this.bodies.some(b => b.pinned)) out.push('pins')
    if (p.gravity) out.push('gravity')
    if (p.drag > 0) out.push('drag')
    if (p.temperature > 0) out.push('heat bath')
    if (this.grab) out.push('your hand')
    return out
  }

  centerOfMass() {
    let m = 0, x = 0, y = 0
    for (const b of this.bodies) {
      if (b.pinned) continue
      m += b.m; x += b.m * b.x; y += b.m * b.y
    }
    return m > 0 ? { x: x / m, y: y / m, m } : null
  }

  // current net force on each body (for drawing force arrows)
  netForces() {
    const P = this._pack()
    const fx = new Float64Array(P.n), fy = new Float64Array(P.n)
    for (const f of this._forces) f.accumulate(this, P, P.x, P.y, P.vx, P.vy, fx, fy)
    return { fx, fy }
  }

  // every force acting on one body, for the free-body inspector
  forcesOn(body) {
    const P = this._pack()
    const i = body.i, out = []
    if (i < 0 || body !== this.bodies[i]) return out
    const stiff = this.params.stiffness
    for (const s of this.springs) {
      if (s.a !== body && s.b !== body) continue
      const t = springTerms(s, P.x, P.y, P.vx, P.vy, stiff)
      const sign = s.a === body ? 1 : -1
      const f = t ? t.elastic + t.damp : 0
      out.push({ kind: s.kind, other: s.a === body ? s.b : s.a, spring: s, fx: t ? sign * f * t.ux : 0, fy: t ? sign * f * t.uy : 0, ext: s.length() - s.rest })
    }
    const fx = new Float64Array(P.n), fy = new Float64Array(P.n)
    for (const f of this._forces) {
      if (f === FORCES.spring) continue
      fx.fill(0); fy.fill(0)
      f.accumulate(this, P, P.x, P.y, P.vx, P.vy, fx, fy)
      out.push({ kind: f.label, fx: fx[i], fy: fy[i] })
    }
    return out
  }

  // fastest natural frequency, for the Δt check. For springs, each mass's
  // stiffness matrix Σ k·u·uᵀ is direction-aware, so grids aren't overrated.
  omegaMax() {
    const P = this._pack(), stiff = this.params.stiffness, n = P.n
    const sxx = new Float64Array(n), sxy = new Float64Array(n), syy = new Float64Array(n)
    for (const s of this.springs) {
      const a = s.a.i, b = s.b.i
      const dx = P.x[b] - P.x[a], dy = P.y[b] - P.y[a]
      const L2 = dx * dx + dy * dy || 1
      const k = s.k * stiff
      const xx = k * dx * dx / L2, xy = k * dx * dy / L2, yy = k * dy * dy / L2
      sxx[a] += xx; sxy[a] += xy; syy[a] += yy
      sxx[b] += xx; sxy[b] += xy; syy[b] += yy
    }
    let w2 = 0
    for (let i = 0; i < n; i++) {
      if (!P.invM[i]) continue
      const half = (sxx[i] + syy[i]) / 2, d = (sxx[i] - syy[i]) / 2
      const lam = half + Math.sqrt(d * d + sxy[i] * sxy[i])
      w2 = Math.max(w2, 2 * lam * P.invM[i])
    }
    const eps2 = Math.max(this.params.softening ** 2, 1e-12)
    const scan = (list, f) => {
      if (list.length > 200) return
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const i = list[a], j = list[b]
          if (!P.invM[i] && !P.invM[j]) continue
          const r2 = (P.x[j] - P.x[i]) ** 2 + (P.y[j] - P.y[i]) ** 2 + eps2
          w2 = Math.max(w2, f(i, j) / (r2 * Math.sqrt(r2)))
        }
      }
    }
    const G = this.params.G, ke = this.params.coulomb
    if (G) scan(P.all, (i, j) => Math.abs(G) * (P.m[i] + P.m[j]))
    if (ke) scan(P.charged, (i, j) => Math.abs(ke * P.q[i] * P.q[j]) * (P.invM[i] + P.invM[j]))
    const g = this.grab
    if (g && g.body.i >= 0 && !g.body.pinned) w2 = Math.max(w2, grabSpring(this, g.body.m).k / g.body.m)
    return Math.sqrt(w2)
  }

  // could a fast mass skip clean through another in one step?
  tunnelling() {
    const p = this.params
    if (!p.bodyCollisions && !p.walls && !this.springCollisionsActive()) return false
    let vmax = 0, rmin = Infinity
    for (const b of this.bodies) {
      if (b.pinned) continue
      vmax = Math.max(vmax, Math.hypot(b.vx, b.vy))
      rmin = Math.min(rmin, b.r)
    }
    return vmax * p.dt > 0.5 * rmin
  }

  // ---------- queries for the editor ----------

  bodyAt(x, y, slop = 0) {
    let best = null, bestD = Infinity
    for (const b of this.bodies) {
      const d = Math.hypot(b.x - x, b.y - y) - b.r
      if (d <= slop && d < bestD) { best = b; bestD = d }
    }
    return best
  }

  springAt(x, y, tol) {
    let best = null, bestD = tol
    for (const s of this.springs) {
      const d = pointSegmentDistance(x, y, s.a.x, s.a.y, s.b.x, s.b.y)
      if (d < bestD) { best = s; bestD = d }
    }
    return best
  }

  springsCrossing(x1, y1, x2, y2) {
    return this.springs.filter(s => segmentsCross(x1, y1, x2, y2, s.a.x, s.a.y, s.b.x, s.b.y))
  }

  // ---------- save / load ----------

  toJSON(digits = 6) {
    const idx = new Map(this.bodies.map((b, i) => [b, i]))
    const r = v => +(+v).toPrecision(digits)
    return {
      v: 2,
      time: r(this.time),
      seed: this.seed,
      params: structuredClone(this.params),
      bodies: this.bodies.map(b => [r(b.x), r(b.y), r(b.vx), r(b.vy), r(b.m), r(b.r), r(b.q), b.pinned ? 1 : 0, b.tint]),
      springs: this.springs.map(s => [idx.get(s.a), idx.get(s.b), r(s.k), r(s.rest), s.kind === 'rope' ? 1 : s.kind === 'rod' ? 2 : 0]),
    }
  }

  static fromJSON(o) {
    const w = new World(o.params || {})
    w.time = +o.time || 0
    if (o.seed) { w.seed = o.seed; w.rng = mulberry32(o.seed) }
    for (const [x, y, vx, vy, m, r, q, pinned, tint] of o.bodies || []) {
      w.addBody({ x: +x, y: +y, vx: +vx, vy: +vy, m: +m, r: +r, q: +q, pinned: !!pinned, tint: tint | 0 })
    }
    for (const [a, b, k, rest, kind] of o.springs || []) {
      const A = w.bodies[a], B = w.bodies[b]
      if (A && B && A !== B) w.addSpring(A, B, { k: +k, rest: +rest, kind: ['spring', 'rope', 'rod'][kind | 0] || 'spring' })
    }
    return w
  }
}

// ============= Geometry helpers =============

export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay
  const len2 = ex * ex + ey * ey
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey))
}

export function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
  return d1 * d2 < 0 && d3 * d4 < 0
}
