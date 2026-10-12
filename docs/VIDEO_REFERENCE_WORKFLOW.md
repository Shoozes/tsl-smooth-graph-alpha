# From a video reference to a verified example

**Status: lesson proposal grounded in the search-scan implementation.** The run
used video extraction, contact-sheet analysis, deterministic implementation, and
browser comparison. There is no recorded invocation or gate receipt establishing
that the canonical **Clone Jutsu** skill ran. This document does not certify that
workflow, assign a retrospective pass, or claim token savings.

The reusable lesson is to turn a recording into a small temporal specification,
then verify the resulting behavior and appearance separately. The concrete
result is the [search-scan example](../examples/showcase/examples/search-scan/README.md).
Its implementation and browser evidence are summarized in
[design-qa.md](../design-qa.md).

## What this run established

The reference was an approximately 11.07-second recording, with a 598 × 512
video stream containing 332 frames at 30 fps. Audio was present but was not used
for the analysis. The public example uses synthetic vocabulary and seeded graph
positions; the private source video and extracted reference frames are not
runtime assets.

A coarse contact sheet established the overall sequence. Full-resolution frames
made the labels and cursor construction readable. Denser samples around the
handoffs supported a continuous camera/focus interpretation. Those observations
produced three implementation priorities:

1. Dense, irregular local webs separated by visible empty space.
2. A small magenta core inside a dark teal ring, with uneven moving filaments.
3. Coordinated cursor movement, camera movement, and progressive label reveal.

The first browser comparison exposed differences that code tests could not:
cloud spacing, point brightness, web density, cursor scale, and label placement.
Later comparisons refined the overview and dimmed neighboring groups during a
focused pass. Narrow-screen checks exposed control naming and feedback issues.

This was a reconstruction of observable presentation. The recording did not
establish the original renderer, graph topology, software identity, or whether
its displayed processing labels corresponded to real backend work.

## Capture and extraction recipe

These are reproducible commands for a short local reference. They are manual
analysis notes, not a new video-processing subsystem. Use a reviewed copy named
`input.mp4` and keep working evidence in the ignored `.artifacts/` directory.
Record the source hash and tool versions with the review evidence. Keep private
source identity, raw logs, frames, and comparison sheets out of public commits.

Create the output directory, then record media metadata and decoded frame
timestamps. The Node command works with the repository's existing runtime.

```sh
node -e "require('node:fs').mkdirSync('.artifacts/video-reference', { recursive: true })"
ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,time_base,start_time,duration,nb_frames -of json input.mp4 > .artifacts/video-reference/probe.json
ffprobe -v error -select_streams v:0 -show_frames -show_entries frame=pts_time,best_effort_timestamp_time,duration_time -of json input.mp4 > .artifacts/video-reference/frames.json
```

Use a bounded contact sheet for orientation. This command creates one sheet of
up to 48 samples at four samples per second, covering approximately the first
12 seconds. Read it left to right, then top to bottom. Empty trailing cells in a
short clip are padding. For a longer reference, choose bounded intervals instead
of treating this first sheet as coverage of the whole video.

```sh
ffmpeg -hide_banner -i input.mp4 -vf "setpts=PTS-STARTPTS,drawtext=text='t=%{pts\:hms}':x=10:y=10:fontcolor=white:fontsize=20:box=1:boxcolor=black@0.7,fps=4,scale=299:256:force_original_aspect_ratio=decrease,pad=299:256:(ow-iw)/2:(oh-ih)/2,tile=4x12:padding=8:margin=8" -frames:v 1 -update 1 .artifacts/video-reference/contact-sheet.png
```

The `drawtext` filter needs an FFmpeg build with font rendering and an available
font. If unavailable, omit that filter and use the timestamp manifest; do not
label cells with invented exact times. The timestamp overlay belongs on the
analysis sheet. Keep exact comparison frames unannotated.

### Timestamp details that matter

- **PTS is presentation time.** `setpts=PTS-STARTPTS` expresses it as elapsed time
  from the first decoded frame. Retain the original timestamp manifest so this
  normalization remains explicit.
- **The timestamp is drawn before `fps`.** It therefore describes the selected
  source frame. Drawing it after `fps` would show the resampled output clock.
- **A sampling cadence is not a source-frame guarantee.** In this run, the
  four-fps command's first source samples were 0.100 and 0.367 seconds, even
  though its output cadence began at 0.000 and 0.250 seconds. Do not infer source
  time solely from a cell number.
- **Average fps is insufficient for variable-rate recordings.** Inspect frame
  timestamps. Do not convert a frame ordinal to time using average fps unless
  constant-rate timing has actually been established.
- **Container duration is not the last frame timestamp.** This source's duration
  was 11.066667 seconds; its final frame began at 11.033333 seconds. Asking for a
  frame at the exact container end can produce no image.
