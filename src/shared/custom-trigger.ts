export const MAX_CUSTOM_TRIGGER_LENGTH = 64;

const RESERVED_CUSTOM_TRIGGERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "settings",
]);
const ENCODED_TRIGGER_SEPARATOR = /%(?:20|21|24|3a|3b|40|7e)/i;

export function validateCustomTrigger(trigger: string): string | null {
  if (!trigger) {
    return "Shortcut is required";
  }
  if (trigger.length > MAX_CUSTOM_TRIGGER_LENGTH) {
    return `Shortcut must be at most ${MAX_CUSTOM_TRIGGER_LENGTH} characters`;
  }
  if (/\s/u.test(trigger)) {
    return "Shortcut cannot contain whitespace";
  }
  if (/[!@$:;~+]/u.test(trigger)) {
    return "Shortcut cannot contain trigger prefixes (!, @, $, :, ;, ~) or +";
  }
  if (trigger.includes(",")) {
    return "Shortcut cannot contain comma";
  }
  if (ENCODED_TRIGGER_SEPARATOR.test(trigger)) {
    return "Shortcut cannot contain encoded spaces or trigger prefixes";
  }
  if (RESERVED_CUSTOM_TRIGGERS.has(trigger.toLowerCase())) {
    return `"${trigger}" is a reserved shortcut`;
  }
  return null;
}
