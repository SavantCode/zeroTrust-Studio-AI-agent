"use client";

const SOUND_ENABLED_KEY = "zt_sound_notifications_enabled";
const DESKTOP_NOTIFY_KEY = "zt_desktop_notifications_enabled";
const PREF_CHANGE_EVENT = "zt-notification-pref-change";
const TOAST_EVENT = "zt-completion-toast";

export interface CompletionToastPayload {
  id: string;
  kind: "build" | "talk" | "error";
  title: string;
  subtitle: string;
  ts: number;
}

let sharedAudioCtx: AudioContext | null = null;
let titleBlinkTimer: ReturnType<typeof setInterval> | null = null;
let originalDocTitle: string | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === "suspended") {
    sharedAudioCtx.resume().catch(() => {
      // ignore if not yet unlocked by user gesture
    });
  }
  return sharedAudioCtx;
}

/**
 * Unlocks the Web Audio API context on user interaction (e.g. clicking Send or toggling sound)
 * so chimes can play reliably when a long-running AI stream finishes.
 */
export function unlockAudioContext(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  } catch {
    // ignore
  }
}

export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(SOUND_ENABLED_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SOUND_ENABLED_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent(PREF_CHANGE_EVENT));
  } catch {
    // ignore
  }
}

export function isDesktopNotifyEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(DESKTOP_NOTIFY_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export async function requestDesktopNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const perm = await Notification.requestPermission();
    return perm === "granted";
  } catch {
    return false;
  }
}

export function onNotificationPrefChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PREF_CHANGE_EVENT, cb);
  return () => window.removeEventListener(PREF_CHANGE_EVENT, cb);
}

export function onCompletionToast(
  cb: (toast: CompletionToastPayload) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const ce = e as CustomEvent<CompletionToastPayload>;
    if (ce.detail) cb(ce.detail);
  };
  window.addEventListener(TOAST_EVENT, handler);
  return () => window.removeEventListener(TOAST_EVENT, handler);
}

/**
 * Plays a clean, synthesized Web Audio API chime with zero external audio assets.
 * - "build": bright ascending major arpeggio (C5 -> E5 -> G5 -> C6)
 * - "talk": warm 2-note chime (E5 -> B5)
 * - "error": gentle low double-tone (A4 -> E4)
 */
export function playCompletionSound(
  kind: "build" | "talk" | "error" = "build",
  force = false
): void {
  if (!force && !isSoundEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes: Array<{ freq: number; start: number; dur: number; type?: OscillatorType }> =
      kind === "build"
        ? [
            { freq: 523.25, start: 0, dur: 0.14, type: "triangle" }, // C5
            { freq: 659.25, start: 0.09, dur: 0.16, type: "triangle" }, // E5
            { freq: 783.99, start: 0.18, dur: 0.18, type: "triangle" }, // G5
            { freq: 1046.5, start: 0.27, dur: 0.38, type: "sine" }, // C6
          ]
        : kind === "talk"
          ? [
              { freq: 587.33, start: 0, dur: 0.16, type: "sine" }, // D5
              { freq: 880.0, start: 0.11, dur: 0.34, type: "sine" }, // A5
            ]
          : [
              { freq: 440.0, start: 0, dur: 0.16, type: "sawtooth" }, // A4
              { freq: 329.63, start: 0.15, dur: 0.28, type: "sawtooth" }, // E4
            ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type || "sine";
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      const peakGain = kind === "error" ? 0.08 : 0.16;
      gain.gain.setValueAtTime(0.0001, now + n.start);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + n.start + n.dur
      );

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
  } catch {
    // ignore audio autoplay restrictions
  }
}

function flashDocumentTitle(alertText: string): void {
  if (typeof document === "undefined") return;
  if (!originalDocTitle) {
    originalDocTitle = document.title || "Zero-Trust AI Studio (Next.js)";
  }
  if (titleBlinkTimer) {
    clearInterval(titleBlinkTimer);
    titleBlinkTimer = null;
  }

  let toggle = true;
  document.title = alertText;
  titleBlinkTimer = setInterval(() => {
    if (!document.hidden) {
      if (titleBlinkTimer) clearInterval(titleBlinkTimer);
      titleBlinkTimer = null;
      if (originalDocTitle) document.title = originalDocTitle;
      return;
    }
    document.title = toggle
      ? alertText
      : originalDocTitle || "Zero-Trust AI Studio";
    toggle = !toggle;
  }, 1200);

  const stopOnFocus = () => {
    if (titleBlinkTimer) {
      clearInterval(titleBlinkTimer);
      titleBlinkTimer = null;
    }
    if (originalDocTitle) document.title = originalDocTitle;
    window.removeEventListener("focus", stopOnFocus);
  };
  window.addEventListener("focus", stopOnFocus);
}

/**
 * Triggers sound chime, in-app toast banner, tab title flash, and OS desktop notification
 * when the AI finishes building, thinking, or responding.
 */
export function notifyAiCompletion(options: {
  kind: "build" | "talk" | "error";
  title: string;
  subtitle: string;
}): void {
  if (typeof window === "undefined") return;

  // 1. Play synthesized chime
  playCompletionSound(options.kind);

  // 2. Dispatch in-app toast notification
  const payload: CompletionToastPayload = {
    id: `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    kind: options.kind,
    title: options.title,
    subtitle: options.subtitle,
    ts: Date.now(),
  };
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: payload }));

  // 3. Flash tab title if user is looking at another tab/window
  if (typeof document !== "undefined" && document.hidden) {
    flashDocumentTitle(options.title);
  }

  // 4. Trigger Browser Desktop Notification if enabled & permitted
  if (
    isDesktopNotifyEnabled() &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      const n = new Notification(options.title, {
        body: options.subtitle,
        silent: true, // We already play our custom Web Audio chime
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTimeout(() => n.close(), 6000);
    } catch {
      // ignore
    }
  }
}