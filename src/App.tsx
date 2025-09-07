import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * Fake Text Story — Builder + Preview (V21)
 * -------------------------------------------------
 * Changes per request:
 * 1) Live preview is a fixed 470×840 panel (social 9:16 fit) — DOM is scaled to fit while keeping the iMessage HUD pixel geometry intact.
 * 2) Added a single "Overall HUD Scale %" (keeps size & position ratios) so the entire iMessage UI can be made larger/smaller uniformly.
 * 3) Removed traffic-light dots; menu is fully scrollable; messages list is its own scroll area.
 * 4) Numbered wizard tabs: 1. Script → 2. Advanced → 3. Background → 4. Export. You proceed through tabs, then export.
 * 5) Export tab guarantees preview/export parity by a single Render Manifest (download in-canvas). MP4 is produced from this manifest in deployment.
 * 6) Transport scrubber enlarged; kept outside of the HUD; white icons.
 * 7) No bubble tails/flicks. Time separator is the first row inside chat. FaceTime icon is blue stroke-only, same thickness as back chevron.
 */

// ----- tokens -----
const BLUE = "#0A84FF";
const GRAY_BG = "#0B0D12";
const SURFACE = "#0F1115";
const BORDER = "#1f2937";
const TEXT = "#EDEDED";
const SUBTEXT = "#9CA3AF";
const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";

const CANVAS = { w: 1080, h: 1920 }; // design coord-space

// ------------------------ helpers ------------------------
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (ratio: number) => `${Math.round(clamp01(ratio) * 10000) / 100}%`;
const calcPctOffset = (ratio: number, px: number) => `calc(${pct(ratio)} - ${px}px)`;
const rid = () => Math.random().toString(36).slice(2, 10);
function swap<T>(arr: T[], a: number, b: number): T[] { const c = arr.slice(); const t = c[a]; c[a] = c[b]; c[b] = t; return c; }
const initials = (name: string) => (name.trim().split(/\s+/)[0]?.[0] ?? "").toUpperCase();
const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60).toString(); const ss = (s % 60).toString().padStart(2, "0"); return `${m}:${ss}`; };
const bytesToDataUrl = (bytes: Uint8Array, mime: string) => new Promise<string>((resolve) => { const blob = new Blob([bytes], { type: mime }); const fr = new FileReader(); fr.onload = () => resolve(String(fr.result || "")); fr.readAsDataURL(blob); });
const ADAM_LOCAL_WAV = new URL('../VoicePreview/adamtrail.wav', import.meta.url).href;

/** Safe file → dataURL (avoids object-URL policy pitfalls) */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error || new Error("FileReader error"));
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsDataURL(file);
    } catch (e) { reject(e); }
  });
}

// --------------------------- types ---------------------------
export type UISettings = {
  // layout
  hudWidthPct: number;     // 0.50..0.95 (fraction of canvas width)
  hudY: number;            // px from top (pre-scale)
  hudRadius: number;       // 0..44 (pre-scale)
  headerH: number;         // px (pre-scale)
  // elements
  avatarPx: number;        // px (pre-scale)
  iconPx: number;          // px (pre-scale)
  chatMaxH: number;        // visible chat max height (pre-scale)
  // bubbles
  bubbleMaxWidthPct: number; // 0.60..0.95 of HUD width
  bubbleRadius: number;    // px (pre-scale)
  bubblePadH: number;      // px (pre-scale)
  bubblePadV: number;      // px (pre-scale)
  bubbleFontPx: number;    // px (pre-scale)
  tsFontPx: number;        // px (pre-scale)
  // global
  hudScalePct: number;     // 75..140 (%). Uniformly scales HUD size & positions while keeping ratios.
};

const DEFAULT_SETTINGS: UISettings = {
  hudWidthPct: 0.60,
  hudY: 110,
  hudRadius: 25,
  headerH: 92,
  avatarPx: 52,
  iconPx: 36,
  chatMaxH: 320,
  bubbleMaxWidthPct: 0.90,
  bubbleRadius: 18,
  bubblePadH: 18,
  bubblePadV: 12,
  bubbleFontPx: 22,
  tsFontPx: 13,
  hudScalePct: 100,
};

