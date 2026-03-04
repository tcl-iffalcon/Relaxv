const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
//  CONFIG
// ============================================================
const RD_API_KEY = process.env.RD_API_KEY || "";
const TORRENTIO  = "https://torrentio.strem.fun";
const PORT       = process.env.PORT || 7000;

const TORRENTIO_CONFIG = [
  "providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,horriblesubs,nyaasi,tokyotosho,anidex",
  "sort=qualitysize",
  `realdebrid=${RD_API_KEY}`,
].join("|");

// ============================================================
//  4K+ KALİTE FİLTRESİ
//  2160p, 4K, UHD, BluRay, BDRemux, Remux, BDRip,
//  HDR, HDR10, HDR10+, Dolby Vision, DV, IMAX
// ============================================================
const QUALITY_PATTERNS = [
  /\b2160p\b/i,
  /\b4K\b/i,
  /\bUHD\b/i,
  /\bBluRay\b/i,
  /\bBlu-Ray\b/i,
  /\bBDRemux\b/i,
  /\bBD\.?Remux\b/i,
  /\bRemux\b/i,
  /\bBDRip\b/i,
  /\bHDR(10)?(\+)?\b/i,
  /\bDolby\.?Vision\b/i,
  /\bDV\b/,
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
  version: "1.0.0",
  name: "Relaxv Addon",
  description:
    "Stremio ve Nuvio için Torrenti ile Real-Debrid üzerinden yalnızca 4K ve üstü içerikler + katalog sunar.",
  logo: "https://i.imgur.com/MZnPBgW.png",
  background: "https://i.imgur.com/LkrxS4J.jpg",
  catalogs: [
    {
      type: "movie",
      id: "rd4k-movies",
      name: "4K Ultra HD Filmler",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id: "rd4k-series",
      name: "4K Ultra HD Diziler",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
  resources: ["catalog", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  behaviorHints: { configurable: false, adult: false },
};

const builder = new addonBuilder(manifest);

// ============================================================
//  HELPERS
// ============================================================

/** Torrentio'dan stream listesi çek */
async function fetchTorrentioStreams(type, imdbId) {
  const url = `${TORRENTIO}/${TORRENTIO_CONFIG}/stream/${type}/${imdbId}.json`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    return res.data?.streams || [];
  } catch (err) {
    console.error(`Torrentio error [${imdbId}]:`, err.message);
    return [];
  }
}

/** 4K+ kalite stream'leri filtrele */
function filterHighQuality(streams) {
  return streams.filter((s) => {
    const text = [(s.title || ""), (s.name || "")].join(" ").replace(/\n/g, " ");
    return isHighQuality(text);
  });
}

/** Kalite rozetleri oluştur */
function qualityBadge(title) {
  const tags = [];
  if (/\bRemux\b/i.test(title))               tags.push("REMUX");
  if (/\bBluRay|Blu-Ray\b/i.test(title))       tags.push("BluRay");
  if (/\bHDR10\+/i.test(title))                tags.push("HDR10+");
  else if (/\bHDR10\b/i.test(title))           tags.push("HDR10");
  else if (/\bHDR\b/i.test(title))             tags.push("HDR");
  if (/Dolby.?Vision|\bDV\b/.test(title))      tags.push("DV");
  if (/\bIMAX\b/i.test(title))                 tags.push("IMAX");
  if (/\b2160p\b/i.test(title))                tags.push("2160p");
  return tags.length ? `[${tags.join(" | ")}]` : "[4K]";
}

/** Stream'i Stremio formatına çevir */
function formatStream(s) {
  const title = [s.title || "", s.name || ""].join(" ").replace(/\n/g, " ").trim();
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

/** Cinemeta'dan meta çek */
async function fetchMeta(type, imdbId) {
  try {
    const res = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 8000 }
    );
    return res.data?.meta || null;
  } catch {
    return null;
  }
}

// ============================================================
//  Popüler 4K IMDb listesi (katalog seed)
// ============================================================
const POPULAR_MOVIES = [
  "tt0816692","tt1375666","tt0468569","tt0137523","tt0109830",
  "tt0167260","tt0120737","tt0167261","tt1345836","tt0110912",
  "tt0133093","tt2106476","tt1853728","tt1130884","tt4154796",
  "tt4154756","tt0245429","tt1745960","tt6751668","tt1160419",
  "tt15239678","tt1877830","tt15398776","tt1517268","tt14444726",
  "tt0499549","tt2278388","tt7286456","tt13610996","tt11138512",
  "tt3581920","tt8093700","tt0317248","tt2267998","tt9603212",
];

const POPULAR_SERIES = [
  "tt0903747","tt0944947","tt5491994","tt4574334","tt7366338",
  "tt0386676","tt0108778","tt2861424","tt2442560","tt1475582",
  "tt3032476","tt4052886","tt0306414","tt2306299","tt8111088",
  "tt7261016","tt4288182","tt6468322","tt10048342","tt14452776",
  "tt11280740","tt9253866","tt13622776","tt15428778","tt21209876",
];

// ============================================================
//  KATALOG HANDLER
// ============================================================
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const keyword = (extra?.search || "").toLowerCase().trim();

  try {
    // Arama modu
    if (keyword) {
      const res = await axios.get(
        `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(keyword)}.json`,
        { timeout: 10000 }
      );
      return { metas: (res.data?.metas || []).slice(0, 50) };
    }

    // Normal katalog
    const idList = type === "movie" ? POPULAR_MOVIES : POPULAR_SERIES;
    const metas  = await Promise.all(
      idList.map(async (imdbId) => {
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
      })
    );

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
        name: "⚠️ Hata",
        description: "RD_API_KEY tanımlanmamış. Render → Environment Variables kontrol et.",
        url: "",
      }],
    };
  }

  try {
    const all      = await fetchTorrentioStreams(type, id);
    const filtered = filterHighQuality(all);
    const streams  = filtered.map(formatStream).filter((s) => s.url);

    console.log(`[${id}] Toplam stream: ${all.length} | 4K+ filtreli: ${filtered.length}`);
    return { streams: streams.slice(0, 20) };
  } catch (err) {
    console.error("Stream error:", err.message);
    return { streams: [] };
  }
});

// ============================================================
//  SUNUCU
// ============================================================
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅  RD 4K Ultra HD Addon çalışıyor`);
console.log(`🌐  http://localhost:${PORT}/manifest.json\n`);
