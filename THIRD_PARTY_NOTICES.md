# Third-party notices

This project is distributed under the MIT license in [LICENSE](LICENSE).

The rendered entry points and local examples use Three.js r185 (`three`
`0.185.0`), licensed under MIT. The exact Three.js license notice is retained in
[docs/licenses/three-MIT.txt](docs/licenses/three-MIT.txt). Three is supplied by
the consuming application or installed from the development lockfile; the
library package does not bundle a second Three runtime. A static demo export
that copies Three/addon bytes must retain this notice alongside those files.

TypeScript, Node declarations, and Three declarations are development dependencies
declared in [package.json](package.json) and pinned by the source checkout's
lockfile. They are not bundled into the runtime package. Their installed
distributions retain their own licenses and notices.

The example datasets are synthetic metadata and generated graph fixtures.
Public screenshots must be captured from those fixtures and reviewed for
private names, paths, counts, endpoints, and account information.
