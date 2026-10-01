/** Hard ceilings for caller-controlled work and browser resource knobs. */
export const RESOURCE_LIMITS = Object.freeze({
  maxLayoutStepsPerUpdate: 256,
  maxLayoutStepsPerRequest: 4_096,
  maxPendingWorkerSteps: 64,
  maxPendingWorkerCommands: 64,
  maxWorkerTimeoutMs: 600_000,
  maxSeparationPairChecksPerStep: 1_000_000,
  maxPixelRatio: 8,
  maxSpatialPickingCellSize: 4_096
});
