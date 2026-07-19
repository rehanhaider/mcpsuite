import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { useState } from "react";
import { ButtonSpinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { whoamiQuery } from "~/routes/__root.tsx";
import { login } from "~/server/fns.ts";

/**
 * Error codes arriving via the OpenAuth UI redirect contract
 * (docs/auth-api.md): the issuer's login screen IS this page.
 */
const FLOW_ERRORS: Record<string, string> = {
  invalid_password: "Invalid email or password",
  invalid_email: "Invalid email or password",
  not_invited: "This email has no account here — ask an administrator to invite you",
  account_disabled: "This account is disabled",
  expired_flow: "The sign-in flow expired — try again",
  signup_disabled: "Self-service signup is disabled on this deployment",
};

const NOTICES: Record<string, string> = {
  password_set: "Password saved — sign in to continue",
  password_reset: "Password reset — sign in with your new password",
};

interface LoginSearch {
  error?: string;
  notice?: string;
  email?: string;
  flow?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
    notice: typeof search.notice === "string" ? search.notice : undefined,
    email: typeof search.email === "string" ? search.email : undefined,
    flow: typeof search.flow === "string" ? search.flow : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(whoamiQuery);
    if (auth) throw redirect({ to: auth.passwordMustChange ? "/set-password" : "/app" });
  },
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    search.error ? (FLOW_ERRORS[search.error] ?? "Sign-in failed — try again") : null,
  );
  const notice = search.notice ? NOTICES[search.notice] : null;
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login({ data: { email: email.trim(), password } });
      if (res.ok) {
        await queryClient.resetQueries();
        navigate({ to: res.mustChangePassword ? "/set-password" : "/app" });
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
        <form
          onSubmit={submit}
          className="animate-pop space-y-3 rounded-xl border border-border bg-card p-6 shadow-xl"
        >
          <h1 className="text-sm font-medium text-foreground/70">
            Sign in to your workspace
          </h1>
          {notice ? <p className="text-xs text-primary">{notice}</p> : null}
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Email
            </span>
            <Input
              type="email"
              required
              autoFocus
              autoComplete="email"
              className="h-10"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Password
            </span>
            <Input
              type="password"
              required
              autoComplete="current-password"
              className="h-10"
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <ButtonSpinner /> : null}
            Sign in
          </Button>
          <p className="pt-1 text-center text-xs text-muted-foreground/70">
            Invited or resetting?{" "}
            <Link to="/set-password" className="text-foreground/80 underline-offset-2 hover:underline">
              Use a setup code
            </Link>{" "}
            ·{" "}
            <Link to="/reset-password" className="text-foreground/80 underline-offset-2 hover:underline">
              Use a reset code
            </Link>
          </p>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          Agent-native CRM — your agents work the pipeline, you stay in control.
        </p>
      </div>
    </div>
  );
}
