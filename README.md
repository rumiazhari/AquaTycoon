# 💧 AquaTycoon 3D — Wastewater Engineering Tycoon

A realistic 3D tycoon/strategy game where you design, build and operate
wastewater treatment plants. Real environmental-engineering mass-balance
simulation (BOD/COD/TSS/N/P/pathogens), a 5-stage campaign, tech tree,
sandbox mode with storm & toxic-spill events — all running fully in the
browser.

Built with **React + TypeScript + Three.js + Vite + Tailwind CSS**.

## ▶️ Play instantly

- **Single-file launcher**: open `AquaTycoon_Launcher.html` in any modern
  browser. Everything (JS/CSS) is inlined into that one file — no install,
  no server, no downloads. Share it, email it, or host it anywhere.
- **GitHub Pages**: after enabling Pages (Actions tab → confirm deploy),
  play at `https://<your-user>.github.io/AquaTycoon/`.

## 🎮 Controls

| Input | Action |
|---|---|
| Left-drag | Pan camera |
| Right/middle-drag | Orbit / tilt camera |
| Scroll | Zoom |
| `R` | Rotate unit before placing |
| `W A S D` / arrows | Pan camera |
| `+` / `-` | Zoom |
| `Esc` | Back to Inspect tool |

Gameplay: pick units from the bottom toolbar (follow the Recommended star),
place them on the grid, connect pipes (unit A → unit B), and meet the
effluent standards shown in the Level Goals panel before cash runs out.

## 🧪 The simulation is real

Each tick solves a hydraulic network with iterative relaxation:
recycles (RAS, internal nitrate) converge stably; every process model uses
genuine heuristics — Monod kinetics for CAS aeration, SOR-based clarifier
settling, UV dose-response log-inactivation, mesophilic anaerobic digestion
biogas yield, RO recovery/brine split, EBPR phosphorus uptake, and more.
Financials (tariffs, power, chemicals, sludge disposal, compliance fines)
are computed from the same mass balance.

## 🗺️ The world

Procedurally generated environment around your plant: rolling hills,
a meandering animated river with sandy banks, ~500 instanced trees,
a neighbouring town (houses, city skyline with night-lit windows, farm
silos), roads with a river bridge and street lights, perimeter fencing
with a welcome gate, drifting clouds, distant mountains, and smooth
day/night cycles.

## 🛠️ Development

```bash
npm install          # install dependencies
npm run dev          # dev server at http://localhost:3000
npm run build        # type-check + production build to dist/
npm run build:all    # build + generate single-file launcher
```

Headless simulation smoke tests:

```bash
npx esbuild scripts/sim-tests.ts --bundle --platform=node --format=cjs --outfile=sim-tests.cjs && node sim-tests.cjs
```

## 🚀 Deploying to GitHub Pages

This repo ships with `.github/workflows/deploy.yml`. Push to `main`,
then in the repository settings set **Pages → Source: GitHub Actions**.
The site publishes automatically with `base: './'` so it works under
the `/AquaTycoon/` subpath.

## 📄 License

MIT
