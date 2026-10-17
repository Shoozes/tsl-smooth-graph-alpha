# Verification

Run checks from the source root after explicit locked setup:

```sh
pnpm run typecheck
pnpm run check
```

`check` compiles the runtime and TypeScript product tests, then runs Node's
built-in test runner against the selected suites. The tests cover graph
input/patch/snapshot behavior, deterministic layout, Worker protocol/failure
handling, owned/borrowed resources, rendering adapter invariants, public exports,
camera/label math, animation clock/cancellation, and the example model/server/menu boundaries. Example/server
checks are HTTP and model tests; they do not launch a GPU browser. Documentation
checks reject missing local links.

`pnpm run test:examples` runs the bounded example/server/menu lane after building.
`node examples/headless.mjs` exercises the built package's headless entry point.
Generated test output goes under ignored `.artifacts/test-dist/`.

The Corpus position-motion regression can run without a renderer or build:
`node --test tests/browser/node-position-motion.test.mjs tests/browser/node-spawn-motion.test.mjs tests/browser/corpus-navigation.test.mjs`.
It checks immediate reduced-motion settling, cancelled frame callbacks, the
actual motion toggle and selection breathing, and existing scale/navigation behavior. These controlled
scheduler tests do not establish visual quality. Verify a mid-build switch to
reduced motion in a real browser before claiming that example qualified.
The example uses demand rendering; measure graph draw calls separately from
Three's internal clock, which can continue requesting frames while visible.

For presentation changes, start `pnpm run showcase` and use an actual local
browser. Record browser version, viewport, renderer backend, selected route,
and synthetic fixture. Check startup, loading/failure messages, empty states,
repeated/interrupted actions, responsive layout, keyboard focus, and readable
text. Public screenshots must come from synthetic data and be inspected before
release. A passing Node test does not prove visual quality or GPU support.

The reviewed release is the exact inventory in `PUBLIC_MANIFEST.json`. Its
fingerprint binds the ordered file table. `public-source.json` records ancestry.
Verify the assembled source, final package, browser journeys, and media before
issuing a new snapshot fingerprint.

This public snapshot includes no performance benchmark claim or universal
browser/GPU guarantee. The 1,000-node example is an inspectable demonstration.
Security scans are scoped to the reviewed source inventory.
