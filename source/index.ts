import { GraphController } from './core/GraphController.js';
import type { ForceGraph, ForceGraphOptions } from './core/types.js';

export async function createForceGraph3D<TNode = unknown, TLink = unknown>(
  options: ForceGraphOptions<TNode, TLink> = {}
): Promise<ForceGraph<TNode, TLink>> {
  return GraphController.create(options);
}

export const createForceGraph = createForceGraph3D;

export { createThreePlatform } from './platform/three/createThreePlatform.js';
export { GraphError } from './core/errors.js';
export type { GraphErrorCode } from './core/errors.js';
export { InvalidationReason, NodeFlags } from './core/types.js';
export type {
  BackendChangeEvent,
  CameraPose,
  DeviceLostEvent,
  EmbeddedHostOptions,
  ForceGraph,
  ForceGraphOptions,
  FrameLoopMode,
  GpuIdPickRequest,
  GraphBounds,
  GraphData,
  GraphDataChange,
  GraphDiagnostics,
  GraphErrorEvent,
  GraphErrorLike,
  GraphEventListener,
  GraphEventMap,
  GraphEventName,
  GraphHostOptions,
  GraphId,
  GraphLink,
  GraphMutationKind,
  GraphMutationResult,
  GraphNode,
  GraphNodeHandle,
  GraphNodeInput,
  GraphNodePatch,
  GraphObserverErrorEvent,
  GraphObserverErrorListener,
  GraphPatch,
  GraphReadView,
  GraphSnapshot,
  GraphStartupReport,
  GraphStartupWarning,
  GraphStartupWarningCode,
  HeadlessHostOptions,
  InteractionOptions,
  LayoutBackend,
  LayoutConfiguration,
  LayoutFailurePolicy,
  LayoutInput,
  LayoutFailedEvent,
  LayoutSeparationDiagnostics,
  LayoutSnapshot,
  LayoutSettledEvent,
  LegacyGraphSnapshot,
  LinkFlowNodeReactionOptions,
  LinkFlowOptions,
  LinkStyleOptions,
  ManagedHostOptions,
  NodeClickEvent,
  NodeDragEvent,
  NodeHoverEvent,
  NodeSelectionEffectOptions,
  NodeSurfaceOptions,
  NodeStateAppearance,
  NodeStateTheme,
  NodeStyleOptions,
  RendererBackend,
  RendererBackendPolicy,
  RendererOptions,
  RendererPickingOptions,
  SelectionChangeEvent,
  StyleValue,
  ValidationMode,
  ValidationOptions,
  Vec3,
  WorkerLike
} from './core/types.js';
export type { CreateThreePlatformOptions, ThreePlatform } from './platform/three/createThreePlatform.js';
