const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
//  CONFIG — buraya kendi Real-Debrid API anahtarını yaz
// ============================================================
const RD_API_KEY = process.env.RD_API_KEY || "BURAYA_API_KEYINI_YAZ";
const RD_BASE    = "https://api.real-debrid.com/rest/1.0";
const PORT       = process.env.PORT || 7000;   // Render otomatik PORT atar

// ============================================================
//  MANIFEST
// ============================================================
const manifest = {
  id: "community.rd4k",
  version: "1.0.0",
  name: "Relaxv Addon",
  description: "Real-Debrid üzerinden yalnızca 4K/2160p içerikler. Katalog + stream desteği.",
  logo: "https://i.imgur.com/MZnPBgW.png",
  background: "https://i.imgur.com/LkrxS4J.jpg",
  catalogs: [
    {
      type: "movie",
      id: "rd4k-movies",
      name: "RD 4K Filmler",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id: "rd4k-series",
      name: "RD 4K Diziler",
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
const rdHeaders = () => ({
  Authorization: `Bearer ${RD_API_KEY}`,
});

/** Real-Debrid torrent listesini çek */
async function getRDTorrents(limit = 200) {
  const res = await axios.get(`${RD_BASE}/torrents`, {
    headers: rdHeaders(),
    params: { limit, offset: 0 },
  });
  return res.data;
}

/** 4K olup olmadığını dosya adından anla */
function is4K(name = "") {
  return /\b(2160p|4K|UHD|uhd|4k)\b/i.test(name);
}

/** IMDb ID'sini torrent adından çıkarmaya çalış (yoksa null) */
function extractImdbId(name = "") {
  const m = name.match(/tt\d{7,8}/i);
  return m ? m[0].toLowerCase() : null;
}

/** Torrent -> stream nesnesi */
function torrentToStream(t) {
  return {
    name: "RD 4K",
    description: `📁 ${t.filename || t.name}\n💾 ${(t.bytes / 1e9).toFixed(2)} GB`,
    url: t.links?.[0] || null,   // unrestricted link (varsa)
    behaviorHints: { notWebReady: false },
  };
}

/** Basit meta nesnesi (Cinemeta yokken fallback) */
function buildMeta(id, type, name) {
  return {
    id,
    type,
    name: name || id,
    poster: `https://images.metahub.space/poster/medium/${id}/img`,
    background: `https://images.metahub.space/background/medium/${id}/img`,
  };
}

// ============================================================
//  KATALOG  — /catalog/:type/:id
// ============================================================
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const torrents = await getRDTorrents(500);
    const keyword  = (extra?.search || "").toLowerCase();

    // 4K filtresi
    let filtered = torrents.filter((t) => is4K(t.filename || t.name || ""));

    // Tür filtresi: "series" = sezon/bölüm içeren
    if (type === "series") {
      filtered = filtered.filter((t) =>
        /\b(S\d{2}|Season|Sezon)\b/i.test(t.filename || t.name || "")
      );
    } else {
      // movie: sezon ifadesi YOK
      filtered = filtered.filter(
        (t) => !/\b(S\d{2}|Season|Sezon)\b/i.test(t.filename || t.name || "")
      );
    }

    // Arama filtresi
    if (keyword) {
      filtered = filtered.filter((t) =>
        (t.filename || t.name || "").toLowerCase().includes(keyword)
      );
    }

    // Tekrar eden imdb id'leri birleştir
    const seen = new Set();
    const metas = [];
    for (const t of filtered) {
      const imdbId = extractImdbId(t.filename || t.name || "");
      const key    = imdbId || t.id;
      if (seen.has(key)) continue;
      seen.add(key);

      metas.push(buildMeta(imdbId || `rd:${t.id}`, type, t.filename || t.name));
    }

    return { metas: metas.slice(0, 100) };
  } catch (err) {
    console.error("Catalog error:", err.message);
    return { metas: [] };
  }
});

// ============================================================
//  STREAM  — /stream/:type/:id
// ============================================================
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const torrents = await getRDTorrents(500);

    // id ile eşleşen torrenti bul (imdb id veya rd: prefix)
    const rdId = id.startsWith("rd:") ? id.slice(3) : null;

    const matched = torrents.filter((t) => {
      if (!is4K(t.filename || t.name || "")) return false;
      if (rdId) return t.id === rdId;
      const tImdb = extractImdbId(t.filename || t.name || "");
      return tImdb && tImdb === id.toLowerCase();
    });

    if (!matched.length) return { streams: [] };

    // Her eşleşen torrent için unrestricted link al
    const streams = [];
    for (const t of matched.slice(0, 5)) {
      if (t.links && t.links.length) {
        try {
          const res = await axios.post(
            `${RD_BASE}/unrestrict/link`,
            new URLSearchParams({ link: t.links[0] }),
            { headers: rdHeaders() }
          );
          const s = torrentToStream(t);
          s.url = res.data.download;
          streams.push(s);
        } catch {
          // link kısıtlama başarısız, atla
        }
      }
    }

    return { streams };
  } catch (err) {
    console.error("Stream error:", err.message);
    return { streams: [] };
  }
});

// ============================================================
//  SUNUCU
// ============================================================
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅  RD 4K Addon çalışıyor → http://localhost:${PORT}/manifest.json`);
console.log(`📺  Stremio'ya eklemek için: stremio://localhost:${PORT}/manifest.json\n`);
