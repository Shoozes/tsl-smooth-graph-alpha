import type { GraphEventListener, GraphEventMap, GraphEventName } from './types.js';

export class GraphEventEmitter {
  private readonly listeners = new Map<GraphEventName, Set<(event: never) => void>>();

  constructor(private readonly reportObserverError: ((eventName: GraphEventName, error: Error) => void) | undefined = undefined) {}

  on<TName extends GraphEventName>(name: TName, listener: GraphEventListener<TName>): () => void {
    const listeners = this.listeners.get(name) ?? new Set<(event: never) => void>();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(name, listeners);
    return () => {
      listeners.delete(listener as (event: never) => void);
      if (listeners.size === 0) {
        this.listeners.delete(name);
      }
    };
  }

  emit<TName extends GraphEventName>(name: TName, event: GraphEventMap[TName]): void {
    const listeners = this.listeners.get(name);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event as never);
      } catch (cause) {
        this.reportObserverError?.(name, toError(cause));
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
