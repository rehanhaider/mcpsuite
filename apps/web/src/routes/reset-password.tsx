import { createFileRoute } from "@tanstack/react-router";
import { AuthShell, RedeemCodeForm } from "~/routes/set-password.tsx";

/**
 * /reset-password (docs/auth-api.md): redeem a one-time RESET code — issued
 * by an administrator (user.resetPassword), or by the server-side owner
 * recovery CLI — and choose a new password. Redeeming ends every existing
 * session for the account. This page is also the redirect target for the
 * OpenAuth /password/change flow's screens (?flow=change&state=…), which
 * hosted self-service reset builds on.
 */
interface ResetPasswordSearch {
  email?: string;
  code?: string;
  error?: string;
  message?: string;
}

const CHANGE_FLOW_ERRORS: Record<string, string> = {
  invalid_email: "Enter a valid email address",
  invalid_code: "That code is not valid",
  invalid_password: "Enter a valid password (10+ characters)",
  password_mismatch: "Passwords do not match",
};

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
    email: typeof search.email === "string" ? search.email : undefined,
    code: typeof search.code === "string" ? search.code : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const search = Route.useSearch();
  const flowError = search.error ? (CHANGE_FLOW_ERRORS[search.error] ?? search.message ?? "Try again") : null;
  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the one-time reset code you were given and choose a new password. Resetting signs you out everywhere."
    >
      {flowError ? <p className="text-xs text-destructive">{flowError}</p> : null}
      <RedeemCodeForm
        purpose="reset"
        successNotice="password_reset"
        cta="Reset password"
        initialEmail={search.email}
        initialCode={search.code}
      />
    </AuthShell>
  );
}
