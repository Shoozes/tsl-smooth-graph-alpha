import type { GraphId, InteractionOptions, Vec3 } from '../core/types.js';

export interface InteractionCallbacks {
  pickNode(event: PointerEvent): GraphId | undefined;
  pickNodeAsync?(event: PointerEvent): Promise<GraphId | undefined>;
  projectDrag(event: PointerEvent, nodeId: GraphId): Vec3 | undefined;
  hover(nodeId: GraphId | undefined, originalEvent: unknown): void;
  click(nodeId: GraphId, originalEvent: unknown): void;
  beginDrag(nodeId: GraphId, position: Vec3, originalEvent: unknown): void;
  moveDrag(nodeId: GraphId, position: Vec3, originalEvent: unknown): void;
  endDrag(nodeId: GraphId, position: Vec3, originalEvent: unknown): void;
  beginDragAsync?(nodeId: GraphId, position: Vec3, originalEvent: unknown): Promise<void>;
  moveDragAsync?(nodeId: GraphId, position: Vec3, originalEvent: unknown): Promise<void>;
  endDragAsync?(nodeId: GraphId, position: Vec3, originalEvent: unknown): Promise<void>;
  reportError?(error: unknown): void;
  getNavigationEnabled?(): boolean | undefined;
  setNavigationEnabled(enabled: boolean): void;
}

interface ActivePointer {
  pointerId: number;
  nodeId: GraphId;
  startX: number;
  startY: number;
  dragging: boolean;
  lastPosition: Vec3 | undefined;
}

