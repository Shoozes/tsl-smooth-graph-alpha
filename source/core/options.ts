import type {
  CameraPose,
  ForceGraphOptions,
  GraphHostOptions,
  InteractionOptions,
  LayoutConfiguration,
  LinkFlowOptions,
  LinkStyleOptions,
  NodeStateAppearance,
  NodeStateTheme,
  NodeStyleOptions,
  NodeSurfaceOptions,
  RendererOptions,
  RendererPickingOptions,
  ValidationOptions,
  Vec3
} from './types.js';
import type { HeadlessGraphOptions, HeadlessLayoutOptions } from '../headless/types.js';
import { GraphError } from './errors.js';
import { RESOURCE_LIMITS } from './resourceLimits.js';

/**
 * Takes one shallow ownership snapshot of every option wrapper while retaining
 * explicitly borrowed runtime objects, payload callbacks, and worker factories.
 */
export function normalizeForceGraphOptions<TNode, TLink>(
  options: ForceGraphOptions<TNode, TLink>
): Readonly<ForceGraphOptions<TNode, TLink>> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Force graph options must be an object.');
  }
  assertOnlyKeys(
    options,
    ['platform', 'host', 'renderer', 'layout', 'nodes', 'links', 'stateTheme', 'interaction', 'validation'],
    'Force graph options'
  );
  const host = copyHostOptions(options.host);
  const renderer = copyRendererOptions(options.renderer);
  const layout = copyLayoutOptions(options.layout);
  const nodes = copyNodeStyleOptions(options.nodes);
  const links = copyLinkStyleOptions(options.links);
  const stateTheme = copyStateTheme(options.stateTheme);
  const interaction = copyInteractionOptions(options.interaction);
  const validation = copyValidationOptions(options.validation);
  return Object.freeze({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(host === undefined ? {} : { host }),
    ...(renderer === undefined ? {} : { renderer }),
    ...(layout === undefined ? {} : { layout }),
    ...(nodes === undefined ? {} : { nodes }),
    ...(links === undefined ? {} : { links }),
    ...(stateTheme === undefined ? {} : { stateTheme }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(validation === undefined ? {} : { validation })
  });
}

/** Validates the intentionally smaller DOM-free option surface. */
export function normalizeHeadlessForceGraphOptions(
  options: HeadlessGraphOptions = {}
): Readonly<HeadlessGraphOptions> {
  assertOnlyKeys(options as unknown as object, ['validation', 'layout'], 'Headless force graph options');
  const validation = copyValidationOptions(options.validation);
  const layout = copyHeadlessLayoutOptions(options.layout);
  return Object.freeze({
    ...(validation === undefined ? {} : { validation }),
    ...(layout === undefined ? {} : { layout: layout as HeadlessLayoutOptions })
  });
}

function copyHeadlessLayoutOptions(options: HeadlessLayoutOptions | undefined): HeadlessLayoutOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options as unknown as object, [
    'dimensions', 'seed', 'autoStart', 'settleThreshold', 'fixedDeltaSeconds',
    'linkDistance', 'linkStrength', 'chargeStrength', 'chargeTheta', 'centerStrength',
    'velocityDecay', 'alphaDecay', 'alphaMinimum', 'minimumNodeDistance',
    'separationStrength', 'separationIterations', 'topologyReheatAlpha',
    'interactionReheatAlpha', 'maxSeparationPairChecksPerStep', 'maxStepsPerUpdate',
    'maxStepsPerRequest'
  ], 'Headless layout options');
  return copyLayoutOptions(options) as HeadlessLayoutOptions;
}

