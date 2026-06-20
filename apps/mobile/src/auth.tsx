// Clerk auth — optional. When EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is set, the app
// gets sign in / sign up (email code + Google) and syncs the wishlist + library
// to the user's Clerk profile metadata (so they follow you across devices).
// When the key is absent, everything below no-ops and the app runs as a guest.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ClerkProvider, useAuth, useClerk, useSignIn, useSignUp, useSSO, useUser } from "@clerk/clerk-expo";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

WebBrowser.maybeCompleteAuthSession();

export const CLERK_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

const secureCache = {
  getToken: (k: string) => SecureStore.getItemAsync(k).catch(() => null),
  saveToken: (k: string, v: string) => SecureStore.setItemAsync(k, v).catch(() => undefined),
};

export function AuthGate({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={CLERK_KEY} tokenCache={Platform.OS === "web" ? undefined : secureCache}>
      {children}
    </ClerkProvider>
  );
}

// ── header sign-in / sign-out control ──
export function AuthButton() {
  if (!CLERK_KEY) return null;
  return <AuthButtonInner />;
}

function AuthButtonInner() {
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);

  if (isSignedIn) {
    const name = user?.primaryEmailAddress?.emailAddress?.split("@")[0] ?? "account";
    return (
      <Pressable style={a.chip} onPress={() => signOut()} accessibilityLabel="Sign out">
        <Text style={a.chipText} numberOfLines={1}>
          {name} · out
        </Text>
      </Pressable>
    );
  }
  // On web, send the user to Clerk's hosted Account Portal (proven, handles the
  // session round-trip correctly). The portal offers "Continue with Google" — one
  // tap, no email codes. Native uses the in-app modal. Sign-in is optional.
  const startSignIn = () => {
    const url = Platform.OS === "web" ? hostedSignInUrl() : null;
    if (url) window.location.assign(url);
    else setOpen(true);
  };
  return (
    <>
      <Pressable style={[a.chip, a.chipOn]} onPress={startSignIn}>
        <Text style={[a.chipText, { color: "#ffffff" }]}>Sign in</Text>
      </Pressable>
      <SignInModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

// Clerk hosted Account Portal sign-in URL, derived from the publishable key's
// Frontend API host, redirecting back to the current page. Handles both
// production (clerk.<app> → accounts.<app>) and dev (<slug>.clerk.accounts.dev
// → <slug>.accounts.dev) keys.
function hostedSignInUrl(): string | null {
  if (!CLERK_KEY || typeof window === "undefined" || typeof atob === "undefined") return null;
  try {
    const fapi = atob(CLERK_KEY.split("_")[2]).replace(/\$+$/, "");
    let portal: string;
    if (fapi.includes(".clerk.accounts.dev")) portal = fapi.replace(".clerk.accounts.dev", ".accounts.dev");
    else if (fapi.startsWith("clerk.")) portal = "accounts." + fapi.slice("clerk.".length);
    else return null;
    const back = window.location.origin + window.location.pathname;
    return `https://${portal}/sign-in?redirect_url=${encodeURIComponent(back)}`;
  } catch {
    return null;
  }
}

function SignInModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { signIn, setActive: setActiveSignIn } = useSignIn();
  const { signUp, setActive: setActiveSignUp } = useSignUp();
  const { startSSOFlow } = useSSO();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const close = () => {
    setEmail("");
    setCode("");
    setStep("email");
    setErr("");
    setBusy(false);
    onClose();
  };

  const sendCode = async () => {
    if (!email.includes("@") || !signIn || !signUp) return;
    setBusy(true);
    setErr("");
    try {
      const si = await signIn.create({ identifier: email });
      const factor = si.supportedFirstFactors?.find((f) => f.strategy === "email_code") as { emailAddressId: string } | undefined;
      if (!factor) throw new Error("no-email-code");
      await signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
      setMode("signin");
      setStep("code");
    } catch {
      try {
        await signUp.create({ emailAddress: email });
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setMode("signup");
        setStep("code");
      } catch (e) {
        setErr(clerkErr(e) ?? "Couldn't send a code — check the address.");
      }
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setErr("");
    try {
      if (mode === "signin" && signIn) {
        const res = await signIn.attemptFirstFactor({ strategy: "email_code", code });
        if (res.status === "complete") return done(setActiveSignIn, res.createdSessionId);
        setErr(`Couldn't finish sign-in (${res.status}).`);
      } else if (signUp) {
        let res = await signUp.attemptEmailAddressVerification({ code });
        // If the Clerk app requires a password, set a random one so the
        // passwordless email-code flow still completes (user never sees it).
        const missing = ((res as { missingFields?: string[] }).missingFields ?? []).concat(
          (res as { requiredFields?: string[] }).requiredFields ?? [],
        );
        if (res.status !== "complete" && missing.includes("password")) {
          res = await signUp.update({ password: randomPassword() });
        }
        if (res.status === "complete") return done(setActiveSignUp, res.createdSessionId);
        setErr(`Almost there — account needs: ${missing.join(", ") || res.status}.`);
      }
    } catch (e) {
      setErr(clerkErr(e) ?? "Wrong or expired code — request a new one.");
    } finally {
      setBusy(false);
    }
  };

  const done = async (setActive: ((p: { session: string }) => Promise<void>) | undefined, session: string | null) => {
    if (setActive && session) await setActive({ session });
    close();
  };

  const google = async () => {
    setBusy(true);
    setErr("");
    try {
      const { createdSessionId, setActive } = await startSSOFlow({ strategy: "oauth_google" });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        close();
      } else {
        setBusy(false);
      }
    } catch {
      setErr("Google sign-in didn't complete.");
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={a.backdrop}>
        <View style={a.sheet}>
          <Text style={a.title}>Sign in to TRDR</Text>
          <Text style={a.sub}>Save your wishlist & library to your account — synced across your devices.</Text>

          {step === "email" ? (
            <>
              <Pressable style={a.google} onPress={google} disabled={busy}>
                <Text style={a.googleText}>Continue with Google</Text>
              </Pressable>
              <Text style={a.or}>or</Text>
              <TextInput
                style={a.input}
                value={email}
                onChangeText={setEmail}
                placeholder="you@email.com"
                placeholderTextColor="#70757c"
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <Pressable style={a.primary} onPress={sendCode} disabled={busy}>
                <Text style={a.primaryText}>{busy ? "…" : "Email me a code"}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={a.sub}>Enter the 6-digit code we emailed to {email}.</Text>
              <TextInput style={a.input} value={code} onChangeText={setCode} placeholder="123456" placeholderTextColor="#70757c" keyboardType="number-pad" />
              <Pressable style={a.primary} onPress={verify} disabled={busy}>
                <Text style={a.primaryText}>{busy ? "…" : "Verify & sign in"}</Text>
              </Pressable>
            </>
          )}

          {err ? <Text style={a.err}>{err}</Text> : null}
          {/* Clerk mounts its invisible Smart-CAPTCHA (bot protection) into this
              node during signUp.create. On RN-Web, nativeID becomes the DOM id,
              so Clerk finds #clerk-captcha and the challenge can run; without it,
              sign-up fails with captcha_missing_token. */}
          <View nativeID="clerk-captcha" style={a.captcha} />
          <Pressable onPress={close}>
            <Text style={a.cancel}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ── sync wishlist + library to the signed-in user's Clerk metadata ──
export function CloudSync(props: {
  specs: unknown[];
  holdings: unknown[];
  onLoad: (d: { specs?: unknown[]; holdings?: unknown[] }) => void;
}) {
  if (!CLERK_KEY) return null;
  return <CloudSyncInner {...props} />;
}

function CloudSyncInner({ specs, holdings, onLoad }: { specs: unknown[]; holdings: unknown[]; onLoad: (d: { specs?: unknown[]; holdings?: unknown[] }) => void }) {
  const { isSignedIn, getToken } = useAuth();
  const hydrated = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = process.env.EXPO_PUBLIC_API_BASE;

  // On sign-in, pull the account's saved library + wishlist ONCE and MERGE it in
  // (onLoad unions by id — never replaces, so a freshly-added card survives).
  useEffect(() => {
    if (!isSignedIn || hydrated.current || !base) return;
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        if (token && active) {
          const r = await fetch(`${base}/api/v1/user/state`, { headers: { Authorization: `Bearer ${token}` } });
          if (r.ok && active) {
            const d = (await r.json()) as { library?: unknown[]; wishlist?: unknown[] };
            onLoad({ specs: d.wishlist, holdings: d.library });
          }
        }
      } catch {
        /* offline / sync not configured → stay local-only */
      }
      hydrated.current = true; // only push AFTER the initial pull, never before
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  // After hydration, push local changes to the account, debounced.
  useEffect(() => {
    if (!isSignedIn || !hydrated.current || !base) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const token = await getToken();
          if (!token) return;
          await fetch(`${base}/api/v1/user/state`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ wishlist: specs, library: holdings }),
          });
        } catch {
          /* best-effort */
        }
      })();
    }, 1500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs, holdings, isSignedIn]);

  return null;
}

