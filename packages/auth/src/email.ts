import { AppError } from "@inkly/domain";
import { appendOutbox, listOutbox, type OutboxRow } from "@inkly/storage/auth";

import { testHooksOn, type AuthEnv } from "./env.ts";

// Q5: one EmailSender interface. Dev, tests and previews capture mail in the Outbox,
// so CI never sends real email; production picks Cloudflare Email Service or Resend.

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailSender {
  readonly provider: EmailProvider;
  send(mail: Mail): Promise<void>;
}

export type EmailProvider = "outbox" | "resend" | "cloudflare";

export function outboxSender(env: AuthEnv): EmailSender {
  return { provider: "outbox", send: (mail) => appendOutbox(env, mail) };
}

export function resendSender(apiKey: string, from: string, fetcher = fetch): EmailSender {
  return {
    provider: "resend",
    async send(mail) {
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!res.ok)
        throw new AppError("internal", `Resend refused the email (${String(res.status)})`);
    },
  };
}

export function cloudflareSender(binding: SendEmail, from: string): EmailSender {
  return {
    provider: "cloudflare",
    async send(mail) {
      await binding.send({ from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/** The sender `EMAIL_PROVIDER` selects. An unset provider means the Outbox only under test hooks. */
export function emailSender(env: AuthEnv): EmailSender {
  const provider = env.EMAIL_PROVIDER ?? (testHooksOn(env) ? "outbox" : undefined);
  if (provider === "outbox") return outboxSender(env);
  if (provider !== "resend" && provider !== "cloudflare") {
    throw new AppError("internal", `EMAIL_PROVIDER ${String(provider)} is not supported`);
  }
  const from = env.EMAIL_FROM;
  if (!from) throw new AppError("internal", "EMAIL_FROM is not set");
  if (provider === "resend") {
    if (!env.RESEND_API_KEY) throw new AppError("internal", "RESEND_API_KEY is not set");
    return resendSender(env.RESEND_API_KEY, from);
  }
  if (!env.SEND_EMAIL) throw new AppError("internal", "SEND_EMAIL binding is not configured");
  return cloudflareSender(env.SEND_EMAIL, from);
}

/** Outbox mail for one address, newest first. Only test hooks read it (Q11). */
export function readOutbox(env: AuthEnv, to: string): Promise<OutboxRow[]> {
  return listOutbox(env, to);
}
