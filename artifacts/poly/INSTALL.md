# Panduan Instalasi Cepat — PolyHFT-Autotrading-V3

## Persyaratan Sistem

- **Node.js** ≥ 18  →  `node --version`
- **npm** ≥ 9       →  `npm --version`

---

## Instalasi (5 langkah)

```bash
# 1. Masuk ke folder bot
cd artifacts/poly

# 2. Install semua dependency
npm install

# 3. Compile TypeScript
npm run build

# 4. Salin file environment
cp .env.example .env

# 5. Verifikasi instalasi
npm run test:full
# Hasil: 367 passed, 5 failed  ← normal sebelum isi credentials
```

---

## Konfigurasi Minimal

Edit file `.env`:

```env
PRIVATE_KEY=0x...                   # private key wallet Anda
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=0         # 0=EOA  1=POLY_PROXY
DRY_RUN=true                        # ganti false hanya saat siap live
ORDER_SIZE=25
COOLDOWN_SECONDS=10
```

Edit `config/base.yaml`:

```yaml
app:
  mode: paper    # ganti 'live' saat siap
```

---

## Menjalankan Bot

| Tujuan | Perintah |
|---|---|
| Paper mode (aman) | `npm run paper` |
| Live mode (order nyata) | `npm run live` |
| Lihat market real-time | `npm run markets` |
| Jalankan test suite | `npm run test:full` |
| Build ulang setelah edit | `npm run build` |

---

## Urutan Aman Sebelum Live Trading

```
[1] npm run build            ← selalu build dulu setelah edit kode
[2] npm run test:full        ← pastikan 367 passed, 5 failed
[3] npm run paper            ← amati ≥50 cycle paper
[4] npm run markets          ← verifikasi koneksi API dan data pasar
[5] npm run live             ← baru live setelah semua OK
```

---

## Menghentikan Bot

`Ctrl+C` — bot shutdown otomatis dengan aman (menunggu cycle selesai, cetak ringkasan).

---

## Troubleshooting Cepat

| Masalah | Solusi |
|---|---|
| Build error | `npm run clean && npm install && npm run build` |
| Lebih dari 5 test failure | Build ulang, cek `.env` |
| Tidak ada order ditempatkan | Cek `DRY_RUN=false` dan `mode: live` |
| API unauthorized | Cek credentials di `.env`, coba buat API key baru |

Panduan lengkap → lihat `README.md`
