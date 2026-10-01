import { NodeFlags, type LinkFlowOptions, type NodeStateTheme, type NodeSurfaceOptions, type Vec3 } from '../core/types.js';
import {
  supportsThreeAttributeAttachment,
  supportsTslGraphTransform,
  supportsTslLinkFlow,
  supportsTslNodeSurface
} from '../platform/three/ThreeCapabilities.js';

export type ThreeObject = Record<string, unknown>;
type ThreeConstructor = new (...args: unknown[]) => object;

export interface NumericAttribute {
  readonly attribute: ThreeObject;
  readonly values: Float32Array | Uint32Array;
  readonly itemSize: number;
}

export interface NodeAttributeSet {
  readonly radius: NumericAttribute;
  readonly color: NumericAttribute;
  readonly state: NumericAttribute;
  readonly flowRole: NumericAttribute | undefined;
}

export interface LinkAttributeSet {
  readonly sourceIndex: NumericAttribute;
  readonly targetIndex: NumericAttribute;
  readonly sourceRadius: NumericAttribute;
  readonly targetRadius: NumericAttribute;
  readonly width: NumericAttribute;
  readonly color: NumericAttribute;
}

export interface PositionAtlasBinding {
  readonly texture: ThreeObject;
  readonly width: number;
}

export interface TslTransformDefinition {
  readonly nodePosition: ThreeObject;
  readonly nodeColor: ThreeObject;
  readonly nodeOpacity: ThreeObject | undefined;
  readonly linkPosition: ThreeObject;
  readonly linkColor: ThreeObject;
  readonly linkOpacity: ThreeObject | undefined;
  readonly positionAtlasNode: ThreeObject;
  readonly stateTheme: TslStateThemeBinding;
  /** Undefined only when the injected TSL module lacks optional surface math. */
  readonly nodeSurface: TslNodeSurfaceBinding | undefined;
  /** Undefined when link flow was not configured or the injected TSL surface cannot build it. */
  readonly linkFlow: TslLinkFlowBinding | undefined;
}

export interface TslStateThemeBinding {
  update(theme: NodeStateTheme): void;
}

/** Updates the shared material's sphere-impostor uniforms without instance writes. */
export interface TslNodeSurfaceBinding {
  update(surface: NodeSurfaceOptions | undefined): void;
  setTime(timeSeconds: number): void;
}

/** Updates one shared directional-flow shader without rewriting link instances. */
export interface TslLinkFlowBinding {
  update(flow: LinkFlowOptions | undefined): void;
  setTime(timeSeconds: number): void;
}

interface TslNode extends ThreeObject {
  readonly x: TslNode;
  readonly y: TslNode;
  readonly z: TslNode;
  readonly w: TslNode;
  readonly xyz: TslNode;
  add(value: unknown): TslNode;
  sub(value: unknown): TslNode;
  mul(value: unknown): TslNode;
  div(value: unknown): TslNode;
  mod(value: unknown): TslNode;
  toInt(): TslNode;
  greaterThan(value: unknown): TslNode;
}

