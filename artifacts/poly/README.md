# PolyHFT-Autotrading-V3

Bot autotrading TypeScript untuk pasar biner Polymarket di jaringan **Polygon mainnet**.  
Menempatkan order nyata melalui CLOB API Polymarket dengan 7 strategi trading aktif.

---

## Daftar Isi

1. [Prasyarat](#1-prasyarat)
2. [Instalasi](#2-instalasi)
3. [Konfigurasi](#3-konfigurasi)
4. [Cara Menjalankan](#4-cara-menjalankan)
5. [Strategi Trading](#5-strategi-trading)
6. [Arsitektur](#6-arsitektur)
7. [Risk Engine](#7-risk-engine)
8. [Cara Mendapatkan Credentials](#8-cara-mendapatkan-credentials)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prasyarat

| Software | Versi minimum | Cek |
|---|---|---|
| Node.js | 18+ (rekomendasi 20 LTS) | `node --version` |
| npm | 9+ | `npm --version` |
| Git | semua versi | `git --version` |

Anda membutuhkan:
- **Wallet Ethereum** dengan USDC di Polygon (untuk live trading)
- **Akun Polymarket** dengan API Key (untuk live trading)
- Koneksi internet stabil

---

## 2. Instalasi

### Langkah 1 — Clone repository

```bash
git clone <repo-url>
cd artifacts/poly
```

### Langkah 2 — Install dependencies

```bash
npm install
```

Dependencies yang akan dipasang:
- `@polymarket/clob-client` — klien resmi CLOB API Polymarket
- `ethers` v6 — signing transaksi on-chain
- `dotenv` — manajemen environment variables
- `yaml` — parsing file konfigurasi

### Langkah 3 — Build (kompilasi TypeScript)

```bash
npm run build
```

Output akan tersimpan di folder `dist/`.

### Langkah 4 — Setup environment

```bash
cp .env.example .env
```

Edit file `.env` sesuai instruksi di [Bagian 3](#3-konfigurasi).

### Langkah 5 — Jalankan test suite

```bash
npm run test:full
```

Hasil yang benar: **367 passed, 5 failed** (5 failure karena credential belum diisi — normal).

---

## 3. Konfigurasi

### File `.env`

```env
# ─── Wallet ───────────────────────────────────────────────────────────────────
PRIVATE_KEY=0x...                   # 32-byte hex, 0x-prefixed (66 karakter total)

# ─── Polymarket API ───────────────────────────────────────────────────────────
POLYMARKET_API_KEY=                 # dari dashboard Polymarket → API Keys
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=

POLYMARKET_SIGNATURE_TYPE=0         # 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
POLYMARKET_FUNDER=                  # kosongkan untuk EOA; isi untuk POLY_PROXY/Safe

# ─── Parameter Trading ────────────────────────────────────────────────────────
ORDER_SIZE=25                       # ukuran order per kaki (USDC)
COOLDOWN_SECONDS=10                 # jeda re-entry ke market yang sama
TARGET_PAIR_COST=0.98               # batas gabungan ask YES+NO

# ─── Saklar Keamanan ──────────────────────────────────────────────────────────
DRY_RUN=true                        # true=paper mode; false=LIVE (order nyata)
```

### File `config/base.yaml`

Konfigurasi utama bot:

```yaml
app:
  mode: paper           # paper | live | backtest
  loop_interval_ms: 250 # interval tiap siklus (ms)

strategy:
  pair_cost_cap: 0.98   # threshold combined ask
  default_order_size: 25

risk:
  starting_capital: 25000.0
  max_gross_exposure: 0.75    # 75% modal total
  max_daily_loss: 0.06        # circuit breaker 6% per hari
  max_drawdown: 0.10          # circuit breaker drawdown 10%
  min_confidence: 0.55        # sinyal di bawah ini dilewati
  fee_bps: 3.5                # biaya taker Polymarket
  slippage_bps: 6.0           # base slippage estimate
```

**Mengubah mode trading:**

```yaml
# Paper mode (aman, tidak ada order nyata):
app:
  mode: paper

# Live mode (order nyata ke Polymarket):
app:
  mode: live
```

---

## 4. Cara Menjalankan

### Perintah utama

| Perintah | Keterangan |
|---|---|
| `npm run build` | Kompilasi TypeScript → `dist/` |
| `npm start` | Jalankan bot (mode dari `config/base.yaml` + `.env`) |
| `npm run paper` | Paksa paper mode (DRY_RUN=true), override `.env` |
| `npm run live` | Paksa live mode (DRY_RUN=false), override `.env` |
| `npm run markets` | Feed pasar real-time (baca saja, tanpa order) |
| `npm run test:full` | Jalankan 367+ assertion test suite |
| `npm run typecheck` | Cek TypeScript tanpa build |
| `npm run clean` | Hapus folder `dist/` |

---

### Alur yang direkomendasikan

#### Tahap 1 — Verifikasi instalasi

```bash
npm install
npm run build
npm run test:full
# Pastikan output: "367 passed, 5 failed" (5 = credential belum diisi)
```

#### Tahap 2 — Paper mode (wajib sebelum live)

```bash
# 1. Set .env: DRY_RUN=true
# 2. Set config/base.yaml: mode: paper
npm start
```

Output tiap cycle:
```
⚡ Cycle #1 299ms · 2025-01-01T00:00:00.000Z
  Scanned   │  9
  Eligible  │  9
  Executed  │  9
  Pairs     │  9
  SingleLegs│  0
  Skipped   │  0
  Fills     │  0
```

Amati minimal **50 cycle** untuk memvalidasi perilaku strategi.

#### Tahap 3 — Live market feed (opsional, read-only)

```bash
npm run markets
```

Menampilkan orderbook real-time dari Polymarket tanpa menempatkan order.

#### Tahap 4 — Live trading

```bash
# 1. Edit .env:
#    PRIVATE_KEY=0x... (private key wallet nyata)
#    POLYMARKET_API_KEY=...
#    POLYMARKET_API_SECRET=...
#    POLYMARKET_API_PASSPHRASE=...
#    DRY_RUN=false

# 2. Edit config/base.yaml:
#    mode: live

# 3. Build ulang (jika ada perubahan kode)
npm run build

# 4. Jalankan
npm run live
```

#### Menghentikan bot dengan aman

Tekan `Ctrl+C` — bot akan:
1. Menangkap sinyal `SIGTERM`/`SIGINT`
2. Menunggu siklus aktif selesai
3. Mencetak ringkasan sesi
4. Keluar dengan kode `0`

---

### Menjalankan sebagai background process

#### Dengan `nohup` (Linux/macOS)

```bash
nohup npm run live > logs/bot.log 2>&1 &
echo "PID: $!"

# Melihat log
tail -f logs/bot.log

# Menghentikan
kill <PID>
```

#### Dengan `pm2` (rekomendasi untuk produksi)

```bash
# Install pm2
npm install -g pm2

# Jalankan bot
pm2 start dist/index.js --name polyhft --log logs/polyhft.log

# Perintah pm2 berguna
pm2 status                    # status proses
pm2 logs polyhft              # lihat log real-time
pm2 restart polyhft           # restart
pm2 stop polyhft              # berhenti
pm2 delete polyhft            # hapus dari pm2

# Auto-start saat reboot
pm2 startup
pm2 save
```

#### Dengan `screen` (Linux/macOS)

```bash
screen -S polyhft
npm run live
# Tekan Ctrl+A, lalu D untuk detach
# Kembali: screen -r polyhft
```

---

## 5. Strategi Trading

Bot menggunakan 7 strategi yang berjalan secara bersamaan setiap cycle:

### Strategi Paired-Entry (beli YES + NO sekaligus)

| Strategi | Nama | Trigger | Confidence |
|---|---|---|---|
| `MarketMakingStrategy` | `dualBuyParity` | `combinedAsk < 1` | `0.55 + (edge/0.10) × 0.40` |
| `VolumeImbalanceStrategy` | `volumeImbalance` | Imbalance orderbook > 12% + edge > 1.5% | `0.55 + imbalance × 1.2 + ...` |
| `ResolutionArbStrategy` | `resolutionArb` | Deep discount: edge > 4.5% | `0.72 + (edge-0.045)/0.05 × 0.20` |

### Strategi Single-Leg (beli satu sisi saja)

| Strategi | Nama | Trigger | Leg |
|---|---|---|---|
| `StatisticalArbitrageStrategy` | `curveArb` | Dislokasi binary identity ≥ 3% | Sisi yang lebih murah |
| `MomentumStrategy` | `momentum` | Imbalance directional > 18% | Sisi yang dominan |
| `MeanReversionStrategy` | `meanReversion` | Implied prob > 60% → beli sisi murah | Sisi yang lebih murah |
| `MetaConfluenceStrategy` | `metaConfluence` | Skor multi-indikator ≥ 60% | Sisi terkuat |

---

## 6. Arsitektur

```
src/
├── index.ts                    ← Entry point, loop utama
├── config.ts                   ← Parsing YAML + env
├── connectors/
│   ├── polymarket.ts           ← Tipe + builder market snapshot
│   ├── polymarketApi.ts        ← Feed Gamma + CLOB (read-only)
│   ├── clobOrderClient.ts      ← Order signing + submission
│   └── tokenDiscovery.ts       ← Auto-resolve token ID (cache 3 menit)
├── strategies/
│   ├── base.ts                 ← Interface TradeSignal + StrategyBase
│   ├── marketMaking.ts         ← dualBuyParity
│   ├── volumeImbalance.ts      ← volumeImbalance
│   ├── resolutionArb.ts        ← resolutionArb
│   ├── statArb.ts              ← curveArb
│   ├── momentum.ts             ← momentum
│   ├── meanReversion.ts        ← meanReversion
│   └── metaConfluence.ts       ← metaConfluence
├── risk/
│   └── engine.ts               ← 9 gates + dynamic slippage
├── execution/
│   └── engine.ts               ← Dual path + FillTracker
├── backtesting/
│   └── engine.ts               ← Simulasi P&L
├── examples/
│   └── liveMarkets.ts          ← CLI feed real-time
└── test/
    └── fullTest.ts             ← 367+ assertions
```

### Alur satu cycle

```
index.ts → loadConfig() → TokenDiscoveryService.resolveTokenIds()
         → polymarketApi.fetchLiveSnapshot() [per market]
         → strategies.generateSignals() [7 strategi paralel]
         → risk.evaluate() [9 gates per sinyal]
         → execution.runCycle() [paired OR single-leg]
         → FillTracker.poll() [live: cek fill setiap 2.5 detik]
         → printCycleReport()
```

---

## 7. Risk Engine

Setiap order melewati 9 gate secara berurutan:

| Gate | Kondisi | Aksi jika gagal |
|---|---|---|
| 1. Size | size > 0 | Tolak |
| 2. Price | price ∈ (0, 1) | Tolak |
| 3. Net edge | grossEdge > fee + slippage | Tolak |
| 4. Confidence | confidence ≥ 0.55 | Tolak |
| 5. Min notional | size × price ≥ $20 | Tolak |
| 6. Max notional | size × price ≤ $1,500 | Cap ukuran |
| 7. Market exposure | < 15% modal | Cap ukuran |
| 8. Daily loss | P&L harian > -6% | Tolak semua |
| 9. Drawdown | Drawdown > -10% | Tolak semua |

### Dynamic slippage berdasarkan volume market

| Volume | Tambahan slippage |
|---|---|
| Tidak diketahui | +15 bps |
| < $10K | +40 bps |
| $10K – $20K | +20 bps |
| $20K – $50K | +8 bps |
| ≥ $50K | +0 bps |

---

## 8. Cara Mendapatkan Credentials

### Private Key

- Export dari MetaMask: Settings → Security → Export Private Key
- Atau buat wallet baru khusus untuk bot (lebih aman)
- Pastikan wallet memiliki USDC di **Polygon** (bukan Ethereum mainnet)
- Tambahkan sedikit MATIC untuk gas fee (~0.1 MATIC cukup untuk ribuan transaksi)

### Polymarket API Key

1. Buka [polymarket.com](https://polymarket.com) dan login
2. Klik profil → **Settings** → **API Keys**
3. Klik **Create New Key**
4. Simpan `API Key`, `Secret`, dan `Passphrase` — hanya tampil sekali
5. Tentukan `POLYMARKET_SIGNATURE_TYPE`:
   - `0` jika Anda menggunakan wallet biasa (MetaMask, Ledger, dll)
   - `1` jika Anda menggunakan **Polymarket Proxy Wallet** (dibuat otomatis oleh Polymarket saat deposit pertama)

### Mengetahui Signature Type Anda

Login ke Polymarket → buka browser console → ketik:
```js
// Jika Anda punya proxy wallet, ini akan return address-nya
window.polymarket?.proxyWallet
```

Jika ada address yang keluar → gunakan `POLYMARKET_SIGNATURE_TYPE=1` dan isi `POLYMARKET_FUNDER` dengan address tersebut.

### Deposit USDC ke Polymarket

1. Beli USDC di exchange (Binance, Coinbase, dll)
2. Withdraw ke Polygon network (bukan ETH mainnet)
3. Transfer ke address wallet yang akan digunakan bot
4. Deposit ke Polymarket melalui UI

---

## 9. Troubleshooting

### Build gagal: `Cannot find module`

```bash
# Bersihkan dan install ulang
npm run clean
rm -rf node_modules
npm install
npm run build
```

### Test menunjukkan lebih dari 5 failure

```bash
# Cek apakah build sudah up-to-date
npm run build
npm run test:full
# 5 failure = normal (credential tidak diisi di environment test)
```

### Bot berjalan tapi tidak ada order

Periksa:
1. `DRY_RUN=true` → ubah ke `false` jika ingin live
2. `mode: paper` di `base.yaml` → ubah ke `live`
3. `combinedAsk` semua market ≥ 1 → market sedang tidak ada edge
4. Risk gate menolak karena daily loss limit → tunggu hari berikutnya

### Error: `insufficient funds`

- Tambahkan USDC ke wallet di Polygon
- Tambahkan MATIC untuk gas fee

### Error: `unauthorized` dari CLOB API

- Cek `POLYMARKET_API_KEY`, `API_SECRET`, `API_PASSPHRASE`
- Pastikan `POLYMARKET_SIGNATURE_TYPE` sesuai jenis wallet Anda
- API key mungkin sudah expired → buat ulang di dashboard

### Bot tidak menemukan token ID market

Token ID di-resolve otomatis dari Gamma API setiap 3 menit. Jika gagal:
- Cek koneksi internet
- Market mungkin sudah ditutup/diselesaikan (pasar biner yang sudah berakhir)
- Bot akan skip market tersebut dan retry di cycle berikutnya

### Melihat log lebih detail

```bash
# Jalankan dengan output tidak ter-buffer
node --no-warnings dist/index.js 2>&1 | tee logs/session.log
```

---

## Struktur Konfigurasi Lengkap

Lihat `config/base.yaml` untuk semua parameter yang tersedia.  
Lihat `.env.example` untuk semua environment variable yang didukung.

---

## Catatan Keamanan

- **Jangan commit `.env`** ke repository — sudah ada di `.gitignore`
- Private key tidak pernah di-log; bot hanya menampilkan `set ✓` atau `missing ✗`
- `DRY_RUN=true` adalah default — tidak bisa menempatkan order nyata tanpa opt-in eksplisit
- Gunakan wallet terpisah khusus bot dengan modal terbatas
- Set `max_daily_loss` dan `max_drawdown` sesuai toleransi risiko Anda