// ---------------------------- Preview Canvas -----------------------------
function FakeTextPreview({
  exportMode = false,
  contactName,
  avatarUrl,
  timeLine,
  messages,
  settings,
  bgColor = "#D0021B",
  durationMs = 60000,
  onTogglePlayExternal,
  timeOverrideMs,
}: {
  exportMode?: boolean;
  contactName: string;
  avatarUrl?: string;
  timeLine: string;
  messages: Array<{ id: string; speaker: "SENDER" | "RECEIVER"; text: string; delay_s?: number; read_receipt?: string | undefined; tapback?: string | null }>;
  settings: UISettings;
  bgColor?: string;
  durationMs?: number;
  onTogglePlayExternal?: (playing: boolean) => void;
  timeOverrideMs?: number;
}) {
  const S = settings.hudScalePct / 100;
  // derive HUD metrics from settings (uniform scale preserves ratios)
  const baseHUDW = Math.round(CANVAS.w * clamp01(settings.hudWidthPct));
  const HUD_W = Math.min(CANVAS.w - 24, Math.max(300, Math.round(baseHUDW * S)));
  const HUD_X = Math.round((CANVAS.w - HUD_W) / 2);
  const HUD_Y = Math.round(settings.hudY * S);
  const HUD_RADIUS = Math.round(settings.hudRadius * S);
  const HEADER_H = Math.max(40, Math.round(settings.headerH * S));
  const AVATAR = Math.round(settings.avatarPx * S);
  const ICON = Math.round(settings.iconPx * S);
  const CHAT_MAX = Math.max(120, Math.round(settings.chatMaxH * S));
  const BUB_MAX_PCT = clamp01(settings.bubbleMaxWidthPct);
  const BUB_R = Math.round(settings.bubbleRadius * S);
  const BUB_PH = Math.round(settings.bubblePadH * S);
  const BUB_PV = Math.round(settings.bubblePadV * S);
  const BUB_F = Math.round(settings.bubbleFontPx * S);
  const TS_F = Math.round(settings.tsFontPx * S);

  const [playing, setPlaying] = useState(!exportMode);
  const [t, setT] = useState(0);
  const raf = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null); // outer container whose HEIGHT grows
  const measureRef = useRef<HTMLDivElement | null>(null); // inner content to measure true height
  const [revealH, setRevealH] = useState<number>(Math.max(100, Math.min(300, CHAT_MAX * 0.5)));

  // schedule: one bubble every 3.000s (or per-message delay)
  const schedule = useMemo(() => {
    let acc = 0; return messages.map((m) => { const d = Math.round(((m.delay_s ?? 3) * 1000)); const at = acc; acc += d; return { id: m.id, at }; });
  }, [messages]);
  const timeMs = exportMode && typeof timeOverrideMs === 'number' ? timeOverrideMs : t;
  const visibleCount = useMemo(() => { let i = 0; while (i < schedule.length && timeMs >= schedule[i].at - 5) i++; return i; }, [timeMs, schedule]);

  // timeline runner
  useEffect(() => {
    // Disable internal timeline when externally controlled (export)
    if (exportMode && typeof timeOverrideMs === 'number') return;
    if (!playing) { if (raf.current) cancelAnimationFrame(raf.current); return; }
    const step = (now: number) => { if (startRef.current == null) startRef.current = now - t; const elapsed = now - startRef.current; setT(elapsed); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step); return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, t, exportMode, timeOverrideMs]);

  // bottom motion & pre-overflow reset (no scroll; height grows)
  useEffect(() => {
    const outer = bodyRef.current; const inner = measureRef.current; if (!outer || !inner) return;
    const maxChatH = Math.min(CHAT_MAX, Math.floor(CANVAS.h * 0.85 - HEADER_H - HUD_Y));
    const contentH = Math.min(maxChatH, inner.scrollHeight + 12);
    const from = revealH; const to = Math.max(100, Math.min(contentH, maxChatH)); if (Math.abs(to - from) < 1) return;
    const steps = 10, dt = 28; let i = 0; const delta = (to - from) / steps;
    const id = setInterval(() => {
      i++; const v = i < steps ? from + delta * i : to; setRevealH(Math.round(v));
      if (i >= steps && to >= maxChatH - 8) setTimeout(() => { setRevealH(Math.max(100, Math.round(maxChatH * 0.5))); startRef.current = performance.now(); setT(0); }, 500);
    }, dt);
    return () => clearInterval(id);
  }, [visibleCount, CHAT_MAX, HEADER_H, HUD_Y]);

  // transport (preview-only)
  const onTogglePlay = () => { const np = !playing; setPlaying(np); onTogglePlayExternal?.(np); };
  const onSeekRatio = (r: number) => { const v = clamp01(r) * durationMs; setT(v); startRef.current = performance.now() - v; };
  const progress = clamp01(timeMs / durationMs);

  return (
    <div style={{ position: "relative", width: CANVAS.w, height: CANVAS.h, background: bgColor, overflow: "hidden" }}>
      {/* iMessage HUD */}
      <div style={{ position: "absolute", left: HUD_X, top: HUD_Y, width: HUD_W, borderRadius: HUD_RADIUS, background: "#0A0A0A", boxShadow: "0 18px 60px rgba(0,0,0,.35)", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ position: "relative", height: HEADER_H, borderBottom: "1px solid #2A2A2A", background: "#1F1F20" }}>
          <button aria-label="Back" onClick={() => {}} style={btnStyle({ left: 16, width: ICON + 22, height: ICON + 22 })}>
            <ChevronLeft color={BLUE} size={ICON} />
          </button>
          <button aria-label="FaceTime" onClick={() => {}} style={btnStyle({ right: 16, width: ICON + 22, height: ICON + 22 })}>
            <FaceTimeLogoOutline color={BLUE} size={ICON} />
          </button>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6 }}>
            <div style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, overflow: "hidden", background: "#C7C7CC", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600 }}>
              {avatarUrl ? (<img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />) : (initials(contactName))}
            </div>
            <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: Math.round(20 * S), color: "#F5F5F7", letterSpacing: "-0.2px" }}>{contactName} <span style={{marginLeft:6, opacity:.9}}>&rsaquo;</span></div>
          </div>
        </div>

        {/* Chat body: HEIGHT grows (no scrolling) */}
        <div ref={bodyRef} style={{ height: revealH, padding: `${Math.round(12*S)}px ${Math.round(16*S)}px ${Math.round(24*S)}px ${Math.round(16*S)}px`, overflow: "hidden", background: "#0A0A0A", pointerEvents: "none" }}>
          <div ref={measureRef}>
            {/* Row 0: time separator INSIDE chat */}
            <div style={{ display: "flex", justifyContent: "center", paddingTop: Math.round(6*S), paddingBottom: Math.round(10*S) }}>
              <div style={{ fontFamily: FONT, fontSize: TS_F, fontWeight: 500, color: "#A9A9AD" }}>{timeLine}</div>
            </div>
            {messages.slice(0, visibleCount).map((m) => (
              <Bubble key={m.id} m={m} maxPct={BUB_MAX_PCT} r={BUB_R} ph={BUB_PH} pv={BUB_PV} f={BUB_F} />
            ))}
          </div>
        </div>
      </div>

      {/* Transport (outside HUD) */}
      {!exportMode && (
        <TransportBar progress={progress} durationMs={durationMs} onSeekRatio={onSeekRatio} onTogglePlay={onTogglePlay} />
      )}
    </div>
  );
}

function Bubble({ m, maxPct, r, ph, pv, f }: { m: any; maxPct: number; r: number; ph: number; pv: number; f: number }) {
  const isSender = m.speaker === "SENDER";
  const bg = isSender ? BLUE : "#1C1C1E";
  const fg = "#FFFFFF";
  const align = isSender ? "flex-end" : "flex-start";
  return (
    <div style={{ display: "flex", justifyContent: align, marginTop: 12 }}>
      <div style={{ maxWidth: pct(maxPct), background: bg, color: fg, padding: `${pv}px ${ph}px`, borderRadius: r, fontFamily: FONT, fontSize: f, lineHeight: 1.22, whiteSpace: "pre-wrap", boxShadow: isSender ? "0 1px 0 rgba(255,255,255,.08) inset" : "none" }}>
        {m.text}
      </div>
    </div>
  );
}

