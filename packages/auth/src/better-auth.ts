// Lets tsc name the zod types inside the Auth instance type in declarations (TS2883).
import type {} from "zod/v4/core";
import { AppError } from "@inkly/domain";
import { authDatabase, listMembershipsOfUser } from "@inkly/storage/auth";
import { betterAuth } from "better-auth";
import { bearer, emailOTP, magicLink, organization } from "better-auth/plugins";
import { adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";

import { reportingEmailFailure } from "./email-failures.ts";
import { emailSender } from "./email.ts";
import type { AuthEnv } from "./env.ts";
import { mintTenantId, mintUserId, newId } from "./ids.ts";
import { memberLimit } from "./limits.ts";

// ADR-0003: Better-Auth runs inside the API Worker on our D1. Organizations are
// Tenants and members are Members; table and column names follow migration 0004.

const ID_PREFIX: Record<string, string> = {
  session: "ses",
  account: "acc",
  verification: "ver",
  member: "mem",
  invitation: "inv",
};

function generateId({ model }: { model: string }): string {
  if (model === "organization") return mintTenantId();
  if (model === "user") return mintUserId();
  return newId(ID_PREFIX[model] ?? "id");
}

const CREATED_UPDATED = { createdAt: "created_at", updatedAt: "updated_at" } as const;

/** "ada@example.com" → "ada", used when a new User has no name yet. */
export function nameFromEmail(email: string): string {
  return email.split("@")[0] ?? email;
}

/** Holds the workspace creator; set once the instance exists, so hooks can call its API. */
interface Deferred {
  createWorkspace?: (userId: string, name: string) => Promise<unknown>;
}

function options(env: AuthEnv, baseURL: string, deferred: Deferred) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new AppError("internal", "BETTER_AUTH_SECRET is not set");
  const send = (to: string, subject: string, text: string) =>
    reportingEmailFailure(() => emailSender(env).send({ to, subject, text }));
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {};

  return {
    appName: "Inkly",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: authDatabase(env),
    // ADR-0003: Inkly owns sign-in rate limits, in KV (see handler.ts).
    rateLimit: { enabled: false },
    socialProviders: google,
    // validateSchema: getAuth shares this instance across the isolate's requests, and
    // Better-Auth's runtime schema check is one D1 promise every concurrent auth call
    // awaits. On Cloudflare, a client disconnect cancels the request that started it,
    // and every later auth call in that isolate then hangs (#72). Migrations own the
    // schema (0004); the auth tests run against them.
    advanced: { database: { generateId, validateSchema: false } },
    user: {
      modelName: "users",
      fields: { emailVerified: "email_verified", ...CREATED_UPDATED },
    },
    session: {
      modelName: "sessions",
      fields: {
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
        ...CREATED_UPDATED,
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...CREATED_UPDATED,
      },
    },
    verification: {
      modelName: "verifications",
      fields: { expiresAt: "expires_at", ...CREATED_UPDATED },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string; name?: string | null }) => {
            const name = user.name?.trim() ? user.name.trim() : nameFromEmail(user.email);
            return Promise.resolve({ data: { ...user, name } });
          },
          after: async (user: { id: string; name: string }) => {
            await deferred.createWorkspace?.(user.id, `${user.name}'s workspace`);
          },
        },
      },
      session: {
        create: {
          before: async (session: { userId: string; activeOrganizationId?: string | null }) => {
            if (session.activeOrganizationId) return { data: session };
            const [first] = await listMembershipsOfUser(env, session.userId);
            return { data: { ...session, activeOrganizationId: first?.tenantId ?? null } };
          },
        },
      },
    },
    plugins: [
      bearer(),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => {
          await send(
            email,
            `${otp} is your Inkly sign-in code`,
            `Your Inkly sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you did not ask for it, ignore this email.`,
          );
        },
      }),
      magicLink({
        expiresIn: 600,
        sendMagicLink: async ({ email, url }) => {
          await send(
            email,
            "Sign in to Inkly",
            `Open this link to sign in to Inkly. It expires in 10 minutes.\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
          );
        },
      }),
      organization({
        roles: { owner: ownerAc, admin: adminAc, editor: memberAc, viewer: memberAc },
        creatorRole: "owner",
        membershipLimit: (_user, org) => memberLimit((org as { plan?: string }).plan),
        sendInvitationEmail: async ({ email, id, organization: tenant, inviter }) => {
          const url = new URL(`/invitations/${id}`, baseURL).toString();
          const who = inviter.user.name || inviter.user.email;
          await send(
            email,
            `${who} invited you to ${tenant.name} on Inkly`,
            `${who} invited you to join ${tenant.name} on Inkly.\n\nAccept the invitation: ${url}\n\nThe invitation expires in 48 hours.`,
          );
        },
        schema: {
          session: { fields: { activeOrganizationId: "active_tenant_id" } },
          organization: {
            modelName: "tenants",
            fields: { createdAt: "created_at" },
            additionalFields: {
              plan: { type: "string", required: false, defaultValue: "free", input: false },
              region: { type: "string", required: false, defaultValue: "default", input: false },
            },
          },
          member: {
            modelName: "memberships",
            fields: { organizationId: "tenant_id", userId: "user_id", createdAt: "created_at" },
          },
          invitation: {
            modelName: "invitations",
            fields: {
              organizationId: "tenant_id",
              inviterId: "inviter_id",
              expiresAt: "expires_at",
              createdAt: "created_at",
            },
          },
        },
      }),
    ],
  };
}

function createAuth(env: AuthEnv, baseURL: string) {
  const deferred: Deferred = {};
  const auth = betterAuth(options(env, baseURL, deferred));
  deferred.createWorkspace = (userId, name) =>
    auth.api.createOrganization({
      body: { name, slug: newId("ws").replace("_", "-"), userId },
    });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

const instances = new WeakMap<AuthEnv, Map<string, Auth>>();

/**
 * The Better-Auth instance for this env and public origin, built once per isolate
 * (building one costs a few ms of CPU). Concurrent requests share it, so it must not
 * hold a pending promise or I/O object from the request that built it: see #72.
 */
export function getAuth(env: AuthEnv, requestUrl: string): Auth {
  const baseURL = env.BETTER_AUTH_URL ?? new URL(requestUrl).origin;
  let byOrigin = instances.get(env);
  if (!byOrigin) {
    byOrigin = new Map();
    instances.set(env, byOrigin);
  }
  let auth = byOrigin.get(baseURL);
  if (!auth) {
    auth = createAuth(env, baseURL);
    byOrigin.set(baseURL, auth);
  }
  return auth;
}

export function googleConfigured(env: AuthEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
