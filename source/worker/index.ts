import { GraphError } from '../core/errors.js';

export type { LayoutWorkerCommand, LayoutWorkerMessage, LayoutWorkerOperation } from '../layout/LayoutBridge.js';

/** Creates the packaged browser worker entry for hosts that want to inject it explicitly. */
export function createForceGraphLayoutWorker(): Worker {
  if (typeof Worker === 'undefined') {
    throw new GraphError('FG_LAYOUT_WORKER_FAILED', 'A browser Worker implementation is required for the forcegraph worker entry.');
  }
  return new Worker(new URL('./force-worker-entry.js', import.meta.url), { type: 'module' });
}

export const forceGraphLayoutWorkerUrl = new URL('./force-worker-entry.js', import.meta.url);