/** Builds the shared node/link attribute and transform contracts for Three's TSL graph. */
export function createTslTransformDefinition(
  tsl: ThreeObject,
  linkWidthUnit: 'world' | 'pixel',
  positionAtlas: PositionAtlasBinding,
  stateTheme: NodeStateTheme,
  nodeSurface: NodeSurfaceOptions | undefined = undefined,
  linkFlow: LinkFlowOptions | undefined = undefined
): TslTransformDefinition | undefined {
  const attribute = tsl.attribute as (name: string, type: string) => TslNode;
  const positionLocal = tsl.positionLocal as TslNode;
  const cameraWorldMatrix = tsl.cameraWorldMatrix as TslNode;
  const cameraPosition = tsl.cameraPosition as TslNode;
  const cameraViewMatrix = tsl.cameraViewMatrix as TslNode | undefined;
  const cameraProjectionMatrix = tsl.cameraProjectionMatrix as TslNode | undefined;
  const cameraViewport = tsl.cameraViewport as TslNode | undefined;
  const instanceIndex = tsl.instanceIndex as TslNode;
  if (!supportsTslGraphTransform(tsl, linkWidthUnit)) {
    return undefined;
  }
  try {
    const createTexture = tsl.texture as (value: unknown) => TslNode;
    const textureLoad = tsl.textureLoad as (...values: unknown[]) => TslNode;
    const createIvec2 = tsl.ivec2 as (x: unknown, y: unknown) => TslNode;
    const createInt = tsl.int as (value: unknown) => TslNode;
    const createUniform = tsl.uniform as (value: number) => TslNode;
    const createVec3 = tsl.vec3 as (x: unknown, y: unknown, z: unknown) => TslNode;
    const floor = tsl.floor as (value: unknown) => TslNode;
    const select = tsl.select as (condition: unknown, ifTrue: unknown, ifFalse: unknown) => TslNode;
    const mix = tsl.mix as (first: unknown, second: unknown, amount: unknown) => TslNode;
    const round = tsl.round as (value: unknown) => TslNode;
    const max = tsl.max as (first: unknown, second: unknown) => TslNode;
    const length = tsl.length as (value: unknown) => TslNode;
    const normalize = tsl.normalize as (value: unknown) => TslNode;
    const cross = tsl.cross as (first: unknown, second: unknown) => TslNode;
    const createThemeBinding = createTslStateThemeBinding(createUniform, createVec3, stateTheme);
    const createSurfaceBinding = createTslNodeSurfaceBinding(tsl, createUniform, createVec3, nodeSurface);
    const createFlowBinding = linkFlow === undefined
      ? undefined
      : createTslLinkFlowBinding(tsl, createUniform, createVec3, mix, linkFlow);
    const positionAtlasNode = createTexture(positionAtlas.texture);
    const atlasWidth = positionAtlas.width;
    const readPosition = (index: TslNode): TslNode => {
      const x = createInt(index.mod(atlasWidth));
      const y = createInt(index.div(atlasWidth));
      return textureLoad(
        positionAtlasNode,
        createIvec2(x, y),
        0
      ).xyz;
    };
    const nodePosition = readPosition(instanceIndex);
    const nodeRadius = attribute('graphRadius', 'float') as TslNode;
    const nodeColor = attribute('graphColor', 'vec3') as TslNode;
    const nodeState = attribute('graphState', 'float') as TslNode;
    const stateActive = (flag: NodeFlags): TslNode => floor(nodeState.div(flag)).mod(2).greaterThan(0.5);
    const applyAppearance = (active: TslNode, appearance: TslStateUniforms, visual: TslVisualNodes): TslVisualNodes => ({
      radius: select(active, visual.radius.mul(appearance.scale), visual.radius),
      color: select(active, round(mix(visual.color, appearance.color, appearance.colorMix).mul(255)).div(255), visual.color),
      visible: select(active, appearance.visible.greaterThan(0.5), visual.visible)
    });
    let nodeVisual: TslVisualNodes = { radius: nodeRadius, color: nodeColor, visible: stateActive(NodeFlags.Visible) };
    for (const [flag, appearance] of [
      [NodeFlags.Dimmed, createThemeBinding.appearances.dimmed],
      [NodeFlags.Pinned, createThemeBinding.appearances.pinned],
      [NodeFlags.Selected, createThemeBinding.appearances.selected],
      [NodeFlags.Hovered, createThemeBinding.appearances.hovered],
      [NodeFlags.Focused, createThemeBinding.appearances.focused],
      [NodeFlags.Hidden, createThemeBinding.appearances.hidden]
    ] as const) {
      nodeVisual = applyAppearance(stateActive(flag), appearance, nodeVisual);
    }
    const selectionActive = createSurfaceBinding === undefined
      ? 0
      : select(stateActive(NodeFlags.Selected), createSurfaceBinding.nodes.selectionEnabled, 0);
    const selectionPulse = createSurfaceBinding === undefined
      ? 0.94
      : (tsl.sin as (value: unknown) => TslNode)(
          createSurfaceBinding.nodes.time.mul(createSurfaceBinding.nodes.selectionBreathSpeed).mul(Math.PI * 2)
        ).mul(select(
          createSurfaceBinding.nodes.selectionBreathAmount.greaterThan(0.015),
          0.06,
          createSurfaceBinding.nodes.selectionBreathAmount.mul(4)
        )).add(0.94);
    if (createSurfaceBinding !== undefined) {
      const selectedBreath = (tsl.sin as (value: unknown) => TslNode)(
        createSurfaceBinding.nodes.time.mul(createSurfaceBinding.nodes.selectionBreathSpeed).mul(Math.PI * 2)
      ).mul(createSurfaceBinding.nodes.selectionBreathAmount).add(1);
      nodeVisual = {
        ...nodeVisual,
        radius: nodeVisual.radius.mul(mix(
          1,
          selectedBreath.mul(createSurfaceBinding.nodes.selectionScale),
          selectionActive
        ))
      };
    }
    if (createFlowBinding !== undefined) {
      const nodeFlowRole = attribute('graphFlowRole', 'float') as TslNode;
      nodeVisual = applyNodeFlowReaction(tsl, mix, select, nodeVisual, nodeFlowRole, createFlowBinding.nodes);
    }
    const resolvedNodeSurface = createSurfaceBinding === undefined
      ? { color: nodeVisual.color, opacity: undefined }
      : applyNodeSurface(
        tsl,
        createVec3,
        mix,
        select,
        nodeVisual.color,
        createSurfaceBinding.nodes,
        selectionActive,
        selectionPulse,
        nodeSurface?.selectionEffect !== undefined
      );
    const matrix = cameraWorldMatrix as unknown as { readonly [index: number]: TslNode };
    const nodeRight = matrix[0]!.xyz;
    const nodeUp = matrix[1]!.xyz;
    const cameraForward = matrix[2]!.xyz;
    const nodePositionNode = nodePosition
      .add(nodeRight.mul(positionLocal.x.mul(select(nodeVisual.visible, nodeVisual.radius, 0).mul(2))))
      .add(nodeUp.mul(positionLocal.y.mul(select(nodeVisual.visible, nodeVisual.radius, 0).mul(2))));

    const sourceIndex = attribute('graphSourceIndex', 'uint') as TslNode;
    const targetIndex = attribute('graphTargetIndex', 'uint') as TslNode;
    const sourceRadius = attribute('graphSourceRadius', 'float') as TslNode;
    const targetRadius = attribute('graphTargetRadius', 'float') as TslNode;
    const source = readPosition(sourceIndex);
    const target = readPosition(targetIndex);
    const width = attribute('graphWidth', 'float') as TslNode;
    const delta = target.sub(source);
    const linkLength = max(length(delta), 0.0001);
    const direction = delta.div(linkLength);
    const visible = linkLength.greaterThan(sourceRadius.add(targetRadius));
    const clippedSource = source.add(direction.mul(select(visible, sourceRadius, linkLength.mul(0.5))));
    const clippedTarget = target.sub(direction.mul(select(visible, targetRadius, linkLength.mul(0.5))));
    const clippedLength = select(visible, linkLength.sub(sourceRadius.add(targetRadius)), 0);
    const midpoint = clippedSource.add(clippedTarget).mul(0.5);
    const toCamera = cameraPosition.sub(midpoint);
    const normal = select(
      length(toCamera).greaterThan(0.0001),
      normalize(toCamera),
      cameraForward
    );
    const rawSide = cross(normal, direction);
    const fallbackSide = cross(nodeUp, direction);
    const secondarySide = cross(nodeRight, direction);
    const stableFallback = select(
      length(fallbackSide).greaterThan(0.0001),
      normalize(fallbackSide),
      normalize(secondarySide)
    );
    const finalSide = select(
      length(rawSide).greaterThan(0.0001),
      normalize(rawSide),
      stableFallback
    );
    let widthNode = width;
    if (linkWidthUnit === 'pixel') {
      const viewMidpoint = cameraViewMatrix!.mul(
        (tsl.vec4 as (value: unknown, w: number) => TslNode)(midpoint, 1)
      ) as TslNode;
      const projectionScale = (cameraProjectionMatrix![1]! as TslNode).y;
      widthNode = width.mul(
        max(viewMidpoint.z.mul(-1), 0.0001)
          .mul(2)
          .div(projectionScale.mul(max(cameraViewport!.w, 1)))
      );
    }
    widthNode = select(visible, widthNode, 0);
    const linkPositionNode = midpoint
      .add(direction.mul(positionLocal.x.mul(clippedLength)))
      .add(finalSide.mul(positionLocal.y.mul(widthNode)));
    const linkColor = attribute('graphLinkColor', 'vec3') as TslNode;
    const resolvedLinkFlow = createFlowBinding === undefined
      ? undefined
      : applyLinkFlow(tsl, mix, linkColor, createFlowBinding.nodes);
    return {
      nodePosition: nodePositionNode,
      nodeColor: resolvedNodeSurface.color,
      nodeOpacity: resolvedNodeSurface.opacity,
      linkPosition: linkPositionNode,
      linkColor: resolvedLinkFlow?.color ?? linkColor,
      linkOpacity: resolvedLinkFlow?.opacity,
      positionAtlasNode,
      stateTheme: createThemeBinding.binding,
      nodeSurface: createSurfaceBinding?.binding,
      linkFlow: createFlowBinding?.binding
    };
  } catch {
    return undefined;
  }
}

