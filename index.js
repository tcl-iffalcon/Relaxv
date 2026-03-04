const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
//  CONFIG
// ============================================================
const RD_API_KEY   = process.env.RD_API_KEY   || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TORRENTIO    = "https://torrentio.strem.fun";
const PORT         = process.env.PORT || 7000;

// ============================================================
//  IN-MEMORY CACHE
// ============================================================
class TTLCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.store = new Map();
    this.ttl   = ttlMs;
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this.store.delete(key); return null; }
    return entry.value;
  }
  set(key, value) {
    this.store.set(key, { value, expires: Date.now() + this.ttl });
  }
}

const catalogCache = new TTLCache(6 * 60 * 60 * 1000); // 6 hours
const streamCache  = new TTLCache(5 * 60 * 1000);       // 5 min

// ============================================================
//  TORRENTIO CONFIG
// ============================================================
const TORRENTIO_CONFIG = [
  "providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,horriblesubs,nyaasi,tokyotosho,anidex",
  "sort=qualitysize",
  `realdebrid=${RD_API_KEY}`,
].join("|");

// ============================================================
//  4K+ QUALITY FILTER
// ============================================================
const QUALITY_PATTERNS = [
  /\b2160p\b/i,
  /\b4K\b/i,
  /\bUHD\b/i,
  /\bBlu[-.]?Ray\b/i,
  /\bBD[-.]?Remux\b/i,
  /\bRemux\b/i,
  /\bBDRip\b/i,
  /\bHDR(?:10)?(?:\+)?\b/i,
  /\bDolby\.?Vision\b/i,
  /(?<![A-Z])\bDV\b(?!D)/,
  /\bIMAX\b/i,
];

function isHighQuality(title = "") {
  return QUALITY_PATTERNS.some((re) => re.test(title));
}