function copyLayoutOptions(options: LayoutConfiguration | undefined): LayoutConfiguration | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, [
    'backend', 'failurePolicy', 'workerFactory', 'dimensions', 'seed', 'autoStart',
    'settleThreshold', 'fixedDeltaSeconds', 'linkDistance', 'linkStrength',
    'chargeStrength', 'chargeTheta', 'centerStrength', 'velocityDecay',
    'alphaDecay', 'alphaMinimum', 'minimumNodeDistance', 'separationStrength',
    'separationIterations', 'topologyReheatAlpha', 'interactionReheatAlpha', 'maxSeparationPairChecksPerStep', 'maxStepsPerUpdate', 'maxStepsPerRequest',
    'maxPendingWorkerSteps', 'workerStepTimeoutMs', 'maxPendingWorkerCommands',
    'workerCommandTimeoutMs'
  ], 'Layout options');
  if (options.backend !== undefined && options.backend !== 'local' && options.backend !== 'worker') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout backend must be local or worker.');
  }
  if (options.failurePolicy !== undefined
    && options.failurePolicy !== 'freeze'
    && options.failurePolicy !== 'fallback-local'
    && options.failurePolicy !== 'dispose') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout failurePolicy must be freeze, fallback-local, or dispose.');
  }
  if (options.workerFactory !== undefined && typeof options.workerFactory !== 'function') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout workerFactory must be a function.');
  }
  if (options.dimensions !== undefined && options.dimensions !== 2 && options.dimensions !== 3) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout dimensions must be 2 or 3.');
  }
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout seed must be a safe integer.');
  }
  assertOptionalBoolean(options.autoStart, 'Layout autoStart');
  assertOptionalPositiveFinite(options.settleThreshold, 'Layout settleThreshold');
  assertOptionalPositiveFinite(options.fixedDeltaSeconds, 'Layout fixedDeltaSeconds');
  assertOptionalPositiveFinite(options.linkDistance, 'Layout linkDistance');
  assertOptionalNonNegativeFinite(options.linkStrength, 'Layout linkStrength');
  assertOptionalFinite(options.chargeStrength, 'Layout chargeStrength');
  assertOptionalPositiveFinite(options.chargeTheta, 'Layout chargeTheta');
  assertOptionalNonNegativeFinite(options.centerStrength, 'Layout centerStrength');
  assertOptionalUnitInterval(options.velocityDecay, 'Layout velocityDecay');
  assertOptionalUnitInterval(options.alphaDecay, 'Layout alphaDecay');
  if (options.alphaMinimum !== undefined
    && (!Number.isFinite(options.alphaMinimum) || options.alphaMinimum <= 0 || options.alphaMinimum > 1)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout alphaMinimum must be greater than zero and at most one.');
  }
  assertOptionalNonNegativeFinite(options.minimumNodeDistance, 'Layout minimumNodeDistance');
  assertOptionalUnitInterval(options.separationStrength, 'Layout separationStrength');
  assertOptionalUnitInterval(options.topologyReheatAlpha, 'Layout topologyReheatAlpha');
  assertOptionalUnitInterval(options.interactionReheatAlpha, 'Layout interactionReheatAlpha');
  if (options.separationIterations !== undefined
    && (!Number.isSafeInteger(options.separationIterations)
      || options.separationIterations < 1
      || options.separationIterations > 4)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout separationIterations must be an integer between 1 and 4.');
  }
  for (const [name, value, maximum] of [
    ['maxSeparationPairChecksPerStep', options.maxSeparationPairChecksPerStep, RESOURCE_LIMITS.maxSeparationPairChecksPerStep],
    ['maxStepsPerUpdate', options.maxStepsPerUpdate, RESOURCE_LIMITS.maxLayoutStepsPerUpdate],
    ['maxStepsPerRequest', options.maxStepsPerRequest, RESOURCE_LIMITS.maxLayoutStepsPerRequest],
    ['maxPendingWorkerSteps', options.maxPendingWorkerSteps, RESOURCE_LIMITS.maxPendingWorkerSteps],
    ['workerStepTimeoutMs', options.workerStepTimeoutMs, RESOURCE_LIMITS.maxWorkerTimeoutMs],
    ['maxPendingWorkerCommands', options.maxPendingWorkerCommands, RESOURCE_LIMITS.maxPendingWorkerCommands],
    ['workerCommandTimeoutMs', options.workerCommandTimeoutMs, RESOURCE_LIMITS.maxWorkerTimeoutMs]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
      throw new GraphError('FG_RENDER_PLATFORM_INVALID', `Layout ${name} must be an integer between 1 and ${maximum}.`);
    }
  }
  if (options.maxStepsPerUpdate !== undefined
    && options.maxStepsPerRequest !== undefined
    && options.maxStepsPerUpdate > options.maxStepsPerRequest) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Layout maxStepsPerUpdate must not exceed maxStepsPerRequest.');
  }
  return Object.freeze({ ...options });
}