export function createNodeAttributes(
  three: ThreeObject,
  geometry: ThreeObject,
  capacity: number,
  includeFlowRole = false
): NodeAttributeSet | undefined {
  const radius = createNumericAttribute(three, geometry, 'graphRadius', 1, capacity);
  const color = createNumericAttribute(three, geometry, 'graphColor', 3, capacity);
  const state = createNumericAttribute(three, geometry, 'graphState', 1, capacity);
  const flowRole = includeFlowRole ? createNumericAttribute(three, geometry, 'graphFlowRole', 1, capacity) : undefined;
  return radius && color && state && (!includeFlowRole || flowRole)
    ? { radius, color, state, flowRole }
    : undefined;
}

export function createLinkAttributes(three: ThreeObject, geometry: ThreeObject, capacity: number): LinkAttributeSet | undefined {
  const sourceIndex = createNumericAttribute(three, geometry, 'graphSourceIndex', 1, capacity, Uint32Array);
  const targetIndex = createNumericAttribute(three, geometry, 'graphTargetIndex', 1, capacity, Uint32Array);
  const sourceRadius = createNumericAttribute(three, geometry, 'graphSourceRadius', 1, capacity);
  const targetRadius = createNumericAttribute(three, geometry, 'graphTargetRadius', 1, capacity);
  const width = createNumericAttribute(three, geometry, 'graphWidth', 1, capacity);
  const color = createNumericAttribute(three, geometry, 'graphLinkColor', 3, capacity);
  return sourceIndex && targetIndex && sourceRadius && targetRadius && width && color
    ? { sourceIndex, targetIndex, sourceRadius, targetRadius, width, color }
    : undefined;
}

