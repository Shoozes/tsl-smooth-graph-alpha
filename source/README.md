# Source map

- `core/` — public contracts, error codes, events, and `GraphController`.
- `data/` — immutable-input normalization plus typed-array graph storage.
- `layout/` — deterministic fixed-step solver, Barnes–Hut charge force, and
  local/worker bridges.
- `platform/three/` — application-owned Three/TSL platform and managed or
  embedded host ownership.
- `render/` — shared instanced node and link layers; no default object or
  material per graph element.
- `interaction/` — optional DOM pointer adapter that emits graph IDs only.
- `labels/` — deterministic screen-space visibility planner with no Three,
  glyph, texture, or DOM ownership.
- `camera/` — pure perspective frame/focus and typed direct/arc tween sampling;
  host cameras, controls, scheduling, and cancellation remain untouched.
- `worker/` — separate worker entry and protocol surface.

Every runtime Three object is constructed from the injected platform. Do not
add a runtime `three` import to `core/`, `data/`, or `layout/`.
