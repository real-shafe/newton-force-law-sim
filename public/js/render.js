// Canvas renderer: a sheet of graph paper in shafe.dev colours.
// Replaces simulation.py's MatplotlibVisualizer.

const TRAIL_LEN = 1200      // points kept per body
const TRAIL_MAX_BODIES = 60
const FONT = '"Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif'

// colours checked for contrast and colour-blind separation on each sheet
export const THEMES = {
  paper: {
    sheet: '#FCFCF8', minor: '#E6EDF8', major: '#C9D7EF', axis: '#AAB4DC', tick: '#5B6280',
    mass: '#1E2A5A', halo: '#FCFCF8', pinFill: '#FCFCF8', pinStroke: '#1E2A5A', hatch: '#5B6280',
    qPos: '#C42A31', qNeg: '#1F5FAD', qGlyph: '#FCFCF8', vel: '#0F8A6A', force: '#A3367F',
    accent: '#E0353B', muted: '#5B6280', text: '#1A1D33', ghost: 'rgba(30, 42, 90, 0.26)',
    ramp: ['#004CAD', '#3260A3', '#566D8F', '#767471', '#A16C50', '#BF6339', '#D75928'],
    speed: ['#9DB0D9', '#6B86C2', '#3C5DA6', '#1E2A5A'],
    tints: ['#1E2A5A', '#2A78D6', '#D9541E', '#8B4513'],
    series: { total: '#1E2A5A', kinetic: '#2A78D6', spring: '#D9541E', gravity: '#0F8A6A', gravitation: '#A3367F', electric: '#8B4513' },
  },
  blueprint: {
    sheet: '#13265A', minor: '#1B3170', major: '#2D4A8A', axis: '#4F6AAE', tick: '#AAB4DC',
    mass: '#FCFCF8', halo: '#13265A', pinFill: '#13265A', pinStroke: '#FCFCF8', hatch: '#AAB4DC',
    qPos: '#FF8A80', qNeg: '#7ABDFF', qGlyph: '#13265A', vel: '#0DCAA9', force: '#D066B1',
    accent: '#FF6B70', muted: '#AAB4DC', text: '#E8ECF8', ghost: 'rgba(232, 236, 248, 0.28)',
    ramp: ['#4CABFD', '#82B9F2', '#AAC4E1', '#D3D1CB', '#E5B696', '#F5A06F', '#FF8757'],
    speed: ['#4F6AAE', '#7F97CF', '#B4C3E8', '#E6ECFB'],
    tints: ['#FCFCF8', '#3899E2', '#F98B6F', '#B09C11'],
    series: { total: '#FCFCF8', kinetic: '#3899E2', spring: '#F98B6F', gravity: '#0DCAA9', gravitation: '#D066B1', electric: '#B09C11' },
  },
}

export const SERIES_DASH = { total: [], kinetic: [], spring: [], gravity: [6, 3], gravitation: [2, 3], electric: [8, 3, 2, 3] }

export function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const n of [1, 2, 5]) if (n * p >= raw - 1e-12) return n * p
  return 10 * p
}

export function formatLength(m) {
  if (m >= 1) return `${+m.toPrecision(3)} m`
  if (m >= 0.01) return `${+(m * 100).toPrecision(3)} cm`
  return `${+(m * 1000).toPrecision(3)} mm`
}

