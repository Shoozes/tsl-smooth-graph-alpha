# Static demo deployment

The showcase is a static website. It serves the built library, local Three.js
modules, two used addons, and synthetic example assets from one origin. There
is no runtime CDN, application server, remote corpus, or npm install fallback.

## Build and verify

Use Node 24 and the pinned pnpm 11.19.0 from [package.json](../package.json):

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
node scripts/build-pages.mjs
```

The last command writes `.artifacts/pages/`. It copies the three public example
trees, JavaScript build output and source maps, corresponding TypeScript
sources, four Three build modules, OrbitControls, BloomNode, and license
notices. It neither installs dependencies nor builds TypeScript. Missing build
output or a Three version that differs from the development pin stops export.
Inputs cannot contain symlinks. Existing output is replaced only when it has a
generated Pages manifest; failures during copying preserve the previous build.

`pages-manifest.json` records every emitted file's size and SHA-256, the lockfile
hash, and a combined inventory fingerprint. It contains no timestamp or local
machine path. The manifest excludes itself to avoid a circular hash. It is a
static build receipt, separate from `PUBLIC_MANIFEST.json` and npm release
qualification.

The [Pages tests](../tests/tooling/pages-build.test.mjs) traverse every demo's
actual JavaScript import graph and CSS references, resolve Worker and source
map paths, verify served MIME types, and check all inventory bytes beneath
`/tsl-smooth-graph-alpha/`. They also check deterministic rebuilds and failure
preservation. These checks prove static routing, not GPU execution.

## GitHub Pages

The [workflow](../.github/workflows/pages.yml) runs checks, builds, and uploads
the static artifact on `main` pushes or manual dispatch. A read-only Pages API
preflight then checks the publishing source. A missing site (HTTP 404) or
legacy branch source writes an exact owner action to the workflow summary and
skips deployment. Unauthorized, failed, or malformed API responses fail the
preflight rather than being treated as a disabled site. Only a verified
`build_type: workflow` permits the deploy job. Deployment uses GitHub's Pages
artifact flow and the `github-pages` environment. A dispatch from another
branch may build an artifact but does not deploy it.

One repository setting is required: **Settings → Pages → Build and deployment
→ Source → GitHub Actions**. The workflow uses the normal `GITHUB_TOKEN`; it
does not attempt to enable Pages with administrator credentials. Repository
or environment rules may require an owner to enable Actions or approve a
deployment. A successful build alone does not mean the site is live: the
`deploy` job must succeed and its environment URL must load.

After selecting the publishing source, run **Actions → Demo Pages → Run
workflow** on `main`. The next workflow run reads the setting again; no extra
repository variable or token is needed.

The expected default project URL is
`https://Shoozes.github.io/tsl-smooth-graph-alpha/`. All assets and navigation
remain relative, so the same output works at the root of another static host
or under a project prefix without a rebuild or hardcoded hostname.

| Route after the site prefix | Content |
| --- | --- |
| `index.html` | Redirect and links to the showcase |
| `showcase/index.html` | Gallery and main GPU graph |
| `showcase/examples/search-scan/index.html` | Search scan with GPU and explicit Canvas2D fallback |
| `corpus/index.html` | Synthetic Corpus Atlas |
| `pages-manifest.json` | Static artifact inventory and fingerprint |

Open individual example pages through the gallery. JavaScript modules require
HTTP(S); opening exported HTML directly as `file://` is not a supported run
method. The local example server can exercise project-relative routes before
deployment:

```sh
FORCEGRAPH_BASE_PATH=/tsl-smooth-graph-alpha node scripts/showcase-server.mjs
```

This environment-variable syntax is for POSIX shells. In PowerShell, set
`$env:FORCEGRAPH_BASE_PATH = '/tsl-smooth-graph-alpha'`, then run the same Node
command. The server prints the full URLs.

## Rendering and release boundary

Most examples require a working WebGPU or WebGL2 context. The gallery keeps
its navigation available if renderer initialization fails, disables the
unusable graph controls, and links to Search scan. Search scan's Canvas2D
fallback approximates its shader halo and does not prove TSL/GPU parity.
Browser/backend evidence must name which renderer actually ran.

Publishing this website does not publish the npm package or qualify a new
library release. The package's reviewed inventory and packaging checks remain
separate. Do not describe a live Canvas demo as a GPU performance result.

## Workflow sources

Actions are pinned to commit SHAs in the workflow. Pins were resolved against
the official repositories; update them deliberately with renewed checks.

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Selecting a Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Pages configuration REST API](https://docs.github.com/en/rest/pages/pages#get-a-github-pages-site)
- [Node setup action](https://github.com/actions/setup-node/tree/48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e)
- [pnpm setup action](https://github.com/pnpm/action-setup/tree/fdbc4fdcf7d143a5d0a39e9a02e103b13e309024)
- [Pages configuration action](https://github.com/actions/configure-pages/tree/983d7736d9b0ae728b81ab479565c72886d7745b)
- [Pages artifact action](https://github.com/actions/upload-pages-artifact/tree/7b1f4a764d45c48632c6b24a0339c27f5614fb0b)
- [Pages deployment action](https://github.com/actions/deploy-pages/tree/d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e)