function copyNodeStyleOptions<TNode>(options: NodeStyleOptions<TNode> | undefined): NodeStyleOptions<TNode> | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['radius', 'color'], 'Node style');
  assertStyleValue(options.radius, 'Node radius', (value) => Number.isFinite(value) && value > 0, 'a positive finite number');
  assertStyleValue(options.color, 'Node color', isRgbColor, 'a 24-bit RGB integer');
  return Object.freeze({
    ...(options.radius === undefined ? {} : { radius: options.radius }),
    ...(options.color === undefined ? {} : { color: options.color })
  });
}

function copyLinkStyleOptions<TLink>(options: LinkStyleOptions<TLink> | undefined): LinkStyleOptions<TLink> | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['width', 'color', 'opacity'], 'Link style');
  assertStyleValue(options.width, 'Link width', (value) => Number.isFinite(value) && value > 0, 'a positive finite number');
  assertStyleValue(options.color, 'Link color', isRgbColor, 'a 24-bit RGB integer');
  assertOptionalUnitInterval(options.opacity, 'Link opacity');
  return Object.freeze({
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.opacity === undefined ? {} : { opacity: options.opacity })
  });
}

function copyValidationOptions(options: ValidationOptions | undefined): ValidationOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['mode'], 'Validation options');
  if (options.mode !== undefined && options.mode !== 'strict' && options.mode !== 'tolerant') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Validation mode must be strict or tolerant.');
  }
  return Object.freeze(options.mode === undefined ? {} : { mode: options.mode });
}

function copyStateTheme(theme: NodeStateTheme | undefined): NodeStateTheme | undefined {
  if (theme === undefined) {
    return undefined;
  }
  assertOnlyKeys(theme, ['dimmed', 'pinned', 'selected', 'hovered', 'focused', 'hidden', 'incidentLinks'], 'State theme');
  if (theme.incidentLinks !== undefined) {
    assertOnlyKeys(theme.incidentLinks, ['dimmed', 'hidden'], 'State theme incidentLinks');
  }
  return Object.freeze({
    ...(theme.dimmed === undefined ? {} : { dimmed: copyStateAppearance(theme.dimmed, 'dimmed') }),
    ...(theme.pinned === undefined ? {} : { pinned: copyStateAppearance(theme.pinned, 'pinned') }),
    ...(theme.selected === undefined ? {} : { selected: copyStateAppearance(theme.selected, 'selected') }),
    ...(theme.hovered === undefined ? {} : { hovered: copyStateAppearance(theme.hovered, 'hovered') }),
    ...(theme.focused === undefined ? {} : { focused: copyStateAppearance(theme.focused, 'focused') }),
    ...(theme.hidden === undefined ? {} : { hidden: copyStateAppearance(theme.hidden, 'hidden') }),
    ...(theme.incidentLinks === undefined ? {} : { incidentLinks: Object.freeze({
      ...(theme.incidentLinks.dimmed === undefined ? {} : { dimmed: copyStateAppearance(theme.incidentLinks.dimmed, 'incidentLinks.dimmed') }),
      ...(theme.incidentLinks.hidden === undefined ? {} : { hidden: copyStateAppearance(theme.incidentLinks.hidden, 'incidentLinks.hidden') })
    }) })
  });
}

