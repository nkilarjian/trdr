import { Children, createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ActivityIndicator, Animated, Image, Linking, Modal, PanResponder, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text as RNText, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

type IconName = keyof typeof Ionicons.glyphMap;
import { alertVM, fairValueVM } from "./src/trdr-ui";
import { buildWishTree, parseWish, type WishNode, type WishSpec } from "./src/trdr-wishlist";
import { AuthButton, AuthGate, CloudSync } from "./src/auth";
import type { Alert } from "@trdr/core";
import snapshot from "./assets/data.json";

type CardKey = { set: string; number: string; variant?: string; grader: string; grade: number };

type Passport = {
  key: CardKey;
  cert: string | null;
  imageUrl?: string;
  fairValue: { point: number; lower: number; upper: number; confidence: number; liquidity: number; compCount: number };
  pop: { atGrade: number; higher: number; total: number } | null;
  recent: { date: string; price: number; type: string }[];
};

type WishHit = {
  wishId: string;
  itemId: string;
  title: string;
  currentPrice: number;
  buyingOption: "AUCTION" | "BIN";
  endTime?: string;
  value: number;
  cool: number;
  interest: number;
  tags: string[];
  fairBand?: { lower: number; point: number; upper: number };
  imageUrl?: string;
  deepLink: string;
};

type Wishlist = { specs: WishSpec[]; tree: WishNode; hits: WishHit[] };

type Holding = { id: string; key: CardKey; cert?: string; imageUrl?: string; acquiredPrice?: number; acquiredAt?: string; acquiredFrom?: string };
type WatchedCard = { key: CardKey; fairValue?: { point: number; lower: number; upper: number; confidence: number; compCount: number }; imageUrl?: string; lowestAsk?: number };
type ValuedHolding = {
  holding: Holding;
  fairValue?: { point: number; lower: number; upper: number; confidence: number };
  trendPct?: number;
  unrealizedPL?: number;
};
type Detection = { id: string; grader?: string; certGuess?: string; confidence: number; cropUrl?: string };
type Scan = { detected: number; added: Holding[]; review: { detection: Detection; reason: string }[]; valued: ValuedHolding[] };

type Feed = {
  alerts: Alert[];
  passport: Passport;
  wishlist: Wishlist;
  library: { holdings: ValuedHolding[] };
  scan: Scan;
};

const FALLBACK = snapshot as unknown as Feed;

// Set EXPO_PUBLIC_API_BASE (e.g. http://192.168.x.x:3000) to fetch live from the
// Fastify API; otherwise the app renders the bundled snapshot offline.
const API_BASE = process.env.EXPO_PUBLIC_API_BASE;

// Light, eBay-style palette: white surfaces, near-black text, eBay blue.
const C = {
  bg: "#f4f5f7", // page background (light gray)
  panel: "#ffffff", // cards / surfaces
  panel2: "#f1f3f5", // subtle inset surface
  line: "#e6e8eb", // hairline borders
  ink: "#15171a", // primary text (near-black)
  muted: "#70757c", // secondary text
  green: "#157347", // discount / gains
  amber: "#9a6700",
  red: "#c0392b", // losses
  accent: "#0654ba", // eBay blue (links, buttons, active)
};

// Monospace for numbers — the terminal feel. Web gets a real mono stack; native
// falls back to its system mono.
const MONO = Platform.select({ web: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", default: "monospace" }) as string;

// Money + signal helpers for the terminal rows.
const money = (n: number) => Math.round(n).toLocaleString();
function signal(edge: number, conf: number): { tag: string; color: string } {
  if (edge >= 0.15 && conf >= 0.7) return { tag: "buy", color: C.green };
  if (edge >= 0.06) return { tag: "watch", color: C.amber };
  return { tag: "thin", color: C.muted };
}

const tone = (t: string) => (t === "high" || t === "ok" ? C.green : t === "medium" || t === "caution" ? C.amber : C.red);

// ── Dynamic Type: an app-level text scale every <Text> respects. Native OS font
// scaling still applies on top (bounded), and this control works on web too. ──
const ScaleCtx = createContext(1);
function Text(props: any) {
  const scale = useContext(ScaleCtx);
  const flat = StyleSheet.flatten(props.style) || {};
  const base = typeof flat.fontSize === "number" ? flat.fontSize : 15;
  return <RNText maxFontSizeMultiplier={1.6} {...props} style={[props.style, { fontSize: base * scale }]} />;
}

// ── plain-language helpers (Pro mode reveals the quant terms) ──
function plain<T>(pro: boolean, simpleVal: T, proVal: T): T {
  return pro ? proVal : simpleVal;
}
function sureness(conf: number): { dots: string; label: string; tone: string } {
  const n = conf >= 0.8 ? 3 : conf >= 0.6 ? 2 : 1;
  return { dots: "●".repeat(n) + "○".repeat(3 - n), label: n === 3 ? "High" : n === 2 ? "Medium" : "Low", tone: n === 3 ? "high" : n === 2 ? "medium" : "low" };
}
function friendlySeller(label: string): string {
  if (label.includes("under-market")) return "Sells below market — worth a look";
  if (label.includes("manipulation") || label.includes("erratic")) return "Be careful with this seller";
  if (label.includes("often high")) return "Tends to price high";
  if (label.includes("limited")) return "New-ish seller";
  return "Seller looks fine";
}

// Free-text → a Holding for the manual "add a card" path (works with no backend).
function parseHolding(text: string, id: string): Holding {
  const grader = (text.match(/\b(PSA|CGC|SGC|BGS)\b/i)?.[1] ?? "PSA").toUpperCase();
  const grade = Number(text.match(/\b(10|9\.5|9|8\.5|8|7|6|5)\b/)?.[1] ?? 10);
  const number = text.match(/#(\w+)/)?.[1] ?? "";
  const set = text
    .replace(/\b(PSA|CGC|SGC|BGS)\b/gi, "")
    .replace(/#\w+/g, "")
    .replace(/\b(10|9\.5|9|8\.5|8|7|6|5)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { id, key: { set: set || "Card", number, grader, grade } };
}

// Open a URL in a real new tab. On web, Linking.openURL can navigate the current
// tab away and/or leave a blank tab; a one-shot anchor click is reliable.
function openExternal(url: string) {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  Linking.openURL(url).catch(() => {});
}

// Build an eBay SOLD-listings search for a card. Prefer a real recent sold title
// (it carries the player name + exact parallel, which the canonical key lacks),
// else fall back to the card's name + grade. Sorted most-recent-sold first.
function ebaySoldUrl(name: string, grader: string, grade: number, sampleTitle?: string): string {
  const base = sampleTitle && sampleTitle.length > 8 ? sampleTitle : `${name} ${grader} ${grade}`;
  const q = base.replace(/#/g, "").replace(/\s+/g, " ").trim();
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13`;
}

export default function App() {
  const [tab, setTab] = useState<"alerts" | "value" | "library" | "wishlist" | "scan" | "passport">("alerts");
  const [source, setSource] = useState<"snapshot" | "live">("snapshot");
  // What the backend can actually do (real creds vs mocks) — drives honest
  // labelling and hides features that aren't really wired (e.g. photo-scan).
  const [caps, setCaps] = useState<{ market?: string; vision?: string; grading?: string }>({});
  const [refreshing, setRefreshing] = useState(false);
  // Your wishlist drives everything (deals + wishlist + the watched cards).
  const [specs, setSpecs] = useState<WishSpec[]>(FALLBACK.wishlist.specs);
  // With a real backend, start EMPTY and show a loading state — never flash the
  // seeded demo deals as if they were live (that's what made it look "broken").
  const [alerts, setAlerts] = useState<Alert[]>(API_BASE ? [] : FALLBACK.alerts);
  const [speculative, setSpeculative] = useState<Alert[]>([]);
  const [watching, setWatching] = useState<WatchedCard[]>([]);
  const [passport, setPassport] = useState<Passport>(FALLBACK.passport);
  const [hits, setHits] = useState<WishHit[]>(API_BASE ? [] : FALLBACK.wishlist.hits);
  const [boardLoaded, setBoardLoaded] = useState(!API_BASE); // no API → the snapshot IS the data
  const [holdings, setHoldings] = useState<ValuedHolding[]>([]); // your library — loaded from the phone
  const [pro, setPro] = useState(false); // Pro mode reveals the quant terms
  const [textScale, setTextScale] = useState(1); // Dynamic Type: app-level text size
  const [onboarded, setOnboarded] = useState<boolean | null>(null); // null = still loading

  useEffect(() => {
    AsyncStorage.getItem("trdr.onboarded")
      .then((v) => setOnboarded(v === "1"))
      .catch(() => setOnboarded(true));
  }, []);

  const finishOnboarding = () => {
    setOnboarded(true);
    AsyncStorage.setItem("trdr.onboarded", "1").catch(() => {});
  };

  // Scan the user's wishlist live → deals + wishlist hits + a passport card.
  const refreshBoard = (currentSpecs: WishSpec[]) => {
    if (!API_BASE) return;
    fetch(`${API_BASE}/api/v1/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specs: currentSpecs }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b: { alerts: Alert[]; speculative?: Alert[]; watching?: WatchedCard[]; wishlist: { hits: WishHit[] }; passport: Passport | null }) => {
        setAlerts(b.alerts);
        setSpeculative(b.speculative ?? []);
        setWatching(b.watching ?? []);
        setHits(b.wishlist.hits);
        if (b.passport) setPassport(b.passport);
        setSource("live");
        setBoardLoaded(true);
        // Cache last-good board so reopening shows real deals instantly (the live
        // scan takes several seconds; nobody should stare at a blank/old screen).
        AsyncStorage.setItem("trdr.board", JSON.stringify({ alerts: b.alerts, speculative: b.speculative ?? [], watching: b.watching ?? [], hits: b.wishlist.hits })).catch(() => {});
      })
      .catch(() => {
        // Unreachable/slow API: mark loaded so we stop showing a spinner forever.
        setBoardLoaded(true);
      });
  };

  // Price the on-device library against the live model (real eBay data when the
  // API has credentials). Posts the user's holdings, merges fair values back in.
  const revalueLibrary = (hs: ValuedHolding[]) => {
    if (!API_BASE || !hs.length) return;
    fetch(`${API_BASE}/api/v1/library/value`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdings: hs.map((v) => v.holding) }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b: { holdings: ValuedHolding[] }) => {
        if (!Array.isArray(b.holdings)) return;
        const byId = new Map(b.holdings.map((v) => [v.holding.id, v]));
        setHoldings((prev) => {
          // Only replace when the fresh copy actually has a value — never blank an
          // existing value if the API hiccups or can't price a card.
          const next = prev.map((v) => {
            const u = byId.get(v.holding.id);
            return u && u.fairValue ? u : v;
          });
          AsyncStorage.setItem("trdr.library", JSON.stringify(next)).catch(() => {});
          return next;
        });
      })
      .catch(() => {
        /* unreachable API → cards stay unvalued (shown as —) */
      });
  };

  // Ask the backend what's real (eBay/vision connected yet?) so the UI stays honest.
  useEffect(() => {
    if (!API_BASE) return;
    fetch(`${API_BASE}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { providers?: { market?: string; vision?: string; grading?: string } } | null) => {
        if (d?.providers) setCaps(d.providers);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    // Show the last real deals immediately (cached) while the live scan re-runs.
    if (API_BASE) {
      AsyncStorage.getItem("trdr.board")
        .then((v) => {
          if (!active || !v) return;
          const b = JSON.parse(v) as { alerts?: Alert[]; speculative?: Alert[]; watching?: WatchedCard[]; hits?: WishHit[] };
          if (b.alerts?.length) {
            setAlerts(b.alerts);
            setSource("live");
            setBoardLoaded(true);
          }
          if (b.speculative?.length) setSpeculative(b.speculative);
          if (b.watching?.length) {
            setWatching(b.watching);
            setSource("live");
            setBoardLoaded(true);
          }
          if (b.hits?.length) setHits(b.hits);
        })
        .catch(() => {});
    }
    AsyncStorage.getItem("trdr.wishlist")
      .then((v) => {
        const saved = v ? (JSON.parse(v) as WishSpec[]) : null;
        const s = saved ?? FALLBACK.wishlist.specs; // honor a saved (even cleared/empty) wishlist
        if (active) setSpecs(s);
        refreshBoard(s);
      })
      .catch(() => refreshBoard(FALLBACK.wishlist.specs));
    // your library is stored on the device
    AsyncStorage.getItem("trdr.library")
      .then((v) => {
        if (active && v) {
          const saved = JSON.parse(v) as ValuedHolding[];
          setHoldings(saved);
          revalueLibrary(saved); // refresh values from the live model on open
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const persistSpecs = (s: WishSpec[]) => AsyncStorage.setItem("trdr.wishlist", JSON.stringify(s)).catch(() => {});
  const addWish = (text: string) => {
    const next = [...specs, parseWish(text, `w-${Date.now()}`)];
    setSpecs(next);
    persistSpecs(next);
    refreshBoard(next);
  };
  // Batch add (the wishlist interview adds several at once) — one state update so
  // they don't clobber each other via a stale `specs` closure.
  const addWishes = (texts: string[]) => {
    const fresh = texts.map((t) => t.trim()).filter(Boolean).map((t, i) => parseWish(t, `w-${Date.now()}-${i}`));
    if (!fresh.length) return;
    const next = [...specs, ...fresh];
    setSpecs(next);
    persistSpecs(next);
    refreshBoard(next);
  };
  const removeWish = (wishId: string) => {
    const next = specs.filter((s) => s.id !== wishId);
    setSpecs(next);
    persistSpecs(next);
    refreshBoard(next);
  };
  const clearWishlist = () => {
    setSpecs([]);
    persistSpecs([]);
    refreshBoard([]);
  };
  const tree = buildWishTree(specs);

  // Library — persisted on the phone (AsyncStorage = localStorage on web).
  // Functional updates so saves can't race a stale `holdings` closure.
  const persistLib = (h: ValuedHolding[]) => AsyncStorage.setItem("trdr.library", JSON.stringify(h)).catch(() => {});
  const addScanned = (valued: ValuedHolding[]) =>
    setHoldings((prev) => {
      // The scanner reuses ids (h-v0, h-v1…) every scan, so the old dedupe-by-id
      // dropped every scan after the first. Stamp a fresh unique id on each.
      const stamp = Date.now();
      const fresh = valued.map((v, i) => ({ ...v, holding: { ...v.holding, id: `h-scan-${stamp}-${i}` } }));
      const next = [...prev, ...fresh];
      persistLib(next);
      return next;
    });
  const addHolding = (text: string) => {
    if (!text.trim()) return;
    setHoldings((prev) => {
      const next = [...prev, { holding: parseHolding(text, `h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`) }];
      persistLib(next);
      revalueLibrary(next); // fetch a live value for the newly added card
      return next;
    });
  };
  const removeHolding = (id: string) =>
    setHoldings((prev) => {
      const next = prev.filter((v) => v.holding.id !== id);
      persistLib(next);
      return next;
    });
  // Edit optional purchase details (price paid / date / where) on a holding.
  const updateHolding = (id: string, patch: Partial<Holding>) =>
    setHoldings((prev) => {
      const next = prev.map((v) => (v.holding.id === id ? { ...v, holding: { ...v.holding, ...patch } } : v));
      persistLib(next);
      revalueLibrary(next); // re-price so unrealized P/L reflects the new cost basis
      return next;
    });

  // Tap-to-open card detail sheet (deals + library cards).
  const [detail, setDetail] = useState<DetailCard | null>(null);

  // Cloud (Clerk) → MERGE the account's saved wishlist/library with what's on the
  // device (union by id). Never replace: a freshly-added card must survive the
  // cloud load even if the cloud copy is empty or arrives late after sign-in.
  const onCloudLoad = (d: { specs?: unknown[]; holdings?: unknown[] }) => {
    if (Array.isArray(d.specs)) {
      const cloud = d.specs as WishSpec[];
      setSpecs((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        const merged = [...prev, ...cloud.filter((s) => s?.id && !seen.has(s.id))];
        persistSpecs(merged);
        refreshBoard(merged);
        return merged;
      });
    }
    if (Array.isArray(d.holdings)) {
      const cloud = d.holdings as ValuedHolding[];
      setHoldings((prev) => {
        const seen = new Set(prev.map((v) => v.holding.id));
        const merged = [...prev, ...cloud.filter((v) => v?.holding?.id && !seen.has(v.holding.id))];
        persistLib(merged);
        revalueLibrary(merged);
        return merged;
      });
    }
  };

  // ── responsive: detect size live (updates on rotate/resize) and adapt ──
  const { width } = useWindowDimensions();
  const kind: "phone" | "tablet" | "wide" = width >= 1000 ? "wide" : width >= 700 ? "tablet" : "phone";
  const columns = kind === "wide" ? 3 : kind === "tablet" ? 2 : 1;
  const maxWidth = kind === "wide" ? 1080 : kind === "tablet" ? 760 : undefined;
  const deviceLabel = kind === "wide" ? "desktop" : kind;

  const tabs: { key: typeof tab; label: string; icon: IconName }[] = [
    { key: "alerts", label: `Deals · ${alerts.length}`, icon: "pricetags-outline" },
    { key: "value", label: "Trade", icon: "swap-horizontal-outline" },
    { key: "library", label: `Library · ${holdings.length}`, icon: "albums-outline" },
    { key: "wishlist", label: `Wishlist · ${hits.length}`, icon: "heart-outline" },
    { key: "scan", label: "Scan", icon: "scan-outline" },
  ];

  // Pull-to-refresh: re-pull deals/wishlist + re-price the library.
  const onRefresh = () => {
    setRefreshing(true);
    refreshBoard(specs);
    revalueLibrary(holdings);
    setTimeout(() => setRefreshing(false), 1200);
  };
  // RN's RefreshControl doesn't work on web (and lets the browser's native
  // pull-to-refresh reload the page). Native gets the pull gesture; web uses the
  // header refresh button below.
  const refreshCtl = Platform.OS === "web" ? undefined : <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} colors={[C.accent]} progressBackgroundColor={C.panel} />;

  // Real eBay market data vs model estimates; real vision backend vs none.
  const marketReal = !!caps.market && caps.market !== "mock";
  const visionReal = !!caps.vision && caps.vision !== "mock";

  const body = (
    <View style={{ width: "100%", maxWidth, alignSelf: "center" }}>
      {tab === "alerts" && <AlertsFeed alerts={alerts} speculative={speculative} watching={watching} columns={columns} pro={pro} onOpenCard={setDetail} loading={!boardLoaded} />}
      {tab === "value" && <QuickValueScreen canScan={visionReal} />}
      {tab === "library" && (
        <LibraryScreen
          holdings={holdings}
          canScan={visionReal}
          scan={FALLBACK.scan}
          onAddScanned={addScanned}
          onAddHolding={addHolding}
          onOpenCard={setDetail}
          onRemove={removeHolding}
          columns={columns}
          pro={pro}
        />
      )}
      {tab === "wishlist" && <WishlistScreen tree={tree} hits={hits} watching={watching} onAdd={addWish} onAddMany={addWishes} onRemoveWish={removeWish} onClear={clearWishlist} onOpenCard={setDetail} columns={columns} pro={pro} />}
      {tab === "scan" && <ScanScreen canScan={visionReal} scan={FALLBACK.scan} onAddScanned={addScanned} onDone={() => setTab("library")} />}
      {tab === "passport" && <PassportScreen passport={passport} pro={pro} />}
      <Text style={styles.foot}>
        {!boardLoaded && API_BASE ? "Loading live data…" : source === "live" ? (marketReal ? "Live sold prices" : "Estimated values") : "Demo data"} · {deviceLabel} layout
        {pro ? ` · ${passport.fairValue.compCount} clean comps` : ""}
      </Text>
    </View>
  );

  const cycleSize = () => setTextScale((s) => (s >= 1.3 ? 1 : s >= 1.15 ? 1.3 : 1.15));
  const header = (
    <View style={styles.header}>
      <Text style={styles.brand}>TRDR</Text>
      {kind !== "phone" ? <Text style={styles.sub}>{plain(pro, "card deals & values", "graded-card mispricing terminal")}</Text> : null}
      <View style={styles.headerControls}>
        <Pressable onPress={onRefresh} style={styles.ctrlChip} accessibilityLabel="Refresh" disabled={refreshing}>
          <Ionicons name="refresh" size={15} color={refreshing ? C.accent : C.muted} />
        </Pressable>
        <AuthButton />
        <Pressable onPress={cycleSize} style={styles.ctrlChip} accessibilityLabel="Text size">
          <Text style={[styles.ctrlText, { fontSize: textScale > 1 ? 15 : 13 }]}>A</Text>
        </Pressable>
        <Pressable onPress={() => setPro((p) => !p)} style={[styles.ctrlChip, pro && styles.ctrlChipOn]}>
          <Text style={[styles.ctrlText, { color: pro ? "#ffffff" : C.muted }]}>{pro ? "Pro" : "Simple"}</Text>
        </Pressable>
        {source === "live" ? (
          <View style={[styles.srcChip, styles.srcLive]}>
            <Text style={[styles.srcText, { color: marketReal ? C.green : C.muted }]}>{marketReal ? "live" : "est"}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  const shell = (inner: ReactNode) => (
    <AuthGate>
      <SafeAreaProvider>
        <ScaleCtx.Provider value={textScale}>
          <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
            <StatusBar style="dark" />
            <CloudSync specs={specs} holdings={holdings} onLoad={onCloudLoad} />
            {header}
            {inner}
            <CardDetailModal card={detail} onClose={() => setDetail(null)} onUpdate={updateHolding} onRemove={removeHolding} />
          </SafeAreaView>
        </ScaleCtx.Provider>
      </SafeAreaProvider>
    </AuthGate>
  );

  // First run: a friendly welcome before the main app.
  if (onboarded === null) return null;
  if (!onboarded) {
    return (
      <SafeAreaProvider>
        <ScaleCtx.Provider value={textScale}>
          <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
            <StatusBar style="dark" />
            <Landing onDone={finishOnboarding} />
          </SafeAreaView>
        </ScaleCtx.Provider>
      </SafeAreaProvider>
    );
  }

  // Wide screens (iPad landscape / desktop): a left sidebar nav + centered content.
  if (kind === "wide") {
    return shell(
      <View style={{ flexDirection: "row", flex: 1 }}>
        <View style={styles.sidebar}>
          {tabs.map((t) => (
            <Pressable key={t.key} style={[styles.sideTab, tab === t.key && styles.sideTabActive]} onPress={() => setTab(t.key)}>
              <Ionicons name={t.icon} size={18} color={tab === t.key ? C.ink : C.muted} />
              <Text style={[styles.sideTabText, tab === t.key && styles.sideTabTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 24 }} refreshControl={refreshCtl}>
          {body}
        </ScrollView>
      </View>,
    );
  }

  // Phone / tablet: content with a bottom tab bar (thumb reach, iOS pattern).
  return shell(
    <>
      <RefreshableScroll refreshing={refreshing} onRefresh={onRefresh} refreshCtl={refreshCtl} style={styles.scroll} contentContainerStyle={{ padding: kind === "tablet" ? 20 : 16, paddingTop: 12 }}>
        {body}
      </RefreshableScroll>
      <View style={styles.bottomBar}>
        {tabs.map((t) => (
          <Pressable key={t.key} style={styles.bottomTab} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
            <Ionicons name={t.icon} size={20} color={tab === t.key ? C.accent : C.muted} />
            <Text style={[styles.bottomTabText, { color: tab === t.key ? C.accent : C.muted }]}>{t.label.split(" · ")[0]}</Text>
          </Pressable>
        ))}
      </View>
    </>,
  );
}

function Landing({ onDone }: { onDone: () => void }) {
  const deals = (FALLBACK.alerts || []).slice(0, 3);
  const edgeOf = (a: Alert) => {
    const p = Number(alertVM(a).predictedClose.replace(/[^0-9.]/g, ""));
    return p > 0 ? (a.fairValue.point - p) / p : 0;
  };
  const props: { icon: IconName; title: string; sub: string }[] = [
    { icon: "trending-up-outline", title: "Underpriced alerts", sub: "Live deals ranked by edge — fair value vs. the asking price, with a buy/watch signal." },
    { icon: "albums-outline", title: "Your collection, valued", sub: "Track every slab like a portfolio: live value, profit/loss, 30-day trend." },
    { icon: "camera-outline", title: "Scan a whole stack", sub: "One photo reads every graded label and adds them for you." },
  ];
  return (
    <ScrollView contentContainerStyle={styles.landWrap}>
      <View style={styles.landHeadRow}>
        <Text style={styles.landBrand}>TRDR</Text>
        <Text style={styles.landTag}>terminal</Text>
      </View>
      <Text style={styles.landTitle}>The terminal for graded cards.</Text>
      <Text style={styles.landSub}>Find underpriced slabs. Track your collection like a portfolio. Built on real eBay comps.</Text>

      <View style={styles.landPanel}>
        <Text style={styles.colH}>Live deals · sample</Text>
        {deals.map((a) => {
          const vm = alertVM(a);
          const e = edgeOf(a);
          const sig = signal(e, a.fairValue.confidence);
          // Tapping a sample deal enters the app — the real, tappable deals (with
          // links to the actual eBay listings) live inside.
          return (
            <Pressable key={a.itemId} style={styles.deal} onPress={onDone}>
              <CardImage uri={a.imageUrl} label={`${a.key.grade}`} size={40} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
                <Text style={styles.dealName} numberOfLines={1}>{vm.title}</Text>
                <Text style={styles.dealMeta} numberOfLines={1}>fv {money(a.fairValue.point)} · ask {vm.predictedClose.replace("$", "")}</Text>
              </View>
              <Text style={[styles.dealEdge, { color: sig.color, marginLeft: 8 }]}>
                {e >= 0 ? "+" : ""}
                {Math.round(e * 100)}%
              </Text>
            </Pressable>
          );
        })}
        <Text style={styles.landDealHint}>Tap a deal to enter the terminal →</Text>
      </View>

      <View style={{ gap: 16, marginTop: 20 }}>
        {props.map((f) => (
          <View key={f.title} style={styles.obRow}>
            <View style={styles.obIcon}>
              <Ionicons name={f.icon} size={20} color={C.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.obRowTitle}>{f.title}</Text>
              <Text style={styles.obRowSub}>{f.sub}</Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable style={[styles.obBtn, { marginTop: 26 }]} onPress={onDone}>
        <Text style={styles.obBtnText}>Enter the terminal →</Text>
      </Pressable>
      <Text style={styles.landFoot}>Free to explore. Sign in (top-right, once inside) to save your wishlist & library across devices.</Text>
    </ScrollView>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

// Pull-to-refresh that works on iOS web (RN's RefreshControl doesn't). Native
// uses the real RefreshControl; web tracks a downward drag at the top of the
// scroll and fires onRefresh, with a small "pull ↓ / release ↑" indicator.
function RefreshableScroll({
  refreshing,
  onRefresh,
  refreshCtl,
  style,
  contentContainerStyle,
  children,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  refreshCtl: ReactElement | undefined;
  style?: object;
  contentContainerStyle?: object;
  children: ReactNode;
}) {
  const atTop = useRef(true);
  const [pull, setPull] = useState(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const refreshingRef = useRef(refreshing);
  refreshingRef.current = refreshing;

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const el = document.getElementById("trdr-pull-wrap");
    if (!el) return;
    let startY: number | null = null;
    const y = (e: TouchEvent) => e.touches?.[0]?.clientY ?? e.changedTouches?.[0]?.clientY ?? null;
    const ts = (e: TouchEvent) => {
      startY = atTop.current ? y(e) : null;
    };
    const tm = (e: TouchEvent) => {
      if (startY == null) return;
      const yy = y(e);
      if (yy == null) return;
      const d = yy - startY;
      setPull(d > 0 ? Math.min(d * 0.5, 80) : 0);
    };
    const te = () => {
      setPull((p) => {
        if (p > 50 && !refreshingRef.current) onRefreshRef.current();
        return 0;
      });
      startY = null;
    };
    el.addEventListener("touchstart", ts, { passive: true });
    el.addEventListener("touchmove", tm, { passive: true });
    el.addEventListener("touchend", te, { passive: true });
    el.addEventListener("touchcancel", te, { passive: true });
    return () => {
      el.removeEventListener?.("touchstart", ts);
      el.removeEventListener?.("touchmove", tm);
      el.removeEventListener?.("touchend", te);
      el.removeEventListener?.("touchcancel", te);
    };
  }, []);

  if (Platform.OS !== "web") {
    return (
      <ScrollView style={style} contentContainerStyle={contentContainerStyle} refreshControl={refreshCtl as never}>
        {children}
      </ScrollView>
    );
  }
  return (
    <View nativeID="trdr-pull-wrap" style={{ flex: 1 }}>
      {pull > 0 || refreshing ? (
        <View style={{ height: refreshing ? 36 : pull, alignItems: "center", justifyContent: "flex-end", paddingBottom: 6 }}>
          <Text style={{ color: C.accent, fontSize: 12, fontFamily: MONO }}>{refreshing ? "refreshing…" : pull > 50 ? "release ↑" : "pull ↓"}</Text>
        </View>
      ) : null}
      <ScrollView
        style={style}
        contentContainerStyle={contentContainerStyle}
        scrollEventThrottle={16}
        onScroll={(e) => {
          atTop.current = (e.nativeEvent.contentOffset?.y ?? 0) <= 0;
        }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** Lays children into N responsive columns (1 column = passthrough). */
function Grid({ columns, children }: { columns: number; children: ReactNode }) {
  if (columns <= 1) return <>{children}</>;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -5 }}>
      {Children.map(children, (child) => (
        <View style={{ width: `${100 / columns}%`, paddingHorizontal: 5 }}>{child}</View>
      ))}
    </View>
  );
}

// Swipe a row LEFT to reveal a red Delete button (the iOS pattern). Works with
// touch on native + mobile web via PanResponder; tap the button to confirm.
function SwipeRow({ children, onDelete, gap = 8 }: { children: ReactNode; onDelete: () => void; gap?: number }) {
  const REVEAL = 84;
  const tx = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const [h, setH] = useState(0);
  const settle = (toValue: number) =>
    Animated.spring(tx, { toValue, useNativeDriver: Platform.OS !== "web", bounciness: 2, speed: 18 }).start();
  const pan = useRef(
    PanResponder.create({
      // Only capture a clear horizontal drag — vertical scroll passes through.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
      onPanResponderMove: (_e, g) => {
        const base = open.current ? -REVEAL : 0;
        tx.setValue(Math.min(0, Math.max(-REVEAL - 28, base + g.dx)));
      },
      onPanResponderRelease: (_e, g) => {
        const o = (open.current ? -REVEAL : 0) + g.dx < -REVEAL / 2;
        open.current = o;
        settle(o ? -REVEAL : 0);
      },
    }),
  ).current;
  return (
    <View style={{ marginBottom: gap }}>
      <View style={[swipe.behind, h ? { height: h } : null]}>
        <Pressable
          style={swipe.del}
          onPress={() => {
            open.current = false;
            settle(0);
            onDelete();
          }}
          accessibilityLabel="Delete"
        >
          <Ionicons name="trash-outline" size={19} color="#ffffff" />
          <Text style={swipe.delText}>Delete</Text>
        </Pressable>
      </View>
      <Animated.View onLayout={(e) => setH(e.nativeEvent.layout.height)} style={{ transform: [{ translateX: tx }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

// Time remaining on an auction, compact.
function timeLeft(endIso?: string): string | null {
  if (!endIso) return null;
  const ms = Date.parse(endIso) - Date.now();
  if (isNaN(ms)) return null;
  if (ms <= 0) return "ended";
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
function confChip(tier: "high" | "med" | "low") {
  return tier === "high" ? { label: "High conf", color: C.green } : tier === "med" ? { label: "Med conf", color: C.amber } : { label: "Low conf", color: C.muted };
}
// Seller chip — probabilistic, never accusatory.
function sellerChip(sr: Alert["sellerRisk"]) {
  if (sr.manipulationRisk >= 0.3) return { label: "Seller: caution", color: C.red };
  if (sr.shrunk || /limited|thin|few|new/i.test(sr.label)) return { label: "Seller: thin history", color: C.amber };
  return { label: "Seller OK", color: C.green };
}

// One ranked edge row. Hero = net edge (after costs); then confidence + seller,
// fair-value band, price/time, and the full identity line. Tap → "why this price".
function DealRow({ a, onOpenCard }: { a: Alert; onOpenCard: (c: DetailCard) => void }) {
  const auction = a.buyingOption === "AUCTION";
  const conf = confChip(a.confidenceTier);
  const sell = sellerChip(a.sellerRisk);
  const tl = timeLeft(a.endTime);
  return (
    <Pressable style={styles.dealCard} onPress={() => onOpenCard({ key: a.key, imageUrl: a.imageUrl, name: a.title, listingUrl: a.deepLink })}>
      <CardImage uri={a.imageUrl} label={`${a.key.grader} ${a.key.grade}`} size={58} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.dealEdgeRow}>
          <Text style={styles.dealEdgeVal}>+${money(a.netEdge)}</Text>
          <Text style={styles.dealEdgePct}>+{Math.round(a.netEdgePct * 100)}%</Text>
          <View style={{ flex: 1 }} />
          <View style={[styles.dealChip, { borderColor: conf.color + "66" }]}>
            <Text style={[styles.dealChipText, { color: conf.color }]}>{conf.label}</Text>
          </View>
        </View>
        <Text style={styles.dealBand} numberOfLines={1}>
          value ${money(a.fairValue.lower)}–${money(a.fairValue.upper)} · sells {a.liquidityTag}
        </Text>
        <Text style={styles.dealPriceLine} numberOfLines={1}>
          {auction
            ? `bid $${money(a.currentPrice)}${a.bidCount ? ` · ${a.bidCount} bids` : ""}${tl ? ` · ${tl} left` : ""} → est close $${money(a.predictedClose)}`
            : `$${money(a.currentPrice)} · Buy It Now`}
        </Text>
        <Text style={styles.dealIdentity} numberOfLines={2}>
          {a.title}
        </Text>
        <View style={[styles.dealChip, styles.dealSellerChip, { borderColor: sell.color + "66" }]}>
          <Text style={[styles.dealChipText, { color: sell.color }]}>{sell.label}</Text>
        </View>
      </View>
    </Pressable>
  );
}

// On-the-spot card valuation: type any card (graded OR raw) → our value band +
// recent sales for graded, and always a one-tap link to real eBay sold prices
// (the reliable universal path — works for raw too). Built for deciding fast.
type TradeLine = { id: string; name: string; market: number | null; value: string; ebay: string; needsReview?: boolean; cropUrl?: string; valuedFor?: string };

function ebaySoldSearch(q: string): string {
  const clean = q.replace(/\b(raw|ungraded)\b/gi, "").replace(/#/g, "").replace(/\s+/g, " ").trim();
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(clean)}&LH_Sold=1&LH_Complete=1&_sop=13`;
}
function nameOfKey(k: CardKey): string {
  return `${k.set ?? ""}${k.number ? ` #${k.number}` : ""}${k.variant ? ` ${k.variant}` : ""} ${k.grader ?? ""} ${k.grade ?? ""}`.replace(/\s+/g, " ").trim();
}

const tv = StyleSheet.create({
  seg: { flexDirection: "row", backgroundColor: C.panel2, borderRadius: 9, padding: 3, borderWidth: 1, borderColor: C.line, marginBottom: 4 },
  segBtn: { flex: 1, paddingVertical: 7, borderRadius: 7, alignItems: "center" },
  segOn: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line },
  segText: { color: C.muted, fontSize: 13, fontWeight: "600" },
  segTextOn: { color: C.ink },
  reviewBanner: { color: C.amber, fontSize: 12, marginTop: 12, lineHeight: 17 },
  reviewCard: { borderColor: C.amber, borderWidth: 1.5 },
  crop: { width: 34, height: 34, borderRadius: 6, backgroundColor: C.panel2 },
  nameInput: { color: C.ink, fontSize: 14, fontWeight: "600", paddingVertical: 2 },
  summary: { marginTop: 14, padding: 12, borderRadius: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line },
  verdict: { fontSize: 15, fontWeight: "700", marginTop: 10, textAlign: "center" },
});

// Two-sided trade evaluator. Snap (or type) the cards on each side — Selling (what
// you give up) and Buying (what you'd get) — we value each on the grounded recent-
// sales path and tell you if the trade favours you. Anything the scanner isn't sure
// about lands on an amber row asking you to confirm what the card is.
function QuickValueScreen({ canScan }: { canScan: boolean }) {
  const [side, setSide] = useState<"selling" | "buying">("selling");
  const [selling, setSelling] = useState<TradeLine[]>([]);
  const [buying, setBuying] = useState<TradeLine[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const lines = side === "selling" ? selling : buying;
  const setLines = side === "selling" ? setSelling : setBuying;
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Market value = median of ACTUAL recent sales (graded only); raw → no value.
  const valueOf = async (q: string): Promise<number | null> => {
    const graded = /\b(PSA|CGC|SGC|BGS)\b/i.test(q) && /\b(10|9\.5|9|8\.5|8|7|6|5)\b/.test(q) && !/\b(raw|ungraded)\b/i.test(q);
    if (!graded || !API_BASE) return null;
    try {
      const key = parseHolding(q, "qv").key;
      const r = await fetch(`${API_BASE}/api/v1/card/detail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
      const d = r.ok ? await r.json() : {};
      const prices = ((d.comps ?? []) as { price: number }[]).map((c) => c.price).filter((p) => p > 0).sort((a, b) => a - b);
      return prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null;
    } catch {
      return null;
    }
  };

  const addManual = async () => {
    const q = text.trim();
    if (!q) return;
    setText("");
    setScanMsg(null);
    setBusy(true);
    const market = await valueOf(q);
    setLines((p) => [...p, { id: `m-${Date.now()}-${p.length}`, name: q, market, value: market != null ? String(Math.round(market)) : "", ebay: ebaySoldSearch(q), needsReview: market == null, valuedFor: q }]);
    setBusy(false);
  };

  const snap = async () => {
    if (!API_BASE) {
      setScanMsg("Scanner isn't reachable right now — type the card above instead.");
      return;
    }
    const img = await pickImageWeb();
    if (!img) return; // user cancelled the picker
    setBusy(true);
    setScanMsg("Reading your photo… this can take a few seconds.");
    try {
      const r = await fetch(`${API_BASE}/api/v1/library/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: { base64: img.base64, mediaType: img.mediaType } }) });
      if (!r.ok) {
        setScanMsg("Couldn't read that photo (scanner error). Try again, or type the card above.");
      } else {
        const s = (await r.json()) as Scan;
        // Confident reads → value each on the same grounded path as a type-in.
        const confident = await Promise.all(
          (s.valued ?? []).map(async (v, i): Promise<TradeLine> => {
            const name = nameOfKey(v.holding.key);
            const market = await valueOf(name);
            return { id: `s-${Date.now()}-${i}`, name, market, value: market != null ? String(Math.round(market)) : "", ebay: ebaySoldSearch(name), needsReview: market == null, valuedFor: name };
          }),
        );
        // Uncertain reads → ask the user to confirm what the card is.
        const unsure: TradeLine[] = (s.review ?? []).map((rv, i) => ({
          id: `r-${Date.now()}-${i}`,
          name: "",
          market: null,
          value: "",
          ebay: "",
          needsReview: true,
          cropUrl: rv.detection.cropUrl,
        }));
        if (confident.length || unsure.length) {
          setLines((p) => [...p, ...confident, ...unsure]);
          setScanMsg(null);
        } else {
          // Found nothing — say so instead of silently doing nothing. The reader
          // only knows GRADED slabs today; raw cards must be typed.
          setScanMsg("No graded slabs found in that photo. Raw (ungraded) cards can't be auto-read yet — type the card name above. For slabs, try a clearer, straight-on shot.");
        }
      }
    } catch {
      setScanMsg("Couldn't reach the scanner — check your connection, or type the card above.");
    }
    setBusy(false);
  };

  // Re-identify a line after its name is edited — turns an amber "needs confirming"
  // row into a valued one, and re-prices any correction.
  const reValue = async (id: string) => {
    const li0 = linesRef.current.find((x) => x.id === id);
    const q = (li0?.name ?? "").trim();
    if (!q || li0?.valuedFor === q) return; // unchanged → don't re-look-up / clobber a manual value
    const market = await valueOf(q);
    setLines((p) => p.map((li) => (li.id === id ? { ...li, market, value: market != null ? String(Math.round(market)) : "", ebay: ebaySoldSearch(q), needsReview: market == null, valuedFor: q } : li)));
  };
  const setName = (id: string, v: string) => setLines((p) => p.map((li) => (li.id === id ? { ...li, name: v } : li)));
  const setValue = (id: string, v: string) => setLines((p) => p.map((li) => (li.id === id ? { ...li, value: v.replace(/[^0-9.]/g, "") } : li)));
  const removeLine = (id: string) => setLines((p) => p.filter((li) => li.id !== id));

  const total = (arr: TradeLine[]) => arr.reduce((s, li) => s + (Number(li.value) || li.market || 0), 0);
  const sellTotal = total(selling);
  const buyTotal = total(buying);
  const net = buyTotal - sellTotal; // you GET buying, GIVE selling
  const both = selling.length > 0 && buying.length > 0;
  const verdict = both
    ? net > 1
      ? { label: `Good trade — you gain $${money(net)}`, color: C.green }
      : net < -1
        ? { label: `You'd give up $${money(-net)} more than you get`, color: C.red }
        : { label: "Even trade", color: C.amber }
    : null;
  const reviewCount = lines.filter((li) => li.needsReview).length;

  return (
    <View>
      <Text style={styles.colH}>Trade evaluator</Text>
      <Text style={styles.qvHint}>Snap the cards on each side — Selling (what you give up) and Buying (what you'd get). We value each and tell you if the trade's fair. Anything we're unsure of, we ask you to confirm.</Text>

      <View style={tv.seg}>
        <Pressable style={[tv.segBtn, side === "selling" && tv.segOn]} onPress={() => setSide("selling")}>
          <Text style={[tv.segText, side === "selling" && tv.segTextOn]}>Selling · {selling.length}</Text>
        </Pressable>
        <Pressable style={[tv.segBtn, side === "buying" && tv.segOn]} onPress={() => setSide("buying")}>
          <Text style={[tv.segText, side === "buying" && tv.segTextOn]}>Buying · {buying.length}</Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
        <TextInput value={text} onChangeText={setText} onSubmitEditing={addManual} returnKeyType="done" autoCapitalize="none" placeholder="type a card, or snap →" placeholderTextColor={C.muted} style={[styles.input, { flex: 1 }]} />
        <Pressable style={styles.addBtn} onPress={addManual}>
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>
      {canScan ? (
        <Pressable style={[styles.scanBtnAlt, { marginTop: 8, flexDirection: "row", justifyContent: "center", gap: 6 }]} onPress={snap}>
          <Ionicons name="camera-outline" size={16} color={C.accent} />
          <Text style={styles.scanBtnAltText}>Snap cards you're {side}</Text>
        </Pressable>
      ) : null}
      {busy ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 }}>
          <ActivityIndicator color={C.accent} />
          {scanMsg ? <Text style={[styles.hint, { flex: 1 }]}>{scanMsg}</Text> : null}
        </View>
      ) : scanMsg ? (
        <Text style={[styles.qvHint, { marginTop: 12 }]}>{scanMsg}</Text>
      ) : null}

      {reviewCount > 0 ? (
        <Text style={tv.reviewBanner}>
          ⚠ {reviewCount} card{reviewCount > 1 ? "s" : ""} need confirming — type the name on the amber row{reviewCount > 1 ? "s" : ""} so we can value {reviewCount > 1 ? "them" : "it"}.
        </Text>
      ) : null}

      {lines.length === 0 ? (
        <Text style={[styles.hint, { marginTop: 14 }]}>Nothing on the {side} side yet. Snap a photo or type a card above.</Text>
      ) : (
        lines.map((li) => (
          <View key={li.id} style={[styles.itemCard, { flexDirection: "column", alignItems: "stretch" }, li.needsReview ? tv.reviewCard : null]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {li.cropUrl ? <Image source={{ uri: li.cropUrl }} style={tv.crop} /> : null}
              <TextInput
                value={li.name}
                onChangeText={(t) => setName(li.id, t)}
                onSubmitEditing={() => reValue(li.id)}
                onBlur={() => reValue(li.id)}
                autoCapitalize="words"
                placeholder={li.needsReview ? "What card is this? e.g. 2018 Prizm Luka Silver PSA 10" : "card name"}
                placeholderTextColor={C.muted}
                style={[tv.nameInput, { flex: 1 }]}
              />
              <Pressable onPress={() => removeLine(li.id)} hitSlop={10} accessibilityLabel="Remove">
                <Ionicons name="close-circle" size={19} color={C.muted} />
              </Pressable>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 }}>
              <Text style={styles.cardSub}>{li.market != null ? `market $${money(li.market)}` : li.needsReview ? "needs confirming" : "no value"}</Text>
              <Text style={styles.tradePriceLbl}>value $</Text>
              <TextInput value={li.value} onChangeText={(t) => setValue(li.id, t)} keyboardType="numeric" placeholder="0" placeholderTextColor={C.muted} style={styles.tradePriceInput} />
            </View>
            {li.name.trim() ? (
              <Pressable onPress={() => openExternal(li.ebay || ebaySoldSearch(li.name))} style={{ marginTop: 6 }}>
                <Text style={{ color: C.accent, fontSize: 12 }}>See sold on eBay →</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      {selling.length > 0 || buying.length > 0 ? (
        <View style={tv.summary}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={styles.tradeTotalLbl}>Selling (you give)</Text>
            <Text style={styles.tradeTotalVal}>${money(sellTotal)}</Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
            <Text style={styles.tradeTotalLbl}>Buying (you get)</Text>
            <Text style={styles.tradeTotalVal}>${money(buyTotal)}</Text>
          </View>
          {verdict ? (
            <Text style={[tv.verdict, { color: verdict.color }]}>{verdict.label}</Text>
          ) : (
            <Text style={[styles.cardSub, { marginTop: 8, textAlign: "center" }]}>Add cards to the other side to compare the trade.</Text>
          )}
          <Pressable
            onPress={() => {
              setSelling([]);
              setBuying([]);
            }}
            style={{ alignSelf: "center", marginTop: 10 }}
          >
            <Text style={{ color: C.muted, fontSize: 12 }}>Clear all</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function AlertsFeed({ alerts, speculative, watching, columns, pro, onOpenCard, loading }: { alerts: Alert[]; speculative: Alert[]; watching: WatchedCard[]; columns: number; pro: boolean; onOpenCard: (c: DetailCard) => void; loading: boolean }) {
  void pro;
  return (
    <View>
      <View style={styles.feedHead}>
        <Text style={styles.colH}>Deals</Text>
        {alerts.length > 0 ? <Text style={styles.feedMeta}>{alerts.length} · ranked by net edge</Text> : null}
      </View>
      {/* Confident deals only here — net edge > 0 after costs AND confidence gate.
          Thin/low-confidence go to "Speculative" below; never mixed in. */}
      {alerts.length === 0 ? (
        <View style={styles.emptyBox}>
          {loading ? <ActivityIndicator color={C.accent} /> : null}
          <Text style={styles.emptyText}>
            {loading
              ? "Finding cards priced under market value…"
              : speculative.length || watching.length
                ? "No confident deals right now — see speculative picks and your tracked cards below."
                : "No deals yet. Add cards to your wishlist to start tracking them."}
          </Text>
        </View>
      ) : (
        <Grid columns={columns}>
          {alerts.map((a) => (
            <DealRow key={a.itemId} a={a} onOpenCard={onOpenCard} />
          ))}
        </Grid>
      )}

      {speculative.length > 0 ? (
        <>
          <Text style={[styles.colH, { marginTop: 22 }]}>Speculative · thin data</Text>
          <Text style={styles.specNote}>Real positive edge, but few or older sales — verify before buying.</Text>
          <Grid columns={columns}>
            {speculative.map((a) => (
              <DealRow key={a.itemId} a={a} onOpenCard={onOpenCard} />
            ))}
          </Grid>
        </>
      ) : null}

      {watching.length > 0 ? (
        <>
          <Text style={[styles.colH, { marginTop: 22 }]}>Watching · {watching.length}</Text>
          <Grid columns={columns}>
            {[...watching]
              .sort((a, b) => (watchEdge(b) ?? -999) - (watchEdge(a) ?? -999))
              .map((w, i) => (
                <WatchCard key={`${w.key.set}-${w.key.number}-${i}`} w={w} onOpenCard={onOpenCard} />
              ))}
          </Grid>
        </>
      ) : null}
    </View>
  );
}

// How a watched card's cheapest current listing compares to its market value.
function watchEdge(w: WatchedCard): number | null {
  const fv = w.fairValue?.point ?? 0;
  const ask = w.lowestAsk ?? 0;
  return fv > 0 && ask > 0 ? Math.round((1 - ask / fv) * 100) : null;
}

function WatchCard({ w, onOpenCard }: { w: WatchedCard; onOpenCard: (c: DetailCard) => void }) {
  const k = w.key;
  const name = `${k.set}${k.number ? ` #${k.number}` : ""}${k.variant ? ` ${k.variant}` : ""}`;
  const fv = w.fairValue?.point ?? 0;
  const ask = w.lowestAsk ?? 0;
  const edge = watchEdge(w);
  return (
    <Pressable style={styles.itemCard} onPress={() => onOpenCard({ key: k, imageUrl: w.imageUrl, name })}>
      <CardImage uri={w.imageUrl} label={`${k.grader} ${k.grade}`} size={46} />
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.cardSub} numberOfLines={1}>
          {k.grader} {k.grade} · value ${money(fv)}
        </Text>
        <View style={styles.cardPriceRow}>
          <Text style={styles.cardPrice}>{ask > 0 ? `$${money(ask)}` : fv > 0 ? `$${money(fv)}` : "—"}</Text>
          {edge != null && edge > 0 ? (
            <View style={styles.underPill}>
              <Text style={styles.underPillText}>{edge}% under</Text>
            </View>
          ) : edge != null && edge < 0 ? (
            <Text style={styles.cardSub}>{Math.abs(edge)}% over value</Text>
          ) : ask > 0 ? (
            <Text style={styles.cardSub}>lowest ask</Text>
          ) : (
            <Text style={styles.cardSub}>market value</Text>
          )}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={16} color={C.muted} style={{ alignSelf: "center" }} />
    </Pressable>
  );
}

function PassportScreen({ passport: p, pro }: { passport: Passport; pro: boolean }) {
  const fv = fairValueVM(p.fairValue as never);
  const span = p.fairValue.upper - p.fairValue.lower || 1;
  const pointPct = ((p.fairValue.point - p.fairValue.lower) / span) * 100;
  const confTone = tone(fv.confidenceTone);
  const sure = sureness(p.fairValue.confidence);
  const liq = p.fairValue.liquidity;
  const sellsOften = liq >= 0.5 ? "often" : liq > 0.15 ? "sometimes" : "rarely";

  return (
    <View>
      <Text style={styles.colH}>{plain(pro, "About this card", "Card passport")}</Text>
      <View style={styles.passport}>
        <View style={styles.ppHeader}>
          <CardImage uri={p.imageUrl} label={`${p.key.grader} ${p.key.grade}`} size={76} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={styles.ppGradeRow}>
              <View style={styles.gradeChip}>
                <Text style={styles.gradeChipText}>
                  {p.key.grader} {p.key.grade}
                </Text>
              </View>
              <View style={styles.verified}>
                <Text style={styles.verifiedText}>verified slab</Text>
              </View>
            </View>
            <Text style={styles.ppName}>
              {p.key.set} #{p.key.number}
              {p.key.variant ? ` ${p.key.variant}` : ""}
            </Text>
            <Text style={styles.ppCert}>cert {p.cert ?? "—"}</Text>
          </View>
        </View>
        <Text style={styles.ppPoint}>
          {fv.point} <Text style={styles.ppPointSmall}>{plain(pro, "what it's worth", "fair value")}</Text>
        </Text>

        <View style={styles.band}>
          <View style={[styles.bandPt, { left: `${pointPct}%` }]} />
        </View>
        <View style={styles.bandLbls}>
          <Text style={styles.bandLbl}>{fv.range.split(" – ")[0]}</Text>
          <Text style={styles.bandLbl}>{plain(pro, "what it's worth", "80% band")}</Text>
          <Text style={styles.bandLbl}>{fv.range.split(" – ")[1]}</Text>
        </View>

        <View style={styles.meter}>
          <View style={[styles.meterFill, { width: `${Math.round(p.fairValue.confidence * 100)}%`, backgroundColor: confTone }]} />
        </View>
        <View style={styles.bandLbls}>
          <Text style={styles.bandLbl}>{plain(pro, "how sure", "confidence")}</Text>
          <Text style={[styles.bandLbl, { color: confTone }]}>{plain(pro, `${sure.dots}  ${sure.label}`, fv.confidence)}</Text>
        </View>

        <View style={styles.stats}>
          <BigStat value={`${p.fairValue.compCount}`} label={plain(pro, "recent sales", "clean comps")} />
          <BigStat value={plain(pro, sellsOften, `${liq.toFixed(2)}/day`)} label={plain(pro, "how often it sells", "liquidity")} />
          <BigStat value={p.pop ? `${p.pop.atGrade}` : "—"} label={plain(pro, "how rare", "pop @ grade")} />
        </View>

        <View style={styles.histHead}>
          <Text style={[styles.histH, { flex: 2 }]}>recent sale</Text>
          <Text style={[styles.histH, { flex: 1, textAlign: "right" }]}>price</Text>
          <Text style={[styles.histH, { flex: 2 }]}>type</Text>
        </View>
        {p.recent.map((r, i) => (
          <View key={i} style={styles.histRow}>
            <Text style={[styles.histCell, { flex: 2 }]}>{r.date}</Text>
            <Text style={[styles.histCell, { flex: 1, textAlign: "right" }]}>${r.price}</Text>
            <Text style={[styles.histCell, { flex: 2, color: C.muted, fontSize: 11 }]}>{r.type}</Text>
          </View>
        ))}

        <Text style={styles.ppFoot}>
          {plain(
            pro,
            "We estimate value from recent real sales, and only show deals we're confident about.",
            "Distribution, not a number. Band reflects sale dispersion; confidence reflects comp depth, tightness & liquidity. Qualified copies segregated; lots, shill wins & relists dropped before estimating.",
          )}
        </Text>
      </View>
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statLbl}>{label}</Text>
      <Text style={[styles.statVal, color ? { color } : null]}>{value}</Text>
    </View>
  );
}
function BigStat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.bigStat}>
      <Text style={styles.bigStatV}>{value}</Text>
      <Text style={styles.bigStatL}>{label}</Text>
    </View>
  );
}

function WishlistScreen({ tree, hits, watching, onAdd, onAddMany, onRemoveWish, onClear, onOpenCard, columns, pro }: { tree: WishNode; hits: WishHit[]; watching: WatchedCard[]; onAdd: (t: string) => void; onAddMany: (t: string[]) => void; onRemoveWish: (id: string) => void; onClear: () => void; onOpenCard: (c: DetailCard) => void; columns: number; pro: boolean }) {
  const [text, setText] = useState("");
  const [iv, setIv] = useState(false);
  const submit = () => {
    const t = text.trim();
    if (t) {
      onAdd(t);
      setText("");
    }
  };
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <Text style={[styles.colH, { marginBottom: 0 }]}>Your wishlist</Text>
        {tree.children.length > 0 ? (
          <Pressable onPress={onClear} style={styles.clearBtn} hitSlop={8}>
            <Ionicons name="trash-outline" size={14} color={C.red} />
            <Text style={styles.clearBtnText}>Clear all</Text>
          </Pressable>
        ) : null}
      </View>
      {iv ? (
        <WishlistInterview
          onClose={() => setIv(false)}
          onBuild={(ws) => {
            onAddMany(ws);
            setIv(false);
          }}
        />
      ) : (
        <>
          <Pressable style={styles.buildBtn} onPress={() => setIv(true)}>
            <Ionicons name="sparkles-outline" size={16} color="#ffffff" />
            <Text style={styles.buildBtnText}>Build my wishlist</Text>
          </Pressable>
          <View style={[styles.addRow, { marginTop: 8 }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              onSubmitEditing={submit}
              returnKeyType="done"
              placeholder="…or add one — e.g. Jordan Fleer PSA 9"
              placeholderTextColor={C.muted}
              style={styles.input}
            />
            <Pressable style={styles.addBtn} onPress={submit}>
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          </View>
        </>
      )}

      {watching.length > 0 ? (
        <>
          <Text style={[styles.colH, { marginTop: 20 }]}>Cards you're tracking · {watching.length}</Text>
          <Grid columns={columns}>
            {[...watching]
              .sort((a, b) => (watchEdge(b) ?? -999) - (watchEdge(a) ?? -999))
              .map((w, i) => (
                <WatchCard key={`${w.key.set}-${w.key.number}-${i}`} w={w} onOpenCard={onOpenCard} />
              ))}
          </Grid>
        </>
      ) : null}

      <View style={[styles.treeBox, { marginTop: 18 }]}>
        {tree.children.map((c) => (
          <TreeNodeView key={c.id} node={c} depth={0} hits={hits} onRemoveWish={onRemoveWish} />
        ))}
      </View>

      <Text style={[styles.colH, { marginTop: 22 }]}>{plain(pro, "Worth a look", "Worth checking out")} · {hits.length}</Text>
      {hits.length === 0 ? (
        <Text style={styles.hint}>The background scan hasn't surfaced anything yet.</Text>
      ) : (
        <Grid columns={columns}>
          {hits.map((h) => <HitCard key={h.itemId} hit={h} />)}
        </Grid>
      )}
    </View>
  );
}

function IChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.ivChip, on && styles.ivChipOn]}>
      <Text style={[styles.ivChipText, on && styles.ivChipTextOn]}>{label}</Text>
    </Pressable>
  );
}