// ============================================================
//  MANIFEST
// ============================================================
const manifest = {
  id: "community.rd4kultrahd",
  version: "1.6.0",
  name: "Relaxv Addon",
  description:
    "Sadece Real-Debrid üzerinden 4K/UHD/BluRay/Remux/HDR/DV stream'i olan içerikleri gösterir.",
  logo:       "https://i.imgur.com/MZnPBgW.png",
  background: "https://i.imgur.com/LkrxS4J.jpg",
  catalogs: [
    {
      type: "movie",
      id:   "rd4k-movies-popular",
      name: "4K • Popüler Filmler",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "movie",
      id:   "rd4k-movies-toprated",
      name: "4K • En Yüksek Puanlı Filmler",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id:   "rd4k-series-popular",
      name: "4K • Popüler Diziler",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id:   "rd4k-series-toprated",
      name: "4K • En Yüksek Puanlı Diziler",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
  resources:   ["catalog", "stream"],
  types:       ["movie", "series"],
  idPrefixes:  ["tt"],
  behaviorHints: { configurable: false, adult: false },
};

const builder = new addonBuilder(manifest);

// ============================================================
//  HELPERS
// ============================================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG  = "https://image.tmdb.org/t/p/w500";

const TMDB_ENDPOINTS = {
  "rd4k-movies-popular":  { tmdbType: "movie", path: "popular"   },
  "rd4k-movies-toprated": { tmdbType: "movie", path: "top_rated" },
  "rd4k-series-popular":  { tmdbType: "tv",    path: "popular"   },
  "rd4k-series-toprated": { tmdbType: "tv",    path: "top_rated" },
};

// warmup state: tracks which catalogs are currently being built
const warmupInProgress = new Set();

// ============================================================
//  TORRENTIO — check if a single item has any 4K stream
// ============================================================
async function has4KStream(stremioType, imdbId) {
  const url = `${TORRENTIO}/${TORRENTIO_CONFIG}/stream/${stremioType}/${imdbId}.json`;
  try {
    const res = await axios.get(url, { timeout: 12000 });
    const streams = res.data?.streams || [];
    return streams.some((s) => {
      const text = `${s.title || ""} ${s.name || ""}`.replace(/\n/g, " ");
      return isHighQuality(text);
    });
  } catch {
    return false;
  }
}

// ============================================================
//  TMDB — fetch items and resolve IMDB IDs
// ============================================================
async function fetchTMDBItems(tmdbType, path) {
  if (!TMDB_API_KEY) {
    console.error("[TMDB] TMDB_API_KEY is not set! Add it in Render → Environment Variables.");
    return [];
  }
  console.log(`[TMDB] Fetching ${tmdbType}/${path}, key: ${TMDB_API_KEY.slice(0,6)}...`);

  const [p1, p2] = await Promise.all([
    axios.get(`${TMDB_BASE}/${tmdbType}/${path}`, {
      params: { api_key: TMDB_API_KEY, language: "tr-TR", page: 1 },
      timeout: 10000,
    }),
    axios.get(`${TMDB_BASE}/${tmdbType}/${path}`, {
      params: { api_key: TMDB_API_KEY, language: "tr-TR", page: 2 },
      timeout: 10000,
    }),
  ]);

  const items = [...(p1.data?.results || []), ...(p2.data?.results || [])];
  console.log(`[TMDB] Got ${items.length} items from TMDB`);

  // Resolve IMDB IDs in batches of 10
  const resolved = [];
  for (let i = 0; i < items.length; i += 10) {
    const batch = await Promise.all(
      items.slice(i, i + 10).map(async (item) => {
        try {
          const ext = await axios.get(
            `${TMDB_BASE}/${tmdbType}/${item.id}/external_ids`,
            { params: { api_key: TMDB_API_KEY }, timeout: 6000 }
          );
          const imdbId = ext.data?.imdb_id;
          if (!imdbId) return null;
          return {
            imdbId,
            stremioType: tmdbType === "movie" ? "movie" : "series",
            name:        item.title || item.name || "",
            poster:      item.poster_path   ? `${TMDB_IMG}${item.poster_path}` : null,
            background:  item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
            description: item.overview || "",
            year:        (item.release_date || item.first_air_date || "").slice(0, 4),
            imdbRating:  item.vote_average  ? String(item.vote_average.toFixed(1)) : undefined,
          };
        } catch { return null; }
      })
    );
    resolved.push(...batch.filter(Boolean));
    await delay(100);
  }
  return resolved;
}

// ============================================================
//  CACHE WARMUP
//  Runs in background — checks each item for 4K availability
//  Processes in batches of 5 with 1s delay to avoid rate limits
// ============================================================
async function warmupCatalog(catalogId, tmdbType, path) {
  if (warmupInProgress.has(catalogId)) return;
  warmupInProgress.add(catalogId);

  console.log(`[warmup:${catalogId}] Starting...`);
  const stremioType = tmdbType === "movie" ? "movie" : "series";

  try {
    const items = await fetchTMDBItems(tmdbType, path);
    console.log(`[warmup:${catalogId}] Checking ${items.length} items for 4K streams...`);

    const verified = [];
    for (let i = 0; i < items.length; i += 5) {
      const batch = items.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (item) => {
          const ok = await has4KStream(stremioType, item.imdbId);
          if (ok) console.log(`[warmup:${catalogId}] ✅ 4K found: ${item.name} (${item.imdbId})`);
          return ok ? item : null;
        })
      );
      verified.push(...results.filter(Boolean));
      await delay(1000); // 1s between batches — be kind to Torrentio
    }

    // Convert to Stremio meta format and store
    const metas = verified.map((item) => ({
      id:          item.imdbId,
      type:        stremioType,
      name:        item.name,
      poster:      item.poster,
      background:  item.background,
      description: item.description,
      year:        item.year,
      imdbRating:  item.imdbRating,
    }));

    catalogCache.set(catalogId, metas);
    console.log(`[warmup:${catalogId}] ✅ Done — ${metas.length} items with 4K streams cached.`);
  } catch (err) {
    console.error(`[warmup:${catalogId}] Error:`, err.message);
  } finally {
    warmupInProgress.delete(catalogId);
  }
}

// ============================================================
//  STREAM HELPERS
// ============================================================

function filterHighQuality(streams) {
  return streams.filter((s) => {
    const text = `${s.title || ""} ${s.name || ""}`.replace(/\n/g, " ");
    return isHighQuality(text);
  });
}

function qualityBadge(title) {
  const tags = [];
  if (/\bRemux\b/i.test(title))                            tags.push("REMUX");
  if (/\bBlu[-.]?Ray\b/i.test(title))                      tags.push("BluRay");
  if (/\bHDR10\+/i.test(title))                            tags.push("HDR10+");
  else if (/\bHDR10\b/i.test(title))                       tags.push("HDR10");
  else if (/\bHDR\b/i.test(title))                         tags.push("HDR");
  if (/Dolby\.?Vision|(?<![A-Z])\bDV\b(?!D)/.test(title)) tags.push("DV");
  if (/\bIMAX\b/i.test(title))                             tags.push("IMAX");
  if (/\b2160p\b/i.test(title))                            tags.push("2160p");
  return tags.length ? `[${tags.join(" | ")}]` : "[4K]";
}

function formatStream(s) {
  if (!s.url) return null;
  const title = `${s.title || ""} ${s.name || ""}`.replace(/\n/g, " ").trim();
  return {
    name:        `🔴 RD ${qualityBadge(title)}`,
    description: s.title || s.name || "",
    url:         s.url,
    behaviorHints: {
      bingeGroup:  s.behaviorHints?.bingeGroup,
      notWebReady: false,
    },
  };
}

