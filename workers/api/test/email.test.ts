import { cloudflareSender, emailSender, readOutbox, resendSender } from "@inkly/auth";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import app, { type Env } from "../src/index.ts";
import { ORIGIN } from "./helpers.ts";

const mail = { to: "Reader@Example.test", subject: "Hello", text: "Body" };

describe("EmailSender", () => {
  it("picks the provider named by EMAIL_PROVIDER", () => {
    const base: Env = { ...env, EMAIL_FROM: "Inkly <mail@example.test>" };
    expect(emailSender({ ...base, EMAIL_PROVIDER: "outbox" }).provider).toBe("outbox");
    expect(emailSender({ ...base, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }).provider).toBe(
      "resend",
    );
    const binding = { send: () => Promise.resolve({ messageId: "m" }) } as unknown as SendEmail;
    expect(
      emailSender({ ...base, EMAIL_PROVIDER: "cloudflare", SEND_EMAIL: binding }).provider,
    ).toBe("cloudflare");
  });

  it("defaults to the Outbox only when test hooks are on", () => {
    const unset: Env = { ...env };
    delete unset.EMAIL_PROVIDER;
    expect(emailSender({ ...unset, TEST_HOOKS: "enabled" }).provider).toBe("outbox");
    expect(() => emailSender(unset)).toThrow(/EMAIL_PROVIDER/);
  });

  it("refuses a real provider without its settings", () => {
    expect(() => emailSender({ ...env, EMAIL_PROVIDER: "resend" })).toThrow(/EMAIL_FROM/);
    expect(() =>
      emailSender({ ...env, EMAIL_PROVIDER: "resend", EMAIL_FROM: "a@example.test" }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      emailSender({ ...env, EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "a@example.test" }),
    ).toThrow(/SEND_EMAIL/);
  });

  it("outbox: stores the mail where test hooks can read it", async () => {
    const to = `outbox-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await emailSender({ ...env, EMAIL_PROVIDER: "outbox" }).send({ ...mail, to });
    expect(await readOutbox(env, to)).toEqual([
      expect.objectContaining({ to, subject: "Hello", text: "Body" }),
    ]);
  });

  it("resend: posts the mail to the Resend API with the key", async () => {
    const calls: Request[] = [];
    const fake = (url: string, init?: RequestInit) => {
      calls.push(new Request(url, init));
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    await resendSender("re_key", "Inkly <mail@example.test>", fake as typeof fetch).send(mail);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer re_key");
    expect(await calls[0]?.json()).toEqual({
      from: "Inkly <mail@example.test>",
      to: [mail.to],
      subject: "Hello",
      text: "Body",
    });
  });

  it("resend: surfaces a refused send as an error", async () => {
    const fake = () => Promise.resolve(new Response("no", { status: 403 }));
    await expect(
      resendSender("k", "a@example.test", fake as typeof fetch).send(mail),
    ).rejects.toThrow(/403/);
  });

  it("cloudflare: sends through the send_email binding", async () => {
    const sent: unknown[] = [];
    const binding = {
      send: (message: unknown) => {
        sent.push(message);
        return Promise.resolve({ messageId: "m" });
      },
    } as unknown as SendEmail;
    await cloudflareSender(binding, "Inkly <mail@example.test>").send(mail);
    expect(sent).toEqual([
      { from: "Inkly <mail@example.test>", to: mail.to, subject: "Hello", text: "Body" },
    ]);
  });
});

describe("requesting a sign-in code", () => {
  it("tells the user when the email could not be sent instead of claiming it was", async () => {
    // Resend configured but unusable, as when it refuses a recipient: the send throws.
    const broken: Env = { ...env, EMAIL_PROVIDER: "resend", EMAIL_FROM: "Inkly <a@example.test>" };
    delete broken.RESEND_API_KEY;
    const res = await app.request(
      `${ORIGIN}/api/auth/email-otp/send-verification-otp`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          email: `nomail-${crypto.randomUUID().slice(0, 8)}@example.test`,
          type: "sign-in",
        }),
      },
      broken,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "email_failed" });
  });
});