function createNumericAttribute(
  three: ThreeObject,
  geometry: ThreeObject,
  name: string,
  itemSize: number,
  capacity: number,
  ArrayType: typeof Float32Array | typeof Uint32Array = Float32Array
): NumericAttribute | undefined {
  const Attribute = asConstructor(three.InstancedBufferAttribute);
  if (!Attribute || !supportsThreeAttributeAttachment(three, geometry)) {
    return undefined;
  }
  const values = new ArrayType(Math.max(1, capacity) * itemSize);
  const attribute = new Attribute(values, itemSize) as ThreeObject;
  if (three.DynamicDrawUsage !== undefined) {
    call(attribute, 'setUsage', three.DynamicDrawUsage);
  }
  call(geometry, 'setAttribute', name, attribute);
  return { attribute, values, itemSize };
}

export function writeVec3Attribute(attribute: NumericAttribute, instance: number, value: Vec3): void {
  const offset = instance * attribute.itemSize;
  attribute.values[offset] = value.x;
  attribute.values[offset + 1] = value.y;
  attribute.values[offset + 2] = value.z;
}

export function writeScalarAttribute(attribute: NumericAttribute, instance: number, value: number): void {
  attribute.values[instance * attribute.itemSize] = value;
}

export function writeColorAttribute(attribute: NumericAttribute, instance: number, color: number): void {
  const offset = instance * attribute.itemSize;
  attribute.values[offset] = ((color >>> 16) & 0xff) / 255;
  attribute.values[offset + 1] = ((color >>> 8) & 0xff) / 255;
  attribute.values[offset + 2] = (color & 0xff) / 255;
}

export function markAttributeNeedsUpdate(attribute: NumericAttribute | undefined, value: boolean): void {
  if (attribute) {
    attribute.attribute.needsUpdate = value;
  }
}

function call(target: ThreeObject, method: string, ...args: unknown[]): unknown {
  const value = target[method];
  return typeof value === 'function' ? value.apply(target, args) : undefined;
}

function asConstructor(value: unknown): ThreeConstructor | undefined {
  return typeof value === 'function' ? value as ThreeConstructor : undefined;
}

interface TslVisualNodes {
  readonly radius: TslNode;
  readonly color: TslNode;
  readonly visible: TslNode;
}

interface TslStateUniforms {
  readonly scale: TslNode;
  readonly color: TslNode;
  readonly colorMix: TslNode;
  readonly visible: TslNode;
}

interface TslNodeSurfaceUniforms {
  readonly profile: TslNode;
  readonly metalness: TslNode;
  readonly roughness: TslNode;
  readonly emissive: TslNode;
  readonly selectionEnabled: TslNode;
  readonly selectionScale: TslNode;
  readonly selectionIntensity: TslNode;
  readonly selectionColor: TslNode;
  readonly selectionBreathAmount: TslNode;
  readonly selectionBreathSpeed: TslNode;
  readonly time: TslNode;
}

interface TslLinkFlowUniforms {
  readonly enabled: TslNode;
  readonly direction: TslNode;
  readonly speed: TslNode;
  readonly frequency: TslNode;
  readonly pulseWidth: TslNode;
  readonly intensity: TslNode;
  readonly color: TslNode;
  readonly time: TslNode;
  readonly reactionEnabled: TslNode;
  readonly reactionScale: TslNode;
  readonly reactionIntensity: TslNode;
  readonly reactionColor: TslNode;
}