- **Decoded frame selection and seeking differ.** For an exact comparison,
  record the selected frame's actual PTS rather than assuming a seek request
  landed on the requested time.

For this verified 30-fps, zero-origin source, decoded frame `n=105` is the
3.50-second frame. Here `n` is zero-based and no preceding resampling filter
changes its meaning. `showinfo` records the selected frame's timestamp.

```sh
ffmpeg -hide_banner -i input.mp4 -vf "select='eq(n,105)',showinfo" -fps_mode vfr -frames:v 1 -update 1 .artifacts/video-reference/reference-3.50.png 2> .artifacts/video-reference/reference-3.50.log
```

For other media, select the first decoded frame at or after an elapsed target
and inspect the receipt. The result may be later than the requested time.

```sh
ffmpeg -hide_banner -i input.mp4 -vf "setpts=PTS-STARTPTS,select='gte(t,3.5)',showinfo" -fps_mode vfr -frames:v 1 -update 1 .artifacts/video-reference/reference-after-3.50.png 2> .artifacts/video-reference/reference-after-3.50.log
```

Extract a short handoff at native temporal resolution when a sparse sheet leaves
movement ambiguous. This example keeps all decoded frames from 3.7–4.2 seconds.

```sh
ffmpeg -hide_banner -i input.mp4 -vf "setpts=PTS-STARTPTS,select='between(t,3.7,4.2)',showinfo" -fps_mode vfr .artifacts/video-reference/handoff-%03d.png 2> .artifacts/video-reference/handoff.log
```

Keep the original frame, timestamp receipt, and source identity together. A crop
or resized sheet is useful evidence for a region, but its pixel dimensions must
not be presented as the original source dimensions.

## Convert observations into a temporal contract

Describe visible actions in time order before choosing a rendering technique.
Separate cursor movement from camera translation and zoom. Sampled continuity
can support an interpretation, but it cannot rule out every hidden cut or prove
physical motion in the source's graph coordinates.

The observed boundaries below are approximate. The example's boundaries are an
explicit implementation choice in its absolute-time replay, not measurements
copied from every original frame.

| Visible phase | Approximate source interval | Example interval |
| --- | --- | --- |
| Gold roles cluster active | 0.0–0.9 s | 0–900 ms |
| Handoff toward rules | 0.9–1.1 s | 900–1,200 ms |
| Teal rules cluster active | 1.1–3.7 s | 1,200–3,800 ms |
| Handoff toward review | 3.8–4.1 s | 3,800–4,100 ms |
| Purple review cluster active | 4.1–6.5 s | 4,100–6,700 ms |
| Handoff toward start | 6.6–6.9 s | 6,700–7,000 ms |
| Copper start cluster active | 6.9–9.4 s | 7,000–9,600 ms |
| Broad reveal and overview pullback | About 9.5 s to the end | 9,600–11,100 ms |

The resulting contract keeps a stable graph and supplies ordered steps, node
references, durations, interpolation endpoints, and visibility state. Sampling
an absolute time must reconstruct the same state regardless of playback history.
An interrupted or backward seek must not leave completion flags from the future.
A revisited group becomes complete only after its final scheduled visit.

Presentation state describes what has been revealed. It must not imply that
retrieval, ranking, citation validation, or model reasoning completed because an
animation reached a particular frame.

## Separate interpretation, mechanical evidence, and browser proof

| Evidence | What it can establish | What it does not establish |
| --- | --- | --- |
| Model inspection of frames | Visible objects, approximate ordering, candidate motion relationships, perceptual priorities, and ambiguities. | Hidden architecture, original application identity, actual backend progress, or exact unsampled motion. |
| Metadata and extraction receipts | Media dimensions, streams, timestamp mapping, selected frames, and declared coverage. | Visual similarity or working application behavior. |
| Pure and instrumented tests | Determinism, valid references, exact replay boundaries, interpolation continuity, input copying, cancellation semantics, ownership, and observed drawing calls. | Browser appearance, GPU execution, measured frame rate, or accessibility in the actual page. |
| Live browser captures and interactions | Rendered composition on the named backend, controls, labels, motion samples, viewport behavior, and visible failure states. | Parity with an untested backend or performance on another device. |

The example's Node tests live under `tests/browser`; their location does not turn
them into browser or GPU tests. The Canvas harness uses real Three objects and
accepted headless graph state, but it remains an instrumented drawing test.

### Compare at the same size

For a faithful comparison, use an unannotated source frame and a live
implementation capture with the same stage dimensions. This run compared both
at **598 × 512 CSS pixels**, with the 598 × 512 source image displayed unscaled.
Record browser zoom, device-pixel ratio, screenshot dimensions, and measured
element dimensions. Equal CSS sizes alone do not establish equal physical pixels
on a high-density display.