function fmtTick(v) {
  const r = +v.toPrecision(4)
  return Math.abs(r) < 1e-9 ? '0' : String(r).replace('-', '−')
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.dpr = 1
    this.w = 1
    this.h = 1
    this.cx = 0
    this.cy = 0
    this.scale = 100 // px per metre
    this.themeName = 'paper'
    this.theme = THEMES.paper
    this.trails = new Map()
    this.arrowK = { vel: 0, force: 0 }
    this.gridCanvas = document.createElement('canvas')
    this.gridKey = ''
    this.avoid = []
    this.speedCuts = null
    this.speedCutsAt = -1
  }

  setTheme(name) {
    this.themeName = THEMES[name] ? name : 'paper'
    this.theme = THEMES[this.themeName]
    this.gridKey = ''
  }

  resize() {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.w = Math.max(1, r.width)
    this.h = Math.max(1, r.height)
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.gridKey = ''
  }

  // fit a world rectangle inside the canvas minus UI insets {top,right,bottom,left}
  fit(view, ins = {}) {
    const t = ins.top || 0, r = ins.right || 0, b = ins.bottom || 0, l = ins.left || 0
    const aw = Math.max(60, this.w - l - r), ah = Math.max(60, this.h - t - b)
    const vw = view.x1 - view.x0, vh = view.y1 - view.y0
    this.scale = Math.min(aw / vw, ah / vh) * 0.94
    const sx = l + aw / 2, sy = t + ah / 2
    this.cx = (view.x0 + view.x1) / 2 - (sx - this.w / 2) / this.scale
    this.cy = (view.y0 + view.y1) / 2 + (sy - this.h / 2) / this.scale
  }

  toScreen(x, y) {
    return [(x - this.cx) * this.scale + this.w / 2, this.h / 2 - (y - this.cy) * this.scale]
  }

  toWorld(px, py) {
    return [(px - this.w / 2) / this.scale + this.cx, (this.h / 2 - py) / this.scale + this.cy]
  }

  zoomAt(px, py, factor, min = 2, max = 5e4) {
    const [wx, wy] = this.toWorld(px, py)
    this.scale = Math.min(max, Math.max(min, this.scale * factor))
    const [nx, ny] = this.toWorld(px, py)
    this.cx += wx - nx
    this.cy += wy - ny
  }

  panBy(dpx, dpy) {
    this.cx -= dpx / this.scale
    this.cy += dpy / this.scale
  }

  clearTrails() { this.trails.clear() }
  resetArrows() { this.arrowK = { vel: 0, force: 0 } }

  recordTrails(world) {
    let count = 0
    for (const b of world.bodies) {
      if (b.pinned) continue
      if (++count > TRAIL_MAX_BODIES) break
      let t = this.trails.get(b)
      if (!t) { t = { pts: new Float32Array(TRAIL_LEN * 2), at: new Float64Array(TRAIL_LEN), head: 0, len: 0 }; this.trails.set(b, t) }
      if (t.len) {
        // skip points that have barely moved on screen
        const p = ((t.head - 1 + TRAIL_LEN) % TRAIL_LEN) * 2
        if (Math.abs(t.pts[p] - b.x) * this.scale < 1.5 && Math.abs(t.pts[p + 1] - b.y) * this.scale < 1.5) continue
      }
      const k = t.head * 2
      t.pts[k] = b.x
      t.pts[k + 1] = b.y
      t.at[t.head] = world.time
      t.head = (t.head + 1) % TRAIL_LEN
      t.len = Math.min(TRAIL_LEN, t.len + 1)
    }
    if (this.trails.size > count) {
      const alive = new Set(world.bodies)
      for (const b of this.trails.keys()) if (!alive.has(b) || b.pinned) this.trails.delete(b)
    }
  }

  // s: { display, selectedBody, selectedSpring, hoverBody, hoverSpring, picked,
  //      preview, cut, ghost, grabLine, insets }
  draw(world, s) {
    const ctx = this.ctx, th = this.theme
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.display.grid) {
      this.ensureGrid()
      ctx.drawImage(this.gridCanvas, 0, 0, this.w, this.h)
    } else {
      ctx.fillStyle = th.sheet
      ctx.fillRect(0, 0, this.w, this.h)
    }
    if (world.params.walls) this.drawWalls(world.params.bounds)
    if (s.underlay) s.underlay(this)
    if (s.display.trails) this.drawTrails(world.time, s.display.trailLen || 4)
    if (s.ghost) this.drawGhost(s.ghost)
    this.drawSprings(world, s)
    if (s.preview) this.drawPreview(s.preview)
    if (s.grabLine) this.drawGrabLine(s.grabLine)
    this.drawArrows(world, s)
    this.drawBodies(world, s)
    if (s.display.com) this.drawCenterOfMass(world)
    if (s.cut) this.drawCut(s.cut)
    if (s.display.grid && s.scaleBar !== false) this.drawScaleBar(s.scaleBarAt)
  }

  // ---------- graph paper, cached until the camera moves ----------

  ensureGrid() {
    const key = `${this.w}x${this.h}@${this.dpr}|${this.cx},${this.cy},${this.scale}|${this.themeName}|${this.avoid.map(r => r.join()).join()}`
    if (key === this.gridKey) return
    this.gridKey = key
    const g = this.gridCanvas
    g.width = this.canvas.width
    g.height = this.canvas.height
    const ctx = g.getContext('2d'), th = this.theme
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = th.sheet
    ctx.fillRect(0, 0, this.w, this.h)
    const [x0, y1] = this.toWorld(0, 0), [x1, y0] = this.toWorld(this.w, this.h)
    // major spacing is the 1-2-5 step that lands between 80 and 200 px
    const major = niceStep(80 / this.scale)
    const minor = major / 5
    const lines = (step, color) => {
      ctx.beginPath()
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const px = Math.round(this.toScreen(x, 0)[0]) + 0.5
        ctx.moveTo(px, 0); ctx.lineTo(px, this.h)
      }
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const py = Math.round(this.toScreen(0, y)[1]) + 0.5
        ctx.moveTo(0, py); ctx.lineTo(this.w, py)
      }
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.stroke()
    }
    if (minor * this.scale >= 10) lines(minor, th.minor)
    lines(major, th.major)
    // axes and origin
    const [ox, oy] = this.toScreen(0, 0)
    ctx.strokeStyle = th.axis
    ctx.lineWidth = 1.5
    ctx.beginPath()
    if (oy > 0 && oy < this.h) { ctx.moveTo(0, oy); ctx.lineTo(this.w, oy) }
    if (ox > 0 && ox < this.w) { ctx.moveTo(ox, 0); ctx.lineTo(ox, this.h) }
    ctx.stroke()
    ctx.fillStyle = th.sheet
    ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    // tick labels along the bottom and left, clear of corners and the UI
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    const label = (text, px, py, align) => {
      ctx.textAlign = align
      const tw = ctx.measureText(text).width
      const bx = align === 'center' ? px - tw / 2 : px
      const box = [bx - 3, py - 8, tw + 6, 16]
      if (this.avoid.some(r => box[0] < r[0] + r[2] && box[0] + box[2] > r[0] && box[1] < r[1] + r[3] && box[1] + box[3] > r[1])) return
      ctx.fillStyle = th.sheet
      ctx.fillRect(...box)
      ctx.fillStyle = th.tick
      ctx.fillText(text, px, py)
    }
    for (let x = Math.ceil(x0 / major) * major; x <= x1; x += major) {
      const px = this.toScreen(x, 0)[0]
      if (px < 64 || px > this.w - 64) continue
      label(fmtTick(x), px, this.h - 12, 'center')
    }
    for (let y = Math.ceil(y0 / major) * major; y <= y1; y += major) {
      const py = this.toScreen(0, y)[1]
      if (py < 40 || py > this.h - 56) continue
      label(fmtTick(y), 6, py, 'left')
    }
    ctx.textAlign = 'left'
  }

  drawScaleBar(at) {
    const ctx = this.ctx, th = this.theme
    const len = niceStep(60 / this.scale)
    const px = len * this.scale
    const x = at ? at[0] : 16, y = at ? at[1] : this.h - 30
    ctx.fillStyle = th.sheet
    ctx.globalAlpha = 0.85
    ctx.fillRect(x - 6, y - 22, px + 12, 30)
    ctx.globalAlpha = 1
    ctx.strokeStyle = th.mass
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 6)
    ctx.stroke()
    ctx.fillStyle = th.text
    ctx.font = `600 12px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(formatLength(len), x + px / 2, y - 5)
    ctx.textAlign = 'left'
  }

  drawWalls(b) {
    const ctx = this.ctx, th = this.theme
    const [l, t] = this.toScreen(b.minX, b.maxY), [r, btm] = this.toScreen(b.maxX, b.minY)
    // a hatched band outside the box, like ground in an engineering drawing
    const band = 10
    ctx.save()
    ctx.beginPath()
    ctx.rect(l - band, t - band, r - l + 2 * band, btm - t + 2 * band)
    ctx.rect(l, t, r - l, btm - t)
    ctx.clip('evenodd')
    ctx.strokeStyle = th.hatch
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1
    ctx.beginPath()
    const span = btm - t + 2 * band
    for (let k = l - band - span; k < r + band; k += 6) {
      ctx.moveTo(k, btm + band); ctx.lineTo(k + span, t - band)
    }
    ctx.stroke()
    ctx.restore()
    ctx.strokeStyle = th.mass
    ctx.lineWidth = 2.5
    ctx.strokeRect(l, t, r - l, btm - t)
  }

  drawTrails(now, seconds) {
    const ctx = this.ctx, th = this.theme
    ctx.lineWidth = 1.5
    const buckets = 8
    for (const [b, t] of this.trails) {
      // only the last `seconds` of the path
      let first = 0
      while (first < t.len && t.at[(t.head - t.len + first + TRAIL_LEN) % TRAIL_LEN] < now - seconds) first++
      const len = t.len - first
      if (len < 2) continue
      ctx.strokeStyle = th.tints[b.tint] || th.mass
      const per = Math.ceil(len / buckets)
      for (let c = 0; c < buckets; c++) {
        const i0 = first + c * per, i1 = Math.min(t.len - 1, first + (c + 1) * per)
        if (i1 <= i0) continue
        ctx.globalAlpha = 0.55 * (c + 1) / buckets
        ctx.beginPath()
        for (let i = i0; i <= i1; i++) {
          const k = ((t.head - t.len + i + TRAIL_LEN) % TRAIL_LEN) * 2
          const px = (t.pts[k] - this.cx) * this.scale + this.w / 2
          const py = this.h / 2 - (t.pts[k + 1] - this.cy) * this.scale
          if (i === i0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  drawGhost(ghost) {
    const ctx = this.ctx, th = this.theme
    ctx.strokeStyle = th.ghost
    ctx.lineWidth = 2
    ctx.beginPath()
    for (const s of ghost.springs) {
      const [ax, ay] = this.toScreen(s.a.x, s.a.y), [bx, by] = this.toScreen(s.b.x, s.b.y)
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
    }
    ctx.stroke()
    ctx.fillStyle = th.ghost
    for (const b of ghost.bodies) {
      if (b.pinned) continue
      const [x, y] = this.toScreen(b.x, b.y)
      ctx.beginPath()
      ctx.arc(x, y, Math.max(3, b.r * this.scale), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ---------- springs ----------

  // strain → ramp index 0..6 (3 is rest) and a line width
  strainStyle(sp, ref) {
    const L = Math.hypot(sp.b.x - sp.a.x, sp.b.y - sp.a.y)
    const e = sp.rest > 0 ? (L - sp.rest) / sp.rest : 0
    const s = Math.max(-1, Math.min(1, e / ref))
    return { idx: Math.round(3 + 3 * s), width: 1.5 + 1.5 * Math.abs(s), e, L }
  }

  drawSprings(world, s) {
    const ctx = this.ctx, th = this.theme
    const springs = world.springs
    if (!springs.length) return
    const mode = s.display.springStyle || 'auto'
    const stress = s.display.stress
    const tear = world.params.tearStrain
    const ref = tear > 0 ? tear : 0.2
    const coilOK = mode === 'coil' || (mode === 'auto' && springs.length <= 40)
    // lines and dense meshes: batch by colour and width
    const buckets = new Map()
    for (const sp of springs) {
      const st = stress ? this.strainStyle(sp, ref) : { idx: -1, width: 1.75, e: 0 }
      let width = st.width
      if (tear > 0 && st.e > 0.8 * tear) width = 3.5
      const color = st.idx < 0 ? th.mass : th.ramp[st.idx]
      const [ax, ay] = this.toScreen(sp.a.x, sp.a.y), [bx, by] = this.toScreen(sp.b.x, sp.b.y)
      if (mode === 'string' || mode === 'rod') {
        ctx.strokeStyle = th.mass
        ctx.lineWidth = mode === 'rod' ? 4 : 1.25
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
        continue
      }
      const restPx = sp.rest * this.scale
      if (coilOK && restPx >= 28 && Math.hypot(bx - ax, by - ay) >= 14) {
        ctx.strokeStyle = color
        ctx.lineWidth = width
        drawCoil(ctx, ax, ay, bx, by, restPx)
        continue
      }
      const key = color + '|' + width.toFixed(1)
      let arr = buckets.get(key)
      if (!arr) buckets.set(key, arr = [color, width, []])
      arr[2].push(ax, ay, bx, by)
    }
    for (const [color, width, pts] of buckets.values()) {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      for (let i = 0; i < pts.length; i += 4) { ctx.moveTo(pts[i], pts[i + 1]); ctx.lineTo(pts[i + 2], pts[i + 3]) }
      ctx.stroke()
    }
    for (const [sp, sel] of [[s.hoverSpring, false], [s.selectedSpring, true]]) {
      if (!sp || !springs.includes(sp)) continue
      const [ax, ay] = this.toScreen(sp.a.x, sp.a.y), [bx, by] = this.toScreen(sp.b.x, sp.b.y)
      ctx.globalAlpha = sel ? 0.3 : 0.18
      ctx.strokeStyle = sel ? th.accent : th.mass
      ctx.lineWidth = 9
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
      ctx.globalAlpha = 1
      if (sel) {
        // dashed outline so selection never relies on colour alone
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1.5
        const nx = -(by - ay), ny = bx - ax, L = Math.hypot(nx, ny) || 1
        for (const sgn of [-1, 1]) {
          const ox = nx / L * 7 * sgn, oy = ny / L * 7 * sgn
          ctx.beginPath(); ctx.moveTo(ax + ox, ay + oy); ctx.lineTo(bx + ox, by + oy); ctx.stroke()
        }
        ctx.setLineDash([])
      }
    }
  }

  drawPreview(p) {
    const ctx = this.ctx, th = this.theme
    const [ax, ay] = this.toScreen(p.x0, p.y0), [bx, by] = this.toScreen(p.x1, p.y1)
    if (p.kind === 'launch') {
      ctx.globalAlpha = 0.5
      ctx.fillStyle = th.mass
      ctx.beginPath(); ctx.arc(ax, ay, Math.max(4, p.r * this.scale), 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
      this.arrow(ax, ay, bx - ax, by - ay, th.accent, true)
      this.tag(p.label, bx + 10, by - 10)
      return
    }
    ctx.setLineDash([6, 5])
    ctx.strokeStyle = p.ok ? th.accent : th.muted
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    ctx.setLineDash([])
    if (p.ghostR) {
      ctx.globalAlpha = 0.45
      ctx.fillStyle = th.mass
      ctx.beginPath(); ctx.arc(bx, by, Math.max(4, p.ghostR * this.scale), 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  drawGrabLine(g) {
    const ctx = this.ctx, th = this.theme
    const [ax, ay] = this.toScreen(g.x0, g.y0), [bx, by] = this.toScreen(g.x1, g.y1)
    if (Math.hypot(bx - ax, by - ay) > 6) {
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = th.accent
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.strokeStyle = th.accent
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.stroke()
    if (g.label) this.tag(g.label, bx + 9, by)
  }

  drawCut(c) {
    const ctx = this.ctx, th = this.theme
    if (c.pts.length < 2) return
    ctx.strokeStyle = th.accent
    ctx.lineWidth = 3
    ctx.globalAlpha = c.alpha ?? 1
    ctx.beginPath()
    c.pts.forEach(([x, y], i) => { const [px, py] = this.toScreen(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py) })
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // ---------- masses ----------

  speedColor(b, world) {
    const th = this.theme
    if (!this.speedCuts || world.time - this.speedCutsAt > 0.5 || world.time < this.speedCutsAt) {
      const v = world.bodies.filter(x => !x.pinned).map(x => Math.hypot(x.vx, x.vy)).sort((a, c) => a - c)
      const q = f => v[Math.min(v.length - 1, Math.floor(v.length * f))] || 0
      this.speedCuts = [q(0.25), q(0.5), q(0.75)]
      this.speedCutsAt = world.time
    }
    const sp = Math.hypot(b.vx, b.vy), c = this.speedCuts
    return th.speed[sp < c[0] ? 0 : sp < c[1] ? 1 : sp < c[2] ? 2 : 3]
  }

  drawBodies(world, s) {
    const ctx = this.ctx, th = this.theme
    const many = world.bodies.length > 150
    const bySpeed = s.display.colorBy === 'speed'
    // which way each pin's springs pull, to place its ground bar opposite
    const pull = new Map()
    for (const sp of world.springs) {
      for (const [p, o] of [[sp.a, sp.b], [sp.b, sp.a]]) {
        if (!p.pinned) continue
        const v = pull.get(p) || [0, 0]
        const L = Math.hypot(o.x - p.x, o.y - p.y) || 1
        v[0] += (o.x - p.x) / L; v[1] += (o.y - p.y) / L
        pull.set(p, v)
      }
    }
    for (const b of world.bodies) {
      const [x, y] = this.toScreen(b.x, b.y)
      const rad = Math.max(many ? 2.5 : 4, b.r * this.scale)
      if (x < -rad - 30 || x > this.w + rad + 30 || y < -rad - 30 || y > this.h + rad + 30) continue
      if (b.pinned) {
        this.drawPivot(x, y, Math.max(5, Math.min(rad, 12)), pull.get(b))
      } else if (b.q) {
        ctx.fillStyle = b.q > 0 ? th.qPos : th.qNeg
        ctx.strokeStyle = th.halo
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        if (rad >= 6) {
          ctx.strokeStyle = th.qGlyph
          ctx.lineWidth = Math.max(2, rad * 0.16)
          const a = rad * 0.55
          ctx.beginPath()
          ctx.moveTo(x - a, y); ctx.lineTo(x + a, y)
          if (b.q > 0) { ctx.moveTo(x, y - a); ctx.lineTo(x, y + a) }
          ctx.stroke()
        } else {
          ctx.strokeStyle = b.q > 0 ? th.qPos : th.qNeg
          ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.arc(x, y, rad + 3, 0, Math.PI * 2); ctx.stroke()
        }
      } else {
        ctx.fillStyle = bySpeed ? this.speedColor(b, world) : (th.tints[b.tint] || th.mass)
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
        if (!many) {
          ctx.strokeStyle = th.halo
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }
      const sel = b === s.selectedBody || b === s.picked
      if (sel) this.reticle(x, y, Math.max(rad, 5) + 5, th.accent, false)
      else if (b === s.hoverBody) {
        ctx.globalAlpha = 0.4
        ctx.strokeStyle = th.mass
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(x, y, Math.max(rad, 5) + 4, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }
    }
  }

  drawPivot(x, y, r, pull) {
    const ctx = this.ctx, th = this.theme
    // ground bar sits opposite the springs (above a hanging pendulum)
    let gx = 0, gy = 1 // screen-space direction to the bar
    if (pull && Math.hypot(pull[0], pull[1]) > 0.2) {
      const L = Math.hypot(pull[0], pull[1])
      gx = -pull[0] / L; gy = pull[1] / L
    }
    const bx = x + gx * (r + 4), by = y + gy * (r + 4)
    const tx = -gy, ty = gx
    ctx.strokeStyle = th.pinStroke
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(bx - tx * 9, by - ty * 9); ctx.lineTo(bx + tx * 9, by + ty * 9); ctx.stroke()
    ctx.strokeStyle = th.hatch
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let k = -1; k <= 1; k++) {
      const sx = bx + tx * k * 6, sy = by + ty * k * 6
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx + gx * 5 + tx * 4, sy + gy * 5 + ty * 4)
    }
    ctx.stroke()
    ctx.fillStyle = th.pinFill
    ctx.strokeStyle = th.pinStroke
    ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = th.pinStroke
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill()
  }

  // selection mark: ring plus four ticks, readable without colour
  reticle(x, y, r, color, dashed) {
    const ctx = this.ctx
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    if (dashed) ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * (r + 1), y + dy * (r + 1)); ctx.lineTo(x + dx * (r + 5), y + dy * (r + 5))
    }
    ctx.stroke()
  }

  tag(text, x, y) {
    const ctx = this.ctx, th = this.theme
    ctx.font = `600 11px ${FONT}`
    const w = ctx.measureText(text).width
    ctx.fillStyle = th.sheet
    ctx.globalAlpha = 0.9
    ctx.fillRect(x - 3, y - 9, w + 6, 16)
    ctx.globalAlpha = 1
    ctx.fillStyle = th.text
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y)
  }

  // ---------- arrows ----------

  arrow(x0, y0, dx, dy, color, open) {
    const ctx = this.ctx
    let len = Math.hypot(dx, dy)
    if (len < 4) return
    let broken = false
    if (len > 140) { dx *= 140 / len; dy *= 140 / len; len = 140; broken = true }
    const ux = dx / len, uy = dy / len
    const x1 = x0 + dx, y1 = y0 + dy
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - (open ? 0 : ux * 6), y1 - (open ? 0 : uy * 6)); ctx.stroke()
    const hl = open ? 7 : 8, hw = open ? 3.7 : 3.5
    const lx = x1 - ux * hl - uy * hw, ly = y1 - uy * hl + ux * hw
    const rx = x1 - ux * hl + uy * hw, ry = y1 - uy * hl - ux * hw
    ctx.beginPath()
    if (open) { ctx.moveTo(lx, ly); ctx.lineTo(x1, y1); ctx.lineTo(rx, ry); ctx.stroke() }
    else { ctx.moveTo(x1, y1); ctx.lineTo(lx, ly); ctx.lineTo(rx, ry); ctx.closePath(); ctx.fill() }
    if (broken) {
      // two break ticks: the real arrow is longer than drawn
      const mx = x0 + dx * 0.5, my = y0 + dy * 0.5
      ctx.beginPath()
      for (const o of [-3, 3]) {
        ctx.moveTo(mx + ux * o - uy * 5, my + uy * o + ux * 5)
        ctx.lineTo(mx + ux * o + uy * 5, my + uy * o - ux * 5)
      }
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  // the scale is set on the first frame anything moves (largest → 60 px)
  // and then frozen until restart, so lengths stay comparable
  arrowScale(key, mags) {
    if (this.arrowK[key]) return this.arrowK[key]
    const top = Math.max(0, ...mags)
    if (!(top > 1e-9)) return 0
    this.arrowK[key] = 60 / top
    return this.arrowK[key]
  }

  drawArrows(world, s) {
    const d = s.display
    const mode = d.arrows || 'off'
    if (mode === 'off' || (!d.velocity && !d.forces)) return
    let bodies = world.bodies.filter(b => !b.pinned)
    if (mode === 'selected') bodies = s.selectedBody && !s.selectedBody.pinned ? [s.selectedBody] : []
    if (!bodies.length && !this.arrowK.vel) return
    const all = world.bodies.filter(b => !b.pinned).slice(0, 250)
    if (mode === 'all') bodies = all
    if (d.forces) {
      const { fx, fy } = world.netForces()
      const k = this.arrowScale('force', all.map(b => Math.hypot(fx[b.i], fy[b.i])))
      if (k) for (const b of bodies) {
        const [x, y] = this.toScreen(b.x, b.y)
        this.arrow(x, y, fx[b.i] * k, -fy[b.i] * k, this.theme.force, false)
      }
    }
    if (d.velocity) {
      const k = this.arrowScale('vel', all.map(b => Math.hypot(b.vx, b.vy)))
      if (k) for (const b of bodies) {
        const [x, y] = this.toScreen(b.x, b.y)
        this.arrow(x, y, b.vx * k, -b.vy * k, this.theme.vel, true)
      }
    }
  }

  drawCenterOfMass(world) {
    const c = world.centerOfMass()
    if (!c) return
    const ctx = this.ctx, th = this.theme
    const [x, y] = this.toScreen(c.x, c.y)
    ctx.strokeStyle = th.mass
    ctx.fillStyle = th.sheet
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = th.mass
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 7, -Math.PI / 2, 0); ctx.closePath(); ctx.fill()
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 7, Math.PI / 2, Math.PI); ctx.closePath(); ctx.fill()
  }
}

// zigzag with a fixed vertex count, so a stretched coil spreads and a
// squashed one bunches up: strain you can read without colour
function drawCoil(ctx, ax, ay, bx, by, restPx) {
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy)
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux
  const lead = Math.min(8, len * 0.15)
  let n = Math.max(6, Math.min(18, Math.round(restPx / 7)))
  if (n % 2) n++
  const amp = Math.min(5, 0.18 * restPx)
  const body = len - 2 * lead
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(ax + ux * lead, ay + uy * lead)
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n
    const side = i % 2 ? -amp : amp
    ctx.lineTo(ax + ux * (lead + body * t) + nx * side, ay + uy * (lead + body * t) + ny * side)
  }
  ctx.lineTo(bx - ux * lead, by - uy * lead)
  ctx.lineTo(bx, by)
  ctx.stroke()
}

// small static render of a world, for scene picker thumbnails
export function drawThumbnail(canvas, world, view, themeName) {
  const r = new Renderer(canvas)
  r.setTheme(themeName)
  r.resize()
  r.fit(view, { top: 4, right: 4, bottom: 4, left: 4 })
  r.draw(world, { display: { grid: false, stress: false, springStyle: world.springs.length > 60 ? 'line' : 'auto' }, scaleBar: false })
}
