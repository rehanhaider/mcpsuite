import { v7 as uuidv7 } from "uuid";

/** UUIDv7 — time-ordered, per product spec. All primary IDs use this. */
export function newId(): string {
  return uuidv7();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** UTC calendar date, YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Turn a free-text label into a stable slug key. */
export function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
