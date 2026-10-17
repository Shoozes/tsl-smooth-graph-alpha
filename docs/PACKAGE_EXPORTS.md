# Package exports and consumer verification

The npm archive remains `@ours/forcegraph-tsl` version `0.3.0-alpha.1` while
publication is prepared. Its eight entry points and their runtime/declaration
names are checked against the [public API baseline](../tests/package/public-api-baseline.json).
The [package metadata](../package.json) is the authoritative export map.

| Import | Runtime responsibility | Type contract |
| --- | --- | --- |
| `@ours/forcegraph-tsl` | Graph factory, injected Three platform, errors and flags | `ForceGraph`, graph/host/layout/style/event contracts |
| `@ours/forcegraph-tsl/core` | Explicit controller and common errors/flags | Core graph contracts |
| `@ours/forcegraph-tsl/three` | Capture the application's exact Three/TSL modules | Platform injection contracts |
| `@ours/forcegraph-tsl/layout` | Deterministic solver and spatial helpers | Layout configuration |
| `@ours/forcegraph-tsl/labels` | Pure screen-space label visibility decisions | Candidates, rectangles, decisions and options |
| `@ours/forcegraph-tsl/camera` | Pure framing/focus recommendations and direct/arc tween sampling | Camera frame, path, easing and sample contracts |
| `@ours/forcegraph-tsl/worker` | Browser Worker factory and packaged module URL | Layout Worker protocol |
| `@ours/forcegraph-tsl/headless` | DOM-free state, layout and snapshots | Independent headless contracts; no DOM library required |

## Search scan ownership

The [Search scan example](../examples/showcase/examples/search-scan/README.md)
composes the existing graph, camera and label APIs. The graph owns normalized
state and its rendering layers. The application owns the renderer, scene,
camera, controls, presentation clock, scanner geometry and DOM labels.

The prefab, synthetic fixture and Canvas2D fallback are example source. They
are not added to the npm export map. The renderer-specific presentation schema
has narrower string-only IDs than the graph's `string | number` IDs, and its
DOM/Three construction and disposal contract needs explicit declarations before
it could become a supported library surface.

A future packaged prefab should first separate the pure replay model from DOM
and Three ownership; define readonly group, step, result, sample and lifecycle
interfaces; state ID and resource bounds; and compile a consumer against those
declarations. Runtime tests must retain transactional construction, deterministic
seek/replacement, cancellation, empty results, reduced motion and borrowed-resource
ownership. That is a separate API decision. No new public type or subpath is
needed to ship the current example.

## Verify the actual archive

After the source review and current manifest are complete, build and use the
review-aware packer. Choose a new output directory for each candidate:

```sh
pnpm run check
npm run pack:release -- --output ../forcegraph-package
node scripts/verify-package.mjs ../forcegraph-package/ours-forcegraph-tsl-0.3.0-alpha.1.tgz
```

The [consumer verifier](../scripts/verify-package.mjs) installs the supplied
archive into a temporary directory outside the checkout. npm runs offline with
lifecycle scripts and peer/optional installation disabled. The consumer does
not link the source tree or inherit its `node_modules` resolution path.

It checks all eight runtime imports and export conditions, deterministic
headless behavior with both numeric and string IDs, the root factory in headless
mode, finite camera sampling, bounded label planning, and the packaged Worker
entry. It also checks notices, the consumer README, export targets and every
shipped source-map input. Unexpected example, script or test files fail the
runtime package inventory check.

Two TypeScript consumer fixtures compile with `strict`, NodeNext resolution,
no source aliases, no ambient `@types` inclusion and `skipLibCheck: false`.
The [headless fixture](../tests/package/consumer-headless.ts) uses only the
`ES2022` library; the [complete fixture](../tests/package/consumer-types.ts)
adds `DOM` for the browser-capable entry points. The compiler comes from the
installed development toolchain; all library imports resolve from the archive.

A successful run writes `<archive>.consumer.json` beside the archive, binding
the result to its SHA-256 digest. `--output <external-report.json>` selects a
different report path. Existing reports are not overwritten, and the temporary
consumer and npm cache are removed on success or failure.

This check proves local package consumption. The packer's adjacent receipt
records the separate source-review fingerprint. Registry ownership, version
availability, browser Worker execution and GPU rendering require their own
evidence; the consumer report does not claim them.

## Release handoff

The packer requires an exact current `PUBLIC_MANIFEST.json` inventory and does
not build `dist` itself. Run the full check before packaging and issue a fresh
source review only after source changes are final. Keep the pack receipt and
consumer report with the exact archive they describe.

Adding repository, homepage and issue-tracker metadata does not expand the
runtime API. Before the first registry release, use an authenticated npm
account with verified publishing access to the `@ours` scope, or deliberately
choose a scope/name that the maintainer controls and update the package's
identity and consumers together. A missing registry listing does not establish
scope ownership. Confirm the intended version is available as well.

Registry authentication or an explicitly configured trusted publisher is a
separate release prerequisite; this repository does not assume either one.
Preparing an archive does not publish it.

## GitHub candidate workflow

The manual [Package candidate workflow](../.github/workflows/package-candidate.yml)
uses Node 24, pinned pnpm, the complete check, the reviewed-source packer, and
the isolated consumer verifier. In **Actions → Package candidate → Run workflow**,
select the reviewed source revision. A successful run uploads the `.tgz`, source
receipt, and consumer report as `forcegraph-package-candidate` for 30 days.
Download the exact candidate before the artifact expires if it will be retained.

The workflow has read-only repository permission and contains no registry
publication step. Once the package identity, version, and publishing account
are verified, publish the reviewed tarball explicitly with public access and
the `alpha` dist-tag. Keep registry output with that tarball's existing receipts.

For recurring registry releases, configure a trusted publisher for an explicit
release workflow after the initial package/account setup. Current npm guidance
requires npm CLI 11.5.1 or newer and Node 22.14.0 or newer for trusted publishing.
The package-candidate workflow is not a configured publisher.

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [Pinned artifact upload action](https://github.com/actions/upload-artifact/tree/cf430e030ddbb5b0abf93d22962f4752f3646cd9)