function copyStateAppearance(appearance: NodeStateAppearance, name: string): NodeStateAppearance {
  assertOnlyKeys(appearance, ['scale', 'color', 'colorMix', 'visible'], `State theme ${name}`);
  const scale = appearance.scale;
  const color = appearance.color;
  const colorMix = appearance.colorMix;
  if (scale !== undefined && (!Number.isFinite(scale) || scale < 0)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `State theme ${name} scale must be finite and non-negative.`);
  }
  if (color !== undefined && (!Number.isSafeInteger(color) || color < 0 || color > 0xffffff)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `State theme ${name} color must be a 24-bit RGB integer.`);
  }
  if (colorMix !== undefined && (!Number.isFinite(colorMix) || colorMix < 0 || colorMix > 1)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `State theme ${name} colorMix must be between zero and one.`);
  }
  if (appearance.visible !== undefined && typeof appearance.visible !== 'boolean') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `State theme ${name} visible must be a boolean.`);
  }
  return Object.freeze({
    ...(scale === undefined ? {} : { scale }),
    ...(color === undefined ? {} : { color }),
    ...(colorMix === undefined ? {} : { colorMix }),
    ...(appearance.visible === undefined ? {} : { visible: appearance.visible })
  });
}

function assertOnlyKeys(value: object, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be an object.`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} contains unsupported field ${unknown}.`);
  }
}

function copyHostOptions(options: GraphHostOptions | undefined): GraphHostOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['mode', 'canvas', 'renderer', 'scene', 'camera', 'controls'], 'Graph host');
  switch (options.mode) {
    case 'managed':
      assertOnlyKeys(options, ['mode', 'canvas'], 'Managed host');
      return Object.freeze({ mode: 'managed', canvas: options.canvas });
    case 'embedded':
      assertOnlyKeys(options, ['mode', 'renderer', 'scene', 'camera', 'canvas', 'controls'], 'Embedded host');
      return Object.freeze({
        mode: 'embedded',
        renderer: options.renderer,
        scene: options.scene,
        camera: options.camera,
        ...(options.canvas === undefined ? {} : { canvas: options.canvas }),
        ...(options.controls === undefined ? {} : { controls: options.controls })
      });
    case 'headless':
      assertOnlyKeys(options, ['mode'], 'Headless host');
      return Object.freeze({ mode: 'headless' });
    default:
      throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Unsupported graph host mode.');
  }
}

function copyRendererOptions(options: RendererOptions | undefined): RendererOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(
    options,
    ['backend', 'antialias', 'alpha', 'nodeSurface', 'linkFlow', 'linkWidthUnit', 'maxPositionAtlasHeight', 'picking', 'cameraPose', 'pixelRatio', 'frameLoop'],
    'Renderer options'
  );
  assertOptionalBoolean(options.antialias, 'Renderer antialias');
  assertOptionalBoolean(options.alpha, 'Renderer alpha');
  if (options.frameLoop !== undefined
    && options.frameLoop !== 'continuous'
    && options.frameLoop !== 'demand'
    && options.frameLoop !== 'external') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer frameLoop must be continuous, demand, or external.');
  }
  const backend = normalizeRendererBackend(options.backend);
  const linkWidthUnit = normalizeLinkWidthUnit(options.linkWidthUnit);
  const maxPositionAtlasHeight = normalizeMaxPositionAtlasHeight(options.maxPositionAtlasHeight);
  const picking = copyRendererPickingOptions(options.picking);
  const cameraPose = copyCameraPose(options.cameraPose);
  const nodeSurface = copyNodeSurfaceOptions(options.nodeSurface);
  const linkFlow = copyLinkFlowOptions(options.linkFlow);
  const pixelRatio = copyPixelRatioOptions(options.pixelRatio);
  return Object.freeze({
    ...(options.antialias === undefined ? {} : { antialias: options.antialias }),
    ...(options.alpha === undefined ? {} : { alpha: options.alpha }),
    ...(backend === undefined ? {} : { backend }),
    ...(linkWidthUnit === undefined ? {} : { linkWidthUnit }),
    ...(maxPositionAtlasHeight === undefined ? {} : { maxPositionAtlasHeight }),
    ...(picking === undefined ? {} : { picking }),
    ...(cameraPose === undefined ? {} : { cameraPose }),
    ...(nodeSurface === undefined ? {} : { nodeSurface }),
    ...(linkFlow === undefined ? {} : { linkFlow }),
    ...(pixelRatio === undefined ? {} : { pixelRatio }),
    ...(options.frameLoop === undefined ? {} : { frameLoop: options.frameLoop })
  });
}

