# Protokol Setor

Aturan yang harus dipenuhi web usaha (Kosinyuk, Atmosphere, tab.booth, …) supaya bisa disambungkan ke app Setor. Setor hanya membaca notifikasi "Rp… diterima" dari DANA dan mengirimkannya; web yang mencocokkan nominal ke tagihan.

Semua respons memakai bentuk `{ "success": true, "data": … }` atau `{ "success": false, "error": { "message": "…" } }`. Wajib HTTPS.

## 1. Pairing

`POST {web}/api/devices/pair`

```json
{ "code": "K7Q2M9XA", "name": "Samsung A15", "band": { "min": 500, "max": 999 } }
```

`band` (opsional) = rentang 3 digit terakhir yang dipilih pemilik di Setor untuk bisnis ini. Web yang mendukung menyimpannya per bisnis dan membalas rentang yang dipakai; web lama mengabaikannya dan membalas rentangnya sendiri (Setor lalu ikut).

Kode dibuat di halaman pengaturan web, 8 karakter, sekali pakai, berlaku 10 menit. Respons:

```json
{
  "token": "…",                                  // simpan di HP, kirim sebagai Bearer
  "device": { "id": "…", "name": "Samsung A15" },
  "business": { "name": "Kos Melati", "type": "kos" },
  "band": { "min": 500, "max": 999 },            // opsional, lihat §3
  "dashboard": "https://kosinyuk.id/tagihan"     // opsional: tombol "Buka dashboard" di Setor
}
```

Web menyimpan **hash** token, bukan tokennya.

QR pairing berisi `https://{web}/setor/pair?c=K7Q2M9XA`. Setor membaca alamat dan kodenya dari QR itu; dipindai kamera biasa, halaman itu menawarkan unduhan Setor.

## 2. Uang masuk

`POST {web}/api/payments/qris/notification` dengan header `Authorization: Bearer <token>`

```json
{ "notifId": "id.dana|1793470000000|Rp799.873 diterima DANA Bisnis.", "amount": 799873, "time": 1793470000000, "text": "Rp799.873 diterima DANA Bisnis." }
```

- `notifId` unik per notifikasi. Web wajib anti-dobel: kiriman ulang dengan `notifId` sama tidak boleh melunasi dua kali.
- Respons `data`: `{ "result": "matched" | "unmatched" | "duplicate", "label": "K3 · Budi" | null }`. Setor memakai `label` sebagai label transaksi.
  Atmosphere versi lama mengirim `reservationCode` dan hasil huruf besar (`MATCHED`, `NO_MATCH`, …); Setor tetap memahaminya.
- `401` → token dicabut, Setor memutus koneksi. `4xx` lain (selain 429) → ditandai gagal, tidak dikirim ulang. `5xx`/offline → antri, dicoba lagi.

## 3. Jalur nominal (band)

Satu DANA bisa dipakai beberapa usaha. Supaya nominal dua usaha tidak pernah sama, tiap usaha memakai jalur **3 digit terakhir nominal bayar**:

| Usaha | 3 digit terakhir |
|---|---|
| tab.booth | 001–099 |
| Atmosphere | 100–499 |
| Kosinyuk | 500–999 |

Web memilih kode unik supaya nominal akhir jatuh di jalurnya, dan mengirim `band` saat pairing. Setor hanya mengirim nominal yang masuk jalur usaha itu; nominal lain (misalnya transfer pribadi Rp50.000) tetap di HP saja. Web yang tidak mengirim `band` menerima semua nominal.

Satu HP bisa terhubung ke beberapa usaha sekaligus; setiap uang masuk dikirim ke satu usaha saja menurut jalurnya (yang `band`-nya cocok, kalau tidak ada: web tanpa `band`).

## 4. Ringkasan & pengingat (opsional)

`POST {web}/api/devices/summary` dengan header Bearer, body `{}`. Dipanggil saat Setor dibuka dan tiap 10 menit selama terbuka; sekaligus menjadi heartbeat (web mencatat `lastSeenAt`).

```json
{
  "business": { "name": "Kos Melati", "type": "kos" },
  "dashboard": "https://kosinyuk.id/tagihan",
  "items": [
    { "id": "…", "title": "Sari · K5", "detail": "Rp800.731 · jatuh tempo 10 Nov", "action": { "text": "WA", "url": "https://wa.me/62…?text=…" } }
  ]
}
```

Setor menampilkan `items` di kotak Notifikasi dengan tombol `action` (hanya URL https). Web tanpa endpoint ini (404) dilewati.

## 5. Ubah rentang

`POST {web}/api/devices/band` (Bearer) `{ "band": { "min": 600, "max": 999 } }` → `{ "band": { … } }` rentang yang dipakai.

- Validasi: bilangan bulat 1–999, `min ≤ max`, minimal 10 angka.
- Hanya tagihan **baru** yang memakai rentang baru; tagihan lama tetap cocok dengan nominalnya.
- Di Setor, rentang lama tetap dikirim ke bisnis yang sama selama 45 hari (`prevBands`), supaya pembayaran tagihan lama tidak nyasar.
- `404` = web lama dengan jalur tetap: Setor kembali ke rentang dari pairing.

## 6. Riwayat (pasang ulang / HP baru)

`POST {web}/api/devices/history` (Bearer), body `{}` → `{ "items": [{ "notifId", "amount", "time", "text", "result", "label" }] }`, pembayaran dari Setor ke bisnis ini selama 90 hari terakhir. Setor memanggilnya setelah pairing dan menggabungkan yang belum ada (berdasarkan `notifId`), jadi data yang sudah terkirim kembali walau HP direset.

## 7. Laporan ganda dari dua HP

Kalau dua HP Setor membaca DANA yang sama, `notifId` berbeda (waktu notifikasi tiap HP beda). Web menganggap laporan **dari perangkat lain** dengan nominal sama dalam ±2 menit sebagai `duplicate`.

## Belum ada

- HMAC + timestamp di atas Bearer, notifikasi aksi dari web ke Setor, sumber selain DANA.
