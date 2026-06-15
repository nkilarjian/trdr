import { Children, createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Image, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text as RNText, TextInput, useWindowDimensions, View } from "react-native";
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

type Holding = { id: string; key: CardKey; cert?: string; imageUrl?: string; acquiredPrice?: number };
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

const C = {
  bg: "#0a0e16",
  panel: "#0f1622",
  panel2: "#0d1420",
  line: "#1c2535",
  ink: "#e6edf3",
  muted: "#8b97a8",
  green: "#3fb950",
  amber: "#d29922",
  red: "#f85149",
  accent: "#58a6ff",
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

export default function App() {
  const [tab, setTab] = useState<"alerts" | "library" | "wishlist" | "passport">("alerts");
  const [source, setSource] = useState<"snapshot" | "live">("snapshot");
  // What the backend can actually do (real creds vs mocks) — drives honest
  // labelling and hides features that aren't really wired (e.g. photo-scan).
  const [caps, setCaps] = useState<{ market?: string; vision?: string; grading?: string }>({});
  const [refreshing, setRefreshing] = useState(false);
  // Your wishlist drives everything (deals + wishlist + the watched cards).
  const [specs, setSpecs] = useState<WishSpec[]>(FALLBACK.wishlist.specs);
  const [alerts, setAlerts] = useState<Alert[]>(FALLBACK.alerts);
  const [passport, setPassport] = useState<Passport>(FALLBACK.passport);
  const [hits, setHits] = useState<WishHit[]>(FALLBACK.wishlist.hits);
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
      .then((b: { alerts: Alert[]; wishlist: { hits: WishHit[] }; passport: Passport | null }) => {
        setAlerts(b.alerts);
        setHits(b.wishlist.hits);
        if (b.passport) setPassport(b.passport);
        setSource("live");
      })
      .catch(() => {
        /* unreachable API → keep the bundled snapshot */
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
          const next = prev.map((v) => byId.get(v.holding.id) ?? v);
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
    AsyncStorage.getItem("trdr.wishlist")
      .then((v) => {
        const saved = v ? (JSON.parse(v) as WishSpec[]) : null;
        const s = saved && saved.length ? saved : FALLBACK.wishlist.specs;
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
  const tree = buildWishTree(specs);

  // Library — persisted on the phone (AsyncStorage = localStorage on web).
  // Functional updates so saves can't race a stale `holdings` closure.
  const persistLib = (h: ValuedHolding[]) => AsyncStorage.setItem("trdr.library", JSON.stringify(h)).catch(() => {});
  const addScanned = (valued: ValuedHolding[]) =>
    setHoldings((prev) => {
      const seen = new Set(prev.map((v) => v.holding.id));
      const next = [...prev, ...valued.filter((v) => !seen.has(v.holding.id))];
      persistLib(next);
      return next;
    });
  const addHolding = (text: string) => {
    if (!text.trim()) return;
    setHoldings((prev) => {
      const next = [...prev, { holding: parseHolding(text, `h-${Date.now()}`) }];
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
  const deviceLabel = Platform.OS === "web" ? "web" : kind === "tablet" ? "tablet" : "phone";

  const tabs: { key: typeof tab; label: string; icon: IconName }[] = [
    { key: "alerts", label: `Deals · ${alerts.length}`, icon: "pricetags-outline" },
    { key: "library", label: `Library · ${holdings.length}`, icon: "albums-outline" },
    { key: "wishlist", label: `Wishlist · ${hits.length}`, icon: "heart-outline" },
    { key: "passport", label: "Card", icon: "card-outline" },
  ];

  // Pull-to-refresh: re-pull deals/wishlist + re-price the library.
  const onRefresh = () => {
    setRefreshing(true);
    refreshBoard(specs);
    revalueLibrary(holdings);
    setTimeout(() => setRefreshing(false), 1200);
  };
  const refreshCtl = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} colors={[C.accent]} progressBackgroundColor={C.panel} />;

  // Real eBay market data vs model estimates; real vision backend vs none.
  const marketReal = !!caps.market && caps.market !== "mock";
  const visionReal = !!caps.vision && caps.vision !== "mock";

  const body = (
    <View style={{ width: "100%", maxWidth, alignSelf: "center" }}>
      {tab === "alerts" && <AlertsFeed alerts={alerts} columns={columns} pro={pro} />}
      {tab === "library" && (
        <LibraryScreen
          holdings={holdings}
          canScan={visionReal}
          scan={FALLBACK.scan}
          onAddScanned={addScanned}
          onAddHolding={addHolding}
          onRemove={removeHolding}
          columns={columns}
          pro={pro}
        />
      )}
      {tab === "wishlist" && <WishlistScreen tree={tree} hits={hits} onAdd={addWish} columns={columns} pro={pro} />}
      {tab === "passport" && <PassportScreen passport={passport} pro={pro} />}
      <Text style={styles.foot}>
        {source === "live" ? (marketReal ? "Live eBay prices" : "Estimated values") : "Demo data"} · {deviceLabel} layout
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
        <AuthButton />
        <Pressable onPress={cycleSize} style={styles.ctrlChip} accessibilityLabel="Text size">
          <Text style={[styles.ctrlText, { fontSize: textScale > 1 ? 15 : 13 }]}>A</Text>
        </Pressable>
        <Pressable onPress={() => setPro((p) => !p)} style={[styles.ctrlChip, pro && styles.ctrlChipOn]}>
          <Text style={[styles.ctrlText, { color: pro ? "#04122b" : C.muted }]}>{pro ? "Pro" : "Simple"}</Text>
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
            <StatusBar style="light" />
            <CloudSync specs={specs} holdings={holdings} onLoad={onCloudLoad} />
            {header}
            {inner}
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
            <StatusBar style="light" />
            <Onboarding onDone={finishOnboarding} />
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
      <ScrollView style={styles.scroll} contentContainerStyle={{ padding: kind === "tablet" ? 20 : 16, paddingTop: 12 }} refreshControl={refreshCtl}>
        {body}
      </ScrollView>
      <View style={styles.bottomBar}>
        {tabs.map((t) => (
          <Pressable key={t.key} style={styles.bottomTab} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
            <Ionicons name={t.icon} size={23} color={tab === t.key ? C.accent : C.muted} />
            <Text style={[styles.bottomTabText, { color: tab === t.key ? C.accent : C.muted }]}>{t.label.split(" · ")[0]}</Text>
          </Pressable>
        ))}
      </View>
    </>,
  );
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const features: { icon: IconName; title: string; sub: string }[] = [
    { icon: "pricetags-outline", title: "Find great deals", sub: "We watch the market and flag cards selling below value." },
    { icon: "albums-outline", title: "Snap your collection", sub: "One photo reads many cards at once — no typing them in." },
    { icon: "heart-outline", title: "Build a wishlist", sub: "Tell us what you want; we hunt for it in the background." },
  ];
  return (
    <View style={styles.obWrap}>
      <Text style={styles.obBrand}>TRDR</Text>
      <Text style={styles.obTitle}>Know what your cards are worth.</Text>
      <Text style={styles.obSub}>Friendly by default — flip on Pro mode anytime for the deep numbers.</Text>
      <View style={{ marginTop: 28, gap: 18 }}>
        {features.map((f) => (
          <View key={f.title} style={styles.obRow}>
            <View style={styles.obIcon}>
              <Ionicons name={f.icon} size={22} color={C.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.obRowTitle}>{f.title}</Text>
              <Text style={styles.obRowSub}>{f.sub}</Text>
            </View>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <Pressable style={styles.obBtn} onPress={onDone}>
        <Text style={styles.obBtnText}>Get started</Text>
      </Pressable>
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
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

function AlertsFeed({ alerts, columns, pro }: { alerts: Alert[]; columns: number; pro: boolean }) {
  // edge % = how far the current price sits below fair value.
  const edgeOf = (a: Alert) => {
    const price = Number(alertVM(a).predictedClose.replace(/[^0-9.]/g, ""));
    return price > 0 ? (a.fairValue.point - price) / price : 0;
  };
  const best = alerts.reduce((m, a) => Math.max(m, edgeOf(a)), 0);
  return (
    <View>
      <View style={styles.feedHead}>
        <Text style={styles.colH}>Live deals</Text>
        <Text style={styles.feedMeta}>
          {alerts.length} open · best <Text style={{ color: C.green }}>+{Math.round(best * 100)}%</Text>
        </Text>
      </View>
      <Grid columns={columns}>
        {alerts.map((a) => {
          const vm = alertVM(a);
          const sure = sureness(a.fairValue.confidence);
          const edge = edgeOf(a);
          const sig = signal(edge, a.fairValue.confidence);
          return (
            <Pressable key={a.itemId} style={styles.deal} onPress={() => Linking.openURL(vm.deepLink)}>
              <CardImage uri={a.imageUrl} label={`${a.key.grade}`} size={44} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
                <Text style={styles.dealName} numberOfLines={1}>
                  {vm.title}
                </Text>
                <Text style={styles.dealMeta} numberOfLines={1}>
                  fv {money(a.fairValue.point)} · {a.buyingOption === "AUCTION" ? "bid" : "ask"} {vm.predictedClose.replace("$", "")} ·{" "}
                  <Text style={{ color: tone(sure.tone) }}>{sure.dots}</Text>
                </Text>
              </View>
              <View style={{ alignItems: "flex-end", marginLeft: 8 }}>
                <Text style={[styles.dealEdge, { color: sig.color }]}>
                  {edge >= 0 ? "+" : ""}
                  {Math.round(edge * 100)}%
                </Text>
                <View style={[styles.sigTag, { borderColor: sig.color + "55" }]}>
                  <Text style={[styles.sigTagText, { color: sig.color }]}>{sig.tag}</Text>
                </View>
              </View>
            </Pressable>
          );
        })}
      </Grid>
      {pro ? <Text style={styles.feedFoot}>edge = fair value vs. current price · dots = comp confidence · buy ≥15% · watch ≥6%</Text> : null}
    </View>
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

function WishlistScreen({ tree, hits, onAdd, columns, pro }: { tree: WishNode; hits: WishHit[]; onAdd: (t: string) => void; columns: number; pro: boolean }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (t) {
      onAdd(t);
      setText("");
    }
  };
  return (
    <View>
      <Text style={styles.colH}>Your wishlist</Text>
      <View style={styles.addRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholder="Add a card or player… e.g. Jordan Fleer PSA 9"
          placeholderTextColor={C.muted}
          style={styles.input}
        />
        <Pressable style={styles.addBtn} onPress={submit}>
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>Add what you want — broad ("any Charizard") or specific. It organizes itself.</Text>

      <View style={styles.treeBox}>
        {tree.children.map((c) => (
          <TreeNodeView key={c.id} node={c} depth={0} hits={hits} />
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

function TreeNodeView({ node, depth, hits }: { node: WishNode; depth: number; hits: WishHit[] }) {
  const isLeaf = !!node.wishId;
  const n = isLeaf ? hits.filter((h) => h.wishId === node.wishId).length : 0;
  return (
    <View>
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
      </View>
      {node.children.map((c) => (
        <TreeNodeView key={c.id} node={c} depth={depth + 1} hits={hits} />
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
  return (
    <View style={styles.card}>
      <View style={styles.alertTop}>
        <CardImage uri={hit.imageUrl} label={hit.buyingOption} size={40} />
        <View style={[styles.badge, { backgroundColor: hit.buyingOption === "AUCTION" ? "#16314f" : "#13301f" }]}>
          <Text style={[styles.badgeText, { color: hit.buyingOption === "AUCTION" ? C.accent : "#5ec06f" }]}>
            {hit.buyingOption}
          </Text>
        </View>
        <Text style={styles.alertTitle} numberOfLines={1}>
          {hit.title}
        </Text>
        <Text style={styles.price}>${hit.currentPrice.toLocaleString()}</Text>
      </View>
      <View style={styles.tagRow}>
        {hit.tags.map((t) => (
          <View key={t} style={[styles.tag, { borderColor: tagColor(t) + "66" }]}>
            <Text style={[styles.tagText, { color: tagColor(t) }]}>{t}</Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Stat label="interest" value={`${Math.round(hit.interest * 100)}%`} color={C.accent} />
        {hit.fairBand ? (
          <Stat label="fair band" value={`$${Math.round(hit.fairBand.lower)} – $${Math.round(hit.fairBand.upper)}`} />
        ) : null}
      </View>
      <Pressable onPress={() => Linking.openURL(hit.deepLink)}>
        <Text style={styles.cta}>Open on eBay →</Text>
      </Pressable>
    </View>
  );
}

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
  onRemove,
  columns,
  pro,
}: {
  holdings: ValuedHolding[];
  canScan: boolean;
  scan: Scan;
  onAddScanned: (v: ValuedHolding[]) => void;
  onAddHolding: (text: string) => void;
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
            <HoldingCard key={v.holding.id} v={v} onRemove={onRemove} />
          ))}
        </Grid>
      )}
    </View>
  );
}

function HoldingCard({ v, onRemove }: { v: ValuedHolding; onRemove?: (id: string) => void }) {
  const k = v.holding.key;
  const val = v.fairValue ? `$${Math.round(v.fairValue.point).toLocaleString()}` : "—";
  const up = (v.trendPct ?? 0) >= 0;
  const trend = v.trendPct != null ? `${up ? "▲" : "▼"} ${Math.abs(v.trendPct * 100).toFixed(1)}%/mo` : "";
  const plUp = (v.unrealizedPL ?? 0) >= 0;
  const pl = v.unrealizedPL != null ? `${plUp ? "+" : "−"}$${Math.abs(Math.round(v.unrealizedPL)).toLocaleString()}` : "";
  return (
    <View style={styles.holdingRow}>
      <CardImage uri={v.holding.imageUrl} label={`${k.grader} ${k.grade}`} size={52} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.holdingName} numberOfLines={1}>
          {k.set}
          {k.number ? ` #${k.number}` : ""}
          {k.variant ? ` ${k.variant}` : ""}
        </Text>
        <Text style={styles.holdingSub}>
          {k.grader} {k.grade}
          {v.holding.cert ? ` · cert ${v.holding.cert}` : ""}
        </Text>
        {trend ? <Text style={[styles.holdingTrend, { color: up ? C.green : C.red }]}>{trend}</Text> : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={styles.holdingVal}>{val}</Text>
        {pl ? <Text style={[styles.holdingPL, { color: plUp ? C.green : C.red }]}>{pl}</Text> : null}
      </View>
      {onRemove ? (
        <Pressable onPress={() => onRemove(v.holding.id)} hitSlop={10} style={styles.holdingRemove} accessibilityLabel="Remove card">
          <Text style={styles.holdingRemoveText}>✕</Text>
        </Pressable>
      ) : null}
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
            <CardImage uri={v.holding.imageUrl} label={`${v.holding.key.grader} ${v.holding.key.grade}`} size={66} />
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
                <CardImage uri={r.detection.cropUrl} label="?" size={66} />
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
  brand: { color: C.ink, fontSize: 20, fontWeight: "700", letterSpacing: 2 },
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
  gradeChip: { backgroundColor: "#04122b", borderWidth: 1, borderColor: "#3a72b8", borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  gradeChipText: { color: C.accent, fontWeight: "800", fontSize: 13 },
  ppCert: { color: C.muted, fontSize: 11 },
  verified: { marginLeft: "auto", borderWidth: 1, borderColor: "#3a72b866", borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
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
  addBtnText: { color: "#04122b", fontWeight: "700", fontSize: 13 },
  hint: { color: C.muted, fontSize: 11, marginTop: 8, lineHeight: 15 },
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
  bottomTabText: { fontSize: 11, fontWeight: "600" },

  obWrap: { flex: 1, paddingHorizontal: 26, paddingTop: 40, paddingBottom: 28 },
  obBrand: { color: C.ink, fontSize: 22, fontWeight: "800", letterSpacing: 3 },
  obTitle: { color: C.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginTop: 16, lineHeight: 32 },
  obSub: { color: C.muted, fontSize: 14, marginTop: 10, lineHeight: 20 },
  obRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  obIcon: { width: 46, height: 46, borderRadius: 12, backgroundColor: "#101a2e", borderWidth: 1, borderColor: "rgba(116,177,240,.3)", alignItems: "center", justifyContent: "center" },
  obRowTitle: { color: C.ink, fontSize: 16, fontWeight: "700" },
  obRowSub: { color: C.muted, fontSize: 13, marginTop: 2, lineHeight: 18 },
  obBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  obBtnText: { color: "#04122b", fontSize: 17, fontWeight: "700" },
  ppHeader: { flexDirection: "row", alignItems: "center", marginBottom: 6 },

  libSummary: { flexDirection: "row", gap: 28, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginBottom: 12 },
  libSumV: { color: C.ink, fontSize: 20, fontWeight: "800", fontFamily: MONO },
  libSumL: { color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  libAddLabel: { color: C.ink, fontSize: 14, fontWeight: "600", marginBottom: 6 },
  scanBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: "center" },
  scanBtnText: { color: "#04122b", fontSize: 16, fontWeight: "700" },
  scanBtnSub: { color: "#0a2547", fontSize: 12, marginTop: 2 },
  scanBtnAlt: { borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 11, alignItems: "center", marginTop: 8 },
  scanBtnAltText: { color: C.accent, fontSize: 13, fontWeight: "600" },
  photoPreviewRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  photoPreview: { width: 56, height: 56, borderRadius: 8, backgroundColor: C.panel },
  holdingRow: { flexDirection: "row", alignItems: "center", backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12, marginBottom: 10 },
  holdingName: { color: C.ink, fontSize: 14, fontWeight: "600" },
  holdingSub: { color: C.muted, fontSize: 12, marginTop: 2 },
  holdingTrend: { fontSize: 12, fontWeight: "600", marginTop: 3, fontFamily: MONO },
  holdingVal: { color: C.ink, fontSize: 16, fontWeight: "800", fontFamily: MONO },
  holdingPL: { fontSize: 12, fontWeight: "600", marginTop: 3, fontFamily: MONO },
  holdingRemove: { marginLeft: 8, padding: 4 },
  holdingRemoveText: { color: C.muted, fontSize: 14, fontWeight: "700" },

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
  scanAddText: { color: "#04210f", fontSize: 14, fontWeight: "700" },
});