function copyPixelRatioOptions(options: RendererOptions['pixelRatio']): RendererOptions['pixelRatio'] {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['minimum', 'maximum'], 'Renderer pixelRatio');
  assertOptionalPositiveFinite(options.minimum, 'Renderer pixelRatio minimum');
  assertOptionalPositiveFinite(options.maximum, 'Renderer pixelRatio maximum');
  if ((options.minimum ?? 1) > RESOURCE_LIMITS.maxPixelRatio
    || (options.maximum ?? 1) > RESOURCE_LIMITS.maxPixelRatio) {
    throw new GraphError(
      'FG_RENDER_PLATFORM_INVALID',
      `Renderer pixelRatio values must not exceed ${RESOURCE_LIMITS.maxPixelRatio}.`
    );
  }
  if (options.minimum !== undefined && options.maximum !== undefined && options.maximum < options.minimum) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer pixelRatio maximum must be at least its minimum.');
  }
  return Object.freeze({
    ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
    ...(options.maximum === undefined ? {} : { maximum: options.maximum })
  });
}

function copyLinkFlowOptions(options: LinkFlowOptions | undefined): LinkFlowOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['enabled', 'direction', 'speed', 'frequency', 'pulseWidth', 'intensity', 'color', 'nodeReaction'], 'Renderer linkFlow');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer linkFlow enabled must be a boolean.');
  }
  if (options.direction !== undefined
    && options.direction !== 'source-to-target'
    && options.direction !== 'target-to-source') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer linkFlow direction must be source-to-target or target-to-source.');
  }
  assertFiniteRange(options.speed, 0, 100, 'speed');
  assertFiniteRange(options.frequency, 0.1, 64, 'frequency');
  assertFiniteRange(options.pulseWidth, 0.02, 1, 'pulseWidth');
  assertFiniteRange(options.intensity, 0, 1, 'intensity');
  if (options.color !== undefined && (!Number.isSafeInteger(options.color) || options.color < 0 || options.color > 0xffffff)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer linkFlow color must be a 24-bit RGB integer.');
  }
  const nodeReaction = copyLinkFlowNodeReactionOptions(options.nodeReaction);
  return Object.freeze({
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.direction === undefined ? {} : { direction: options.direction }),
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.frequency === undefined ? {} : { frequency: options.frequency }),
    ...(options.pulseWidth === undefined ? {} : { pulseWidth: options.pulseWidth }),
    ...(options.intensity === undefined ? {} : { intensity: options.intensity }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(nodeReaction === undefined ? {} : { nodeReaction })
  });
}

function copyLinkFlowNodeReactionOptions(
  options: LinkFlowOptions['nodeReaction']
): NonNullable<LinkFlowOptions['nodeReaction']> | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['enabled', 'scale', 'intensity', 'color'], 'Renderer linkFlow nodeReaction');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer linkFlow nodeReaction enabled must be a boolean.');
  }
  assertFiniteRange(options.scale, 1, 3, 'nodeReaction scale');
  assertFiniteRange(options.intensity, 0, 1, 'nodeReaction intensity');
  if (options.color !== undefined && (!Number.isSafeInteger(options.color) || options.color < 0 || options.color > 0xffffff)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer linkFlow nodeReaction color must be a 24-bit RGB integer.');
  }
  return Object.freeze({
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.scale === undefined ? {} : { scale: options.scale }),
    ...(options.intensity === undefined ? {} : { intensity: options.intensity }),
    ...(options.color === undefined ? {} : { color: options.color })
  });
}

function assertFiniteRange(value: number | undefined, minimum: number, maximum: number, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `Renderer linkFlow ${name} must be between ${minimum} and ${maximum}.`);
  }
}

