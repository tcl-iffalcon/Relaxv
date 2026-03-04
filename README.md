# 🎬 RD 4K Ultra — Stremio Addon

Real-Debrid hesabındaki **4K / 2160p / UHD** içerikleri Stremio'da katalog olarak gösteren özel eklenti.

---

## Özellikler

| Özellik | Detay |
|---|---|
| 🎥 Yalnızca 4K | 2160p / UHD / 4K filtre |
| 📂 Katalog | Film & Dizi sekmeleri, arama |
| ⚡ Stream | Real-Debrid unrestrict ile direkt oynatma |
| 🔑 API Key | Kendi RD hesabın, başkasına bağımlılık yok |

---

## Kurulum

### 1. Gereksinimler
- [Node.js](https://nodejs.org) v14+
- Real-Debrid hesabı + API anahtarı

### 2. API Anahtarını Al
1. https://real-debrid.com/apitoken adresine git
2. Token'ı kopyala

### 3. Çalıştır

```bash
# Bağımlılıkları yükle
npm install

# API key ile başlat
RD_API_KEY=senin_api_keyın node index.js
```

Windows için:
```cmd
set RD_API_KEY=senin_api_keyın
node index.js
```

Ya da `index.js` içinde doğrudan yaz:
```js
const RD_API_KEY = "senin_api_keyın";
```

### 4. Stremio'ya Ekle

Addon çalışınca Stremio'da:
```
http://localhost:7000/manifest.json
```
adresini "Install from URL" ile ekle.

---

## Uzaktan Erişim (Opsiyonel)

Telefon veya başka cihazdan erişmek istersen [Railway](https://railway.app) veya [Render](https://render.com) gibi ücretsiz platformlara deploy edebilirsin.

Environment variable olarak `RD_API_KEY` tanımla, `PORT` otomatik alınır.

---

## Notlar

- Real-Debrid torrent listendeki dosya adında `2160p`, `4K`, `UHD` geçmiyorsa eklenti o içeriği göstermez.
- IMDb ID'si dosya adında geçen torrентler katalogda poster ile görünür.
- Stremio açıkken addon'ın çalışır durumda olması gerekir.
