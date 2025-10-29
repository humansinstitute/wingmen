const DEFAULT_SEGMENT = "anonymous";

const sanitizeSegment = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_SEGMENT;
  const cleaned = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return DEFAULT_SEGMENT;
  return cleaned.slice(0, 120);
};

export const normaliseNpub = (input: string | null | undefined): string | null => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const deriveNpubSegment = (input: string | null | undefined): string => {
  const normalized = normaliseNpub(input);
  if (!normalized) return DEFAULT_SEGMENT;
  return sanitizeSegment(normalized);
};
