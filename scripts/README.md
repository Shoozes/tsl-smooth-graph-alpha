# Product scripts

- `showcase-server.mjs` starts a localhost-only example server with explicit
  theme, showcase, synthetic Corpus Atlas, package, and installed Three routes.
- `browser/static-server.mjs` serves approved directories with MIME types,
  realpath containment, size bounds, and non-executable unknown content.
- `run-tests.mjs` selects the shipped Node test suites without shell globs.
- `check-docs.mjs` validates local Markdown destinations in the public source.
- `pack.mjs` inventories the local npm package, stages the exact files, replaces
  the staged README with the consumer guide, and writes the archive plus a
  source-fingerprint receipt outside the source tree. It does not install
  dependencies or run lifecycle scripts.

`app.ps1` is the PowerShell 5.1/7 app entry. It delegates to the root `run.mjs`
runner, which reads the single [project.tasks.json](../project.tasks.json)
registry and dispatches the same product commands. Stable `forcegraph.*` IDs
and short aliases select the same tasks. Setup is selected explicitly; the
runner requires the installed pinned pnpm version and prevents automatic
toolchain provisioning.
