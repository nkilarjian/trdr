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
  // On web, use Clerk's polished HOSTED sign-in (password / Google / stays signed
  // in) — the same experience as a Next.js Clerk app. Fall back to the in-app
  // modal on native (Expo has no drop-in hosted page) or if the URL can't build.
  const startSignIn = () => {
    const url = Platform.OS === "web" ? hostedSignInUrl() : null;
    if (url) window.location.assign(url);
    else setOpen(true);
  };
  return (
    <>
      <Pressable style={[a.chip, a.chipOn]} onPress={startSignIn}>
        <Text style={[a.chipText, { color: "#04122b" }]}>Sign in</Text>
      </Pressable>
      <SignInModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

// Build the Clerk Account Portal sign-in URL from the publishable key, with a
// redirect back to wherever the user is now. Dev key encodes the Frontend API
// host (…clerk.accounts.dev); the hosted portal lives at the …accounts.dev twin.
function hostedSignInUrl(): string | null {
  if (!CLERK_KEY || typeof window === "undefined" || typeof atob === "undefined") return null;
  try {
    const fapi = atob(CLERK_KEY.split("_")[2]).replace(/\$+$/, ""); // immune-dinosaur-48.clerk.accounts.dev
    const portal = fapi.replace(".clerk.accounts.dev", ".accounts.dev");
    if (!portal.endsWith(".accounts.dev")) return null;
    // Clean origin+path (drop ?query/#hash) so it matches Clerk's allowed-redirect list.
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
                placeholderTextColor="#8b97a8"
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
              <TextInput style={a.input} value={code} onChangeText={setCode} placeholder="123456" placeholderTextColor="#8b97a8" keyboardType="number-pad" />
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
  const { user, isLoaded } = useUser();
  const lastSynced = useRef("");
  const loadedFor = useRef<string | null>(null);

  // on sign-in: pull the account's saved wishlist/library down (once per user)
  useEffect(() => {
    if (!isLoaded || !user || loadedFor.current === user.id) return;
    loadedFor.current = user.id;
    const md = (user.unsafeMetadata ?? {}) as { wishlist?: unknown[]; library?: unknown[] };
    if (Array.isArray(md.wishlist) || Array.isArray(md.library)) {
      onLoad({ specs: md.wishlist, holdings: md.library });
      lastSynced.current = JSON.stringify({ w: md.wishlist ?? [], l: md.library ?? [] });
    } else {
      lastSynced.current = ""; // no cloud data → push local up
    }
  }, [isLoaded, user, onLoad]);

  // on change while signed in: push up (skip if unchanged → no loop)
  useEffect(() => {
    if (!user) return;
    const cur = JSON.stringify({ w: specs, l: holdings });
    if (cur === lastSynced.current) return;
    lastSynced.current = cur;
    user.update({ unsafeMetadata: { ...(user.unsafeMetadata ?? {}), wishlist: specs, library: holdings } }).catch(() => undefined);
  }, [specs, holdings, user]);

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
  chip: { borderWidth: 1, borderColor: "#232c3b", borderRadius: 20, paddingHorizontal: 11, paddingVertical: 4, maxWidth: 130 },
  chipOn: { backgroundColor: "#74b1f0", borderColor: "#74b1f0" },
  chipText: { color: "#8b97a8", fontSize: 12, fontWeight: "700" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 22 },
  sheet: { width: "100%", maxWidth: 360, backgroundColor: "#141925", borderWidth: 1, borderColor: "#232c3b", borderRadius: 16, padding: 20 },
  title: { color: "#e6edf3", fontSize: 19, fontWeight: "700" },
  sub: { color: "#8b97a8", fontSize: 13, marginTop: 6, lineHeight: 18 },
  google: { backgroundColor: "#e6edf3", borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 16 },
  googleText: { color: "#0b0e14", fontSize: 15, fontWeight: "700" },
  or: { color: "#8b97a8", fontSize: 12, textAlign: "center", marginVertical: 12 },
  input: { backgroundColor: "#0b0e14", borderWidth: 1, borderColor: "#232c3b", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, color: "#e6edf3", fontSize: 15 },
  primary: { backgroundColor: "#74b1f0", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 12 },
  primaryText: { color: "#04122b", fontSize: 15, fontWeight: "700" },
  err: { color: "#f85149", fontSize: 13, marginTop: 12 },
  captcha: { alignItems: "center", marginTop: 8 },
  cancel: { color: "#8b97a8", fontSize: 14, textAlign: "center", marginTop: 16 },
});