function TransportBar({ progress, durationMs, onSeekRatio, onTogglePlay }: any) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const seekFromEvent = (e: MouseEvent | any) => { const bar = barRef.current; if (!bar) return 0; const rect = bar.getBoundingClientRect(); const ratio = clamp01((e.clientX - rect.left) / rect.width); onSeekRatio(ratio); return ratio; };
  useEffect(() => { if (!dragging) return; const move = (e: MouseEvent) => seekFromEvent(e); const up = () => setDragging(false); window.addEventListener("mousemove", move as any); window.addEventListener("mouseup", up as any, { once: true } as any); return () => { window.removeEventListener("mousemove", move as any); window.removeEventListener("mouseup", up as any); }; }, [dragging]);
  return (
    <div style={{ position: "absolute", left: 24, right: 24, bottom: 24, display: "flex", alignItems: "center", gap: 20, padding: "16px 22px", borderRadius: 20, background: "rgba(0,0,0,.55)", boxShadow: "0 8px 22px rgba(0,0,0,.35)", zIndex: 10, backdropFilter: "saturate(180%) blur(10px)" }}>
      <button aria-label="Play/Pause" onClick={onTogglePlay} style={transportBtn}><PlayPauseIcon /></button>
      <div style={{ color: "#FFF", fontFamily: FONT, fontSize: 20, minWidth: 64, textAlign: "right" }}>{fmt(progress * durationMs)}</div>
      <div ref={barRef} role="slider" tabIndex={0}
        onKeyDown={(e)=>{ if(e.key==="ArrowRight") onSeekRatio(clamp01(progress+0.02)); if(e.key==="ArrowLeft") onSeekRatio(clamp01(progress-0.02)); }}
        onMouseDown={(e)=>{ setDragging(true); const r = seekFromEvent(e.nativeEvent || e); setHoverRatio(r); }}
        onMouseMove={(e)=>{ const bar = barRef.current; if(!bar) return; const rect = bar.getBoundingClientRect(); const r = clamp01(((e.nativeEvent||e).clientX - rect.left)/rect.width); setHoverRatio(r); }}
        onMouseLeave={()=>setHoverRatio(null)}
        style={{ flex: 1, height: 24, borderRadius: 12, background: "rgba(255,255,255,.22)", position: "relative", cursor: "pointer" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: pct(progress), background: "#FFFFFF", borderRadius: 10 }}/>
        {hoverRatio!==null && (<div style={{ position: "absolute", top: -28, left: pct(hoverRatio), transform: "translateX(-50%)", background: "rgba(0,0,0,.75)", color: "#FFF", padding: "2px 6px", borderRadius: 6, fontSize: 12, pointerEvents: "none" }}>{fmt(hoverRatio*durationMs)}</div>)}
        <div style={{ position: "absolute", top: "50%", left: calcPctOffset(progress, 10), width: 20, height: 20, transform: "translateY(-50%)", borderRadius: 10, background: "#FFFFFF", boxShadow: "0 1px 3px rgba(0,0,0,.35)" }}/>
      </div>
      <div style={{ color: "#FFF", fontFamily: FONT, fontSize: 20, minWidth: 56, textAlign: "left" }}>{fmt(durationMs)}</div>
    </div>
  );
}

