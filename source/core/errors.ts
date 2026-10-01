export type GraphErrorCode =
  | 'FG_DATA_DUPLICATE_NODE_ID'
  | 'FG_DATA_DUPLICATE_LINK_ID'
  | 'FG_DATA_MISSING_SOURCE'
  | 'FG_DATA_MISSING_TARGET'
  | 'FG_DATA_INVALID_ID'
  | 'FG_DATA_INVALID_POSITION'
  | 'FG_DATA_MUTATION_IN_PROGRESS'
  | 'FG_DATA_STALE_MUTATION_PLAN'
  | 'FG_RENDER_BACKEND_UNAVAILABLE'
  | 'FG_RENDER_CAPABILITY_UNAVAILABLE'
  | 'FG_RENDER_CAPACITY_EXCEEDED'
  | 'FG_RENDER_PLATFORM_INVALID'
  | 'FG_LAYOUT_STEP_LIMIT_EXCEEDED'
  | 'FG_LAYOUT_WORKER_QUEUE_FULL'
  | 'FG_LAYOUT_WORKER_FAILED'
  | 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  | 'FG_LAYOUT_NONFINITE_OUTPUT'
  | 'FG_LAYOUT_MUTATION_FROZEN'
  | 'FG_LAYOUT_MUTATION_ROLLBACK_FAILED'
  | 'FG_STYLE_RESOLUTION_FAILED'
  | 'FG_LABEL_INVALID_CANDIDATE'
  | 'FG_LABEL_DUPLICATE_ID'
  | 'FG_LABEL_INVALID_OPTIONS'
  | 'FG_CAMERA_INVALID_BOUNDS'
  | 'FG_CAMERA_INVALID_OPTIONS'
  | 'FG_RESOURCE_ALREADY_DISPOSED';

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: GraphErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
