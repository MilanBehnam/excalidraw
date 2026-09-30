import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { useRef, useState } from "react";

import { appJotaiStore, useAtomValue, useSetAtom } from "../app-jotai";
import { deleteMyData, openShareLinkFromUrl } from "../collections/collections";

import {
  authDialogAtom,
  authUserAtom,
  changeName,
  confirmSignUp,
  deleteCognitoUser,
  forgotPassword,
  resendCode,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from "./auth";

import "./AuthDialog.scss";

import type { AuthDialogState, CognitoError } from "./auth";

type Mode = "signIn" | "signUp" | "confirm" | "forgot" | "reset" | "account";

const TITLES: Record<Mode, string> = {
  signIn: "Sign in",
  signUp: "Create account",
  confirm: "Confirm your email",
  forgot: "Reset password",
  reset: "Choose a new password",
  account: "Your account",
};

const PASSWORD_HINT =
  "At least 8 characters, with a lowercase letter and a number";

export const AuthDialog = () => {
  const dialog = useAtomValue(authDialogAtom);
  // remounted on every open, so each opening starts with a fresh form
  return dialog ? <AuthDialogContent dialog={dialog} /> : null;
};

const AuthDialogContent = ({
  dialog,
}: {
  dialog: NonNullable<AuthDialogState>;
}) => {
  const setDialog = useSetAtom(authDialogAtom);
  const user = useAtomValue(authUserAtom);
  const excalidrawAPI = useExcalidrawAPI();
  const formRef = useRef<HTMLFormElement>(null);

  const [mode, setMode] = useState<Mode>(dialog.account ? "account" : "signIn");
  const [email, setEmail] = useState(user?.email || "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(user?.name || "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(dialog.reason || null);
  const [busy, setBusy] = useState(false);

  const close = () => setDialog(null);

  const switchTo = (next: Mode, message: string | null = null) => {
    setMode(next);
    setError(null);
    setNotice(message);
  };

  const signedIn = () => {
    close();
    // a share link that was waiting for sign-in
    if (excalidrawAPI) {
      openShareLinkFromUrl(excalidrawAPI, window.location.origin);
    }
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err: any) {
      if ((err as CognitoError).code === "UserNotConfirmedException") {
        await resendCode(email).catch(() => {});
        switchTo("confirm", `We sent a code to ${email}.`);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    switch (mode) {
      case "signIn":
        return run(async () => {
          await signIn(cleanEmail, password);
          signedIn();
        });
      case "signUp":
        return run(async () => {
          await signUp(cleanEmail, password, name.trim());
          // fake dev logins are signed in right away, real ones need the code
          if (appJotaiStore.get(authUserAtom)) {
            signedIn();
          } else {
            switchTo("confirm", `We sent a code to ${cleanEmail}.`);
          }
        });
      case "confirm":
        return run(async () => {
          await confirmSignUp(cleanEmail, code.trim());
          await signIn(cleanEmail, password);
          signedIn();
        });
      case "forgot":
        return run(async () => {
          await forgotPassword(cleanEmail);
          switchTo("reset", `We sent a code to ${cleanEmail}.`);
        });
      case "reset":
        return run(async () => {
          await resetPassword(cleanEmail, code.trim(), password);
          await signIn(cleanEmail, password);
          signedIn();
        });
      case "account":
        return run(async () => {
          await changeName(name.trim());
          setNotice("Name saved.");
        });
    }
  };

  const onDeleteAccount = () => {
    if (
      !window.confirm(
        "Delete your account and everything you own? People you shared with lose access. This can't be undone.",
      )
    ) {
      return;
    }
    run(async () => {
      await deleteMyData();
      await deleteCognitoUser();
      close();
    });
  };

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    props: React.InputHTMLAttributes<HTMLInputElement>,
  ) => (
    <label className="auth-dialog__field">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        {...props}
      />
    </label>
  );

  return (
    <Dialog
      onCloseRequest={close}
      title={TITLES[mode]}
      size="small"
      className="auth-dialog"
      // the first field focuses itself (the dialog would pick the last one)
      autofocus={false}
    >
      <form ref={formRef} onSubmit={onSubmit} className="auth-dialog__form">
        {notice && <p className="auth-dialog__notice">{notice}</p>}

        {mode === "signUp" &&
          field("Name (shown next to your cursor)", name, setName, {
            autoComplete: "name",
            maxLength: 100,
            autoFocus: true,
          })}
        {(mode === "signIn" || mode === "signUp" || mode === "forgot") &&
          field("Email", email, setEmail, {
            type: "email",
            autoComplete: "email",
            autoFocus: mode !== "signUp",
          })}
        {(mode === "confirm" || mode === "reset") &&
          field("Code from the email", code, setCode, {
            autoComplete: "one-time-code",
            inputMode: "numeric",
            autoFocus: true,
          })}
        {(mode === "signIn" || mode === "signUp" || mode === "reset") &&
          field(
            mode === "reset" ? "New password" : "Password",
            password,
            setPassword,
            {
              type: "password",
              autoComplete:
                mode === "signIn" ? "current-password" : "new-password",
              minLength: 8,
              title: mode === "signIn" ? undefined : PASSWORD_HINT,
            },
          )}
        {mode === "account" && (
          <>
            <p className="auth-dialog__notice">Signed in as {user?.email}</p>
            {field("Name (shown next to your cursor)", name, setName, {
              autoComplete: "name",
              maxLength: 100,
            })}
          </>
        )}

        {(mode === "signUp" || mode === "reset") && (
          <p className="auth-dialog__hint">{PASSWORD_HINT}</p>
        )}
        {error && <p className="auth-dialog__error">{error}</p>}

        <FilledButton
          size="large"
          fullWidth
          status={busy ? "loading" : null}
          onClick={() => formRef.current?.requestSubmit()}
          label={
            {
              signIn: "Sign in",
              signUp: "Create account",
              confirm: "Confirm",
              forgot: "Send code",
              reset: "Save password",
              account: "Save name",
            }[mode]
          }
        />
        {/* lets Enter submit the form (FilledButton is type="button") */}
        <button type="submit" hidden />

        <div className="auth-dialog__links">
          {mode === "signIn" && (
            <>
              <button type="button" onClick={() => switchTo("signUp")}>
                Create account
              </button>
              <button type="button" onClick={() => switchTo("forgot")}>
                Forgot password?
              </button>
            </>
          )}
          {(mode === "signUp" || mode === "forgot") && (
            <button type="button" onClick={() => switchTo("signIn")}>
              I already have an account
            </button>
          )}
          {mode === "confirm" && (
            <button
              type="button"
              onClick={() =>
                run(async () => {
                  await resendCode(email.trim().toLowerCase());
                  setNotice("New code sent.");
                })
              }
            >
              Send a new code
            </button>
          )}
          {mode === "account" && (
            <>
              <button
                type="button"
                onClick={() => {
                  signOut();
                  close();
                }}
              >
                Sign out
              </button>
              <button
                type="button"
                className="auth-dialog__danger"
                onClick={onDeleteAccount}
              >
                Delete account
              </button>
            </>
          )}
        </div>
      </form>
    </Dialog>
  );
};
