import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Wordmark } from "../components/brand/wordmark.tsx";
import { HealthStatus } from "../components/health-status.tsx";
import { Button } from "../components/ui/button.tsx";
import { Field } from "../components/ui/field.tsx";
import { Sheet, SheetBody } from "../components/ui/sheet.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { formText } from "../lib/form.ts";
import { safeNext } from "../lib/session.ts";

type Step = { kind: "email" } | { kind: "code"; email: string };

export function SignInRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ google: boolean }>("/api/auth-options")
      .then((o) => {
        if (!cancelled) setGoogle(o.google);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step.kind === "code") heading.current?.focus();
  }, [step.kind]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function requestCode(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = formText(new FormData(e.currentTarget), "email");
    void run(async () => {
      await api("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        json: { email, type: "sign-in" },
      });
      setStep({ kind: "code", email });
    });
  }

  function verifyCode(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== "code") return;
    const otp = formText(new FormData(e.currentTarget), "code");
    void run(async () => {
      await api("/api/auth/sign-in/email-otp", {
        method: "POST",
        json: { email: step.email, otp },
      });
      await navigate(next, { replace: true });
    });
  }

  function continueWithGoogle() {
    void run(async () => {
      const { url } = await api<{ url: string }>("/api/auth/sign-in/social", {
        method: "POST",
        json: { provider: "google", callbackURL: next },
      });
      window.location.assign(url);
    });
  }

  return (
    <div data-testid="sign-in" className="flex min-h-dvh flex-col items-center px-4 py-12">
      <title>Sign in · Inkly</title>
      <main id="main" className="flex w-full max-w-md flex-col gap-6">
        <Wordmark />
        <Sheet>
          <SheetBody className="flex flex-col gap-6">
            {step.kind === "email" ? (
              <>
                <div className="flex flex-col gap-2">
                  <h1 className="text-3xl">Sign in to Inkly</h1>
                  <p className="text-muted-foreground">
                    We email you a 6-digit code. New here? The same code creates your account and
                    your own workspace.
                  </p>
                </div>
                <form className="flex flex-col gap-5" onSubmit={requestCode} noValidate>
                  <Field
                    label="Email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    {...(error !== undefined && { error })}
                  />
                  <Button type="submit" loading={busy}>
                    Email me a code
                  </Button>
                </form>
                {google && (
                  <>
                    <p className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                      or
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                    </p>
                    <Button variant="secondary" onClick={continueWithGoogle} disabled={busy}>
                      Continue with Google
                    </Button>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <h1 ref={heading} tabIndex={-1} className="text-3xl outline-none">
                    Check your email
                  </h1>
                  <p className="text-muted-foreground">
                    We sent a 6-digit code to{" "}
                    <strong className="text-foreground">{step.email}</strong>. It expires in 10
                    minutes.
                  </p>
                </div>
                <form className="flex flex-col gap-5" onSubmit={verifyCode} noValidate>
                  <Field
                    label="Code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    {...(error !== undefined && { error })}
                  />
                  <Button type="submit" loading={busy}>
                    Sign in
                  </Button>
                </form>
                <Button
                  variant="link"
                  className="self-start"
                  onClick={() => {
                    setError(undefined);
                    setStep({ kind: "email" });
                  }}
                >
                  Use a different email
                </Button>
              </>
            )}
          </SheetBody>
        </Sheet>
        <div className="text-sm">
          <HealthStatus />
        </div>
      </main>
    </div>
  );
}
