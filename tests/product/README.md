# Product tests

These tests verify public API exports, input ownership, stable-ID mutation,
snapshot migration, deterministic layout, bounded Worker semantics, injected
Three ownership, rendering adapter invariants, interaction, and pure camera/
label math. They do not establish a browser/GPU matrix or performance capacity.

Run `pnpm run test` from the source root after the explicit dependency setup.
The build and compiled tests remain ignored, rebuildable output.
