# Working on AtlasScope

AtlasScope is a Laravel 13 application that scans an uploaded Laravel project
and renders it as an interactive 3D architecture map. Read `README.md` first —
it documents the scanner stages, the API and the UI.

## Conventions

- **The scanner is static.** Nothing from an uploaded project may be executed:
  no `require`, no `eval`, no booting the target application. Everything is read
  with `nikic/php-parser` or as text.
- **Stages talk through files, never through memory.** Each stage in
  `app/Services/Scan/Stages/` reads and writes JSON in
  `{workspace}/.atlas/*.json` via `ScanContext`. Keep it that way so a scan can
  be re-run stage by stage.
- **`GraphBuilder` is the only mutable graph.** Nodes are keyed
  (`class:App\Models\Task`, `route:GET /tasks`, `table:tasks`, `view:tasks.index`)
  and merging is how later stages enrich earlier discoveries. Anything a stage
  adds to a node has to survive `mergeNode()` — including the `pos_x/pos_y/pos_z`
  coordinates written by `LayoutStage`.
- **Layout is deterministic.** TestFlow and every other project must land in the
  same coordinates on every machine; do not introduce randomness.
- **The front end is vanilla ES modules with three.js**, bundled by Vite from
  `resources/js/app.js`. `resources/js/atlas/main.js` wires everything together:
  `api.js` (endpoint client), `store.js` (visibility, filters, selection),
  `layouts.js` (four layout engines), `scene.js` (the renderer), `inspector.js`
  (the right panel), `trace.js` (request journeys), `scan.js` (progress overlay),
  `ui.js` (rail, legend, minimap, tooltips).
- **CSS is hand-written** in `resources/css/app.css`. There is no utility
  framework and there must not be one; reuse the existing design-system classes
  (`atlas`, `hud-pill`, `rail-item`, `metric`, `card`, `chip`, `legend`, …).

## Checks before calling anything done

```bash
php -l <every PHP file you touched>
php artisan test
npm run build
```

Then exercise the real thing in a browser (`php artisan serve`, open
`/projects/{uuid}/atlas`) — the renderer, picker, inspector and scan overlay are
all JavaScript and PHP tests will not catch a broken boot.

## Gotchas that have bitten before

- `Stmt\Namespace_` nodes contain the top-level statements: recurse into them or
  you will silently parse nothing.
- PHP 8.4's lexer rejects adjacent string concatenation inside array literals.
- `InstancedMesh` caches a bounding sphere the first time it is raycast; because
  instances start at zero scale, picking needs that cache invalidated whenever
  an instance matrix is written.
- A `<canvas>` is a replaced element — `inset: 0` alone leaves it at 300×150.
- `[hidden]` needs `display: none !important` when a component sets its own
  `display`, or "hidden" panels keep rendering.
- Scans run on the `atlas` queue. `ATLAS_SYNC_SCANS=true` runs them inline.
