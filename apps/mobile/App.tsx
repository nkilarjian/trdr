import { useEffect, useState } from "react";
import { Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { alertVM, fairValueVM } from "./src/trdr-ui";
import type { Alert } from "@trdr/core";
import snapshot from "./assets/data.json";

type Passport = {
  key: { set: string; number: string; variant?: string; grader: string; grade: number };
  cert: string | null;
  fairValue: { point: number; lower: number; upper: number; confidence: number; liquidity: number; compCount: number };
  pop: { atGrade: number; higher: number; total: number } | null;
  recent: { date: string; price: number; type: string }[];
};

type Feed = { alerts: Alert[]; passport: Passport };

const FALLBACK = snapshot as unknown as Feed;

// Set EXPO_PUBLIC_API_BASE (e.g. http://192.168.x.x:3000) to fetch live from the
// Fastify API; otherwise the app renders the bundled snapshot offline.
const API_BASE = process.env.EXPO_PUBLIC_API_BASE;

const C = {
  bg: "#0b0e14",
  panel: "#141925",
  panel2: "#1b2230",
  line: "#232c3b",
  ink: "#e6edf3",
  muted: "#8b97a8",
  green: "#3fb950",
  amber: "#d29922",
  red: "#f85149",
  accent: "#74b1f0",
};

const tone = (t: string) => (t === "high" || t === "ok" ? C.green : t === "medium" || t === "caution" ? C.amber : C.red);

export default function App() {
  const [tab, setTab] = useState<"alerts" | "passport">("alerts");
  const [feed, setFeed] = useState<Feed>(FALLBACK);
  const [source, setSource] = useState<"snapshot" | "live">("snapshot");

  useEffect(() => {
    if (!API_BASE) return;
    let active = true;
    fetch(`${API_BASE}/api/v1/feed`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: Feed) => {
        if (active) {
          setFeed(json);
          setSource("live");
        }
      })
      .catch(() => {
        /* unreachable API → keep the bundled snapshot */
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.brand}>TRDR</Text>
        <Text style={styles.sub}>graded-card mispricing terminal</Text>
        <View style={[styles.srcChip, source === "live" ? styles.srcLive : styles.srcSnap]}>
          <Text style={[styles.srcText, { color: source === "live" ? C.green : C.muted }]}>
            {source === "live" ? "live" : "snapshot"}
          </Text>
        </View>
      </View>

      <View style={styles.tabs}>
        <TabButton label={`Alerts · ${feed.alerts.length}`} active={tab === "alerts"} onPress={() => setTab("alerts")} />
        <TabButton label="Passport" active={tab === "passport"} onPress={() => setTab("passport")} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ padding: 16, paddingTop: 8 }}>
        {tab === "alerts" ? <AlertsFeed alerts={feed.alerts} /> : <PassportScreen passport={feed.passport} />}
        <Text style={styles.foot}>
          {source === "live" ? "Live from the model API" : "Bundled snapshot"} on mock data ·{" "}
          {feed.passport.fairValue.compCount} clean comps
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function AlertsFeed({ alerts }: { alerts: Alert[] }) {
  return (
    <View>
      <Text style={styles.colH}>Underpriced alerts</Text>
      {alerts.map((a) => {
        const vm = alertVM(a);
        return (
          <View key={a.itemId} style={styles.card}>
            <View style={styles.alertTop}>
              <View style={[styles.badge, { backgroundColor: a.buyingOption === "AUCTION" ? "#16314f" : "#13301f" }]}>
                <Text style={[styles.badgeText, { color: a.buyingOption === "AUCTION" ? C.accent : "#5ec06f" }]}>
                  {a.buyingOption}
                </Text>
              </View>
              <Text style={styles.alertTitle} numberOfLines={1}>
                {vm.title}
              </Text>
              <Text style={styles.edge}>{vm.edge} edge</Text>
            </View>
            <View style={styles.row}>
              <Stat label={a.buyingOption === "AUCTION" ? "predicted close" : "price now"} value={vm.predictedClose} />
              <Stat label="fair band" value={vm.band.range} />
              <Stat label="confidence" value={vm.band.confidence} color={tone(vm.band.confidenceTone)} />
            </View>
            <View style={styles.row}>
              <View style={[styles.chip, { borderColor: tone(vm.sellerTone) + "66" }]}>
                <Text style={[styles.chipText, { color: tone(vm.sellerTone) }]}>seller: {vm.sellerChip}</Text>
              </View>
            </View>
            <Pressable onPress={() => Linking.openURL(vm.deepLink)}>
              <Text style={styles.cta}>Open on eBay →</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function PassportScreen({ passport: p }: { passport: Passport }) {
  const fv = fairValueVM(p.fairValue as never);
  const span = p.fairValue.upper - p.fairValue.lower || 1;
  const pointPct = ((p.fairValue.point - p.fairValue.lower) / span) * 100;
  const confTone = tone(fv.confidenceTone);

  return (
    <View>
      <Text style={styles.colH}>Card passport</Text>
      <View style={styles.passport}>
        <View style={styles.ppGradeRow}>
          <View style={styles.gradeChip}>
            <Text style={styles.gradeChipText}>
              {p.key.grader} {p.key.grade}
            </Text>
          </View>
          <Text style={styles.ppCert}>cert {p.cert ?? "—"}</Text>
          <View style={styles.verified}>
            <Text style={styles.verifiedText}>verified slab</Text>
          </View>
        </View>

        <Text style={styles.ppName}>
          {p.key.set} #{p.key.number}
          {p.key.variant ? ` ${p.key.variant}` : ""}
        </Text>
        <Text style={styles.ppPoint}>
          {fv.point} <Text style={styles.ppPointSmall}>fair value</Text>
        </Text>

        <View style={styles.band}>
          <View style={[styles.bandPt, { left: `${pointPct}%` }]} />
        </View>
        <View style={styles.bandLbls}>
          <Text style={styles.bandLbl}>{fv.range.split(" – ")[0]}</Text>
          <Text style={styles.bandLbl}>80% band</Text>
          <Text style={styles.bandLbl}>{fv.range.split(" – ")[1]}</Text>
        </View>

        <View style={styles.meter}>
          <View style={[styles.meterFill, { width: `${Math.round(p.fairValue.confidence * 100)}%`, backgroundColor: confTone }]} />
        </View>
        <View style={styles.bandLbls}>
          <Text style={styles.bandLbl}>confidence</Text>
          <Text style={[styles.bandLbl, { color: confTone }]}>{fv.confidence}</Text>
        </View>

        <View style={styles.stats}>
          <BigStat value={`${p.fairValue.compCount}`} label="clean comps" />
          <BigStat value={`${p.fairValue.liquidity.toFixed(2)}/day`} label="liquidity" />
          <BigStat value={p.pop ? `${p.pop.atGrade}` : "—"} label="pop @ grade" />
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
          Distribution, not a number. Band reflects sale dispersion; confidence reflects comp depth, tightness &
          liquidity. Qualified copies segregated; lots, shill wins & relists dropped before estimating.
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, flexDirection: "row", alignItems: "baseline", gap: 10 },
  brand: { color: C.ink, fontSize: 20, fontWeight: "700", letterSpacing: 2 },
  sub: { color: C.muted, fontSize: 12 },
  srcChip: { marginLeft: "auto", borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 2 },
  srcLive: { borderColor: "rgba(63,185,80,.4)" },
  srcSnap: { borderColor: C.line },
  srcText: { fontSize: 11 },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  tab: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: C.line },
  tabActive: { backgroundColor: C.panel2, borderColor: C.accent },
  tabText: { color: C.muted, fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: C.ink },
  scroll: { flex: 1 },
  colH: { color: C.muted, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 },
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
  ppPoint: { color: C.ink, fontSize: 33, fontWeight: "800", letterSpacing: -1 },
  ppPointSmall: { color: C.muted, fontSize: 12, fontWeight: "400" },
  band: { height: 8, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, marginTop: 14, marginBottom: 6, position: "relative" },
  bandPt: { position: "absolute", top: -4, width: 3, height: 16, backgroundColor: C.ink, borderRadius: 2 },
  bandLbls: { flexDirection: "row", justifyContent: "space-between" },
  bandLbl: { color: C.muted, fontSize: 11 },
  meter: { height: 6, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, marginTop: 12, marginBottom: 2, overflow: "hidden" },
  meterFill: { height: "100%" },
  stats: { flexDirection: "row", gap: 10, marginVertical: 16 },
  bigStat: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10 },
  bigStatV: { color: C.ink, fontSize: 16, fontWeight: "700" },
  bigStatL: { color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  histHead: { flexDirection: "row", paddingVertical: 4 },
  histH: { color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  histRow: { flexDirection: "row", paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line },
  histCell: { color: C.ink, fontSize: 12 },
  ppFoot: { color: C.muted, fontSize: 11, lineHeight: 16, marginTop: 14 },
  foot: { color: C.muted, fontSize: 11, textAlign: "center", marginTop: 18, marginBottom: 8 },
});
