// The Shell's one login surface (ADR-03, 05-a section 3's ownership table:
// "Login flow and session lifecycle: Shell ... zones never render a login
// form"). Rendered OUTSIDE components/protected-layout.tsx's gate (see
// app.tsx) -- it is the one route that must be reachable while signed out.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  classifyNavigationTarget,
} from "@hyperbolic/ui";
import type { SessionStatus } from "../lib/session";
import { sanitizeReturnPath } from "../lib/return-path";

interface LoginPageProps {
  status: SessionStatus;
  onSignIn: (email: string, password: string) => Promise<void>;
  replaceDocument?: (href: string) => void;
}

function replaceBrowserDocument(href: string): void {
  window.location.replace(href);
}

function LoginPage({ status, onSignIn, replaceDocument = replaceBrowserDocument }: LoginPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const replacedDocumentTarget = useRef<string | null>(null);

  const returnTo = sanitizeReturnPath(new URLSearchParams(location.search).get("return"));
  const returnKind = classifyNavigationTarget(returnTo);

  function replaceReturnDocumentOnce(): void {
    if (replacedDocumentTarget.current === returnTo) return;
    replacedDocumentTarget.current = returnTo;
    replaceDocument(returnTo);
  }

  useEffect(() => {
    if (status === "signed-in" && returnKind === "document") {
      replaceReturnDocumentOnce();
    }
  }, [replaceDocument, returnKind, returnTo, status]);

  if (status === "checking") {
    // Session status isn't resolved yet -- mirrors
    // components/protected-layout.tsx's own "loading" branch. Avoids a
    // flash of the login form for an operator who is actually already
    // signed in (that case resolves via the branch just below, one render
    // later), matching this issue's "no flash of gated content before
    // redirect" in the OTHER direction too.
    return <div className="min-h-dvh bg-bg" data-testid="auth-checking" />;
  }

  if (status === "signed-in") {
    // Already authenticated (a returning operator with a still-valid
    // cached session navigated to /login directly, or signIn() below just
    // resolved and this component is still mounted for one more render):
    // never show a login form to a signed-in session -- SH-2/SH-3's
    // "exactly one login surface" would be violated by a stray second
    // prompt.
    return returnKind === "document" ? null : <Navigate to={returnTo} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSignIn(email, password);
      if (returnKind === "document") {
        replaceReturnDocumentOnce();
      } else {
        navigate(returnTo, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Check your email and password.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to hyperbolic-core</CardTitle>
        </CardHeader>
        <CardContent>
          <form data-testid="login-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                data-testid="login-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                data-testid="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error && (
              <p data-testid="login-error" role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" data-testid="login-submit" disabled={submitting}>
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default LoginPage;