type StateName = 'dimmed' | 'pinned' | 'selected' | 'hovered' | 'focused' | 'hidden';

interface TslUniformValues {
  readonly scale: TslNode;
  readonly red: TslNode;
  readonly green: TslNode;
  readonly blue: TslNode;
  readonly colorMix: TslNode;
  readonly visible: TslNode;
}

interface TslNodeSurfaceUniformValues {
  readonly profile: TslNode;
  readonly metalness: TslNode;
  readonly roughness: TslNode;
  readonly emissive: TslNode;
  readonly selectionEnabled: TslNode;
  readonly selectionScale: TslNode;
  readonly selectionIntensity: TslNode;
  readonly selectionRed: TslNode;
  readonly selectionGreen: TslNode;
  readonly selectionBlue: TslNode;
  readonly selectionBreathAmount: TslNode;
  readonly selectionBreathSpeed: TslNode;
  readonly time: TslNode;
}

interface TslLinkFlowUniformValues {
  readonly enabled: TslNode;
  readonly direction: TslNode;
  readonly speed: TslNode;
  readonly frequency: TslNode;
  readonly pulseWidth: TslNode;
  readonly intensity: TslNode;
  readonly red: TslNode;
  readonly green: TslNode;
  readonly blue: TslNode;
  readonly time: TslNode;
  readonly reactionEnabled: TslNode;
  readonly reactionScale: TslNode;
  readonly reactionIntensity: TslNode;
  readonly reactionRed: TslNode;
  readonly reactionGreen: TslNode;
  readonly reactionBlue: TslNode;
}

function createTslStateThemeBinding(
  uniform: (value: number) => TslNode,
  vec3: (x: unknown, y: unknown, z: unknown) => TslNode,
  initial: NodeStateTheme
): { readonly appearances: Record<StateName, TslStateUniforms>; readonly binding: TslStateThemeBinding } {
  const states: readonly StateName[] = ['dimmed', 'pinned', 'selected', 'hovered', 'focused', 'hidden'];
  const inputs = Object.fromEntries(states.map((state) => {
    const appearance = initial[state];
    const color = toRgb(appearance?.color);
    const values = {
      scale: uniform(appearance?.scale ?? 1),
      red: uniform(color[0]),
      green: uniform(color[1]),
      blue: uniform(color[2]),
      colorMix: uniform(appearance?.colorMix ?? 0),
      visible: uniform(appearance?.visible === false ? 0 : 1)
    };
    return [state, { values, nodes: { scale: values.scale, color: vec3(values.red, values.green, values.blue), colorMix: values.colorMix, visible: values.visible } }];
  })) as unknown as Record<StateName, { readonly values: TslUniformValues; readonly nodes: TslStateUniforms }>;
  return {
    appearances: Object.fromEntries(states.map((state) => [state, inputs[state].nodes])) as Record<StateName, TslStateUniforms>,
    binding: {
      update(theme): void {
        for (const state of states) {
          const appearance = theme[state];
          const color = toRgb(appearance?.color);
          setUniform(inputs[state].values.scale, appearance?.scale ?? 1);
          setUniform(inputs[state].values.red, color[0]);
          setUniform(inputs[state].values.green, color[1]);
          setUniform(inputs[state].values.blue, color[2]);
          setUniform(inputs[state].values.colorMix, appearance?.colorMix ?? 0);
          setUniform(inputs[state].values.visible, appearance?.visible === false ? 0 : 1);
        }
      }
    }
  };
}

