/** Small shared primitives: header, empty state, avatar, spinner, cards. */
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { initials } from "~/lib/format.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

export { Kbd } from "~/components/ui/kbd";

/** Product-standard controlled modal composed from the official Dialog. */
export function Modal(props: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => (open ? undefined : props.onClose())}
    >
      <DialogContent className={props.wide ? "sm:max-w-3xl" : "sm:max-w-xl"}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
          {props.open ? props.children : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PageHeader(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.subtitle ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {props.subtitle}
          </p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex items-center gap-2">{props.actions}</div>
      ) : null}
    </div>
  );
}

export function EmptyState(props: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-14 text-center">
      {props.icon ?? <EmptyGlyph />}
      <p className="text-sm font-medium text-foreground/70">{props.title}</p>
      {props.hint ? (
        <p className="max-w-sm text-xs text-muted-foreground">{props.hint}</p>
      ) : null}
      {props.action ? <div className="mt-2">{props.action}</div> : null}
    </div>
  );
}

function EmptyGlyph() {
  return (
    <svg
      width="56"
      height="44"
      viewBox="0 0 56 44"
      fill="none"
      aria-hidden
      className="text-foreground/25"
    >
      <rect
        x="4"
        y="8"
        width="48"
        height="32"
        rx="6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <circle cx="20" cy="22" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M30 18h14M30 24h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle
        cx="46"
        cy="8"
        r="3.5"
        fill="var(--color-primary)"
        opacity="0.8"
      />
    </svg>
  );
}

export function Avatar(props: { name: string; size?: "xs" | "sm" }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-foreground/70 ${
        props.size === "xs" ? "size-5 text-[9px]" : "size-6 text-[10px]"
      }`}
      title={props.name}
    >
      {initials(props.name)}
    </div>
  );
}

export function Spinner({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center gap-2 py-12 text-muted-foreground ${className ?? ""}`}
    >
      <Loader2 className="size-4 animate-spin" />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  );
}

/** Inline spinner for buttons. */
export function ButtonSpinner() {
  return <Loader2 className="size-3.5 animate-spin" />;
}

export function SectionCard(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-card ${props.className ?? ""}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {props.title}
          </h2>
          {props.subtitle ? (
            <p className="mt-0.5 text-xs tracking-normal normal-case text-muted-foreground/70">
              {props.subtitle}
            </p>
          ) : null}
        </div>
        {props.actions}
      </header>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

/** Definition-list row used on detail pages and compact admin forms. */
export function Field(props: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-baseline gap-2 py-1 text-sm">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className="min-w-0 break-words">
        {props.children}
        {props.hint ? (
          <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
            {props.hint}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children?: ReactNode;
}) {
  const url = href.startsWith("http") ? href : `https://${href}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-cyan underline-offset-3 hover:underline"
    >
      {children ?? href.replace(/^https?:\/\//, "")}
    </a>
  );
}
