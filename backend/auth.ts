// Who is calling: verifies the Cognito ID token the app sends as
// `Authorization: Bearer <token>` (and as the socket handshake auth).

import { CognitoJwtVerifier } from "aws-jwt-verify";

export type User = { sub: string; email: string; name: string };

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";

/**
 * Local dev/tests only (backend/docker-compose.yml): accepts made-up
 * `dev:<email>:<name>` tokens instead of real Cognito logins. Never set in AWS.
 */
export const DEV_FAKE_AUTH = process.env.DEV_FAKE_AUTH === "true";
if (DEV_FAKE_AUTH) {
  console.warn("DEV_FAKE_AUTH is on: anyone can sign in as anyone");
}

const verifier = USER_POOL_ID
  ? CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      clientId: CLIENT_ID,
      tokenUse: "id",
    })
  : null;

/** what the app needs to talk to Cognito (public values) */
export const authConfig = {
  region: USER_POOL_ID.split("_")[0] || null,
  clientId: CLIENT_ID || null,
  fakeAuth: DEV_FAKE_AUTH,
};

/** null for a missing or invalid token */
export const verifyToken = async (
  token: string | null | undefined,
): Promise<User | null> => {
  if (!token) {
    return null;
  }
  if (DEV_FAKE_AUTH && token.startsWith("dev:")) {
    const [, email, name] = token.split(":").map(decodeURIComponent);
    return email
      ? { sub: `dev-${email}`, email: email.toLowerCase(), name: name || email }
      : null;
  }
  try {
    const payload = await verifier!.verify(token);
    // sharing is by email, so only confirmed addresses count
    if (!payload.email_verified) {
      return null;
    }
    return {
      sub: payload.sub,
      email: String(payload.email).toLowerCase(),
      name: String(payload.name || payload.email),
    };
  } catch {
    return null;
  }
};
