/** Formatting helpers — all client-safe, no deps. */

export function formatMoneyMinor(amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor == null) return "—";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toLocaleString()}`;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
    [604_800_000, "w"],
  ];
  if (abs < 60_000) return diff >= 0 ? "just now" : "in <1m";
  for (let i = units.length - 1; i >= 0; i--) {
    const [ms, label] = units[i]!;
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return diff >= 0 ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return formatDate(iso);
}

/** Days until a YYYY-MM-DD (or ISO) date; negative = overdue. */
export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const target = new Date(`${date.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