function clerkErr(e: unknown): string | undefined {
  const m = (e as { errors?: { message?: string }[] })?.errors?.[0]?.message;
  return m;
}

// A strong random password, used only when the Clerk instance requires one —
// keeps the email-code flow passwordless from the user's point of view.
function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let s = "";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const a = StyleSheet.create({
  chip: { borderWidth: 1, borderColor: "#e6e8eb", borderRadius: 20, paddingHorizontal: 11, paddingVertical: 4, maxWidth: 130 },
  chipOn: { backgroundColor: "#0654ba", borderColor: "#0654ba" },
  chipText: { color: "#70757c", fontSize: 12, fontWeight: "600" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 22 },
  sheet: { width: "100%", maxWidth: 360, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e6e8eb", borderRadius: 16, padding: 20 },
  title: { color: "#15171a", fontSize: 18, fontWeight: "600" },
  sub: { color: "#70757c", fontSize: 13, marginTop: 6, lineHeight: 18 },
  google: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d4d7dc", borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 16 },
  googleText: { color: "#15171a", fontSize: 15, fontWeight: "600" },
  or: { color: "#70757c", fontSize: 12, textAlign: "center", marginVertical: 12 },
  input: { backgroundColor: "#f7f8f9", borderWidth: 1, borderColor: "#d4d7dc", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: "#15171a", fontSize: 15 },
  primary: { backgroundColor: "#0654ba", borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 12 },
  primaryText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
  err: { color: "#c0392b", fontSize: 13, marginTop: 12 },
  captcha: { alignItems: "center", marginTop: 8 },
  cancel: { color: "#70757c", fontSize: 14, textAlign: "center", marginTop: 16 },
});
