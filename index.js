const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
//  CONFIG
// ============================================================
const RD_API_KEY = process.env.RD_API_KEY || "";
const TORRENTIO  = "https://torrentio.strem.fun";
const PORT       = process.env.PORT || 7000;

// ============================================================
//  SIMPLE IN-MEMORY CACHE
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

const metaCache   = new TTLCache(30 * 60 * 1000); // 30 min
const streamCache = new TTLCache( 5 * 60 * 1000); // 5 min

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
  /(?<![A-Z])\bDV\b(?!D)/,      // DV but NOT DVD
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
  version: "1.4.0",
  name: "Relaxv Addon",
  description:
    "Stremio ve Nuvio için Real-Debrid kullanarak Torrentio kaynaklarından yalnızca 4K/UHD/BluRay/Remux/HDR/DV içerikler sunar.",
  logo:       "https://i.imgur.com/MZnPBgW.png",
  background: "https://i.imgur.com/LkrxS4J.jpg",
  catalogs: [
    {
      type: "movie",
      id:   "rd4k-movies",
      name: "4K Ultra HD Filmler",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id:   "rd4k-series",
      name: "4K Ultra HD Diziler",
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

/** Small async delay */
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Run promises in batches with a pause between each batch.
 * Smaller batch size + delay prevents Cinemeta rate limiting.
 */
async function batchedAll(items, fn, batchSize = 8, delayMs = 250) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
    if (i + batchSize < items.length) await delay(delayMs);
  }
  return results;
}

/** Fetch stream list from Torrentio (with cache) */
async function fetchTorrentioStreams(type, id) {
  const cacheKey = `streams:${type}:${id}`;
  const cached   = streamCache.get(cacheKey);
  if (cached) return cached;

  const url = `${TORRENTIO}/${TORRENTIO_CONFIG}/stream/${type}/${id}.json`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const streams = res.data?.streams || [];
    streamCache.set(cacheKey, streams);
    return streams;
  } catch (err) {
    console.error(`Torrentio error [${id}]:`, err.message);
    return [];
  }
}

/** Filter to only 4K+ quality streams */
function filterHighQuality(streams) {
  return streams.filter((s) => {
    const text = `${s.title || ""} ${s.name || ""}`.replace(/\n/g, " ");
    return isHighQuality(text);
  });
}

/** Build quality badge tags from title string */
function qualityBadge(title) {
  const tags = [];
  if (/\bRemux\b/i.test(title))                               tags.push("REMUX");
  if (/\bBlu[-.]?Ray\b/i.test(title))                         tags.push("BluRay");
  if (/\bHDR10\+/i.test(title))                               tags.push("HDR10+");
  else if (/\bHDR10\b/i.test(title))                          tags.push("HDR10");
  else if (/\bHDR\b/i.test(title))                            tags.push("HDR");
  if (/Dolby\.?Vision|(?<![A-Z])\bDV\b(?!D)/.test(title))    tags.push("DV");
  if (/\bIMAX\b/i.test(title))                                tags.push("IMAX");
  if (/\b2160p\b/i.test(title))                               tags.push("2160p");
  return tags.length ? `[${tags.join(" | ")}]` : "[4K]";
}

/** Convert a Torrentio stream object to Stremio format */
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

/**
 * Fetch metadata from Cinemeta with up to 2 retries + exponential back-off.
 * Poster fallback chain:
 *   meta.poster  →  meta.posterShape  →  Metahub CDN (IMDB thumbnails)
 */
async function fetchMeta(type, imdbId, retries = 2) {
  const cacheKey = `meta:${type}:${imdbId}`;
  const cached   = metaCache.get(cacheKey);
  if (cached) return cached;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(
        `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
        { timeout: 8000 }
      );
      const meta = res.data?.meta;
      if (!meta) break;

      // Poster fallback: Cinemeta sometimes omits poster for older titles
      if (!meta.poster) {
        meta.poster =
          meta.posterShape ||
          `https://images.metahub.space/poster/medium/${imdbId}/img`;
      }

      metaCache.set(cacheKey, meta);
      return meta;
    } catch (err) {
      if (attempt < retries) {
        await delay(500 * (attempt + 1)); // 500ms → 1000ms back-off
      } else {
        console.warn(`fetchMeta failed [${imdbId}]:`, err.message);
      }
    }
  }
  return null;
}