function createTslNodeSurfaceBinding(
  tsl: ThreeObject,
  uniform: (value: number) => TslNode,
  vec3: (x: unknown, y: unknown, z: unknown) => TslNode,
  initial: NodeSurfaceOptions | undefined
): { readonly nodes: TslNodeSurfaceUniforms; readonly binding: TslNodeSurfaceBinding } | undefined {
  if (!supportsTslNodeSurface(tsl)) {
    return undefined;
  }
  const selectionColor = toRgb(initial?.selectionEffect?.color ?? 0x7c3aed);
  const values: TslNodeSurfaceUniformValues = {
    profile: uniform(surfaceProfileValue(initial)),
    metalness: uniform(initial?.metalness ?? 0.82),
    roughness: uniform(initial?.roughness ?? 0.24),
    emissive: uniform(initial?.emissive ?? 0.04),
    selectionEnabled: uniform(initial?.selectionEffect === undefined || initial.selectionEffect.enabled === false ? 0 : 1),
    selectionScale: uniform(initial?.selectionEffect?.bubbleScale ?? 1.55),
    selectionIntensity: uniform(initial?.selectionEffect?.intensity ?? 0.9),
    selectionRed: uniform(selectionColor[0]),
    selectionGreen: uniform(selectionColor[1]),
    selectionBlue: uniform(selectionColor[2]),
    selectionBreathAmount: uniform(initial?.selectionEffect?.breathAmount ?? 0.015),
    selectionBreathSpeed: uniform(initial?.selectionEffect?.breathSpeed ?? 2.1),
    time: uniform(0)
  };
  const nodes: TslNodeSurfaceUniforms = {
    profile: values.profile,
    metalness: values.metalness,
    roughness: values.roughness,
    emissive: values.emissive,
    selectionEnabled: values.selectionEnabled,
    selectionScale: values.selectionScale,
    selectionIntensity: values.selectionIntensity,
    selectionColor: vec3(values.selectionRed, values.selectionGreen, values.selectionBlue),
    selectionBreathAmount: values.selectionBreathAmount,
    selectionBreathSpeed: values.selectionBreathSpeed,
    time: values.time
  };
  return {
    nodes,
    binding: {
      update(surface): void {
        const nextSelectionColor = toRgb(surface?.selectionEffect?.color ?? 0x7c3aed);
        setUniform(values.profile, surfaceProfileValue(surface));
        setUniform(values.metalness, surface?.metalness ?? 0.82);
        setUniform(values.roughness, surface?.roughness ?? 0.24);
        setUniform(values.emissive, surface?.emissive ?? 0.04);
        setUniform(values.selectionEnabled, surface?.selectionEffect === undefined || surface.selectionEffect.enabled === false ? 0 : 1);
        setUniform(values.selectionScale, surface?.selectionEffect?.bubbleScale ?? 1.55);
        setUniform(values.selectionIntensity, surface?.selectionEffect?.intensity ?? 0.9);
        setUniform(values.selectionRed, nextSelectionColor[0]);
        setUniform(values.selectionGreen, nextSelectionColor[1]);
        setUniform(values.selectionBlue, nextSelectionColor[2]);
        setUniform(values.selectionBreathAmount, surface?.selectionEffect?.breathAmount ?? 0.015);
        setUniform(values.selectionBreathSpeed, surface?.selectionEffect?.breathSpeed ?? 2.1);
      },
      setTime(timeSeconds): void {
        setUniform(values.time, timeSeconds);
      }
    }
  };
}

function createTslLinkFlowBinding(
  tsl: ThreeObject,
  uniform: (value: number) => TslNode,
  vec3: (x: unknown, y: unknown, z: unknown) => TslNode,
  mix: (first: unknown, second: unknown, amount: unknown) => TslNode,
  initial: LinkFlowOptions
): { readonly nodes: TslLinkFlowUniforms; readonly binding: TslLinkFlowBinding } | undefined {
  if (!supportsTslLinkFlow(tsl)) {
    return undefined;
  }
  const values: TslLinkFlowUniformValues = {
    enabled: uniform(initial.enabled === false ? 0 : 1),
    direction: uniform(flowDirectionValue(initial)),
    speed: uniform(initial.speed ?? 0.45),
    frequency: uniform(initial.frequency ?? 1.5),
    pulseWidth: uniform(initial.pulseWidth ?? 0.2),
    intensity: uniform(initial.intensity ?? 0.92),
    red: uniform(toRgb(initial.color ?? 0xffffff)[0]),
    green: uniform(toRgb(initial.color ?? 0xffffff)[1]),
    blue: uniform(toRgb(initial.color ?? 0xffffff)[2]),
    time: uniform(0),
    reactionEnabled: uniform(initial.nodeReaction === undefined || initial.nodeReaction.enabled === false ? 0 : 1),
    reactionScale: uniform(initial.nodeReaction?.scale ?? 1.32),
    reactionIntensity: uniform(initial.nodeReaction?.intensity ?? 0.72),
    reactionRed: uniform(toRgb(initial.nodeReaction?.color ?? initial.color ?? 0xffffff)[0]),
    reactionGreen: uniform(toRgb(initial.nodeReaction?.color ?? initial.color ?? 0xffffff)[1]),
    reactionBlue: uniform(toRgb(initial.nodeReaction?.color ?? initial.color ?? 0xffffff)[2])
  };
  const update = (flow: LinkFlowOptions | undefined): void => {
    const color = toRgb(flow?.color ?? 0xffffff);
    const reactionColor = toRgb(flow?.nodeReaction?.color ?? flow?.color ?? 0xffffff);
    setUniform(values.enabled, flow === undefined || flow.enabled === false ? 0 : 1);
    setUniform(values.direction, flowDirectionValue(flow));
    setUniform(values.speed, flow?.speed ?? 0.45);
    setUniform(values.frequency, flow?.frequency ?? 1.5);
    setUniform(values.pulseWidth, flow?.pulseWidth ?? 0.2);
    setUniform(values.intensity, flow?.intensity ?? 0.92);
    setUniform(values.red, color[0]);
    setUniform(values.green, color[1]);
    setUniform(values.blue, color[2]);
    setUniform(values.reactionEnabled, flow?.nodeReaction === undefined || flow.nodeReaction.enabled === false ? 0 : 1);
    setUniform(values.reactionScale, flow?.nodeReaction?.scale ?? 1.32);
    setUniform(values.reactionIntensity, flow?.nodeReaction?.intensity ?? 0.72);
    setUniform(values.reactionRed, reactionColor[0]);
    setUniform(values.reactionGreen, reactionColor[1]);
    setUniform(values.reactionBlue, reactionColor[2]);
  };
  return {
    nodes: {
      enabled: values.enabled,
      direction: values.direction,
      speed: values.speed,
      frequency: values.frequency,
      pulseWidth: values.pulseWidth,
      intensity: values.intensity,
      color: vec3(values.red, values.green, values.blue),
      time: values.time,
      reactionEnabled: values.reactionEnabled,
      reactionScale: values.reactionScale,
      reactionIntensity: values.reactionIntensity,
      reactionColor: vec3(values.reactionRed, values.reactionGreen, values.reactionBlue)
    },
    binding: {
      update,
      setTime(timeSeconds): void {
        setUniform(values.time, timeSeconds);
      }
    }
  };
}

