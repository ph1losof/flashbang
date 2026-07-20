export const MIN_SNAP_CHAIN_TARGETS = 2;
export const MAX_SNAP_CHAIN_TARGETS = 8;

export interface PartialSnapChain {
  chainPrefix: string;
  partial: string;
  selectedTriggers: readonly string[];
}

export function parsePartialSnapChain(value: string): PartialSnapChain | null {
  const lastComma = value.lastIndexOf(",");
  if (lastComma === -1) {
    return null;
  }

  const selectedTriggers = value
    .substring(0, lastComma)
    .split(",")
    .map((trigger) => trigger.toLowerCase());
  if (
    selectedTriggers.length >= MAX_SNAP_CHAIN_TARGETS ||
    selectedTriggers.some((trigger) => !trigger)
  ) {
    return null;
  }

  return {
    chainPrefix: value.substring(0, lastComma + 1),
    partial: value.substring(lastComma + 1).toLowerCase(),
    selectedTriggers,
  };
}