function copyNodeSurfaceOptions(options: NodeSurfaceOptions | undefined): NodeSurfaceOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['profile', 'metalness', 'roughness', 'emissive', 'selectionEffect'], 'Renderer nodeSurface');
  const profile = options.profile;
  if (profile !== undefined && profile !== 'flat' && profile !== 'metallic') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer nodeSurface profile must be flat or metallic.');
  }
  for (const [name, value] of Object.entries({
    metalness: options.metalness,
    roughness: options.roughness,
    emissive: options.emissive
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new GraphError('FG_RENDER_PLATFORM_INVALID', `Renderer nodeSurface ${name} must be between zero and one.`);
    }
  }
  const selectionEffect = copyNodeSelectionEffectOptions(options.selectionEffect);
  return Object.freeze({
    ...(profile === undefined ? {} : { profile }),
    ...(options.metalness === undefined ? {} : { metalness: options.metalness }),
    ...(options.roughness === undefined ? {} : { roughness: options.roughness }),
    ...(options.emissive === undefined ? {} : { emissive: options.emissive }),
    ...(selectionEffect === undefined ? {} : { selectionEffect })
  });
}

function copyNodeSelectionEffectOptions(
  options: NodeSurfaceOptions['selectionEffect']
): NonNullable<NodeSurfaceOptions['selectionEffect']> | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['enabled', 'bubbleScale', 'intensity', 'color', 'breathAmount', 'breathSpeed'], 'Renderer nodeSurface selectionEffect');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer nodeSurface selectionEffect enabled must be a boolean.');
  }
  for (const [name, value, minimum, maximum] of [
    ['bubbleScale', options.bubbleScale, 1, 3],
    ['intensity', options.intensity, 0, 1],
    ['breathAmount', options.breathAmount, 0, 0.25],
    ['breathSpeed', options.breathSpeed, 0, 10]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
      throw new GraphError(
        'FG_RENDER_PLATFORM_INVALID',
        `Renderer nodeSurface selectionEffect ${name} must be between ${minimum} and ${maximum}.`
      );
    }
  }
  if (options.color !== undefined && (!Number.isSafeInteger(options.color) || options.color < 0 || options.color > 0xffffff)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer nodeSurface selectionEffect color must be a 24-bit RGB integer.');
  }
  return Object.freeze({
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.bubbleScale === undefined ? {} : { bubbleScale: options.bubbleScale }),
    ...(options.intensity === undefined ? {} : { intensity: options.intensity }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.breathAmount === undefined ? {} : { breathAmount: options.breathAmount }),
    ...(options.breathSpeed === undefined ? {} : { breathSpeed: options.breathSpeed })
  });
}

function copyRendererPickingOptions(options: RendererPickingOptions | undefined): RendererPickingOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['mode', 'gpuIdThreshold', 'spatialCellSize', 'gpuIdPicker'], 'Renderer picking');
  const mode = options.mode;
  if (mode !== undefined && mode !== 'auto' && mode !== 'raycast' && mode !== 'spatial' && mode !== 'gpu-id') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer picking mode is unsupported.');
  }
  const gpuIdThreshold = normalizePositiveSafeInteger(options.gpuIdThreshold, 'gpuIdThreshold');
  const spatialCellSize = normalizePositiveSafeInteger(
    options.spatialCellSize,
    'spatialCellSize',
    RESOURCE_LIMITS.maxSpatialPickingCellSize
  );
  if (options.gpuIdPicker !== undefined && typeof options.gpuIdPicker !== 'function') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer gpuIdPicker must be a function when supplied.');
  }
  return Object.freeze({
    ...(mode === undefined ? {} : { mode }),
    ...(gpuIdThreshold === undefined ? {} : { gpuIdThreshold }),
    ...(spatialCellSize === undefined ? {} : { spatialCellSize }),
    ...(options.gpuIdPicker === undefined ? {} : { gpuIdPicker: options.gpuIdPicker })
  });
}

