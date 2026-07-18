/**
 * Semantic color token → class maps. Kept literal so Tailwind never purges
 * them. Tokens mirror SEMANTIC_COLORS in @emcp/core/domain; the palette is
 * defined in styles/app.css (`--tone-*` variables, exposed as Tailwind
 * colors). Values are stored in the DB, so token names never change.
 */
import type { SemanticColor } from "@emcp/core/domain";

export type Tone = SemanticColor;

const CHIP_BASE = "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap";
const CHIP_BASE_XS = "inline-flex h-4 w-fit shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium whitespace-nowrap";

const TINT: Record<SemanticColor, string> = {
  primary: "bg-primary/12 text-primary",
  secondary: "bg-violet/12 text-violet",
  accent: "bg-cyan/12 text-cyan",
  info: "bg-info/12 text-info",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  error: "bg-destructive/12 text-destructive",
  neutral: "bg-muted text-foreground/70",
  ghost: "bg-muted text-muted-foreground",
};

export const DOT_CLASS: Record<SemanticColor, string> = {
  primary: "bg-primary",
  secondary: "bg-violet",
  accent: "bg-cyan",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/50",
  ghost: "bg-muted-foreground/30",
};

export const TEXT_CLASS: Record<SemanticColor, string> = {
  primary: "text-primary",
  secondary: "text-violet",
  accent: "text-cyan",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  neutral: "text-foreground/70",
  ghost: "text-muted-foreground",
};

function tintOf(color: string | null | undefined): string {
  return TINT[(color ?? "ghost") as SemanticColor] ?? TINT.ghost;
}

/** Self-contained chip class (layout + tint). Apply to a <span> or <Link>. */
export function chipClass(color: string | null | undefined, size: "xs" | "sm" = "sm"): string {
  return `${size === "xs" ? CHIP_BASE_XS : CHIP_BASE} ${tintOf(color)}`;
}

/** Back-compat aliases (soft and solid render identically in the new theme). */
export function badgeClass(color: string | null | undefined, _soft = false): string {
  return chipClass(color);
}

export function dotClass(color: string | null | undefined): string {
  return DOT_CLASS[(color ?? "ghost") as SemanticColor] ?? DOT_CLASS.ghost;
}
