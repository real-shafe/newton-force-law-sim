# Newton Force Law Simulation

A spring-mass physics simulation built around Newton's second law, F = ma. Forces, integrators, collision logic and scenes are separate, swappable pieces.

**Play:** https://newton-sim.shafe.dev

## In the browser

`public/` is a live JavaScript port of `simulation.py` with the same modular design:

- 12 scenes: the original hexagon, tearable cloth, a double pendulum, Newton's cradle, charges in a box, jelly, a hanging chain, orbits, the three-body figure-eight, coupled oscillators, a thermal lattice and an empty sandbox
- Forces: springs (with damping, rope springs and tearing), uniform gravity, air drag, Newton's gravitation, Coulomb's law, a heat bath and your hand
- Five integrators to compare: explicit Euler, semi-implicit Euler, velocity Verlet, RK4 and the original Python "RK4"
- An energy ledger that separates heat and the work your hand does from the integrator's own error, plus momentum, ghost-twin chaos and Maxwell–Boltzmann views
- Grab, build, pin and snip tools, a free-body inspector for any mass, undo, and share links

The Python `RK4Integrator` computes the force once and reuses it for all four stages, so it reduces to `x += v·dt + ½a·dt²`, `v += a·dt` and slowly gains energy. The browser version keeps it as an option next to a true RK4, so you can watch the difference.

**Controls:** drag a mass to fling it, click one to see the forces on it, scroll or pinch to zoom. Press `?` on the page for every gesture and shortcut.

Plain static files: vanilla ES modules and Canvas 2D, no build step.

## Python version

Install the dependencies:

```bash
pip install -r requirements.txt
```

Run the default example:

```bash
python simulation.py
```

An animated matplotlib window shows the masses arranged in a hexagon, with a plot of the total system energy.

## Deploy

Served by a Cloudflare Worker with static assets (`wrangler.jsonc`). Deploy with:

```bash
npx wrangler deploy
```

## Repository contents

- `simulation.py`: the Python implementation and example `main()` function.
- `requirements.txt`: Python dependencies.
- `public/`: the browser version (`js/engine.js` physics, `js/scenes.js` presets, `js/render.js` canvas drawing, `js/app.js` interface).
- `wrangler.jsonc`: Cloudflare Worker config.
