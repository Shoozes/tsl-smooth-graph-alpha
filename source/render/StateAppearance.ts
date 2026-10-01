import {
  NodeFlags,
  type NodeStateAppearance,
  type NodeStateTheme
} from '../core/types.js';

const DEFAULT_NODE_STATE_THEME: Required<NodeStateTheme> = Object.freeze({
  dimmed: Object.freeze({ scale: 0.88, color: 0x07101d, colorMix: 0.65 }),
  pinned: Object.freeze({ color: 0xffc36e, colorMix: 0.18 }),
  selected: Object.freeze({ scale: 1.18, color: 0xffffff, colorMix: 0.32 }),
  hovered: Object.freeze({ scale: 1.12, color: 0x8fe3ff, colorMix: 0.42 }),
  focused: Object.freeze({ scale: 1.12, color: 0xffffff, colorMix: 0.2 }),
  hidden: Object.freeze({ visible: false }),
  incidentLinks: Object.freeze({
    dimmed: Object.freeze({ scale: 0.5, color: 0x07101d, colorMix: 0.5 }),
    hidden: Object.freeze({ visible: false })
  })
});

export interface ResolvedNodeVisual {
  readonly radius: number;
  readonly color: number;
  readonly visible: boolean;
}

export function mergeNodeStateTheme(theme: NodeStateTheme | undefined): NodeStateTheme {
  return Object.freeze({
    dimmed: mergeAppearance(DEFAULT_NODE_STATE_THEME.dimmed, theme?.dimmed),
    pinned: mergeAppearance(DEFAULT_NODE_STATE_THEME.pinned, theme?.pinned),
    selected: mergeAppearance(DEFAULT_NODE_STATE_THEME.selected, theme?.selected),
    hovered: mergeAppearance(DEFAULT_NODE_STATE_THEME.hovered, theme?.hovered),
    focused: mergeAppearance(DEFAULT_NODE_STATE_THEME.focused, theme?.focused),
    hidden: mergeAppearance(DEFAULT_NODE_STATE_THEME.hidden, theme?.hidden),
    incidentLinks: Object.freeze({
      dimmed: mergeAppearance(DEFAULT_NODE_STATE_THEME.incidentLinks.dimmed!, theme?.incidentLinks?.dimmed),
      hidden: mergeAppearance(DEFAULT_NODE_STATE_THEME.incidentLinks.hidden!, theme?.incidentLinks?.hidden)
    })
  });
}

export function resolveNodeVisual(
  radius: number,
  color: number,
  flags: number,
  theme: NodeStateTheme
): ResolvedNodeVisual {
  let resolvedRadius = Math.max(0.001, radius);
  let resolvedColor = color;
  let visible = (flags & NodeFlags.Visible) !== 0;
  const apply = (appearance: NodeStateAppearance | undefined): void => {
    if (!appearance) return;
    resolvedRadius *= appearance.scale ?? 1;
    if (appearance.color !== undefined) {
      resolvedColor = mixHexColor(resolvedColor, appearance.color, appearance.colorMix ?? 1);
    }
    if (appearance.visible !== undefined) visible = appearance.visible;
  };
  if ((flags & NodeFlags.Dimmed) !== 0) apply(theme.dimmed);
  if ((flags & NodeFlags.Pinned) !== 0) apply(theme.pinned);
  if ((flags & NodeFlags.Selected) !== 0) apply(theme.selected);
  if ((flags & NodeFlags.Hovered) !== 0) apply(theme.hovered);
  if ((flags & NodeFlags.Focused) !== 0) apply(theme.focused);
  if ((flags & NodeFlags.Hidden) !== 0) apply(theme.hidden);
  return { radius: visible ? Math.max(0.001, resolvedRadius) : 0, color: resolvedColor, visible };
}

/** Resolves incident links from the same endpoint appearances used by rendering and picking. */
export function resolveIncidentLinkVisual(
  width: number,
  color: number,
  sourceFlags: number,
  targetFlags: number,
  sourceVisible: boolean,
  targetVisible: boolean,
  theme: NodeStateTheme
): { width: number; color: number } {
  if (!sourceVisible || !targetVisible) {
    return { ...applyLinkAppearance(width, color, theme.incidentLinks?.hidden), width: 0 };
  }
  if ((sourceFlags & NodeFlags.Dimmed) !== 0 || (targetFlags & NodeFlags.Dimmed) !== 0) {
    return applyLinkAppearance(width, color, theme.incidentLinks?.dimmed);
  }
  return { width, color };
}

function mergeAppearance(defaults: NodeStateAppearance, override: NodeStateAppearance | undefined): NodeStateAppearance {
  return Object.freeze({ ...defaults, ...override });
}

function applyLinkAppearance(width: number, color: number, appearance: NodeStateAppearance | undefined): { width: number; color: number } {
  const resolvedWidth = appearance?.visible === false ? 0 : Math.max(0.001, width * (appearance?.scale ?? 1));
  return {
    width: resolvedWidth,
    color: appearance?.color === undefined ? color : mixHexColor(color, appearance.color, appearance.colorMix ?? 1)
  };
}

function mixHexColor(first: number, second: number, amount: number): number {
  const mix = Math.min(1, Math.max(0, amount));
  const firstColor = first >>> 0;
  const secondColor = second >>> 0;
  const channel = (shift: number): number => Math.round(
    (((firstColor >>> shift) & 0xff) * (1 - mix)) + (((secondColor >>> shift) & 0xff) * mix)
  );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