async function fetchTorrentioStreams(type, id) {
  const cacheKey = `streams:${type}:${id}`;
  const cached   = streamCache.get(cacheKey);
  if (cached) return cached;

  const url = `${TORRENTIO}/${TORRENTIO_CONFIG}/stream/${type}/${id}.json`;
  try {
    const res     = await axios.get(url, { timeout: 15000 });
    const streams = res.data?.streams || [];
    streamCache.set(cacheKey, streams);
    return streams;
  } catch (err) {
    console.error(`Torrentio error [${id}]:`, err.message);
    return [];
  }
}

// ============================================================
//  CATALOG HANDLER
// ============================================================
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const keyword = (extra?.search || "").trim();

  // ── Search mode ─────────────────────────────────────────
  if (keyword) {
    if (!TMDB_API_KEY) return { metas: [] };
    try {
      const tmdbType = type === "movie" ? "movie" : "tv";
      const res = await axios.get(`${TMDB_BASE}/search/${tmdbType}`, {
        params: { api_key: TMDB_API_KEY, query: keyword, language: "tr-TR" },
        timeout: 10000,
      });
      const items = (res.data?.results || []).slice(0, 20);
      const metas = await Promise.all(
        items.map(async (item) => {
          try {
            const ext = await axios.get(
              `${TMDB_BASE}/${tmdbType}/${item.id}/external_ids`,
              { params: { api_key: TMDB_API_KEY }, timeout: 6000 }
            );
            const imdbId = ext.data?.imdb_id;
            if (!imdbId) return null;
            return {
              id:          imdbId,
              type,
              name:        item.title || item.name || "",
              poster:      item.poster_path   ? `${TMDB_IMG}${item.poster_path}` : null,
              background:  item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
              description: item.overview || "",
              year:        (item.release_date || item.first_air_date || "").slice(0, 4),
            };
          } catch { return null; }
        })
      );
      return { metas: metas.filter(Boolean) };
    } catch (err) {
      console.error("Search error:", err.message);
      return { metas: [] };
    }
  }

  // ── Normal catalog ───────────────────────────────────────
  const endpoint = TMDB_ENDPOINTS[id];
  if (!endpoint) return { metas: [] };

  const cached = catalogCache.get(id);

  if (cached) {
    // Cache var → anında dön, ama süresi yaklaşıyorsa arka planda yenile
    return { metas: cached };
  }

  // Cache yok → arka planda warmup başlat, şimdilik boş dön
  // (Stremio birkaç saniyede bir retry atar, warmup bitince dolu gelir)
  warmupCatalog(id, endpoint.tmdbType, endpoint.path);

  return {
    metas: [{
      id:   "tt0000001",
      type,
      name: "⏳ 4K içerikler kontrol ediliyor...",
      poster: "https://i.imgur.com/MZnPBgW.png",
      description: "Real-Debrid üzerinden 4K stream'leri olan içerikler yükleniyor. Lütfen 1-2 dakika bekleyin ve sayfayı yenileyin.",
    }],
  };
});

// ============================================================
//  STREAM HANDLER
// ============================================================
builder.defineStreamHandler(async ({ type, id }) => {
  if (!RD_API_KEY) {
    return {
      streams: [{
        name:        "⚠️ Hata",
        description: "RD_API_KEY tanımlanmamış. Render → Environment Variables kontrol et.",
        url:         "https://real-debrid.com",
      }],
    };
  }

  try {
    const all      = await fetchTorrentioStreams(type, id);
    const filtered = filterHighQuality(all);
    const streams  = filtered.map(formatStream).filter(Boolean).slice(0, 20);

    console.log(`[${id}] Total: ${all.length} | 4K+ filtered: ${filtered.length} | served: ${streams.length}`);
    return { streams };
  } catch (err) {
    console.error("Stream error:", err.message);
    return { streams: [] };
  }
});

// ============================================================
//  SERVER + STARTUP WARMUP
// ============================================================
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`
✅  RD 4K Ultra HD Addon v1.6.0 running`);
console.log(`🔑  RD_API_KEY:   ${RD_API_KEY   ? '✅ set' : '❌ MISSING'}`);
console.log(`🎬  TMDB_API_KEY: ${TMDB_API_KEY ? '✅ set' : '❌ MISSING'}`);
console.log(`🌐  http://localhost:${PORT}/manifest.json\n`);

// Kick off background warmup for all catalogs on startup
// Staggered by 5s so they don't all hammer Torrentio at once
if (RD_API_KEY && TMDB_API_KEY) {
  Object.entries(TMDB_ENDPOINTS).forEach(([catalogId, endpoint], i) => {
    setTimeout(() => {
      warmupCatalog(catalogId, endpoint.tmdbType, endpoint.path);
    }, i * 5000);
  });
}