// Tap-through + free-text wishlist setup. Builds plain wish strings the existing
// parseWish() understands, then hands them up as a batch.
function WishlistInterview({ onBuild, onClose }: { onBuild: (wishes: string[]) => void; onClose: () => void }) {
  const CATS = ["Basketball", "Football", "Baseball", "Pokémon", "Soccer", "Hockey", "F1 / racing", "Other"];
  const GRADES = ["PSA 10", "PSA 9+", "Any grade"];
  const [cats, setCats] = useState<string[]>([]);
  const [grade, setGrade] = useState("PSA 10");
  const [extra, setExtra] = useState("");
  const toggle = (c: string) => setCats((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const ready = cats.length > 0 || extra.trim().length > 0;
  const build = () => {
    const g = grade === "Any grade" ? "" : grade;
    const wishes: string[] = [];
    for (const c of cats) wishes.push(`${c} ${g}`.trim());
    for (const line of extra.split(/[\n,]+/)) if (line.trim()) wishes.push(line.trim());
    onBuild(wishes);
  };
  return (
    <View style={styles.interview}>
      <Text style={styles.ivStep}>What do you collect?</Text>
      <View style={styles.chipWrap}>
        {CATS.map((c) => (
          <IChip key={c} label={c} on={cats.includes(c)} onPress={() => toggle(c)} />
        ))}
      </View>
      <Text style={[styles.ivStep, { marginTop: 14 }]}>Grades you care about</Text>
      <View style={styles.chipWrap}>
        {GRADES.map((g) => (
          <IChip key={g} label={g} on={grade === g} onPress={() => setGrade(g)} />
        ))}
      </View>
      <Text style={[styles.ivStep, { marginTop: 14 }]}>Anything specific? (optional)</Text>
      <TextInput
        value={extra}
        onChangeText={setExtra}
        multiline
        placeholder={"players, sets, cards — one per line, e.g.\nany Charizard under $400\n2018 Prizm Luka PSA 10"}
        placeholderTextColor={C.muted}
        style={[styles.input, { height: 78, paddingTop: 9, textAlignVertical: "top" }]}
      />
      <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
        <Pressable style={styles.scanCancel} onPress={onClose}>
          <Text style={styles.scanCancelText}>Cancel</Text>
        </Pressable>
        <Pressable style={[styles.scanAdd, !ready && { opacity: 0.5 }]} onPress={ready ? build : undefined} disabled={!ready}>
          <Text style={styles.scanAddText}>Build wishlist</Text>
        </Pressable>
      </View>
    </View>
  );
}

function TreeNodeView({ node, depth, hits, onRemoveWish }: { node: WishNode; depth: number; hits: WishHit[]; onRemoveWish: (id: string) => void }) {
  const isLeaf = !!node.wishId;
  const n = isLeaf ? hits.filter((h) => h.wishId === node.wishId).length : 0;
  const row = (
    <View style={[styles.treeRow, { paddingLeft: 4 + depth * 16 }]}>
      <Text style={[styles.treeLabel, isLeaf ? styles.treeLeaf : null]}>
        {isLeaf ? "◆ " : "› "}
        {node.label}
      </Text>
      {isLeaf && n > 0 ? (
        <View style={styles.hitBadge}>
          <Text style={styles.hitBadgeText}>{n}</Text>
        </View>
      ) : null}
      {isLeaf && node.wishId ? (
        <Pressable onPress={() => onRemoveWish(node.wishId as string)} hitSlop={12} style={{ marginLeft: "auto", paddingLeft: 8 }} accessibilityLabel="Remove wish">
          <Ionicons name="close-circle" size={19} color={C.muted} />
        </Pressable>
      ) : null}
    </View>
  );
  return (
    <View>
      {/* A wish (leaf) can be swiped left to delete, or tap the ✕. */}
      {isLeaf && node.wishId ? (
        <SwipeRow gap={0} onDelete={() => onRemoveWish(node.wishId as string)}>
          {row}
        </SwipeRow>
      ) : (
        row
      )}
      {node.children.map((c) => (
        <TreeNodeView key={c.id} node={c} depth={depth + 1} hits={hits} onRemoveWish={onRemoveWish} />
      ))}
    </View>
  );
}

function tagColor(t: string): string {
  if (t === "good value") return C.green;
  if (t === "over budget") return C.red;
  if (t === "under budget") return C.muted;
  return C.accent; // low pop / sleeper / gem grade / rare variant
}

function HitCard({ hit }: { hit: WishHit }) {
  const fv = hit.fairBand?.point ?? 0;
  const under = fv > 0 && hit.currentPrice > 0 ? Math.round((1 - hit.currentPrice / fv) * 100) : 0;
  return (
    <Pressable style={styles.itemCard} onPress={() => openExternal(hit.deepLink)}>
      <CardImage uri={hit.imageUrl} label={hit.buyingOption === "AUCTION" ? "Auction" : "BIN"} size={46} />
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {hit.title}
        </Text>
        <Text style={styles.cardSub} numberOfLines={1}>
          {hit.buyingOption === "AUCTION" ? "Auction" : "Buy It Now"}
          {fv > 0 ? ` · value $${money(fv)}` : ""}
        </Text>
        <View style={styles.cardPriceRow}>
          <Text style={styles.cardPrice}>${money(hit.currentPrice)}</Text>
          {under > 0 ? (
            <View style={styles.underPill}>
              <Text style={styles.underPillText}>{under}% under value</Text>
            </View>
          ) : null}
        </View>
      </View>
      <Ionicons name="open-outline" size={15} color={C.muted} style={{ alignSelf: "center" }} />
    </Pressable>
  );
}

type DetailCard = { id?: string; key: CardKey; imageUrl?: string; name: string; isOwned?: boolean; holding?: Holding; listingUrl?: string };

// Tap-to-open card detail: photo, value band, price sparkline, recent sold comps,
// eBay link, and (for owned cards) purchase details + remove.
function CardDetailModal({
  card,
  onClose,
  onUpdate,
  onRemove,
}: {
  card: DetailCard | null;
  onClose: () => void;
  onUpdate?: (id: string, patch: Partial<Holding>) => void;
  onRemove?: (id: string) => void;
}) {
  const [data, setData] = useState<{ fairValue?: { point: number; lower: number; upper: number; confidence: number; compCount: number }; comps?: { price: number; soldAt: string; title?: string; saleType?: string }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [paid, setPaid] = useState("");
  const [date, setDate] = useState("");
  const [where, setWhere] = useState("");

  useEffect(() => {
    if (!card) return;
    setData(null);
    setPaid(card.holding?.acquiredPrice != null ? String(card.holding.acquiredPrice) : "");
    setDate(card.holding?.acquiredAt ?? "");
    setWhere(card.holding?.acquiredFrom ?? "");
    if (!API_BASE) return;
    let active = true;
    setLoading(true);
    fetch(`${API_BASE}/api/v1/card/detail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: card.key }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d) => active && setData(d))
      .catch(() => active && setData({ comps: [] }))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [card]);

  if (!card) return null;
  const k = card.key;
  const fv = data?.fairValue;
  const comps = data?.comps ?? [];
  const ebay = ebaySoldUrl(card.name, k.grader, k.grade, comps[0]?.title);
  const series = comps.map((c) => c.price).filter((p) => p > 0).reverse();
  const max = Math.max(1, ...series);
  const min = series.length ? Math.min(...series) : 0;
  const saveEdit = () => {
    if (!card.id || !onUpdate) return;
    const n = paid.trim() ? Number(paid.replace(/[^0-9.]/g, "")) : undefined;
    onUpdate(card.id, { acquiredPrice: n != null && Number.isFinite(n) ? n : undefined, acquiredAt: date.trim() || undefined, acquiredFrom: where.trim() || undefined });
    onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={cd.backdrop} onPress={onClose} />
      <View style={cd.sheet}>
        <View style={cd.handle} />
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 14, marginBottom: 4 }}>
            <CardImage uri={card.imageUrl} label={`${k.grader} ${k.grade}`} size={84} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={cd.name}>{card.name}</Text>
              <View style={cd.gradeChip}>
                <Text style={cd.gradeChipText}>
                  {k.grader} {k.grade}
                  {k.variant ? ` · ${k.variant}` : ""}
                </Text>
              </View>
              <Text style={cd.value}>{fv ? `$${Math.round(fv.point).toLocaleString()}` : loading ? "…" : "—"}</Text>
              {fv ? (
                <Text style={cd.band}>
                  ${Math.round(fv.lower).toLocaleString()} – ${Math.round(fv.upper).toLocaleString()} · {sureness(fv.confidence).dots} · {fv.compCount} comps
                </Text>
              ) : null}
            </View>
          </View>

          {series.length > 1 ? (
            <View style={cd.spark}>
              {series.map((p, i) => (
                <View key={i} style={[cd.sparkBar, { height: 5 + ((p - min) / (max - min || 1)) * 30 }]} />
              ))}
            </View>
          ) : null}

          <Text style={cd.section}>Why this value — recent sold</Text>
          {comps.length > 0 ? (
            <Text style={cd.whyLine}>
              Built from {comps.length} sale{comps.length === 1 ? "" : "s"}
              {comps.length > 1 ? ` · ${comps[comps.length - 1].soldAt.slice(0, 10)} → ${comps[0].soldAt.slice(0, 10)}` : ""} (lots, autos, wrong parallels excluded)
            </Text>
          ) : null}
          {comps.length === 0 ? (
            <Text style={cd.empty}>{loading ? "Loading sold comps…" : "No sold-price data for this exact card yet — tap “See sold on eBay” below to check."}</Text>
          ) : (
            comps.slice(0, 12).map((c, i) => {
              const auction = c.saleType === "auction-close";
              return (
                <View key={i} style={cd.compRow}>
                  <Text style={cd.compDate}>{c.soldAt.slice(0, 10)}</Text>
                  <View style={[cd.compType, { borderColor: auction ? C.accent : C.line }]}>
                    <Text style={[cd.compTypeText, { color: auction ? C.accent : C.muted }]}>{auction ? "auction" : "BIN"}</Text>
                  </View>
                  <Text style={cd.compTitle} numberOfLines={1}>{c.title || ""}</Text>
                  <Text style={cd.compPrice}>${Math.round(c.price).toLocaleString()}</Text>
                </View>
              );
            })
          )}

          {card.isOwned && onUpdate ? (
            <View style={cd.editBox}>
              <Text style={cd.section}>Your purchase</Text>
              <View style={cd.editRow}>
                <Text style={cd.editLabel}>Price paid</Text>
                <TextInput value={paid} onChangeText={setPaid} keyboardType="numeric" placeholder="$ — optional" placeholderTextColor={C.muted} style={cd.editInput} />
              </View>
              <View style={cd.editRow}>
                <Text style={cd.editLabel}>Date</Text>
                <TextInput value={date} onChangeText={setDate} placeholder="optional" placeholderTextColor={C.muted} style={cd.editInput} />
              </View>
              <View style={cd.editRow}>
                <Text style={cd.editLabel}>Where</Text>
                <TextInput value={where} onChangeText={setWhere} autoCapitalize="words" placeholder="optional" placeholderTextColor={C.muted} style={cd.editInput} />
              </View>
              <Pressable style={cd.saveBtn} onPress={saveEdit}>
                <Text style={cd.saveText}>Save details</Text>
              </Pressable>
            </View>
          ) : null}

          {/* For a live deal, the listing URL is the actual auction to buy. */}
          {card.listingUrl ? (
            <Pressable style={[cd.cta, { marginTop: 16 }]} onPress={() => openExternal(card.listingUrl as string)}>
              <Text style={cd.ctaText}>View this listing on eBay →</Text>
            </Pressable>
          ) : null}
          <View style={{ flexDirection: "row", gap: 9, marginTop: card.listingUrl ? 9 : 16 }}>
            <Pressable style={card.listingUrl ? cd.ctaAlt : cd.cta} onPress={() => openExternal(ebay)}>
              <Text style={card.listingUrl ? cd.ctaAltText : cd.ctaText}>See sold on eBay →</Text>
            </Pressable>
            {card.isOwned && card.id && onRemove ? (
              <Pressable style={cd.removeBtn} onPress={() => { onRemove(card.id as string); onClose(); }} accessibilityLabel="Remove card">
                <Ionicons name="trash-outline" size={18} color={C.red} />
              </Pressable>
            ) : null}
          </View>
          <Pressable onPress={onClose}>
            <Text style={cd.close}>Close</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const swipe = StyleSheet.create({
  behind: { position: "absolute", top: 0, right: 0, width: 84, backgroundColor: C.red, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  del: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center", gap: 2 },
  delText: { color: "#ffffff", fontSize: 11, fontWeight: "600" },
});

const cd = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "88%", backgroundColor: "#ffffff", borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderColor: "#e6e8eb", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#d4d7dc", alignSelf: "center", marginBottom: 14 },
  name: { color: C.ink, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  gradeChip: { alignSelf: "flex-start", marginTop: 7, borderWidth: 1, borderColor: "#b5d4f4", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  gradeChipText: { color: C.accent, fontFamily: MONO, fontSize: 11 },
  value: { color: C.ink, fontFamily: MONO, fontSize: 21, fontWeight: "600", marginTop: 9 },
  band: { color: C.muted, fontFamily: MONO, fontSize: 11, marginTop: 2 },
  spark: { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 40, marginTop: 14, marginBottom: 6 },
  sparkBar: { flex: 1, backgroundColor: C.green, borderRadius: 1, minHeight: 4, opacity: 0.85 },
  section: { color: C.muted, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", marginTop: 16, marginBottom: 8 },
  whyLine: { color: C.muted, fontSize: 11, marginTop: -4, marginBottom: 8, lineHeight: 15 },
  empty: { color: C.muted, fontSize: 12, fontFamily: MONO },
  compRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line },
  compDate: { color: C.muted, fontFamily: MONO, fontSize: 11, width: 64 },
  compType: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  compTypeText: { fontSize: 9, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3 },
  compTitle: { color: C.muted, fontSize: 11, flex: 1 },
  compPrice: { color: C.ink, fontFamily: MONO, fontSize: 13 },
  editBox: { marginTop: 4 },
  editRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  editLabel: { color: C.muted, fontSize: 12, width: 70 },
  editInput: { flex: 1, backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: C.ink, fontSize: 13, fontFamily: MONO },
  saveBtn: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 9, alignItems: "center", marginTop: 2 },
  saveText: { color: C.ink, fontWeight: "600", fontSize: 13 },
  cta: { flex: 1, backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  ctaText: { color: "#ffffff", fontWeight: "700", fontSize: 14 },
  ctaAlt: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  ctaAltText: { color: C.ink, fontWeight: "600", fontSize: 14 },
  removeBtn: { width: 48, borderWidth: 1, borderColor: "#f0caca", borderRadius: 10, alignItems: "center", justifyContent: "center" },
  close: { color: C.muted, fontSize: 14, textAlign: "center", marginTop: 16 },
});

function CardImage({ uri, label, size = 52 }: { uri?: string; label?: string; size?: number }) {
  const [err, setErr] = useState(false);
  if (uri && !err) {
    return <Image source={{ uri }} onError={() => setErr(true)} style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.panel2 }} />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: C.muted, fontSize: size > 44 ? 11 : 9, fontWeight: "700", textAlign: "center" }}>{label ?? "CARD"}</Text>
    </View>
  );
}

// On web/desktop (Windows) there's no camera, so building the library means
// picking an image file. On native, a camera/library picker supplies the uri
// (expo-image-picker / expo-camera — wired in the native build).
type PickedImage = { previewUri: string; base64: string; mediaType: string };
function pickImageWeb(): Promise<PickedImage | undefined> {
  const g = globalThis as { document?: any; URL?: any; FileReader?: any; Image?: any };
  if (!g.document) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const input = g.document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    // On phones this lets the user pick the camera OR a photo from the library.
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(undefined);
      const previewUri = g.URL ? g.URL.createObjectURL(file) : "";
      const reader = new g.FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        const done = (base64: string, mediaType: string) => resolve({ previewUri, base64, mediaType });
        const fromDataUrl = (u: string) => {
          const m = u.match(/^data:(.*?);base64,(.*)$/);
          done(m ? m[2] : "", m ? m[1] : "image/jpeg");
        };
        // Downscale a big phone photo so it fits the request + vision-API limits
        // (and costs less). A slab label is legible well under 1600px.
        try {
          const img = new g.Image();
          img.onload = () => {
            try {
              const MAX = 1600;
              let w = img.width, h = img.height;
              if (Math.max(w, h) > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
              const canvas = g.document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              canvas.getContext("2d").drawImage(img, 0, 0, w, h);
              fromDataUrl(canvas.toDataURL("image/jpeg", 0.85));
            } catch { fromDataUrl(src); }
          };
          img.onerror = () => fromDataUrl(src);
          img.src = src;
        } catch { fromDataUrl(src); }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

function LibraryScreen({
  holdings,
  canScan,
  scan: bundledScan,
  onAddScanned,
  onAddHolding,
  onOpenCard,
  onRemove,
  columns,
  pro,
}: {
  holdings: ValuedHolding[];
  canScan: boolean;
  scan: Scan;
  onAddScanned: (v: ValuedHolding[]) => void;
  onAddHolding: (text: string) => void;
  onOpenCard: (c: DetailCard) => void;
  onRemove: (id: string) => void;
  columns: number;
  pro: boolean;
}) {
  void pro;
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<Scan>(bundledScan);
  const [photoUri, setPhotoUri] = useState<string | undefined>(undefined);
  const [manual, setManual] = useState("");
  const total = holdings.reduce((s, v) => s + (v.fairValue?.point ?? 0), 0);
  const hasPL = holdings.some((v) => v.unrealizedPL != null);
  const totalPL = holdings.reduce((s, v) => s + (v.unrealizedPL ?? 0), 0);
  const isWeb = Platform.OS === "web";
  const submitManual = () => {
    onAddHolding(manual);
    setManual("");
  };

  const runScan = async (img?: PickedImage) => {
    setPhotoUri(img?.previewUri);
    if (API_BASE) {
      try {
        const r = await fetch(`${API_BASE}/api/v1/library/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: img ? { base64: img.base64, mediaType: img.mediaType } : {} }),
        });
        if (r.ok) setScan((await r.json()) as Scan);
      } catch {
        /* unreachable API → keep the bundled scan */
      }
    }
    setScanning(true);
  };

  const upload = async () => {
    const img = await pickImageWeb();
    if (img) runScan(img);
  };

  // canScan comes from the backend's capability report — only true when a real
  // vision provider is connected, so we never show the demo scanner as if real.
  return (
    <View>
      <Text style={styles.colH}>Your library</Text>
      <View style={styles.libSummary}>
        <View>
          <Text style={styles.libSumV}>{holdings.length}</Text>
          <Text style={styles.libSumL}>cards</Text>
        </View>
        <View>
          <Text style={styles.libSumV}>${Math.round(total).toLocaleString()}</Text>
          <Text style={styles.libSumL}>est. value</Text>
        </View>
        {hasPL ? (
          <View>
            <Text style={[styles.libSumV, { color: totalPL >= 0 ? C.green : C.red }]}>
              {totalPL >= 0 ? "+" : "−"}${Math.abs(Math.round(totalPL)).toLocaleString()}
            </Text>
            <Text style={styles.libSumL}>profit/loss</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.libAddLabel}>Add a card</Text>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
        <TextInput
          value={manual}
          onChangeText={setManual}
          onSubmitEditing={submitManual}
          returnKeyType="done"
          autoCapitalize="none"
          placeholder="e.g. 2018 Prizm Luka #280 PSA 10"
          placeholderTextColor={C.muted}
          style={[styles.input, { flex: 1 }]}
        />
        <Pressable style={styles.addBtn} onPress={submitManual}>
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {canScan ? (
        <Pressable style={styles.scanBtnAlt} onPress={isWeb ? upload : () => runScan(undefined)}>
          <Text style={styles.scanBtnAltText}>{isWeb ? "or upload a photo to read many at once" : "or take a photo to read many at once"}</Text>
        </Pressable>
      ) : (
        <Text style={styles.hint}>Tip: photo scanning turns on once the scanner's connected — for now, add cards by hand.</Text>
      )}

      {canScan && scanning ? (
        <ScanFlow
          scan={scan}
          photoUri={photoUri}
          onAdd={() => {
            onAddScanned(scan.valued);
            setScanning(false);
          }}
          onCancel={() => setScanning(false)}
        />
      ) : null}

      {holdings.length === 0 ? (
        <Text style={[styles.hint, { marginTop: 12 }]}>Your library is empty — add a card above. It's saved on this device.</Text>
      ) : (
        <Grid columns={columns}>
          {holdings.map((v) => (
            <SwipeRow key={v.holding.id} gap={7} onDelete={() => onRemove(v.holding.id)}>
              <HoldingCard v={v} onOpenCard={onOpenCard} />
            </SwipeRow>
          ))}
        </Grid>
      )}
    </View>
  );
}