/** Produces a smooth source-to-target color pulse from the link plane's normalized U coordinate. */
function applyLinkFlow(
  tsl: ThreeObject,
  mix: (first: unknown, second: unknown, amount: unknown) => TslNode,
  baseColor: TslNode,
  flow: TslLinkFlowUniforms
): { readonly color: TslNode; readonly opacity: TslNode } {
  const linkUv = (tsl.uv as () => TslNode)().x;
  const pulse = createFlowPulse(tsl, mix, linkUv, flow).mul(flow.intensity);
  return {
    color: mix(baseColor, flow.color, pulse),
    opacity: mix(1, pulse.mul(0.82).add(0.18), flow.enabled)
  };
}

/** Applies the shared arrival pulse only to nodes that own the active directed endpoint. */
function applyNodeFlowReaction(
  tsl: ThreeObject,
  mix: (first: unknown, second: unknown, amount: unknown) => TslNode,
  select: (condition: unknown, ifTrue: unknown, ifFalse: unknown) => TslNode,
  visual: TslVisualNodes,
  role: TslNode,
  flow: TslLinkFlowUniforms
): TslVisualNodes {
  const floor = tsl.floor as (value: unknown) => TslNode;
  const incoming = floor(role).mod(2).greaterThan(0.5);
  const outgoing = floor(role.div(2)).mod(2).greaterThan(0.5);
  const forward = flow.direction.greaterThan(0);
  const activeRole = select(forward, incoming, outgoing);
  const endpoint = select(forward, 1, 0);
  const pulse = createFlowPulse(tsl, mix, endpoint, flow)
    .mul(flow.reactionEnabled)
    .mul(select(activeRole, 1, 0));
  return {
    radius: visual.radius.mul(mix(1, flow.reactionScale, pulse)),
    color: mix(visual.color, flow.reactionColor, pulse.mul(flow.reactionIntensity)),
    visible: visual.visible
  };
}

function createFlowPulse(
  tsl: ThreeObject,
  mix: (first: unknown, second: unknown, amount: unknown) => TslNode,
  normalizedPosition: TslNode,
  flow: TslLinkFlowUniforms
): TslNode {
  const sin = tsl.sin as (value: unknown) => TslNode;
  const pow = tsl.pow as (value: unknown, exponent: unknown) => TslNode;
  const phase = normalizedPosition.mul(flow.frequency)
    .sub(flow.time.mul(flow.speed).mul(flow.direction))
    .mul(Math.PI * 2);
  const wave = sin(phase).mul(0.5).add(0.5);
  const sharpness = mix(24, 1.5, flow.pulseWidth);
  return pow(wave, sharpness).mul(flow.enabled);
}

/**
 * Shades a camera-facing disc as a sphere impostor. This deliberately stays
 * unlit and self-contained: hosts do not need to own scene lights, probes, or
 * a post-processing chain just to use the shared metallic profile.
 */
