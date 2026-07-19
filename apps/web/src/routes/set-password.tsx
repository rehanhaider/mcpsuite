import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { useState } from "react";
import { ButtonSpinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { whoamiQuery } from "~/routes/__root.tsx";
import { changePassword, setPassword } from "~/server/fns.ts";

/**
 * /set-password (docs/auth-api.md):
 *   - signed out — redeem a one-time SETUP code (invited/pending users and
 *     the first-run owner) and choose a password;
 *   - signed in with password_must_change — the forced-change screen (every
 *     catalog operation is refused until the password is changed here).
 */
interface SetPasswordSearch {
  email?: string;
  code?: string;
}

export const Route = createFileRoute("/set-password")({
  validateSearch: (search: Record<string, unknown>): SetPasswordSearch => ({
    email: typeof search.email === "string" ? search.email : undefined,
    code: typeof search.code === "string" ? search.code : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(whoamiQuery);
    return { forcedChange: auth?.passwordMustChange === true };
  },
  component: SetPasswordPage,
});

function SetPasswordPage() {
  const { forcedChange } = Route.useRouteContext();
  const search = Route.useSearch();
  return (
    <AuthShell
      title={forcedChange ? "Choose a new password" : "Set your password"}
      subtitle={
        forcedChange
          ? "Your password was issued for you — set your own before continuing."
          : "Enter the one-time setup code you were given and choose a password."
      }
    >
      {forcedChange ? (
        <ForcedChangeForm />
      ) : (
        <RedeemCodeForm
          purpose="setup"
          successNotice="password_set"
          cta="Set password"
          initialEmail={search.email}
          initialCode={search.code}
        />
      )}
    </AuthShell>
  );
}

export function AuthShell(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div
      data-theme="dark"
      style={{ colorScheme: "dark" }}
      className="relative flex min-h-dvh items-center justify-center bg-background bg-dots px-4 text-foreground"
    >
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <Zap className="size-6 text-primary" fill="currentColor" />
          <span className="font-mono text-xl font-bold tracking-tight">
            emcp<span className="text-muted-foreground/60">/crm</span>
          </span>
        </div>
        <div className="animate-pop space-y-3 rounded-xl border border-border bg-card p-6 shadow-xl">
          <h1 className="text-sm font-medium text-foreground/70">{props.title}</h1>
          <p className="text-xs text-muted-foreground">{props.subtitle}</p>
          {props.children}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          <Link to="/login" className="underline-offset-2 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export function RedeemCodeForm(props: {
  purpose: "setup" | "reset";
  successNotice: "password_set" | "password_reset";
  cta: string;
  initialEmail?: string;
  initialCode?: string;
}) {
  const [email, setEmail] = useState(props.initialEmail ?? "");
  const [code, setCode] = useState(props.initialCode ?? "");
  const [password, setPasswordValue] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== repeat) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setPassword({
        data: { email: email.trim(), code: code.trim(), purpose: props.purpose, password },
      });
      if (res.ok) {
        navigate({ to: "/login", search: { notice: props.successNotice, email: email.trim() } });
      } else {
        setError(res.error);
      }
    } catch {
      setError("Something went wrong — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Email">
        <Input
          type="email"
          required
          autoFocus={!props.initialEmail}
          autoComplete="email"
          className="h-10"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label={props.purpose === "setup" ? "Setup code" : "Reset code"}>
        <Input
          required
          autoFocus={!!props.initialEmail}
          autoComplete="one-time-code"
          className="h-10 font-mono"
          placeholder="XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Field label="New password (10+ characters)">
        <Input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          className="h-10"
          placeholder="••••••••••"
          value={password}
          onChange={(e) => setPasswordValue(e.target.value)}
        />
      </Field>
      <Field label="Repeat password">
        <Input
          type="password"
          required
          autoComplete="new-password"
          className="h-10"
          placeholder="••••••••••"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Field>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <ButtonSpinner /> : null}
        {props.cta}
      </Button>
    </form>
  );
}

function ForcedChangeForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== repeat) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await changePassword({ data: { current, next } });
      if (res.ok) {
        await queryClient.resetQueries();
        navigate({ to: "/app" });
      } else {
        setError(res.error);
      }
    } catch {
      setError("Something went wrong — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Current password">
        <Input
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          className="h-10"
          placeholder="••••••••••"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password (10+ characters)">
        <Input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          className="h-10"
          placeholder="••••••••••"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Repeat new password">
        <Input
          type="password"
          required
          autoComplete="new-password"
          className="h-10"
          placeholder="••••••••••"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Field>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <ButtonSpinner /> : null}
        Save and continue
      </Button>
    </form>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}
