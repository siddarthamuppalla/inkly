// The signer side of an Envelope over the API (T3.3): signed out, by link token. The grant
// cookie the code check sets is scoped to the link's own path.
import { ErrorResponse, SignerDone, SignerEnvelope } from "@inkly/domain";

import { ApiError } from "./api.ts";

const signPath = (token: string) => `/api/sign/${encodeURIComponent(token)}`;

async function failure(res: Response): Promise<ApiError> {
  const body = ErrorResponse.safeParse(await res.json().catch(() => null));
  const code = body.success ? body.data.error : "error";
  const message = body.success ? (body.data.message ?? code) : res.statusText;
  return new ApiError(res.status, code, message);
}

async function send(token: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${signPath(token)}${path}`, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!res.ok) throw await failure(res);
  return res;
}

export const signingApi = {
  envelope: async (token: string) => SignerEnvelope.parse(await (await send(token, "")).json()),
  sendCode: async (token: string): Promise<void> => {
    await send(token, "/code", {});
  },
  verify: async (token: string, code: string): Promise<void> => {
    await send(token, "/verify", { code });
  },
  content: async (token: string): Promise<ArrayBuffer> =>
    (await send(token, "/content")).arrayBuffer(),
  sign: async (token: string, values: Record<string, string>) =>
    SignerDone.parse(await (await send(token, "/sign", { values, consent: true })).json()),
  decline: async (token: string, reason: string) =>
    SignerDone.parse(await (await send(token, "/decline", { reason })).json()),
};