function applyNodeSurface(
  tsl: ThreeObject,
  vec3: (x: unknown, y: unknown, z: unknown) => TslNode,
  mix: (first: unknown, second: unknown, amount: unknown) => TslNode,
  select: (condition: unknown, ifTrue: unknown, ifFalse: unknown) => TslNode,
  color: TslNode,
  surface: TslNodeSurfaceUniforms,
  selectionActive: TslNode | number,
  selectionPulse: TslNode | number,
  selectionOpacityEnabled: boolean
): { color: TslNode; opacity: TslNode | undefined } {
  const dot = tsl.dot as (left: unknown, right: unknown) => TslNode;
  const max = tsl.max as (left: unknown, right: unknown) => TslNode;
  const sqrt = tsl.sqrt as (value: unknown) => TslNode;
  const pow = tsl.pow as (value: unknown, exponent: unknown) => TslNode;
  const surfaceUv = (tsl.uv as () => TslNode)();
  const localX = surfaceUv.x.mul(2).sub(1);
  const localY = surfaceUv.y.mul(2).sub(1);
  const radialSquared = localX.mul(localX).add(localY.mul(localY));
  const selectedSurface = selectionActive;
  const bodyBoundary = pow(surface.selectionScale.mul(surface.selectionScale), -1);
  const bodyRadialSquared = select(
    radialSquared.greaterThan(bodyBoundary),
    1,
    radialSquared.div(bodyBoundary)
  );
  const shadedRadialSquared = mix(radialSquared, bodyRadialSquared, selectedSurface);
  const normalScale = mix(1, surface.selectionScale, selectedSurface);
  const localZ = sqrt(max(shadedRadialSquared.mul(-1).add(1), 0));
  const normal = vec3(localX.mul(normalScale), localY.mul(normalScale), localZ);
  const lightDirection = vec3(0.34, 0.56, 0.76);
  const diffuse = dot(normal, lightDirection).mul(0.5).add(0.5);
  const diffuseLight = diffuse.mul(0.38).add(surface.emissive.mul(0.24).add(0.58));
  const highlightDirection = vec3(-0.24, 0.32, 0.92);
  const highlightSharpness = mix(8, 2, surface.roughness);
  const specular = pow(max(dot(normal, highlightDirection), 0), highlightSharpness)
    .mul(surface.metalness.mul(surface.roughness.mul(-0.08).add(0.12)));
  const retainedColor = color.mul(surface.emissive.mul(0.2).add(1));
  const whiteHighlight = specular.mul(0.78);
  const shaded = retainedColor
    .mul(diffuseLight)
    .add(vec3(whiteHighlight, whiteHighlight, whiteHighlight));
  const surfaceColor = mix(color, shaded, surface.profile);
  const bodyRim = pow(max(bodyRadialSquared, 0), 2.5).mul(selectedSurface);
  const glassBody = mix(
    surfaceColor,
    color.mul(0.4).add(vec3(0.02, 0.04, 0.065)),
    bodyRim.mul(0.34).mul(surface.selectionIntensity)
  );
  const bubbleProgress = max(radialSquared.sub(bodyBoundary).div(bodyBoundary.mul(-1).add(1)), 0);
  const edgeGlow = pow(bubbleProgress, 2.4).mul(selectionPulse).mul(surface.selectionIntensity);
  const softGlow = bubbleProgress.mul(-1).add(1).mul(selectionPulse).mul(surface.selectionIntensity);
  const outerBubble = surface.selectionColor.mul(0.1)
    .add(color.mul(0.025))
    .add(surface.selectionColor.mul(softGlow.mul(0.55)))
    .add(surface.selectionColor.mul(edgeGlow.mul(0.9)));
  const selectedTreatment = select(
    radialSquared.greaterThan(bodyBoundary),
    outerBubble,
    glassBody
  );
  const bubbleOpacity = mix(0.42, 0.68, bubbleProgress)
    .mul(selectionPulse)
    .mul(surface.selectionIntensity);
  const selectedOpacity = select(radialSquared.greaterThan(bodyBoundary), bubbleOpacity, 1);
  return {
    color: mix(surfaceColor, selectedTreatment, selectedSurface),
    opacity: selectionOpacityEnabled ? mix(1, selectedOpacity, selectedSurface) : undefined
  };
}

function setUniform(node: TslNode, value: number): void {
  (node as unknown as { value?: unknown }).value = value;
}

function surfaceProfileValue(surface: NodeSurfaceOptions | undefined): number {
  return surface?.profile === 'metallic' ? 1 : 0;
}

function flowDirectionValue(flow: LinkFlowOptions | undefined): number {
  return flow?.direction === 'target-to-source' ? -1 : 1;
}

function toRgb(color: number | undefined): readonly [number, number, number] {
  const value = color === undefined ? 0 : color >>> 0;
  return [((value >>> 16) & 0xff) / 255, ((value >>> 8) & 0xff) / 255, (value & 0xff) / 255];
}
