export function resolveSuggestProvider(
  value: string | null | undefined,
  allowUnsafeCustomSuggestUrls: boolean
): string {
  const provider = value || "default";
  return provider === "custom" && !allowUnsafeCustomSuggestUrls
    ? "none"
    : provider;
}