function normalizePositiveSafeInteger(value: number | undefined, name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `Renderer ${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeMaxPositionAtlasHeight(value: RendererOptions['maxPositionAtlasHeight']): RendererOptions['maxPositionAtlasHeight'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Renderer maxPositionAtlasHeight must be a positive safe integer.');
  }
  return value;
}

function copyCameraPose(pose: CameraPose | undefined): CameraPose | undefined {
  if (pose === undefined) {
    return undefined;
  }
  assertOnlyKeys(pose, ['position', 'target'], 'Managed camera pose');
  const position = copyFiniteVec3(pose.position, 'camera position');
  const target = copyFiniteVec3(pose.target, 'camera target');
  return Object.freeze({ position, target });
}

function copyFiniteVec3(value: Vec3, label: string): Readonly<Vec3> {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `Managed camera ${label} must contain finite x, y, and z values.`);
  }
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function normalizeLinkWidthUnit(unit: RendererOptions['linkWidthUnit']): RendererOptions['linkWidthUnit'] {
  if (unit === undefined || unit === 'world' || unit === 'pixel') {
    return unit;
  }
  throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Unsupported link width unit.');
}

function normalizeRendererBackend(backend: RendererOptions['backend']): RendererOptions['backend'] {
  if (backend === undefined || backend === 'auto' || backend === 'webgl2' || backend === 'webgpu-preferred') {
    return backend;
  }
  if (backend === 'webgpu') {
    return 'webgpu-preferred';
  }
  throw new GraphError('FG_RENDER_BACKEND_UNAVAILABLE', 'Unsupported renderer backend policy.');
}

function copyInteractionOptions(options: InteractionOptions | undefined): InteractionOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  assertOnlyKeys(options, ['hover', 'dragNodes', 'selection', 'navigation'], 'Interaction options');
  assertOptionalBoolean(options.hover, 'Interaction hover');
  assertOptionalBoolean(options.navigation, 'Interaction navigation');
  if (options.selection !== undefined
    && options.selection !== 'none'
    && options.selection !== 'single'
    && options.selection !== 'multiple') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Interaction selection must be none, single, or multiple.');
  }
  let dragNodes = options.dragNodes;
  if (typeof dragNodes === 'object' && dragNodes !== null) {
    assertOnlyKeys(dragNodes, ['enabled', 'releaseBehavior'], 'Interaction dragNodes');
    assertOptionalBoolean(dragNodes.enabled, 'Interaction dragNodes enabled');
    if (dragNodes.releaseBehavior !== undefined
      && dragNodes.releaseBehavior !== 'unpin'
      && dragNodes.releaseBehavior !== 'keep-pinned') {
      throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Interaction dragNodes releaseBehavior must be unpin or keep-pinned.');
    }
    dragNodes = Object.freeze({
      ...(dragNodes.enabled === undefined ? {} : { enabled: dragNodes.enabled }),
      ...(dragNodes.releaseBehavior === undefined ? {} : { releaseBehavior: dragNodes.releaseBehavior })
    });
  } else if (dragNodes !== undefined && typeof dragNodes !== 'boolean') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Interaction dragNodes must be a boolean or options object.');
  }
  return Object.freeze({
    ...(options.hover === undefined ? {} : { hover: options.hover }),
    ...(dragNodes === undefined ? {} : { dragNodes }),
    ...(options.selection === undefined ? {} : { selection: options.selection }),
    ...(options.navigation === undefined ? {} : { navigation: options.navigation })
  });
}

function assertOptionalBoolean(value: boolean | undefined, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be a boolean.`);
  }
}

function assertOptionalFinite(value: number | undefined, label: string): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be finite.`);
  }
}

function assertOptionalPositiveFinite(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be positive and finite.`);
  }
}

function assertOptionalNonNegativeFinite(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be finite and non-negative.`);
  }
}

function assertOptionalUnitInterval(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be between zero and one.`);
  }
}

function assertStyleValue<T>(
  value: number | ((item: Readonly<T>, index: number) => number) | undefined,
  label: string,
  validate: (value: number) => boolean,
  expectation: string
): void {
  if (value !== undefined && typeof value !== 'function' && (typeof value !== 'number' || !validate(value))) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be ${expectation} or an accessor function.`);
  }
}

function isRgbColor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffff;
}
