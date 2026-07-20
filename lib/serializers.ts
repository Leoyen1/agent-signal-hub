export function jsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function toJsonArray(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

export function sourceCount(value: string | null | undefined): number {
  return jsonArray(value).length;
}

export function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== "")) as T;
}
