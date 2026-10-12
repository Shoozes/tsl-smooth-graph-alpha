# Search scan — implementation verification

final result: passed

Scope: the reference-inspired example and its working Canvas2D fallback in the
available cloud browser. The primary Three/WebGPU/WebGL2 path is implemented but
GPU execution remains unverified: this browser provides neither WebGPU nor a
WebGL2 context. The fallback uses real TSL headless graph state and the same
camera/timeline/label planners, but does not execute TSL shaders. This report is
not a GPU performance claim or an npm release review.

## Source and implementation

- Source repository: `Shoozes/tsl-smooth-graph-alpha`, inspected base
  `2421a5938f73be86a774d1fd870d20c20cf1d5c0`.
- Visual source: a supplied 598 × 512 pixel, 30 fps recording lasting
  11.066667 seconds. The recording and extracted reference frames remain
  private task evidence and are not included in this public repository.
- Source frames: exact 3.50 s and 11.00 s frames, extracted before implementation,
  at `video_analysis/exact_frames/frame_008.png` and `frame_023.png` in the task
  workspace. Audio was not used.
- Implemented route: `/showcase/examples/search-scan/index.html`.
- Normalized comparison: original frame and live implementation iframe appear
  together in one browser screenshot. Each occupies **598 × 512 CSS pixels**;
  the original frame has 598 × 512 source pixels. No image rescaling or browser
  chrome is included inside either comparison region.
- Comparison captures are 1363 × 936 pixels. Desktop app viewport is
  1363 × 936; narrow app viewport is a real 390 × 844 iframe. The narrow capture
  contains the surrounding QA page and the unscaled iframe. DOM measurement
  confirmed `clientWidth = scrollWidth = 390`.
- Clean reference captures use `presentation=1&paused=1&t=3500` and
  `presentation=1&paused=1&t=11000`. UI tests use the normal controls.

The included implementation screenshot is
[search-scan-overview.jpg](examples/showcase/examples/search-scan/media/search-scan-overview.jpg).
Additional task evidence is retained under the ignored `.artifacts/search-scan-qa/`
directory and was included in the private source handoff archive. These captures
are evidence of this run, not public runtime assets. Only the implementation-only
overview above is included in the repository.

## Comparison history and fixes

| Iteration | Finding | Fix | Post-fix evidence |
| --- | --- | --- | --- |
| First close-up / overview | P1: clouds were too far apart; bright points overwhelmed the connecting web; scanner and labels lacked the reference proportions. | Compressed the vertical arrangement, enlarged irregular cluster envelopes, increased the fixture to 900 points per group, reduced ordinary point size, and strengthened thin local links. Tuned focus/overview framing and scanner scale. | `comparison-close-final.jpg`, `comparison-overview.jpg` |
| Label and focus pass | P2: group headers floated too far above their clouds; long annotation suffixes made overview labels sparse; bright neighboring groups competed with the scanner. | Tightened group label anchors, shortened visible words to their labels, used smaller overview text, moved the active word clear of the core, and dimmed surrounding graph groups at replay boundaries. | `comparison-close-final.jpg`, `desktop-final.jpg` |
| Narrow viewport | P2: CSS hid the visual labels for the search field and playhead without reliable accessible names; search feedback was hidden on narrow screens. | Added explicit accessible names and retained search help/result feedback in the narrow layout. Shortened the input placeholder to fit. | `mobile-final.jpg`; browser accessibility tree exposes “Find a label” and “Playhead”, and displays two matches for `scope`. |

Final code review also corrected two lifecycle/input risks: the GPU graph omits
its optional canvas so only the host OrbitControls owns pointer input, and a
persisted `pagehide` now pauses the host rather than disposing a page that the
browser may restore from its Back/Forward cache. `pageshow` resets the elapsed
clock and requests a frame. Normal page disposal still releases owned resources.

The first comparison is saved as `comparison-before.jpg`. Full-view source and
implementation were compared in the same image after the visual fixes. The
3.50-second comparison is also the focused-region check: at the original video
size, its scanner, core, label boxes, and local graph web are directly visible.
The reference video is compressed and uses a different topology and vocabulary;
exact glyph or node-coordinate equivalence is not claimed.

## Required fidelity surfaces

| Surface | Assessment |
| --- | --- |
| Fonts and typography | Monospaced group names and boxed word labels follow the reference hierarchy. Text size adapts to close-up/overview and viewport width. The exact font cannot be established from the compressed recording; the example uses the repository's existing monospace stack. Controls retain readable hierarchy and visible focus treatment. |
| Spacing and composition | Seven irregular clouds occupy the same broad arrangement: objective above, context/review left, role/rules right, start central, roles below. The revised overview is compact; focus views leave neighboring structure in view. Controls fit at 390 pixels without horizontal overflow. |
| Colors and tokens | Near-black background, muted blue/magenta/violet/gold/teal/white clusters, teal scanner, pink core and result emphasis. Surrounding groups dim while the selected group remains legible. Existing Vector Relay controls frame the new stage. |
| Image and geometry quality | Actual procedural graph, Three scanner geometry, and browser-rendered motion; no flattened reference image is used as the implementation. The fallback uses painter ordering without a depth buffer and approximates only the TSL halo. The source's blur, dense depth cues, and exact topology are not reproduced pixel for pixel. |
| Copy and content | Fixture vocabulary is synthetic. “Labels”, “revealing”, and “replay” describe presentation. Search states report actual text matches and no results. The UI does not claim live retrieval, model reasoning, or validation progress. |

