# Little Links

A touch-friendly mini golf game powered by an AssemblyScript WebAssembly physics engine, an HTML canvas renderer, and Effect 4 Atom state.

## Play locally

```sh
npm install
npm run dev
```

Open the local URL shown by Vite. Place the ball in the striped tee area, press the ball, drag backward to choose power and direction, then release.

## Verify and build

```sh
npm test
npm run build
```

The static production site is written to `dist/` with relative asset URLs, so it works both on a project Pages URL and a custom domain.

## Publish with GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` builds and deploys every push to `main`. In the GitHub repository, choose **Settings → Pages → Source → GitHub Actions** once if Pages is not already configured for Actions.

## Architecture

- `assembly/index.ts` owns ball placement, velocity, friction, wall/bumper collisions, strokes, cups, and the three course layouts.
- `src/main.ts` loads the WASM module, draws the responsive canvas, translates pointer gestures into putts, and updates the Effect Atom UI state.
- `tests/physics.test.js` exercises the compiled WebAssembly module directly.

