# Tests

- `product/` checks graph state, deterministic layout, snapshots, Worker
  protocols, public exports, Three injection, interaction, camera, and labels.
- `browser/` contains bounded Node tests for example models, camera scheduling, and localhost
  module delivery. These checks do not launch a browser or prove GPU rendering.
- `tooling/` checks that the app menu lists safely, stops on failure, rejects
  escaped directories, and never hides setup inside run/test sequences.
- `package/public-api-baseline.json` freezes the intended public export surface.

`pnpm run test` builds ESM/declarations, compiles TypeScript tests into ignored
`.artifacts/test-dist/`, and runs the selected Node suites. `pnpm run check`
adds typechecking and documentation-link validation. A real local browser
session remains required for renderer/presentation verification; see
[docs/VERIFICATION.md](../docs/VERIFICATION.md).
