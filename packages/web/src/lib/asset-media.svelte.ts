import { api, listRenditions } from "./api.js";
import type { Version } from "./api.js";

/* Per-asset media details for browsing surfaces (thumbnails, hover scrub,
   version counts, transcode chips). Project asset lists carry this data
   inline. The lazy two-read path remains only for older or id-only payloads,
   with bounded concurrency so those surfaces cannot stampede the API. */

export interface AssetMedia {
  versionCount: number;
  currentVersion: Version | null;
  transcodeStatus: string | null;
  posterUrl: string | null;
  spriteUrl: string | null;
  spriteVttUrl: string | null;
}

export interface MediaEntry {
  status: "loading" | "ready" | "failed";
  media?: AssetMedia;
}

interface ObservedAsset {
  id: string;
  current_version_id?: string | null;
  /* A picture chosen for this asset overrides the generated poster on every
     surface that draws a thumbnail. The stamp busts the browser cache when the
     choice changes. */
  has_thumbnail?: boolean;
  updated_at?: number;
  /* The asset list now carries the media facts inline (poster, sprite,
     version count, transcode state); an asset that arrives with them never
     costs a follow-up request. Absent on older payloads and on surfaces that
     only know an id -- those take the two-read path below. */
  media?: {
    version_count: number;
    current_version: Version | null;
    poster_url: string | null;
    sprite_url: string | null;
    sprite_vtt_url: string | null;
  } | null;
}

const CONCURRENCY = 6;

export interface MediaCache {
  readonly entries: Record<string, MediaEntry>;
  request: (asset: ObservedAsset) => void;
  refresh: (asset: ObservedAsset) => void;
  setTranscodeStatus: (assetId: string, status: string) => void;
  /* Svelte action: fetches the asset's media when the node scrolls into
     view. Falls back to an immediate fetch where IntersectionObserver is
     unavailable. */
  observe: (
    node: Element,
    asset: ObservedAsset,
  ) => { update: (asset: ObservedAsset) => void; destroy: () => void };
}

export const createMediaCache = (): MediaCache => {
  const entries = $state<Record<string, MediaEntry>>({});
  const waiting: Array<() => Promise<void>> = [];
  let active = 0;

  const pump = (): void => {
    while (active < CONCURRENCY && waiting.length > 0) {
      const task = waiting.shift();
      if (!task) return;
      active += 1;
      void task().finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  const load = async (asset: ObservedAsset): Promise<void> => {
    try {
      const versions = (
        await api<{ items: Version[] }>(`/api/v1/assets/${asset.id}/versions`)
      ).items;
      const current =
        versions.find((version) => version.id === asset.current_version_id) ??
        versions[0] ??
        null;
      let posterUrl: string | null = null;
      let spriteUrl: string | null = null;
      let spriteVttUrl: string | null = null;
      if (current) {
        try {
          const renditions = (await listRenditions(current.id)).items;
          for (const rendition of renditions) {
            if (rendition.kind === "poster") posterUrl = rendition.url;
            if (rendition.kind === "sprite") {
              spriteUrl = rendition.url;
              spriteVttUrl = rendition.vtt_url;
            }
          }
        } catch {
          /* No renditions yet (still transcoding): keep the text card. */
        }
      }
      entries[asset.id] = {
        status: "ready",
        media: {
          versionCount: versions.length,
          currentVersion: current,
          transcodeStatus: current?.transcode_status ?? null,
          posterUrl: asset.has_thumbnail
            ? `/api/v1/assets/${asset.id}/thumbnail?v=${String(asset.updated_at ?? 0)}`
            : posterUrl,
          spriteUrl,
          spriteVttUrl,
        },
      };
    } catch {
      entries[asset.id] = { status: "failed" };
    }
  };

  const request = (asset: ObservedAsset): void => {
    if (entries[asset.id]) return;
    if (asset.media) {
      entries[asset.id] = {
        status: "ready",
        media: {
          versionCount: asset.media.version_count,
          currentVersion: asset.media.current_version,
          transcodeStatus:
            asset.media.current_version?.transcode_status ?? null,
          posterUrl: asset.has_thumbnail
            ? `/api/v1/assets/${asset.id}/thumbnail?v=${String(asset.updated_at ?? 0)}`
            : asset.media.poster_url,
          spriteUrl: asset.media.sprite_url,
          spriteVttUrl: asset.media.sprite_vtt_url,
        },
      };
      return;
    }
    entries[asset.id] = { status: "loading" };
    waiting.push(() => load(asset));
    pump();
  };

  const refresh = (asset: ObservedAsset): void => {
    /* Only refetch what something already asked for; untouched rows load on
       first visibility as usual. */
    if (!entries[asset.id]) return;
    waiting.push(() => load(asset));
    pump();
  };

  const setTranscodeStatus = (assetId: string, status: string): void => {
    const entry = entries[assetId];
    if (entry?.media)
      entries[assetId] = {
        ...entry,
        media: { ...entry.media, transcodeStatus: status },
      };
  };

  let observer: IntersectionObserver | null = null;
  const observedAssets = new Map<Element, ObservedAsset>();
  const ensureObserver = (): IntersectionObserver | null => {
    if (observer) return observer;
    if (typeof IntersectionObserver === "undefined") return null;
    observer = new IntersectionObserver(
      (intersections) => {
        for (const intersection of intersections) {
          if (!intersection.isIntersecting) continue;
          const asset = observedAssets.get(intersection.target);
          if (asset) request(asset);
          observer?.unobserve(intersection.target);
          observedAssets.delete(intersection.target);
        }
      },
      { rootMargin: "120px" },
    );
    return observer;
  };

  const observe = (
    node: Element,
    asset: ObservedAsset,
  ): { update: (asset: ObservedAsset) => void; destroy: () => void } => {
    const io = ensureObserver();
    if (io) {
      observedAssets.set(node, asset);
      io.observe(node);
    } else {
      request(asset);
    }
    return {
      update(next: ObservedAsset) {
        if (observedAssets.has(node)) observedAssets.set(node, next);
      },
      destroy() {
        observedAssets.delete(node);
        observer?.unobserve(node);
      },
    };
  };

  return {
    get entries() {
      return entries;
    },
    request,
    refresh,
    setTranscodeStatus,
    observe,
  };
};

/* Sprite VTT geometry: each cue points at "sprite.jpg#xywh=x,y,w,h". */
export interface SpriteTile {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const parseSpriteVtt = (text: string): SpriteTile[] => {
  const tiles: SpriteTile[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /#xywh=(\d+),(\d+),(\d+),(\d+)\s*$/.exec(line);
    if (match)
      tiles.push({
        x: Number(match[1]),
        y: Number(match[2]),
        w: Number(match[3]),
        h: Number(match[4]),
      });
  }
  return tiles;
};