// ---------------- Builder + Wizard Tabs + Fixed Preview ----------------
function FakeTextBuilder() {
  type Tab = "SCRIPT" | "VOICES" | "ADVANCED" | "BACKGROUND" | "EXPORT";
  const [tab, setTab] = useState<Tab>("SCRIPT");
  const stepIndex = { SCRIPT: 1, VOICES: 2, ADVANCED: 3, BACKGROUND: 4, EXPORT: 5 }[tab];

  // Script state
  const [contactName, setContactName] = useState("Anna");
  const [timeLine, setTimeLine] = useState("Today 7:42 PM");
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Array<{ id: string; speaker: "SENDER"|"RECEIVER"; text: string; delay_s?: number; read_receipt?: string; tapback?: string | null }>>([
    { id: rid(), speaker: "SENDER", text: "Hey, you free?" },
    { id: rid(), speaker: "RECEIVER", text: "Yep! On my way." },
    { id: rid(), speaker: "SENDER", text: "Great—see you soon." },
  ]);

  // Advanced sizing
  const [settings, setSettings] = useState<UISettings>({ ...DEFAULT_SETTINGS });
  const setUI = (patch: Partial<UISettings>) => setSettings((s) => ({ ...s, ...patch }));
  const [showSizing, setShowSizing] = useState(true);

  // Background
  const [bgColor, setBgColor] = useState<string>("#D0021B");

  // TTS / Voices (Async AI)
  const ASYNC_API_BASE = "https://api.async.ai/v1";
  const ASYNC_API_KEY = "sk_d6353f89aae4f33b903dc2b5b87cb890541948de0008f44317700ec765e7a858";
  const ASYNC_TTS_MODEL = "async-tts";
  const [voices, setVoices] = useState<string[]>([]);
  const [senderVoice, setSenderVoice] = useState<string>("");
  const [receiverVoice, setReceiverVoice] = useState<string>("");
  const ADAM_PREVIEW_TEXT = "hey its adam, you know the viral voice on ticktok";
  const [previewing, setPreviewing] = useState<null | 'sender' | 'receiver'>(null);
  const [senderPreviewUrl, setSenderPreviewUrl] = useState<string | null>(null);
  const [receiverPreviewUrl, setReceiverPreviewUrl] = useState<string | null>(null);
  const [voicePreviewCache, setVoicePreviewCache] = useState<Record<string,string>>({});

  const fetchVoices = async () => {
    try {
      // DIRECT: async.ai user voices library endpoint (Your Voices)
      const libraryRes = await fetch(`${ASYNC_API_BASE}/users/me/voices`, { headers: { Authorization: `Bearer ${ASYNC_API_KEY}` } });
      let list: string[] = [];
      if (libraryRes.ok) {
        const data = await libraryRes.json();
        list = Array.isArray(data?.data)
          ? data.data.map((v: any) => v?.id || v?.name).filter(Boolean)
          : Array.isArray(data?.voices)
            ? data.voices.map((v: any) => v?.id || v?.name).filter(Boolean)
            : [];
      }
      const fallback = ["adam","alloy","verse","aria","coral","sage","amber","onxy","rose","pearl","opal"].filter(Boolean);
      let next = (list.length ? list : fallback).slice(0, 64);
      if (!next.includes('adam')) next = ['adam', ...next];
      setVoices(next);
      if (!senderVoice && next[0]) setSenderVoice(next[0]);
      if (!receiverVoice && next[1]) setReceiverVoice(next[1]);
    } catch {
      const fallback = ["adam","alloy","verse","aria","coral","sage","amber","onyx","rose","pearl","opal"];
      setVoices(fallback);
      if (!senderVoice) setSenderVoice(fallback[0]);
      if (!receiverVoice) setReceiverVoice(fallback[1]);
    }
  };
  useEffect(() => { if (voices.length === 0) fetchVoices(); }, []);

  const getOrCreatePreviewUrl = async (voice: string): Promise<string> => {
    try {
      const storageKey = `tts_preview_${voice}`;
      const cached = localStorage.getItem(storageKey);
      if (cached) return cached;
      const line = voice.toLowerCase() === 'adam' ? ADAM_PREVIEW_TEXT : 'Hello, this is a sample voice.';
      const seg = await synthesizeSegment(line, voice, -1);
      const url = await bytesToDataUrl(seg.bytes, 'audio/mpeg');
      try { localStorage.setItem(storageKey, url); } catch {}
      setVoicePreviewCache((c)=>({ ...c, [voice]: url }));
      return url;
    } catch {
      return '';
    }
  };

  // DnD helpers
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const handleDrop = (target: number) => {
    if (dragIndex === null || dragIndex === target) return;
    setMessages((m) => { const c = m.slice(); const [itm] = c.splice(dragIndex, 1); c.splice(target, 0, itm); return c; });
    setDragIndex(null); setDragOverIndex(null);
  };

  // Actions
  const addMsg = () => setMessages((m) => m.concat([{ id: rid(), speaker: "SENDER", text: "New message" }]));
  const delMsg = (id: string) => setMessages((m) => m.filter((x) => x.id !== id));
  const upMsg = (i: number) => setMessages((m) => (i <= 0 ? m.slice() : swap(m, i, i - 1)));
  const dnMsg = (i: number) => setMessages((m) => (i >= m.length - 1 ? m.slice() : swap(m, i, i + 1)));
  const setField = (id: string, patch: Partial<any>) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : { ...x })));

  const swapAll = () => setMessages((m) => m.map((x) => ({ ...x, speaker: x.speaker === "SENDER" ? "RECEIVER" : "SENDER" })));
  const resetDelays = () => setMessages((m) => m.map((x) => ({ ...x, delay_s: undefined })));
  const clearTapbacks = () => setMessages((m) => m.map((x) => ({ ...x, tapback: null })));

  // Avatar safe handler
  const onAvatar = async (e: any) => { const f: File | undefined = e?.target?.files?.[0]; if (!f) return; try { const dataUrl = await fileToDataUrl(f); setAvatarUrl(dataUrl); } catch { setAvatarUrl(undefined); } };

  // Responsive preview geometry: target ~1/3 of viewport width, clamped, centered
  const [viewportW, setViewportW] = useState<number>(typeof window !== 'undefined' ? window.innerWidth : 1440);
  const [viewportH, setViewportH] = useState<number>(typeof window !== 'undefined' ? window.innerHeight : 900);
  useEffect(() => {
    const onResize = () => { setViewportW(window.innerWidth); setViewportH(window.innerHeight); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const isNarrow = viewportW < 1280;
  // Base right-third width, then shrink preview window by 30%
  const baseThirdW = Math.min(Math.max(viewportW * 0.33, 380), 580);
  const PRE_W = Math.round(baseThirdW * 0.70);
  const PRE_H = Math.round(PRE_W * (840 / 470));
  const scale = Math.min(PRE_W / CANVAS.w, PRE_H / CANVAS.h);
  const scaledW = Math.round(CANVAS.w * scale);
  const scaledH = Math.round(CANVAS.h * scale);
  const offsetX = Math.max(0, Math.round((PRE_W - scaledW) / 2));
  const offsetY = Math.max(0, Math.round((PRE_H - scaledH) / 2));

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string>("");

  // Manifest for export parity
  const manifest = useMemo(() => ({
    kind: 'FAKE_TEXT',
    canvas: { width: CANVAS.w, height: CANVAS.h, fps: 30, dpr: 2 },
    background: { type: 'solid', value: bgColor },
    layout: { mode: 'SINGLE' },
    messages,
    meta: { contactName, timeLine },
    settings,
  }), [bgColor, messages, contactName, timeLine, settings]);

  const download = (name: string, data: Blob | string) => {
    const blob = typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  const downloadManifest = () => download('render-manifest.json', JSON.stringify(manifest, null, 2));

  const goNext = () => setTab((t)=> t === 'SCRIPT' ? 'VOICES' : t === 'VOICES' ? 'ADVANCED' : t === 'ADVANCED' ? 'BACKGROUND' : t === 'BACKGROUND' ? 'EXPORT' : 'EXPORT');
  const goPrev = () => setTab((t)=> t === 'EXPORT' ? 'BACKGROUND' : t === 'BACKGROUND' ? 'ADVANCED' : t === 'ADVANCED' ? 'VOICES' : 'SCRIPT');

  // Exact export: render frames from the same DOM using html2canvas, encode with ffmpeg.wasm
  const naturalDurationMs = useMemo(() => {
    // Sum of per-message delays plus a tail pad to match preview pacing
    const total = messages.reduce((acc, m) => acc + Math.round(((m.delay_s ?? 3) * 1000)), 0);
    return Math.max(3000, total + 1500);
  }, [messages]);

  const synthesizeSegment = async (text: string, voice: string, idx: number): Promise<{ bytes: Uint8Array; durationMs: number }> => {
    // Prefer user library voice synthesis if available
    const url = `${ASYNC_API_BASE}/users/me/voices/${encodeURIComponent(voice)}/speech`;
    const fallbackUrl = `${ASYNC_API_BASE}/audio/speech`;
    let res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ASYNC_API_KEY}` }, body: JSON.stringify({ input: text, format: 'mp3' }) });
    if (!res.ok) {
      res = await fetch(fallbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ASYNC_API_KEY}` }, body: JSON.stringify({ model: ASYNC_TTS_MODEL, voice, input: text, format: 'mp3' }) });
    }
    if (!res.ok) throw new Error(`TTS failed (${res.status})`);
    const ab = await res.arrayBuffer();
    // Decode to obtain accurate duration
    const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuf = await ac.decodeAudioData(ab.slice(0));
    const durationMs = Math.round(audioBuf.duration * 1000);
    return { bytes: new Uint8Array(ab), durationMs };
  };

  const previewVoice = async (who: 'sender'|'receiver') => {
    if (previewing) return;
    try {
      setPreviewing(who);
      const voice = who === 'sender' ? (senderVoice || voices[0] || 'adam') : (receiverVoice || voices[1] || voices[0] || 'adam');
      let url: string | null = null;
      if (voice.toLowerCase() === 'adam') {
        // Use local bundled sample for Adam
        url = ADAM_LOCAL_WAV;
      } else {
        const existing = who === 'sender' ? (senderPreviewUrl || voicePreviewCache[voice]) : (receiverPreviewUrl || voicePreviewCache[voice]);
        url = existing || await getOrCreatePreviewUrl(voice);
      }
      if (who === 'sender') setSenderPreviewUrl(url); else setReceiverPreviewUrl(url);
      const audio = new Audio(url); audio.onended = () => setPreviewing(null); await audio.play();
    } catch {
      setPreviewing(null);
    }
  };

  const exportMp4Exact = async () => {
    if (exporting) return;
    try {
      setTab('EXPORT');
      setExporting(true);
      setExportNote('Preparing renderer...');

      // Offscreen mount at full canvas size for perfect parity (1080×1920)
      const off = document.createElement('div');
      Object.assign(off.style, { position: 'fixed', left: '-10000px', top: '0px', width: `${CANVAS.w}px`, height: `${CANVAS.h}px`, background: bgColor, overflow: 'hidden' });
      document.body.appendChild(off);
      const offRoot = createRoot(off);

      // Controlled time container
      const ExportHost: React.FC = () => {
        const [timeMs, setTimeMs] = useState(0);
        (window as any).__setExportTime = setTimeMs;
        return (
          <FakeTextPreview
            exportMode
            contactName={contactName}
            avatarUrl={avatarUrl}
            timeLine={timeLine}
            messages={messages}
            settings={settings}
            bgColor={bgColor}
            durationMs={naturalDurationMs}
            timeOverrideMs={timeMs}
          />
        );
      };
      offRoot.render(<ExportHost />);

      // Wait a frame for layout
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      // 1) Generate TTS per message in order using selected voices
      setExportNote('Generating speech audio…');
      const audioSegBytes: Uint8Array[] = [];
      const audioDurations: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const voice = (m.speaker === 'SENDER' ? senderVoice : receiverVoice) || voices[0] || 'alloy';
        setExportNote(`Generating speech (${i+1}/${messages.length})…`);
        const seg = await synthesizeSegment(m.text, voice, i);
        audioSegBytes.push(seg.bytes);
        audioDurations.push(seg.durationMs);
      }

      // 2) Build an export-specific message schedule using speech durations (next message appears when previous finishes)
      const messagesForExport = messages.map((m, i) => ({ ...m, delay_s: Math.max(0.01, Math.round((audioDurations[i] || 0) / 10) / 100) }));
      // Remount export host with speech-driven schedule
      offRoot.unmount();
      offRoot.render((() => {
        const ExportHost2: React.FC = () => {
          const [timeMs, setTimeMs] = useState(0);
          (window as any).__setExportTime = setTimeMs;
          return (
            <FakeTextPreview
              exportMode
              contactName={contactName}
              avatarUrl={avatarUrl}
              timeLine={timeLine}
              messages={messagesForExport}
              settings={settings}
              bgColor={bgColor}
              durationMs={audioDurations.reduce((a,b)=>a+b,0)}
              timeOverrideMs={timeMs}
            />
          );
        };
        return <ExportHost2 />;
      })());

      await new Promise((r) => requestAnimationFrame(() => r(null)));

      // 3) Capture frames strictly at 30fps along the speech-paced timeline
      setExportNote('Capturing frames…');
      const { default: html2canvas } = await import('html2canvas');
      const fps = 30;
      const dt = Math.round(1000 / fps);
      const frames: Array<Uint8Array> = [];
      const naturalTotalMs = audioDurations.reduce((a,b)=>a+b,0);
      const totalFrames = Math.ceil(naturalTotalMs / dt);

      // Capture the offscreen export DOM to ensure timeline control and no scrubber
      const targetEl = off;

      for (let i = 0; i <= totalFrames; i++) {
        const exportTimelineMs = Math.min(naturalTotalMs, Math.round(i * dt));
        (window as any).__setExportTime(exportTimelineMs);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const canvas = await html2canvas(targetEl, { backgroundColor: null, width: CANVAS.w, height: CANVAS.h, scale: 1, useCORS: true, logging: false });
        const blob: Blob | null = await new Promise<Blob | null>((res) => canvas.toBlob((b: Blob | null) => res(b), 'image/jpeg', 0.85));
        if (!blob) throw new Error('Canvas toBlob failed');
        const ab = await blob.arrayBuffer();
        frames.push(new Uint8Array(ab));
      }

      setExportNote('Encoding audio…');
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ffmpeg = new FFmpeg();
      await ffmpeg.load();

      // Write frames
      for (let i = 0; i < frames.length; i++) {
        const name = `frame_${String(i).padStart(5, '0')}.jpg`;
        await ffmpeg.writeFile(name, frames[i]);
      }

      // Write audio segments and concat using filter_complex to avoid mp3 container issues
      const inputArgs: string[] = [];
      const concatInputs: string[] = [];
      for (let i = 0; i < audioSegBytes.length; i++) {
        const aName = `seg_${String(i).padStart(3,'0')}.mp3`;
        await ffmpeg.writeFile(aName, audioSegBytes[i]);
        inputArgs.push('-i', aName);
        concatInputs.push(`[${i}:a]`);
      }
      const filter = `${concatInputs.join('')}concat=n=${audioSegBytes.length}:v=0:a=1[a]`;
      await ffmpeg.exec([...inputArgs, '-filter_complex', filter, '-map', '[a]', '-c:a', 'aac', 'voice.m4a']);

      setExportNote(`Encoding MP4 (${frames.length} frames @ ${fps}fps)…`);
      await ffmpeg.exec(['-framerate', String(fps), '-i', 'frame_%05d.jpg', '-i', 'voice.m4a', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p', '-shortest', '-movflags', '+faststart', 'out.mp4']);
      const data: any = await ffmpeg.readFile('out.mp4');
      const mp4Blob = new Blob([data.buffer ?? data], { type: 'video/mp4' });
      download('fake-text.mp4', mp4Blob);

      offRoot.unmount(); off.remove();
      setExportNote('');
      setExporting(false);
    } catch (e) {
      setExportNote('Export failed. See console.');
      console.error(e);
      setExporting(false);
    }
  };

  const gridCols = isNarrow ? '1fr' : `minmax(720px, 1fr) ${PRE_W}px`;
  return (
    <div style={{ height: "100vh", overflow: "hidden", display: "grid", gridTemplateColumns: gridCols, gap: 24, alignItems: "start", justifyItems: isNarrow?"stretch":"center", padding: 24, background: GRAY_BG }}>
      {/* Builder column (scrollable) */}
      <div style={{ width: "100%", maxHeight: "calc(100vh - 48px)", overflow: "hidden", borderRadius: 16, border: `1px solid ${BORDER}`, boxShadow: "0 10px 40px rgba(0,0,0,.35)", background: SURFACE }}>
        {/* Title bar (no traffic-lights) */}
        <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", borderBottom: `1px solid ${BORDER}`, background: "linear-gradient(180deg, rgba(28,28,30,.85), rgba(28,28,30,.75))", backdropFilter: "saturate(180%) blur(10px)" }}>
          <div style={{ color: TEXT, fontFamily: FONT, fontSize: 13, opacity: .9 }}>Fake Text Story — Builder</div>
          <div style={{ color: SUBTEXT, fontFamily: FONT, fontSize: 12 }}>Step {stepIndex} of 5</div>
        </div>

        {/* Numbered tabs */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, borderBottom: `1px solid ${BORDER}`, background: "linear-gradient(180deg, rgba(17,17,19,.75), rgba(17,17,19,.60))", backdropFilter: "saturate(180%) blur(8px)" }}>
          <Segmented value={tab} onChange={(k)=>setTab(k as any)} options={[
            { key: "SCRIPT", label: "1. Script" },
            { key: "VOICES", label: "2. Voices" },
            { key: "ADVANCED", label: "3. Advanced" },
            { key: "BACKGROUND", label: "4. Background" },
            { key: "EXPORT", label: "5. Export" },
          ]} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={goPrev} style={toolbarBtn} disabled={tab==='SCRIPT'}>Back</button>
            <button onClick={goNext} style={toolbarBtn} disabled={tab==='EXPORT'}>Next</button>
          </div>
        </div>

        {/* Scroll body */}
        <div style={{ height: "calc(100% - 88px)", overflowY: "auto", padding: 16, fontFamily: FONT, color: TEXT }}>
          {tab === "SCRIPT" && (
            <>
              <section style={card}>
                <h4 style={h4}>Identity</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={lbl}>Contact Name<input style={inp} value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
                  <label style={lbl}>Time Separator<input style={inp} value={timeLine} onChange={(e) => setTimeLine(e.target.value)} placeholder="Today 7:42 PM" /></label>
                  <label style={lbl}>Avatar<input type="file" accept="image/*" onChange={onAvatar} /></label>
                </div>
              </section>

              <section style={card}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <h4 style={{ ...h4, marginBottom: 0, flex: 1 }}>Messages</h4>
                  <button onClick={swapAll} style={btnMini}>Swap All</button>
                  <button onClick={resetDelays} style={btnMini}>Reset Delays</button>
                  <button onClick={clearTapbacks} style={btnMiniDanger}>Clear Tapbacks</button>
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto', marginTop: 8, paddingRight: 4 }}>
                  {messages.map((m, i) => (
                    <div key={m.id}
                      onDragOver={(e)=>{e.preventDefault(); setDragOverIndex(i);}}
                      onDragEnter={()=>setDragOverIndex(i)}
                      onDragLeave={()=>setDragOverIndex(null)}
                      onDrop={()=>handleDrop(i)}
                      style={rowStyle(i===dragIndex, i===dragOverIndex)}>
                      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto auto", gap: 8, alignItems: "center" }}>
                        <div draggable onDragStart={()=>setDragIndex(i)} onDragEnd={()=>{setDragIndex(null); setDragOverIndex(null);}} title="Drag to re-order" style={dragHandle}>⋮⋮</div>
                        <div style={{ display:"flex", gap:8 }}>
                          <button onClick={()=>setField(m.id,{speaker:"SENDER"})} style={speakerPill(m.speaker==="SENDER")} aria-label="Sender">Sender</button>
                          <button onClick={()=>setField(m.id,{speaker:"RECEIVER"})} style={speakerPill(m.speaker==="RECEIVER")} aria-label="Receiver">Receiver</button>
                        </div>
                        <input type="number" min={0} step={0.1} value={m.delay_s ?? ""} placeholder="Delay (s) default 3.0" onChange={(e) => setField(m.id, { delay_s: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ ...inp, width: 160 }} />
                        <button onClick={() => upMsg(i)} style={btnMini} aria-label="Move up">▲</button>
                        <button onClick={() => dnMsg(i)} style={btnMini} aria-label="Move down">▼</button>
                        <button onClick={() => delMsg(m.id)} style={btnMiniDanger} aria-label="Delete">✕</button>
                      </div>
                      <textarea value={m.text} onChange={(e) => setField(m.id, { text: e.target.value })} style={ta} rows={3} />
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input style={inp} placeholder="Read receipt (optional)" value={m.read_receipt || ""} onChange={(e) => setField(m.id, { read_receipt: e.target.value || undefined })} />
                        <select value={m.tapback || ""} onChange={(e) => setField(m.id, { tapback: (e.target.value || null) })} style={sel}>
                          <option value="">Tapback: none</option>
                          <option value="like">Like</option>
                          <option value="love">Love</option>
                          <option value="laugh">Laugh</option>
                          <option value="emphasize">Emphasize</option>
                          <option value="question">Question</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={addMsg} style={{ ...btn, width: "100%", marginTop: 12 }}>Add Message</button>
              </section>
            </>
          )}

          {tab === "VOICES" && (
            <section style={{ ...card, padding:16, background:"linear-gradient(180deg, #0F1115 0%, #0B0D12 100%)", border:`1px solid ${BORDER}`, borderRadius:14, boxShadow:"0 10px 40px rgba(0,0,0,.35)", display:'grid', gap:14 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <h4 style={{...h4, margin:0, fontSize:16}}>Voices</h4>
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={fetchVoices} style={btnPrimary}>Refresh</button>
                </div>
              </div>
              <p style={{opacity:.85, margin:0, fontSize:12}}>Choose premium voices for each speaker and preview before export. Includes Adam (viral TikTok style).</p>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div style={{ padding:12, border:`1px solid ${BORDER}`, borderRadius:12, background:"#0E1014" }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                    <strong>Sender</strong>
                    {senderPreviewUrl && <audio controls src={senderPreviewUrl} style={{height:28}} />}
                  </div>
                  <select style={sel} value={senderVoice} onChange={(e)=>setSenderVoice(e.target.value)}>{voices.map(v=> <option key={v} value={v}>{v}</option>)}</select>
                  <div style={{ display:'flex', gap:8, marginTop:8 }}>
                    <button onClick={()=>previewVoice('sender')} disabled={previewing!==null} style={btnPrimary}>{previewing==='sender'?'Playing…':'Preview'}</button>
                  </div>
                </div>
                <div style={{ padding:12, border:`1px solid ${BORDER}`, borderRadius:12, background:"#0E1014" }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                    <strong>Receiver</strong>
                    {receiverPreviewUrl && <audio controls src={receiverPreviewUrl} style={{height:28}} />}
                  </div>
                  <select style={sel} value={receiverVoice} onChange={(e)=>setReceiverVoice(e.target.value)}>{voices.map(v=> <option key={v} value={v}>{v}</option>)}</select>
                  <div style={{ display:'flex', gap:8, marginTop:8 }}>
                    <button onClick={()=>previewVoice('receiver')} disabled={previewing!==null} style={btnPrimary}>{previewing==='receiver'?'Playing…':'Preview'}</button>
                  </div>
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:12 }}>
                <div style={{ fontSize:12, color:SUBTEXT }}>Powered by Async AI</div>
              </div>
            </section>
          )}

          {tab === "ADVANCED" && (
            <section style={card}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                <button onClick={()=>setShowSizing(s=>!s)} style={collapseHdrBtn} aria-expanded={showSizing} aria-controls="sizing-panel">
                  <span style={{display:"inline-block",transform: showSizing?"rotate(90deg)":"rotate(0deg)", transition:"transform .18s ease"}}>▸</span>
                  <strong style={{marginLeft:6}}>Sizing Controls</strong>
                </button>
                <button onClick={()=>setSettings({...DEFAULT_SETTINGS})} style={btnPrimary}>Reset to default</button>
              </div>
              {showSizing && (
                <div id="sizing-panel" style={{marginTop:8}}>
                  <SliderRow label="Overall HUD scale %" min={50} max={240} value={settings.hudScalePct} onChange={(v)=>setUI({hudScalePct:v})} />
                  <SliderRow label="HUD width %" min={45} max={98} value={Math.round(settings.hudWidthPct*100)} onChange={(v)=>setUI({hudWidthPct:v/100})} />
                  <SliderRow label="HUD Y (px)" min={40} max={320} value={settings.hudY} onChange={(v)=>setUI({hudY:v})} />
                  <SliderRow label="HUD radius" min={0} max={44} value={settings.hudRadius} onChange={(v)=>setUI({hudRadius:v})} />
                  <SliderRow label="Header height" min={42} max={96} value={settings.headerH} onChange={(v)=>setUI({headerH:v})} />
                  <SliderRow label="Avatar size" min={36} max={80} value={settings.avatarPx} onChange={(v)=>setUI({avatarPx:v})} />
                  <SliderRow label="Icon size" min={18} max={36} value={settings.iconPx} onChange={(v)=>setUI({iconPx:v})} />
                  <SliderRow label="Chat max height" min={150} max={560} value={settings.chatMaxH} onChange={(v)=>setUI({chatMaxH:v})} />
                  <SliderRow label="Bubble max width %" min={60} max={95} value={Math.round(settings.bubbleMaxWidthPct*100)} onChange={(v)=>setUI({bubbleMaxWidthPct:v/100})} />
                  <SliderRow label="Bubble radius" min={12} max={28} value={settings.bubbleRadius} onChange={(v)=>setUI({bubbleRadius:v})} />
                  <SliderRow label="Bubble pad H" min={10} max={28} value={settings.bubblePadH} onChange={(v)=>setUI({bubblePadH:v})} />
                  <SliderRow label="Bubble pad V" min={8} max={22} value={settings.bubblePadV} onChange={(v)=>setUI({bubblePadV:v})} />
                  <SliderRow label="Bubble font px" min={16} max={28} value={settings.bubbleFontPx} onChange={(v)=>setUI({bubbleFontPx:v})} />
                  <SliderRow label="Timestamp font px" min={11} max={18} value={settings.tsFontPx} onChange={(v)=>setUI({tsFontPx:v})} />
                </div>
              )}
            </section>
          )}

          {tab === "BACKGROUND" && (
            <section style={card}>
              <h4 style={h4}>Background</h4>
              <p style={{opacity:.8, marginTop:0, marginBottom:8, fontSize:12}}>Choose a solid background color for the canvas (export uses the same).</p>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(9, 1fr)", gap:10 }}>
                {["#D0021B","#000000","#111827","#0A84FF","#1C1C1E","#10B981","#F59E0B","#8B5CF6","#FFFFFF"].map((c)=> (
                  <button key={c} onClick={()=>setBgColor(c)} title={c} style={{ width:32, height:32, borderRadius:8, border: `2px solid ${bgColor===c?BLUE:BORDER}`, background: c }} />
                ))}
              </div>
              <div style={{marginTop:12}}>
                <label style={lbl}>Custom hex
                  <input style={inp} placeholder="#RRGGBB" value={bgColor} onChange={(e)=>setBgColor(e.target.value)} />
                </label>
              </div>
            </section>
          )}

          {tab === "EXPORT" && (
            <section style={card}>
              <h4 style={h4}>Export</h4>
              <p style={{ marginTop: 0, color: SUBTEXT, fontSize: 13 }}>Render an MP4 that matches the live preview exactly. This runs fully in-browser; large exports can take a while.</p>
              <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems:'center' }}>
                <button onClick={exportMp4Exact} disabled={exporting} style={btnPrimary}>{exporting? 'Rendering…' : 'Render MP4 (exact)'}</button>
                <button onClick={downloadManifest} style={toolbarBtn}>Download Render Manifest (.json)</button>
              </div>
              {exporting && (
                <div style={{ marginTop: 10, color: SUBTEXT, fontSize: 12 }}>{exportNote}</div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* Responsive, centered preview column (~one-third width) */}
      <div style={{ width: PRE_W, height: "calc(100vh - 48px)", position: isNarrow?"static":"sticky", top: 24, display: "flex", alignItems: "flex-start", justifyContent: "center", margin: isNarrow?"0 auto":undefined }}>
        <div id="preview-box" style={{ position: 'relative', width: PRE_W, height: PRE_H, background: "#000", borderRadius: 20, overflow: "hidden", boxShadow: "0 20px 80px rgba(0,0,0,.45)" }}>
          <div style={{ position: 'absolute', left: offsetX, top: offsetY, width: CANVAS.w, height: CANVAS.h, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <FakeTextPreview contactName={contactName} avatarUrl={avatarUrl} timeLine={timeLine} messages={messages} settings={settings} bgColor={bgColor} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderRow({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "180px 1fr 72px", alignItems: "center", gap: 8, margin: "8px 0" }}>
      <span style={{ fontSize: 12, opacity: 0.9 }}>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e)=>onChange(Number((e.target as HTMLInputElement).value))} />
      <input type="number" min={min} max={max} value={value} onChange={(e)=>onChange(Number((e.target as HTMLInputElement).value))} style={{ ...inp, padding: "6px 8px" }} />
    </label>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (k: string)=>void; options: Array<{key: string; label: string}> }){
  return (
    <div role="tablist" aria-label="Sections" style={{ display: "inline-flex", padding: 2, borderRadius: 10, background: "rgba(255,255,255,.06)", border: `1px solid ${BORDER}`, boxShadow: "inset 0 -1px 0 rgba(255,255,255,.04)" }}>
      {options.map((o, idx) => {
        const active = value === o.key;
        return (
          <button key={o.key} role="tab" aria-selected={active} onClick={()=>onChange(o.key)}
            style={{ padding: "8px 14px", fontFamily: FONT, fontSize: 13, fontWeight: 600, color: active?"#E6F0FF":"#D1D5DB", background: active?"rgba(10,132,255,.18)":"transparent", border: `1px solid ${active?BLUE:"transparent"}`, borderRadius: 8, marginLeft: idx?4:0, cursor: "pointer", transition: "all .12s ease" }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------- Styles & Icons ----------------
const card: React.CSSProperties = { padding: 12, borderRadius: 12, background: SURFACE, border: `1px solid ${BORDER}`, marginTop: 12 };
const h4: React.CSSProperties = { margin: "0 0 8px", fontSize: 14 };
const lbl: React.CSSProperties = { display: "block", marginTop: 8, fontSize: 12, opacity: 0.9 };
const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#171717", color: TEXT, marginTop: 6, outline: "none" };
const sel: React.CSSProperties = { ...inp };
const ta: React.CSSProperties = { ...inp, fontFamily: FONT };
const btn: React.CSSProperties = { padding: "10px 12px", borderRadius: 10, border: `1px solid ${BLUE}`, background: "rgba(10,132,255,.10)", color: "#EAF2FF", cursor: "pointer", fontFamily: FONT, fontWeight: 600 };
const btnMini: React.CSSProperties = { padding: "6px 8px", borderRadius: 8, border: `1px solid ${BLUE}`, background: "rgba(10,132,255,.08)", color: "#EAF2FF", cursor: "pointer", fontFamily: FONT };
const btnMiniDanger: React.CSSProperties = { ...btnMini, border: "1px solid #512626", background: "#2A1414", color: "#FFD1D1" };

const toolbarBtn: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "rgba(255,255,255,.04)", color: SUBTEXT, cursor: "pointer", fontFamily: FONT };
const btnPrimary: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, border: `1px solid ${BLUE}`, background: "rgba(10,132,255,.12)", color: "#E6F0FF", cursor: "pointer", fontWeight: 600 };
const collapseHdrBtn: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "rgba(255,255,255,.04)", color: TEXT, cursor: "pointer", fontFamily: FONT };

const speakerPill = (active: boolean): React.CSSProperties => ({ padding: "6px 10px", borderRadius: 9999, border: `1px solid ${active?BLUE:BORDER}`, background: active ? "rgba(10,132,255,.18)" : "rgba(255,255,255,.04)", color: active ? "#FFF" : "#DDD", cursor: "pointer", fontFamily: FONT, fontWeight: 600 });
const dragHandle: React.CSSProperties = { width: 18, color: "#99A3AE", cursor: "grab", userSelect: "none", textAlign: "center" };
const rowStyle = (isDragging?: boolean, isOver?: boolean): React.CSSProperties => ({ marginTop: 12, padding: 12, borderRadius: 12, background: "#14161B", border: `1px solid ${isOver?BLUE:BORDER}`, transition: "transform .14s ease, box-shadow .14s ease, opacity .14s", transform: isDragging?"translateX(6px) scale(1.02)":undefined, boxShadow: isDragging?"0 14px 34px rgba(0,0,0,.5)":undefined, opacity: isDragging?0.9:1 });
const btnStyle = (pos: Partial<React.CSSProperties>): React.CSSProperties => ({ position: "absolute", top: "50%", transform: "translateY(-50%)", width: 44, height: 44, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", color: BLUE, cursor: "pointer", ...pos });
const transportBtn: React.CSSProperties = { width: 48, height: 48, borderRadius: 12, border: "1px solid rgba(255,255,255,.28)", background: "rgba(0,0,0,.35)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };

function ChevronLeft({ color = BLUE, size = 22 }: { color?: string; size?: number }) { return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18l-6-6 6-6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>); }
function FaceTimeLogoOutline({ color = BLUE, size = 22 }: { color?: string; size?: number }) { return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M16 10 L21 7 L21 17 L16 14 Z" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>); }
function PlayPauseIcon() { return (<svg width="22" height="22" viewBox="0 0 24 24" fill="#FFF" aria-hidden="true"><path d="M8 5v14l11-7z"/><path d="M6 5h4v14H6z" opacity=".0"/></svg>); }

export default function App(){
  // Self-tests to guard immutability & helpers
  if (typeof window !== "undefined") {
    const a = [{ id: "1", speaker: "SENDER", text: "a" }, { id: "2", speaker: "RECEIVER", text: "b" }];
    const b = swap(a, 0, 1); console.assert(a !== b && a[0].id === "1" && b[0].id === "2", "swap() immutability");
    const c = a.map((x) => ({ ...x, text: x.text.toUpperCase() })); console.assert(c !== a && c[0].text === "A" && a[0].text === "a", "map clone immutability");
    console.assert(pct(0.335).endsWith("%"), "pct() percent");
    console.assert(typeof calcPctOffset(0.5, 8) === "string", "calcPctOffset string");
  }
  return (
    <>
      <FakeTextBuilder />
    </>
  );
}


