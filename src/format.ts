import type { Guest } from "./types.ts";

// Parses an excerpt anchor as a segment index or elapsed seconds.
export function parseAt(at?: string): {
  kind: "index" | "seconds";
  value: number;
} | null {
  if (at === undefined) return { kind: "index", value: 0 };
  const idx = /^(?:#?t-)?(\d+)$/u.exec(at);
  if (idx) return { kind: "index", value: Number(idx[1]) };
  const hms = /^(\d+):(\d{2}):(\d{2})$/u.exec(at);
  if (hms && Number(hms[2]) < 60 && Number(hms[3]) < 60) {
    const seconds = Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    return { kind: "seconds", value: seconds };
  }
  const ms = /^(\d+):(\d{2})$/u.exec(at);
  if (ms && Number(ms[2]) < 60) {
    return { kind: "seconds", value: Number(ms[1]) * 60 + Number(ms[2]) };
  }
  return null;
}

// Formats an optional duration for episode metadata.
export function duration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// Bounds displayed text while leaving the last word intact when possible.
export function cap(text: string, max: number): string {
  if (text.length <= max) return text.trim();
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

// Gives agents a ready attribution string for the returned page URL.
export const cite = (url: string): string => `Chain of Thought, chainofthought.show — ${url}`;

// Includes company names to distinguish guests with similar names.
export const guestStrings = (guests: Guest[]): string[] => guests.map(g =>
  g.company ? `${g.name} (${g.company})` : g.name
);

// Matches chapter labels without requiring accents in the query.
export const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
