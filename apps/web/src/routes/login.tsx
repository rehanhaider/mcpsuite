import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
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

export const Route = createFileRoute("/login")({
  beforeLoad: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(whoamiQuery);
    if (auth) throw redirect({ to: "/app" });
  },
  component: LoginPage,
});

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          Agent-native CRM — your agents work the pipeline, you stay in control.
        </p>
      </div>
    </div>
  );
}