## Browser checks

| Check | Observed result |
| --- | --- |
| Default startup | Ready state; 6,440 nodes and 15,029 links; explicitly labelled Canvas2D fallback. |
| Play and speed | Playback at 0.5× advanced from 3.50 s through the rules-to-review handoff. |
| Pause / idle rendering | After the final requested frame settled, the render counter remained at 25 across observations while paused. No continuous idle redraw was observed. |
| Backward seeking | Canvas Left Arrow moved from 4.29 s to 3.99 s; phase returned to `travel`, group `review`, and real transition strands were visible. |
| Search | `source` returned five matching labels and a 7.20 s presentation. Narrow-screen `scope` returned two matches and a 3.60 s presentation. |
| No results | `no-such-label-xyz` produced the empty-result message, 0.00 / 0.00 s, disabled playback, and preserved the graph. |
| Reset | Restored the reference sequence and its 11.10 s duration; respected the current reduced-motion choice. |
| Reduced motion | Showed a stationary completed overview; replay was disabled; search results remained available. The OS-priority calculation and media-query listener were reviewed; changing the OS preference itself was not emulated in this browser. |
| Manual camera | An actual pointer drag disabled Follow camera and displayed the manual-camera message. |
| Back/Forward cache | Navigated to the gallery and used browser Back. `pageshow.persisted` was true, the graph was not disposed, the completed scene returned, and Replay remained enabled. |
| Responsive controls | Real 390 × 844 iframe; no horizontal overflow; controls and search feedback visible; search and reduced-motion controls worked by accessible name. |
| Console | Fresh final application tab had no application warnings or errors. Browser-extension messages were excluded. Earlier explicit GPU attempts failed before the fallback was added and are recorded separately below. |

Browser screenshots: `transition.jpg`, `desktop-final.jpg`, `mobile-final.jpg`.
No frame-rate or device-performance conclusion is drawn from these UI checks.

## Code verification

`pnpm run check` passed:

- TypeScript type checking and build.
- **191 product tests**.
- **86 example/tooling tests**, including 17 new fixture/timeline/prefab tests
  and six static Pages build/preflight tests.
- Documentation-link validation.

The new tests cover deterministic seeded data, node/link references, pure
elapsed-time sampling, boundary continuity, backward seeking, repeated groups
in rank order, empty sequences, malformed inputs, collision-free label keys,
transactional sequence replacement, failed-construction rollback, disposal,
and borrowed resource ownership. Their `tests/browser` location does not make
them GPU browser tests: they execute in Node.

The Canvas adapter was additionally exercised with real Three objects and the
real headless package through an instrumented drawing context, including
projection, primitives, focus dimming, input validation, and paint counters.
That instrumented check is supplementary; the saved browser captures establish
the rendered fallback result.

The package export map, runtime source, dependencies, and lockfile are unchanged.
Package metadata, consumer verification, and static hosting preparation are
documented separately in [package exports](docs/PACKAGE_EXPORTS.md) and
[deployment](docs/DEPLOYMENT.md). The refreshed source manifest binds the public
candidate. This visual report does not establish GPU parity or npm publication.

The static hosting artifact was also opened beneath a nested URL prefix. Its
gallery exposed the unavailable-renderer panel, retained navigation, disabled
unusable graph controls, and opened Search scan through the visible fallback
link. The shipped example loaded 6,440 nodes and 15,029 links; `source` produced
five matches and a 7.20-second replay. These checks use the same Canvas backend
limitation described above. The final full repository check passed 277 tests.

## Remaining limits and polish

- **GPU verification gap:** initial automatic selection reported WebGPU
  unavailable, then WebGL2 context creation returned null. A forced WebGL2
  attempt failed the same way. The example now detects that case before owning
  its canvas and provides the explicit fallback. GPU execution should be checked
  in a browser with a real supported context before claiming GPU parity.
- **P3 / accepted reference variation:** the graph's seeded topology, synthetic
  vocabulary, exact scanner path, and sharp Canvas rendering differ from the
  recording. The cluster language, sequence, progressive labels, and camera
  behavior are reproduced as a reusable example, not as an exact video clone.
- **Consumer integration:** RAG Method's existing accepted-result replay is the
  documented integration point. No RAG source or retrieval authority changed.

No actionable P0/P1/P2 issue remains in the tested fallback workflow.
