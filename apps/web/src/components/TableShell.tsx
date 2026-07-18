/** Shared table card — same width, border, and horizontal scroll on every list page. */
import type { ReactNode } from "react";

export const TABLE_CLASS = "w-full text-sm";

export function TableShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border bg-card">
      <div className="overflow-x-auto">{children}</div>
      {footer}
    </div>
  );
}