/** DOM input adapter only; it emits semantic graph IDs and never creates UI. */
export class InteractionController {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InteractionCallbacks;
  private readonly hoverEnabled: boolean;
  private readonly dragEnabled: boolean;
  private readonly idleNavigationEnabled: boolean;
  private readonly restoreNavigationEnabled: boolean;
  private active: ActivePointer | undefined;
  private hoverFrameRequest: number | undefined;
  private hoverEvent: PointerEvent | undefined;
  private hoverRequestRevision = 0;
  private fallbackPointerTarget: EventTarget | undefined;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: InteractionOptions, callbacks: InteractionCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.hoverEnabled = options.hover ?? true;
    this.dragEnabled = typeof options.dragNodes === 'object'
      ? options.dragNodes.enabled ?? true
      : options.dragNodes ?? true;
    const requestedNavigationEnabled = options.navigation ?? true;
    this.restoreNavigationEnabled = callbacks.getNavigationEnabled?.() ?? requestedNavigationEnabled;
    this.idleNavigationEnabled = requestedNavigationEnabled && this.restoreNavigationEnabled;
    this.callbacks.setNavigationEnabled(this.idleNavigationEnabled);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancelActiveInteraction();
    this.disposed = true;
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.cancelHover();
    this.callbacks.setNavigationEnabled(this.restoreNavigationEnabled);
  }

  get activeNodeId(): GraphId | undefined {
    return this.active?.nodeId;
  }

  /** Releases pointer ownership and applies the configured drag completion policy. */
  cancelActiveInteraction(originalEvent: unknown = undefined, emitEndDrag = true): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = undefined;
    this.removeFallbackPointerRelease();
    this.releasePointerCapture(active.pointerId);
    if (emitEndDrag && active.dragging && active.lastPosition) {
      this.dispatchDrag('end', active.nodeId, active.lastPosition, originalEvent);
    }
    this.callbacks.setNavigationEnabled(this.idleNavigationEnabled);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.cancelHover();
    if (this.disposed || this.active || !isSupportedPrimaryPointer(event)) {
      return;
    }
    const nodeId = this.callbacks.pickNode(event);
    if (nodeId === undefined) {
      return;
    }
    this.active = {
      pointerId: event.pointerId,
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      lastPosition: undefined
    };
    if (!this.capturePointer(event.pointerId)) {
      this.installFallbackPointerRelease();
    }
    this.callbacks.setNavigationEnabled(false);
    claimPointer(event);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) {
      if (this.hoverEnabled && isSupportedPrimaryPointer(event)) {
        this.requestHover(event);
      }
      return;
    }
    const distance = Math.hypot(event.clientX - active.startX, event.clientY - active.startY);
    if (!active.dragging && this.dragEnabled && distance >= 3) {
      const position = this.callbacks.projectDrag(event, active.nodeId);
      if (position) {
        active.dragging = true;
        active.lastPosition = position;
        this.dispatchDrag('begin', active.nodeId, position, event);
      }
    }
    if (active.dragging) {
      const position = this.callbacks.projectDrag(event, active.nodeId);
      if (position) {
        active.lastPosition = position;
        this.dispatchDrag('move', active.nodeId, position, event);
      }
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    this.finishPointer(event, false);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.cancelHover();
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    this.finishPointer(event, true);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    this.finishPointer(event, true, false);
  };

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.active && this.hoverEnabled) {
      this.cancelHover();
      this.callbacks.hover(undefined, event);
    }
  };

  private finishPointer(event: PointerEvent, cancelled: boolean, releaseCapture = true): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = undefined;
    this.removeFallbackPointerRelease();
    if (releaseCapture) {
      this.releasePointerCapture(event.pointerId);
    }
    if (active.dragging) {
      const position = this.callbacks.projectDrag(event, active.nodeId) ?? active.lastPosition;
      if (position) {
        this.dispatchDrag('end', active.nodeId, position, event);
      }
      this.callbacks.setNavigationEnabled(this.idleNavigationEnabled);
      return;
    }
    this.callbacks.setNavigationEnabled(this.idleNavigationEnabled);
    if (!cancelled) {
      this.callbacks.click(active.nodeId, event);
    }
  }

  private capturePointer(pointerId: number): boolean {
    try {
      if (typeof this.canvas.setPointerCapture !== 'function') {
        return false;
      }
      this.canvas.setPointerCapture(pointerId);
      return typeof this.canvas.hasPointerCapture !== 'function' || this.canvas.hasPointerCapture(pointerId);
    } catch {
      return false;
    }
  }

  private installFallbackPointerRelease(): void {
    const target = this.canvas.ownerDocument?.defaultView
      ?? (typeof window === 'undefined' ? undefined : window);
    if (!target || this.fallbackPointerTarget) {
      return;
    }
    this.fallbackPointerTarget = target;
    target.addEventListener('pointerup', this.onFallbackPointerEnd);
    target.addEventListener('pointercancel', this.onFallbackPointerEnd);
    target.addEventListener('blur', this.onFallbackBlur);
  }

  private removeFallbackPointerRelease(): void {
    const target = this.fallbackPointerTarget;
    if (!target) {
      return;
    }
    target.removeEventListener('pointerup', this.onFallbackPointerEnd);
    target.removeEventListener('pointercancel', this.onFallbackPointerEnd);
    target.removeEventListener('blur', this.onFallbackBlur);
    this.fallbackPointerTarget = undefined;
  }

  private readonly onFallbackPointerEnd = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.active?.pointerId === pointerEvent.pointerId) {
      this.finishPointer(pointerEvent, event.type !== 'pointerup', false);
    }
  };

  private readonly onFallbackBlur = (event: Event): void => {
    this.cancelActiveInteraction(event);
  };

  private releasePointerCapture(pointerId: number): void {
    try {
      this.canvas.releasePointerCapture?.(pointerId);
    } catch {
      // A lost capture may already have been released by the browser.
    }
  }

  private requestHover(event: PointerEvent): void {
    this.hoverEvent = event;
    if (this.hoverFrameRequest !== undefined) {
      return;
    }
    if (typeof requestAnimationFrame !== 'function') {
      this.flushHover();
      return;
    }
    this.hoverFrameRequest = requestAnimationFrame(() => {
      this.hoverFrameRequest = undefined;
      this.flushHover();
    });
  }

  private dispatchDrag(kind: 'begin' | 'move' | 'end', nodeId: GraphId, position: Vec3, originalEvent: unknown): void {
    const asyncCallback = kind === 'begin'
      ? this.callbacks.beginDragAsync
      : kind === 'move' ? this.callbacks.moveDragAsync : this.callbacks.endDragAsync;
    if (asyncCallback) {
      try {
        void Promise.resolve(asyncCallback(nodeId, position, originalEvent))
          .catch((error) => this.callbacks.reportError?.(error));
      } catch (error) {
        this.callbacks.reportError?.(error);
      }
      return;
    }
    if (kind === 'begin') {
      this.callbacks.beginDrag(nodeId, position, originalEvent);
    } else if (kind === 'move') {
      this.callbacks.moveDrag(nodeId, position, originalEvent);
    } else {
      this.callbacks.endDrag(nodeId, position, originalEvent);
    }
  }

  private flushHover(): void {
    const event = this.hoverEvent;
    this.hoverEvent = undefined;
    if (!event || this.disposed || this.active || !this.hoverEnabled) {
      return;
    }
    const asyncPick = this.callbacks.pickNodeAsync;
    if (!asyncPick) {
      this.callbacks.hover(this.callbacks.pickNode(event), event);
      return;
    }
    const revision = ++this.hoverRequestRevision;
    try {
      void Promise.resolve(asyncPick(event)).then(
        (nodeId) => {
          if (!this.disposed && !this.active && revision === this.hoverRequestRevision) {
            this.callbacks.hover(nodeId, event);
          }
        },
        (error) => this.callbacks.reportError?.(error)
      );
    } catch (error) {
      this.callbacks.reportError?.(error);
    }
  }

  private cancelHover(): void {
    this.hoverRequestRevision += 1;
    if (this.hoverFrameRequest !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.hoverFrameRequest);
    }
    this.hoverFrameRequest = undefined;
    this.hoverEvent = undefined;
  }
}

function isSupportedPrimaryPointer(event: PointerEvent): boolean {
  if (event.isPrimary === false) {
    return false;
  }
  return event.button === undefined || event.button === 0 || event.button === -1;
}

function claimPointer(event: PointerEvent): void {
  try {
    event.stopPropagation?.();
    event.preventDefault?.();
  } catch {
    // Hosts may provide synthetic pointer events with restricted methods.
  }
}
