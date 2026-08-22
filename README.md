# Little Links

A touch-friendly mini golf game powered by an AssemblyScript WebAssembly physics engine, an HTML canvas renderer, and Effect 4 Atom state.

## Play locally

```sh
npm install
npm run dev
```

Open the local URL shown by Vite. Place the ball in the striped tee area, press the ball, drag backward to choose power and direction, then release. On touch screens, the course fills the available portrait or landscape viewport; pinch with two fingers to zoom and drag with two fingers to pan. With a mouse, use the wheel to zoom around the cursor and drag with the right or middle button to pan. The padded camera bounds let any part of the course be centered on screen.

While a shot is rolling, the camera follows only after the ball crosses the outer 25% of the viewport. It stops following with the ball so the player can position the camera for the next shot.

Sound starts enabled, with distinct synthesized cues for placing the ball, striking a putt, and rebounding from rails or obstacles. Guidance stays visible on the first hole, remains out of the way on later holes, and returns after 60 seconds without player input.

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
- `src/main.ts` loads the WASM module, pre-renders each static course to an offscreen bitmap for per-frame blitting, draws only dynamic game objects, translates pointer gestures into putts, and updates the Effect Atom UI state.
- `tests/physics.test.js` exercises the compiled WebAssembly module directly.
