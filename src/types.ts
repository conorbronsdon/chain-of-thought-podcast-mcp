export interface ManifestEntry { slug: string; episode: number; season: number | null; title: string; publishedAt: string | null; guests: string[]; canonicalUrl: string; json: string; hasTranscript: boolean; segmentCount: number }
export interface Manifest { schemaVersion: number; dataUpdatedAt: string; counts: { episodes: number; segments: number; withTranscript?: number }; episodes: ManifestEntry[] }
export interface Guest { name: string; company: string | null }
export interface Chapter { time: string; seconds: number; label: string }
export interface Segment { index: number; time: string; seconds: number; speaker: string; text: string; url: string }
export interface EpisodeFile { schemaVersion: number; episode: number; slug: string; season: number | null; guid: string | null; title: string; canonicalUrl: string; publishedAt: string | null; durationSeconds: number | null; guests: Guest[]; audioUrl: string | null; transistorUrl: string | null; youtubeUrl: string | null; summary: string; chapters: Chapter[]; hasTranscript: boolean; segmentCount: number; transcript: Segment[]; usage?: unknown }