function HoldingCard({ v, onOpenCard }: { v: ValuedHolding; onOpenCard: (c: DetailCard) => void }) {
  const k = v.holding.key;
  const h = v.holding;
  const val = v.fairValue ? `$${Math.round(v.fairValue.point).toLocaleString()}` : "—";
  const up = (v.trendPct ?? 0) >= 0;
  const trend = v.trendPct != null ? `${up ? "▲" : "▼"} ${Math.abs(v.trendPct * 100).toFixed(1)}%/mo` : "";
  const plUp = (v.unrealizedPL ?? 0) >= 0;
  const pl = v.unrealizedPL != null ? `${plUp ? "+" : "−"}$${Math.abs(Math.round(v.unrealizedPL)).toLocaleString()}` : "";
  const name = `${k.set}${k.number ? ` #${k.number}` : ""}${k.variant ? ` ${k.variant}` : ""}`;
  // Whole row taps open the detail sheet (photo, comps, edit, remove). Single
  // Pressable — no nested flex Pressable (that collapses to zero-height on iOS).
  return (
    <Pressable style={[styles.itemCard, { marginBottom: 0 }]} onPress={() => onOpenCard({ id: h.id, key: k, imageUrl: h.imageUrl, name, isOwned: true, holding: h })}>
      <CardImage uri={h.imageUrl} label={`${k.grader} ${k.grade}`} size={46} />
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.cardSub} numberOfLines={1}>
          {k.grader} {k.grade}
          {h.acquiredPrice != null ? ` · paid $${money(h.acquiredPrice)}` : ""}
          {h.acquiredFrom ? ` · ${h.acquiredFrom}` : ""}
        </Text>
        <View style={styles.cardPriceRow}>
          <Text style={styles.cardPrice}>{val}</Text>
          {pl ? (
            <Text style={[styles.cardPL, { color: plUp ? C.green : C.red }]}>
              {pl} {trend ? `· ${trend}` : ""}
            </Text>
          ) : trend ? (
            <Text style={[styles.cardPL, { color: up ? C.green : C.red }]}>{trend}</Text>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={16} color={C.muted} style={{ alignSelf: "center" }} />
    </Pressable>
  );
}

function ScanScreen({
  canScan,
  scan: bundledScan,
  onAddScanned,
  onDone,
}: {
  canScan: boolean;
  scan: Scan;
  onAddScanned: (v: ValuedHolding[]) => void;
  onDone?: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<Scan>(bundledScan);
  const [photoUri, setPhotoUri] = useState<string | undefined>(undefined);
  const isWeb = Platform.OS === "web";

  const runScan = async (img?: PickedImage) => {
    setPhotoUri(img?.previewUri);
    if (API_BASE) {
      try {
        const r = await fetch(`${API_BASE}/api/v1/library/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: img ? { base64: img.base64, mediaType: img.mediaType } : {} }),
        });
        if (r.ok) setScan((await r.json()) as Scan);
      } catch {
        /* unreachable API → keep the bundled scan */
      }
    }
    setScanning(true);
  };
  const upload = async () => {
    const img = await pickImageWeb();
    if (img) runScan(img);
  };

  return (
    <View>
      <Text style={styles.colH}>Scan your collection</Text>
      {canScan ? (
        <>
          <Pressable style={styles.scanBtn} onPress={isWeb ? upload : () => runScan(undefined)}>
            <Ionicons name="camera-outline" size={22} color="#ffffff" />
            <Text style={styles.scanBtnText}>{isWeb ? "Upload a photo" : "Take a photo"}</Text>
            <Text style={styles.scanBtnSub}>Reads every slab in the shot</Text>
          </Pressable>
          {scanning ? (
            <ScanFlow
              scan={scan}
              photoUri={photoUri}
              onAdd={() => {
                onAddScanned(scan.valued);
                setScanning(false);
                onDone?.();
              }}
              onCancel={() => setScanning(false)}
            />
          ) : (
            <Text style={styles.hint}>Point at a stack of graded cards — it reads each label (year, set, player, #, grade) and adds them to your library. Cheap: ~1¢ a card.</Text>
          )}
        </>
      ) : (
        <View style={styles.scanBox}>
          <Text style={styles.scanTitle}>Scanner not connected</Text>
          <Text style={[styles.hint, { marginTop: 6 }]}>The AI card-reader isn't switched on yet. For now, add cards by hand in Library — it's saved on this device.</Text>
        </View>
      )}
    </View>
  );
}

function ScanFlow({ scan, photoUri, onAdd, onCancel }: { scan: Scan; photoUri?: string; onAdd: () => void; onCancel: () => void }) {
  return (
    <View style={styles.scanBox}>
      {photoUri ? (
        <View style={styles.photoPreviewRow}>
          <Image source={{ uri: photoUri }} style={styles.photoPreview} resizeMode="cover" />
          <Text style={styles.hint}>From your photo</Text>
        </View>
      ) : null}
      <Text style={styles.scanTitle}>
        Read {scan.added.length} of {scan.detected} cards
      </Text>
      <Text style={styles.hint}>One photo of a stack — we read as many as we can at once.</Text>
      <View style={styles.scanGrid}>
        {scan.valued.map((v) => (
          <View key={v.holding.id} style={styles.scanCell}>
            <CardImage uri={v.holding.imageUrl} label={`${v.holding.key.grader} ${v.holding.key.grade}`} size={46} />
            <Text style={styles.scanCheck}>✓ read</Text>
          </View>
        ))}
      </View>
      {scan.review.length > 0 ? (
        <View>
          <Text style={[styles.hint, { marginTop: 12 }]}>{scan.review.length} need a quick check:</Text>
          <View style={styles.scanGrid}>
            {scan.review.map((r) => (
              <View key={r.detection.id} style={styles.scanCell}>
                <CardImage uri={r.detection.cropUrl} label="?" size={46} />
                <Text style={styles.scanQ}>tap to confirm</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      <View style={styles.scanActions}>
        <Pressable style={styles.scanCancel} onPress={onCancel}>
          <Text style={styles.scanCancelText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.scanAdd} onPress={onAdd}>
          <Text style={styles.scanAddText}>Add {scan.added.length} cards</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, flexDirection: "row", alignItems: "baseline", gap: 10 },
  brand: { color: C.ink, fontSize: 17, fontWeight: "500", letterSpacing: 1 },
  sub: { color: C.muted, fontSize: 12 },
  srcChip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 2 },
  srcLive: { borderColor: "rgba(63,185,80,.4)" },
  srcSnap: { borderColor: C.line },
  srcText: { fontSize: 11 },
  headerControls: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
  ctrlChip: { borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 4, minWidth: 34, alignItems: "center" },
  ctrlChipOn: { backgroundColor: C.accent, borderColor: C.accent },
  ctrlText: { color: C.muted, fontSize: 12, fontWeight: "700" },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  tab: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: C.line },
  tabActive: { backgroundColor: C.panel2, borderColor: C.accent },
  tabText: { color: C.muted, fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: C.ink },
  scroll: { flex: 1 },
  colH: { color: C.muted, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 },
  feedHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  feedMeta: { color: C.muted, fontSize: 11, fontFamily: MONO, marginBottom: 10 },
  feedFoot: { color: C.muted, fontSize: 11, fontFamily: MONO, lineHeight: 16, marginTop: 6 },
  // Clean, eBay-style card: photo · title/condition/price · chevron.
  itemCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 8, marginBottom: 7 },
  cardBody: { flex: 1, minWidth: 0, justifyContent: "center" },
  cardTitle: { color: C.ink, fontSize: 13, fontWeight: "500", lineHeight: 17 },
  cardSub: { color: C.muted, fontSize: 11, marginTop: 2 },
  cardPriceRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 7 },
  cardPrice: { color: C.ink, fontSize: 15, fontWeight: "600", fontFamily: MONO },
  cardPL: { fontSize: 11, fontFamily: MONO },
  underPill: { backgroundColor: "#e7f5ec", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  underPillText: { color: C.green, fontSize: 11, fontWeight: "600" },
  cardProMeta: { color: C.muted, fontSize: 10, fontFamily: MONO, marginTop: 4 },
  // Ranked edge row — hero is the net edge.
  dealCard: { flexDirection: "row", alignItems: "flex-start", gap: 11, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10, marginBottom: 8 },
  dealEdgeRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  dealEdgeVal: { color: C.green, fontSize: 19, fontWeight: "700", fontFamily: MONO },
  dealEdgePct: { color: C.green, fontSize: 13, fontWeight: "600", fontFamily: MONO },
  dealChip: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  dealChipText: { fontSize: 10, fontWeight: "600" },
  dealSellerChip: { alignSelf: "flex-start", marginTop: 5 },
  dealBand: { color: C.muted, fontSize: 12, marginTop: 4, fontFamily: MONO },
  dealPriceLine: { color: C.ink, fontSize: 12, marginTop: 3 },
  dealIdentity: { color: C.muted, fontSize: 11, marginTop: 3, lineHeight: 15 },
  specNote: { color: C.muted, fontSize: 11, marginBottom: 8, marginTop: -4 },
  qvHint: { color: C.muted, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  qvComp: { color: C.muted, fontSize: 11, fontFamily: MONO, marginTop: 3 },
  tradePriceLbl: { color: C.muted, fontSize: 12 },
  tradePriceInput: { borderWidth: 1, borderColor: C.line, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, color: C.ink, fontSize: 14, fontFamily: MONO, minWidth: 64, backgroundColor: C.panel2 },
  tradeTotal: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line },
  tradeTotalLbl: { color: C.muted, fontSize: 13 },
  tradeTotalVal: { color: C.ink, fontSize: 17, fontWeight: "700", fontFamily: MONO },
  clearBtn: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  clearBtnText: { color: C.red, fontSize: 12, fontWeight: "600" },
  emptyBox: { alignItems: "center", justifyContent: "center", paddingVertical: 48, gap: 14 },
  emptyText: { color: C.muted, fontSize: 14, textAlign: "center", paddingHorizontal: 30, lineHeight: 20 },
  deal: { flexDirection: "row", alignItems: "center", backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 10, marginBottom: 7 },
  dealName: { color: C.ink, fontSize: 13 },
  dealMeta: { color: C.muted, fontSize: 11, fontFamily: MONO, marginTop: 3 },
  dealEdge: { fontSize: 16, fontFamily: MONO, fontWeight: "700" },
  sigTag: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 0, marginTop: 3 },
  sigTagText: { fontSize: 11, fontFamily: MONO },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginBottom: 10 },
  alertTop: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },
  badgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  alertTitle: { color: C.ink, fontSize: 13, fontWeight: "600", flex: 1 },
  edge: { color: C.green, fontSize: 14, fontWeight: "800" },
  row: { flexDirection: "row", gap: 16, marginTop: 4, flexWrap: "wrap", alignItems: "center" },
  statBox: {},
  statLbl: { color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  statVal: { color: C.ink, fontSize: 14, fontWeight: "700" },
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3, marginTop: 8 },
  chipText: { fontSize: 11 },
  cta: { color: C.accent, fontSize: 12, marginTop: 11 },

  passport: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 18 },
  ppGradeRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  gradeChip: { backgroundColor: "#e6f1fb", borderWidth: 1, borderColor: "#b5d4f4", borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  gradeChipText: { color: C.accent, fontWeight: "800", fontSize: 13 },
  ppCert: { color: C.muted, fontSize: 11 },
  verified: { marginLeft: "auto", borderWidth: 1, borderColor: "#b5d4f4", borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  verifiedText: { color: C.accent, fontSize: 11 },
  ppName: { color: C.ink, fontSize: 15, fontWeight: "700", marginBottom: 4 },
  ppPoint: { color: C.ink, fontSize: 33, fontWeight: "800", letterSpacing: -1, fontFamily: MONO },
  ppPointSmall: { color: C.muted, fontSize: 12, fontWeight: "400" },
  band: { height: 8, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, marginTop: 14, marginBottom: 6, position: "relative" },
  bandPt: { position: "absolute", top: -4, width: 3, height: 16, backgroundColor: C.ink, borderRadius: 2 },
  bandLbls: { flexDirection: "row", justifyContent: "space-between" },
  bandLbl: { color: C.muted, fontSize: 11 },
  meter: { height: 6, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, marginTop: 12, marginBottom: 2, overflow: "hidden" },
  meterFill: { height: "100%" },
  stats: { flexDirection: "row", gap: 10, marginVertical: 16 },
  bigStat: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10 },
  bigStatV: { color: C.ink, fontSize: 16, fontWeight: "700", fontFamily: MONO },
  bigStatL: { color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  histHead: { flexDirection: "row", paddingVertical: 4 },
  histH: { color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  histRow: { flexDirection: "row", paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line },
  histCell: { color: C.ink, fontSize: 12 },
  ppFoot: { color: C.muted, fontSize: 11, lineHeight: 16, marginTop: 14 },
  foot: { color: C.muted, fontSize: 11, textAlign: "center", marginTop: 18, marginBottom: 8 },

  addRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10, color: C.ink, fontSize: 13 },
  addBtn: { backgroundColor: C.accent, borderRadius: 9, paddingHorizontal: 16, paddingVertical: 10 },
  addBtnText: { color: "#ffffff", fontWeight: "700", fontSize: 13 },
  hint: { color: C.muted, fontSize: 11, marginTop: 8, lineHeight: 15 },
  buildBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12 },
  buildBtnText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  interview: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14 },
  ivStep: { color: C.ink, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  ivChip: { borderWidth: 1, borderColor: C.line, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: C.panel2 },
  ivChipOn: { backgroundColor: C.accent, borderColor: C.accent },
  ivChipText: { color: C.muted, fontSize: 13, fontWeight: "600" },
  ivChipTextOn: { color: "#ffffff" },
  treeBox: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 6, marginTop: 12 },
  treeRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  treeLabel: { color: C.muted, fontSize: 13 },
  treeLeaf: { color: C.ink, fontWeight: "600" },
  hitBadge: { marginLeft: 8, backgroundColor: "rgba(116,177,240,.15)", borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1 },
  hitBadgeText: { color: C.accent, fontSize: 10, fontWeight: "700" },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  tag: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  tagText: { fontSize: 11 },
  price: { color: C.ink, fontSize: 14, fontWeight: "800", fontFamily: MONO },

  tabsScroll: { flexGrow: 0 },
  sidebar: { width: 200, paddingHorizontal: 12, paddingTop: 6, gap: 6, borderRightWidth: 1, borderRightColor: C.line },
  sideTab: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 10 },
  sideTabActive: { backgroundColor: C.panel2 },
  sideTabText: { color: C.muted, fontSize: 15, fontWeight: "600" },
  sideTabTextActive: { color: C.ink },
  bottomBar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.bg, paddingTop: 8 },
  bottomTab: { flex: 1, alignItems: "center", paddingVertical: 4, gap: 3 },
  bottomTabText: { fontSize: 10, fontWeight: "500" },

  landWrap: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 36 },
  landHeadRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  landBrand: { color: C.ink, fontSize: 24, fontWeight: "800", letterSpacing: 3, fontFamily: MONO },
  landTag: { color: C.accent, fontSize: 12, fontFamily: MONO, borderWidth: 1, borderColor: "#b5d4f4", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  landTitle: { color: C.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.5, lineHeight: 36, marginTop: 22 },
  landSub: { color: C.muted, fontSize: 15, lineHeight: 22, marginTop: 12 },
  landPanel: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 12, marginTop: 22 },
  landFoot: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: "center" },
  landDealHint: { color: C.accent, fontSize: 12, marginTop: 8, textAlign: "center" },
  obWrap: { flex: 1, paddingHorizontal: 26, paddingTop: 40, paddingBottom: 28 },
  obBrand: { color: C.ink, fontSize: 22, fontWeight: "800", letterSpacing: 3 },
  obTitle: { color: C.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginTop: 16, lineHeight: 32 },
  obSub: { color: C.muted, fontSize: 14, marginTop: 10, lineHeight: 20 },
  obRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  obIcon: { width: 46, height: 46, borderRadius: 12, backgroundColor: "#e6f1fb", borderWidth: 1, borderColor: "#cfe0f5", alignItems: "center", justifyContent: "center" },
  obRowTitle: { color: C.ink, fontSize: 16, fontWeight: "700" },
  obRowSub: { color: C.muted, fontSize: 13, marginTop: 2, lineHeight: 18 },
  obBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  obBtnText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  ppHeader: { flexDirection: "row", alignItems: "center", marginBottom: 6 },

  libSummary: { flexDirection: "row", gap: 28, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginBottom: 12 },
  libSumV: { color: C.ink, fontSize: 16, fontWeight: "600", fontFamily: MONO },
  libSumL: { color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  libAddLabel: { color: C.ink, fontSize: 14, fontWeight: "600", marginBottom: 6 },
  scanBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: "center" },
  scanBtnText: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
  scanBtnSub: { color: "#dbe7f7", fontSize: 12, marginTop: 2 },
  scanBtnAlt: { borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 11, alignItems: "center", marginTop: 8 },
  scanBtnAltText: { color: C.accent, fontSize: 13, fontWeight: "600" },
  photoPreviewRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  photoPreview: { width: 56, height: 56, borderRadius: 8, backgroundColor: C.panel },
  holdingRow: { flexDirection: "row", alignItems: "center", backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 10, marginBottom: 7 },
  holdingName: { color: C.ink, fontSize: 13, fontWeight: "600" },
  holdingSub: { color: C.muted, fontSize: 11, marginTop: 2, fontFamily: MONO },
  holdingTrend: { fontSize: 12, fontWeight: "600", marginTop: 3, fontFamily: MONO },
  holdingVal: { color: C.ink, fontSize: 16, fontWeight: "800", fontFamily: MONO },
  holdingPL: { fontSize: 12, fontWeight: "600", marginTop: 3, fontFamily: MONO },
  holdingEdit: { marginLeft: 8, padding: 4 },
  holdingRemove: { marginLeft: 6, padding: 4 },
  holdingRemoveText: { color: C.muted, fontSize: 14, fontWeight: "700" },
  editPanel: { backgroundColor: C.panel2, borderWidth: 1, borderTopWidth: 0, borderColor: C.line, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 10, gap: 8 },
  editRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  editLabel: { color: C.muted, fontSize: 12, width: 70 },
  editInput: { flex: 1, backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: C.ink, fontSize: 13, fontFamily: MONO },
  editSave: { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 9, alignItems: "center", marginTop: 2 },
  editSaveText: { color: "#ffffff", fontWeight: "700", fontSize: 13 },

  scanBox: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.accent, borderRadius: 12, padding: 14, marginBottom: 14 },
  scanTitle: { color: C.ink, fontSize: 16, fontWeight: "700" },
  scanGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 },
  scanCell: { width: 66, alignItems: "center" },
  scanCheck: { color: C.green, fontSize: 10, fontWeight: "700", marginTop: 4 },
  scanQ: { color: C.amber, fontSize: 10, marginTop: 4 },
  scanActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  scanCancel: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 11, paddingVertical: 12, alignItems: "center" },
  scanCancelText: { color: C.muted, fontSize: 14, fontWeight: "600" },
  scanAdd: { flex: 2, backgroundColor: C.green, borderRadius: 11, paddingVertical: 12, alignItems: "center" },
  scanAddText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
});
