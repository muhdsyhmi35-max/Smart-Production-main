# How a GPU Works

Interactive 3D walkthrough of GPU parallelism — VRAM, memory controller, SIMD “press,” pipeline stages, ALUs, and a live thread grid.

Inspired by the style of elaborate AI-built GPU explainers (dark industrial scene, amber data, step narration, transport controls).

## Run locally

Serve this folder over HTTP (ES modules + import maps need a server):

```bash
npx --yes serve gpu-how-it-works -p 4173
```

Then open `http://localhost:4173`.

## Controls

- **Next / Back** — step through the lesson
- **Play / Pause** — animation + auto-advance
- **Orbit** — gentle camera drift (drag to take over)
- **Arrow keys / Space** — next, previous, play/pause
- Drag to orbit, scroll to zoom

## Stack

Vanilla HTML/CSS/JS + Three.js (CDN import map), EffectComposer bloom, OrbitControls.