The clean-stage route supports `presentation=1&paused=1&t=3500`. Test the normal
controls separately. Inspect a close-up and overview, then a short sequence of
samples around each handoff. A single final frame cannot expose camera snapping,
stale labels, discontinuous cursor travel, or idle animation that keeps rendering.

Keep a small before/after record: observation, relevant region/time, change,
and verification. In this run, that record was useful for cluster spacing,
point-to-edge brightness, scanner scale, label placement, and neighboring-group
dimming. Recheck the whole composition after a regional correction.

### Playback and backend checklist

- Start playback through the visible control and observe the scanner, camera,
  and playhead at separate times. A rendered still or increasing render-call
  counter does not establish working animation or successful GPU draws.
- Compare playhead progress with elapsed visible time, including sparse frames.
  A presentation clock must not stretch an eleven-second replay into minutes.
- Pause and confirm the settled view stops requesting continuous frames.
- Seek forward and backward, including exact phase boundaries and group revisits.
- Exercise search, empty results, reset, replay, and manual camera takeover.
- Check a narrow viewport, accessible control names, keyboard input, and feedback.
- Check reduced motion separately: stable overview, no autonomous motion,
  available results, and no continuous redraw. Record whether the OS preference
  change was actually exercised or only reviewed in code. Verify the viewer can
  explicitly opt into this animation through the page's controls, and can stop
  it again without changing operating-system settings.
- Name the backend actually observed: WebGPU, WebGL2, or Canvas2D fallback.
  Force the intended backend when claiming its coverage.
- Keep unavailable required backends visible as failures. The example's explicit
  Canvas fallback has its own scope; it does not demonstrate TSL shader execution,
  a GPU depth buffer, or GPU performance.
- Test cleanup and browser restoration behavior where relevant. Preserve the
  distinction between pausing a cached page and disposing a destroyed page.

## Clone Jutsu routing: proposed lesson, not a receipt

The supplied working vocabulary is **capture → mechanical gate →
reuse_review / review_regions / review_full / blocked**. This run informs how a
video reference could feed that process. It does not establish that the installed
canonical skill, its thresholds, or its automation were used.

Before assigning a route, the mechanical gate should establish source identity,
timestamp mapping, capture completeness, compatible viewport/backend conditions,
and the identity of any previous reviewed baseline. A model's statement that two
images look close is not a substitute for those checks.

| Proposed route | Evidence needed for this kind of task |
| --- | --- |
| `reuse_review` | The canonical policy explicitly permits reuse of an identified prior review, and current evidence meets that policy. Do not infer eligibility from visual similarity alone. |
| `review_regions` | A compatible full capture and baseline exist, and a bounded change can be inspected in identified regions and time intervals. Recheck overall composition after the correction. |
| `review_full` | New composition, camera behavior, motion, backend, or uncertain change scope requires the full sequence and both focused/overview views. This is the sensible starting review for a new reconstruction. |
| `blocked` | Required source, trustworthy timestamps, compatible captures, or an explicitly required working backend are missing. Record the missing evidence precisely. |

Do not invent gate thresholds or backfill a certified status for this session.
Any canonical skill change belongs in that skill's maintained source and requires
its actual instructions and persistence workflow. This document is only a
repository lesson proposal.

Contact sheets can concentrate review attention, but this run did not measure
token savings. A future claim needs comparable tasks, model/settings, coverage,
input accounting, human review effort, and outcome quality; reduced image count
alone is insufficient.

## Ownership and publication boundary

| Owner | Responsibility |
| --- | --- |
| GenEye | Generic capture identity, temporal extraction, timestamp evidence, and reusable capture/review tooling. Consume its existing tooling when available; this example should not grow a duplicate framework. |
| ForceGraph TSL | Accepted graph presentation, deterministic replay, scanner geometry, camera/label behavior, example controls, and rendering verification. These lessons and manual commands support that work. |
| RAG Method | Accepted search results and their order, source identity, citations, context selection, and request-generation/corpus guards. Presentation consumes those decisions and cancels superseded replay. |
| Canonical Clone Jutsu skill owner | Actual gate implementation, routing policy, review reuse rules, and skill updates. This document does not replace that authority. |

Before a public commit, remove private media, reference-frame crops, original
upload names, machine-specific paths, and logs that expose them. Commit only
reviewed synthetic implementation captures needed by the example. Keep evidence
retention separate from runtime assets and from npm release approval.

Run the relevant tests and `pnpm run check` after changes. Follow
[CONTRIBUTING.md](../CONTRIBUTING.md) for candidate verification and publication
boundaries. The repeatable completion record is: identified source and coverage,
timestamped observations, bounded temporal contract, implementation, mechanical
results, browser/backend evidence, remaining differences, and the published
source identity.
