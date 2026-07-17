export const TRIGGER_PREFIXES = ["!", "@", "$", ":", ";", "~"] as const;

export type TriggerPrefix = (typeof TRIGGER_PREFIXES)[number];

export const DEFAULT_BANG_PREFIX: TriggerPrefix = "!";
export const DEFAULT_SNAP_PREFIX: TriggerPrefix = "@";

export function isTriggerPrefix(value: unknown): value is TriggerPrefix {
  return (
    typeof value === "string" &&
    (TRIGGER_PREFIXES as readonly string[]).includes(value)
  );
}

export function resolveTriggerPrefixes(
  bang: unknown,
  snap: unknown
): readonly [bang: TriggerPrefix, snap: TriggerPrefix] {
  const bangPrefix = isTriggerPrefix(bang) ? bang : DEFAULT_BANG_PREFIX;
  const snapPrefix = isTriggerPrefix(snap) ? snap : DEFAULT_SNAP_PREFIX;
  return bangPrefix === snapPrefix
    ? [DEFAULT_BANG_PREFIX, DEFAULT_SNAP_PREFIX]
    : [bangPrefix, snapPrefix];
}

export function encodeTriggerPrefixes(
  bang: TriggerPrefix,
  snap: TriggerPrefix
): string {
  return `${TRIGGER_PREFIXES.indexOf(bang)}${TRIGGER_PREFIXES.indexOf(snap)}`;
}

export function decodeTriggerPrefixes(
  value: string
): readonly [bang: TriggerPrefix, snap: TriggerPrefix] | null {
  if (value.length !== 2) {
    return null;
  }
  const bang = TRIGGER_PREFIXES[value.charCodeAt(0) - 48];
  const snap = TRIGGER_PREFIXES[value.charCodeAt(1) - 48];
  return bang && snap && bang !== snap ? [bang, snap] : null;
}