// ============================================================
//  POPULAR 4K IMDb SEED LIST
// ============================================================
const POPULAR_MOVIES = [
  "tt0816692","tt1375666","tt0468569","tt0137523","tt0109830",
  "tt0167260","tt0120737","tt0167261","tt1345836","tt0110912",
  "tt0133093","tt2106476","tt1853728","tt1130884","tt4154796",
  "tt4154756","tt0245429","tt1745960","tt6751668","tt1160419",
  "tt15239678","tt1877830","tt15398776","tt1517268","tt14444726",
  "tt0499549","tt2278388","tt7286456","tt13610996","tt11138512",
  "tt3581920","tt8093700","tt0317248","tt2267998","tt9603212",
  "tt0111161","tt0068646","tt0071562","tt0050083","tt0108052",
  "tt0167404","tt0073486","tt0099685","tt0047478","tt0034583",
  "tt0076759","tt0080684","tt0086190","tt0120815","tt0114369",
  "tt0102926","tt0110413","tt0253474","tt0120689","tt0056058",
  "tt0172495","tt1392190","tt0209144","tt0407887","tt1675434",
  "tt4633694","tt0266543","tt0435761","tt0910970","tt2096673",
  "tt0382932","tt1745375","tt0078788","tt0057565","tt0052357",
  "tt0042876","tt0017136","tt0015864","tt0038650","tt0041959",
  "tt8267604","tt6966692","tt1454468","tt3783958","tt2582802",
  "tt5013056","tt2024544","tt1291584","tt0405094","tt0758758",
  "tt0093058","tt0082971","tt0119217","tt0114814","tt0198781",
  "tt0180093","tt0264464","tt0363163","tt0372784","tt0436697",
  "tt0458339","tt0816692","tt0454921","tt1201607","tt1285016",
];

const POPULAR_SERIES = [
  "tt0903747","tt0944947","tt5491994","tt4574334","tt7366338",
  "tt0386676","tt0108778","tt2861424","tt2442560","tt1475582",
  "tt3032476","tt4052886","tt0306414","tt2306299","tt8111088",
  "tt7261016","tt4288182","tt6468322","tt10048342","tt14452776",
  "tt11280740","tt9253866","tt13622776","tt15428778","tt21209876",
  "tt0141842","tt0460649","tt1051220","tt0412142","tt0773262",
  "tt0098904","tt0185906","tt0397150","tt2707408","tt0096697",
  "tt0367279","tt1520211","tt2395695","tt1831164","tt4955642",
  "tt0417299","tt0285331","tt0264235","tt0389564","tt0436992",
  "tt1844624","tt2709128","tt6741278","tt0455275","tt2049116",
  "tt4158110","tt5421602","tt5753856","tt6156584","tt8946378",
  "tt9544034","tt0898266","tt1137463","tt0290978","tt1439629",
  "tt2560140","tt3743822","tt4786824","tt5071412","tt5180504",
  "tt6769208","tt7081796","tt7225765","tt7375420","tt7604476",
  "tt7661068","tt8177592","tt8772296","tt9016300","tt0472954",
  "tt0149460","tt0103359","tt0106179","tt0112159","tt0115147",
  "tt0118421","tt0121955","tt0147800","tt0203259","tt0348914",
  "tt0411198","tt0423731","tt0491738","tt0773262","tt0848228",
  "tt1632701","tt1844172","tt2085059","tt2297535","tt3398228",
  "tt3581458","tt4532368","tt5555260","tt6468322","tt6710474",
];

// ============================================================
//  CATALOG HANDLER
// ============================================================
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const keyword = (extra?.search || "").toLowerCase().trim();

  try {
    // ── Search mode ──────────────────────────────────────────
    if (keyword) {
      const res = await axios.get(
        `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(keyword)}.json`,
        { timeout: 10000 }
      );
      return { metas: (res.data?.metas || []).slice(0, 50) };
    }

    // ── Normal catalog — fetch in batches of 8, 250ms apart ─
    const idList = type === "movie" ? POPULAR_MOVIES : POPULAR_SERIES;

    const metas = await batchedAll(idList, async (imdbId) => {
      const meta = await fetchMeta(type, imdbId);
      if (!meta) return null;
      return {
        id:          imdbId,
        type,
        name:        meta.name,
        poster:      meta.poster,
        background:  meta.background,
        description: meta.description,
        year:        meta.year,
        imdbRating:  meta.imdbRating,
      };
    }, 8, 250);

    return { metas: metas.filter(Boolean) };
  } catch (err) {
    console.error("Catalog error:", err.message);
    return { metas: [] };
  }
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
//  SERVER
// ============================================================
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅  RD 4K Ultra HD Addon running`);
console.log(`🌐  http://localhost:${PORT}/manifest.json\n`);
