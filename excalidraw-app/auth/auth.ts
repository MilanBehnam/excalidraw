// Accounts: the browser talks to AWS Cognito directly (passwords never reach
// our backend) and sends the resulting ID token to the backend.

import { appJotaiStore, atom } from "../app-jotai";
import { STORAGE_KEYS } from "../app_constants";

export type AuthUser = { sub: string; email: string; name: string };

type Session = {
  idToken: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
};

// the socket server and the HTTP API are the same backend
const BACKEND_URL = new URL(
  import.meta.env.VITE_APP_WS_SERVER_URL,
  window.location.href,
);

export const apiUrl = (path: string) => new URL(`api/${path}`, BACKEND_URL);

// session
// -----------------------------------------------------------------------------

const loadSession = (): Session | null => {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AUTH) || "null",
    );
  } catch {
    return null;
  }
};

const userFromSession = (session: Session | null): AuthUser | null => {
  if (!session) {
    return null;
  }
  if (session.idToken.startsWith("dev:")) {
    const [, email, name] = session.idToken.split(":").map(decodeURIComponent);
    return { sub: `dev-${email}`, email, name };
  }
  try {
    const payload = JSON.parse(
      atob(session.idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return { sub: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
};

let session = loadSession();

/** the signed-in user, or null */
export const authUserAtom = atom<AuthUser | null>(userFromSession(session));

const setSession = (next: Session | null) => {
  session = next;
  try {
    if (next) {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_AUTH,
        JSON.stringify(next),
      );
    } else {
      localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AUTH);
    }
  } catch {}
  appJotaiStore.set(authUserAtom, userFromSession(next));
};

// the dialog
// -----------------------------------------------------------------------------

export type AuthDialogState = { reason?: string; account?: boolean } | null;
export const authDialogAtom = atom<AuthDialogState>(null);

/** sign in (or account settings, when already signed in) */
export const openAuthDialog = (reason?: string) =>
  appJotaiStore.set(authDialogAtom, {
    reason,
    account: !!appJotaiStore.get(authUserAtom),
  });

// cognito
// -----------------------------------------------------------------------------

type Config = { region: string; clientId: string; fakeAuth: boolean };
let configPromise: Promise<Config> | null = null;

const getConfig = () => {
  configPromise ??= fetch(apiUrl("config")).then((res) => {
    if (!res.ok) {
      configPromise = null;
      throw new Error("Can't reach the server");
    }
    return res.json();
  });
  return configPromise;
};

export class CognitoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const cognito = async (action: string, body: Record<string, unknown>) => {
  const { region } = await getConfig();
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(json.__type || "Error")
      .split("#")
      .pop()!;
    throw new CognitoError(code, json.message || "Something went wrong");
  }
  return json;
};

const withClient = async (body: Record<string, unknown>) => ({
  ClientId: (await getConfig()).clientId,
  ...body,
});

const saveAuthResult = (
  result: {
    IdToken: string;
    AccessToken: string;
    RefreshToken?: string;
    ExpiresIn: number;
  },
  refreshToken: string | null = null,
) =>
  setSession({
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken ?? refreshToken,
    expiresAt: Date.now() + result.ExpiresIn * 1000,
  });

/** local dev backend with DEV_FAKE_AUTH: any email signs in, no password */
const fakeSignIn = (email: string, name?: string) =>
  setSession({
    idToken: `dev:${encodeURIComponent(email)}:${encodeURIComponent(
      name || email.split("@")[0],
    )}`,
    accessToken: null,
    refreshToken: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });

export const signUp = async (email: string, password: string, name: string) => {
  if ((await getConfig()).fakeAuth) {
    return fakeSignIn(email, name);
  }
  await cognito(
    "SignUp",
    await withClient({
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: name },
      ],
    }),
  );
};

export const confirmSignUp = async (email: string, code: string) =>
  cognito(
    "ConfirmSignUp",
    await withClient({ Username: email, ConfirmationCode: code }),
  );

export const resendCode = async (email: string) =>
  cognito("ResendConfirmationCode", await withClient({ Username: email }));

export const signIn = async (email: string, password: string) => {
  if ((await getConfig()).fakeAuth) {
    return fakeSignIn(email);
  }
  const { AuthenticationResult } = await cognito(
    "InitiateAuth",
    await withClient({
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  saveAuthResult(AuthenticationResult);
};

export const forgotPassword = async (email: string) =>
  cognito("ForgotPassword", await withClient({ Username: email }));

export const resetPassword = async (
  email: string,
  code: string,
  password: string,
) =>
  cognito(
    "ConfirmForgotPassword",
    await withClient({
      Username: email,
      ConfirmationCode: code,
      Password: password,
    }),
  );

export const signOut = () => setSession(null);

const refresh = async () => {
  if (!session?.refreshToken) {
    throw new Error("no refresh token");
  }
  const { AuthenticationResult } = await cognito(
    "InitiateAuth",
    await withClient({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: session.refreshToken },
    }),
  );
  saveAuthResult(AuthenticationResult, session.refreshToken);
};

/** a valid ID token for the backend, refreshed when about to expire */
export const getIdToken = async (): Promise<string | null> => {
  if (!session) {
    return null;
  }
  if (session.expiresAt - 60_000 < Date.now()) {
    try {
      await refresh();
    } catch {
      // refresh token expired or revoked: signed out
      setSession(null);
      return null;
    }
  }
  return session!.idToken;
};

export const changeName = async (name: string) => {
  if (!session?.accessToken) {
    // fake dev login: just re-issue it with the new name
    return fakeSignIn(appJotaiStore.get(authUserAtom)!.email, name);
  }
  await getIdToken();
  await cognito("UpdateUserAttributes", {
    AccessToken: session!.accessToken,
    UserAttributes: [{ Name: "name", Value: name }],
  });
  // new ID token carrying the new name
  await refresh();
};

/** removes the account; the caller deletes the user's data first */
export const deleteCognitoUser = async () => {
  if (session?.accessToken) {
    await getIdToken();
    await cognito("DeleteUser", { AccessToken: session!.accessToken });
  }
  setSession(null);
};
