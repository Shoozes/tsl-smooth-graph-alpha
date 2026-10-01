# Contributing

Use Node.js 22.13 or newer, the pinned pnpm version, and the lockfile:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

The source is ESM TypeScript. Keep the eight package entry points, seeded
layout behavior, input-copying contract, snapshot migration, and owned/borrowed
resource boundaries stable. Inject Three/TSL through the application platform;
do not introduce a second Three runtime into core, data, or layout.

Run the smallest relevant check while editing, then `pnpm run check`. It builds
the package, compiles and runs product tests, runs bounded example/server/menu
tests, and checks local documentation links. Generated output belongs in
ignored `dist/`, `.artifacts/`, or `release/` directories.

Use `pnpm run showcase` to inspect changes in a real local browser. Exercise
repeated actions, cancellation, empty/error/loading states, keyboard focus,
and narrow layouts when changing the examples. Node tests do not prove GPU
rendering or visual quality. State the tested browser, renderer backend, and
fixture when reporting those results.

The [app menu](project.tasks.json) delegates to the same package commands.
Setup is explicit; run/test tasks must not trigger installation. Keep
application UI in `examples/`, reusable behavior in `source/`, and public task
adapters in `scripts/`.

Preserve [LICENSE](LICENSE) and [dependency notices](THIRD_PARTY_NOTICES.md).
Use synthetic data and reviewed media in public examples. Keep credentials,
private document contents, and machine-specific paths outside the source.

The reviewed snapshot inventory is `PUBLIC_MANIFEST.json`. Any source, task,
documentation, dependency, or media change requires new candidate verification
and a new fingerprint before release. Publication and hosting are separate
maintainer decisions.
