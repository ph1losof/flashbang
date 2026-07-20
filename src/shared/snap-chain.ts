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

  const selectedTriggers: string[] = [];
  let segmentStart = 0;
  while (segmentStart <= lastComma) {
    const comma = value.indexOf(",", segmentStart);
    const segmentEnd = comma === -1 || comma > lastComma ? lastComma : comma;
    if (
      segmentEnd === segmentStart ||
      selectedTriggers.length >= MAX_SNAP_CHAIN_TARGETS
    ) {
      return null;
    }
    selectedTriggers.push(
      value.substring(segmentStart, segmentEnd).toLowerCase()
    );
    if (segmentEnd === lastComma) {
      break;
    }
    segmentStart = segmentEnd + 1;
  }
  if (selectedTriggers.length >= MAX_SNAP_CHAIN_TARGETS) {
    return null;
  }

  return {
    chainPrefix: value.substring(0, lastComma + 1),
    partial: value.substring(lastComma + 1).toLowerCase(),
    selectedTriggers,
  };
}
