# Buku Kas (PWA)

Dashboard keuangan pribadi yang:
- jalan di **laptop dan HP** dari satu alamat web, bisa dipasang seperti aplikasi;
- **tetap bisa dipakai tanpa internet**, semua catatan tersimpan di perangkat;
- **tersinkron lewat Google Drive Anda** (folder tersembunyi khusus aplikasi) saat online;
- **hanya bisa dipakai pemilik**. Orang lain hanya melihat Overview kosong; tab lain meminta login.

Tidak ada server, tidak ada biaya. Python/PostgreSQL lama tidak dipakai lagi (hanya untuk impor sekali).

---

## 1. Setup Google (sekali saja, ±10 menit)

1. Buka <https://console.cloud.google.com/> → buat **project baru** (mis. `buku-kas`).
2. **APIs & Services → Library** → cari **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (atau *Google Auth Platform*):
   - User type: **External**.
   - Isi nama aplikasi (`Buku Kas`) dan email Anda.
   - **Data access / Scopes**: tambahkan `.../auth/drive.appdata`.
   - **Audience / Test users**: tambahkan **email Google Anda saja**.
   - Biarkan status **Testing**. Ini yang membuat akun lain ditolak oleh Google sendiri.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: `https://NAMA-GITHUB-ANDA.github.io`
     (tanpa garis miring dan tanpa nama repo di belakangnya).
   - Redirect URI tidak perlu diisi.
   - Salin **Client ID**-nya (berakhiran `.apps.googleusercontent.com`).
5. Buat hash email Anda. Jalankan di PowerShell (ganti emailnya):
   ```powershell
   $e = 'emailanda@gmail.com'.Trim().ToLower(); -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($e)) | % { $_.ToString('x2') })
   ```
6. Isi `js/config.js`:
   ```js
   window.BK_CONFIG = {
     GOOGLE_CLIENT_ID: '1234...apps.googleusercontent.com',
     OWNER_EMAIL_SHA256: 'hasil langkah 5',
   };
   ```
   Client ID bukan rahasia. Email disimpan sebagai hash supaya tidak terbaca di repo publik.

## 2. Taruh di GitHub Pages

1. Di GitHub: **New repository** (mis. `bukukas`), **Public**.
2. **Add file → Upload files** → seret **isi** folder `BukuKas-PWA` (bukan foldernya). Pastikan
   `index.html` berada di akar repo. Jangan ikutkan file ekspor/cadangan JSON, `uploads`, `.xlsx`, `.dump`.
3. **Settings → Pages → Build and deployment**: Source **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Tunggu 1–2 menit. Alamat aplikasi: `https://NAMA-GITHUB-ANDA.github.io/bukukas/`.

## 3. Pindahkan data lama (sekali, di laptop)

1. Pastikan PostgreSQL lama menyala, lalu jalankan:
   ```bash
   py tools/export_pg.py
   ```
   Hasilnya `D:\Zuang\BukuKas-export\bukukas-export-<tanggal>.json` (di **luar** folder repo, berisi data Anda).
2. Buka alamat aplikasi di Chrome/Edge laptop → **🔐 Masuk** → login dengan akun Google Anda.
3. **⚙️ Pengaturan → ☁️ Sinkron & Cadangan → 📥 Impor data lama**:
   - File ekspor: pilih JSON dari langkah 1.
   - Foto struk lama: buka `D:\Zuang\uploads`, tekan **Ctrl+A**, pilih semua.
   - **Mulai impor**. Foto otomatis dikecilkan (±50–200 KB per foto).
4. Ketuk **🔄 Sinkron sekarang**. Data dan foto naik ke Google Drive.

## 4. Pasang di HP

1. Buka alamat aplikasi di **Chrome** HP → menu ⋮ → **Instal aplikasi / Tambahkan ke layar utama**.
2. Buka dari ikon **Buku Kas** → **🔐 Masuk** → data dan foto turun dari Drive.

## Pemakaian sehari-hari

- Catat seperti biasa, online atau offline. Semuanya langsung tersimpan di perangkat.
- Tombol awan di kanan atas menunjukkan status:
  - **☁️ Tersinkron**: aman.
  - **Belum tersinkron** / **📴 Offline**: tersimpan lokal, akan dikirim saat online.
  - **🔑 Ketuk untuk sinkron**: izin Google (±1 jam) habis. Ketuk sekali untuk sinkron lagi.
- Sinkron berjalan otomatis saat aplikasi dibuka, saat internet kembali, setelah mencatat, dan tiap 3 menit.
- Bila dua perangkat mengubah transaksi yang **sama** saat offline, perubahan yang **paling akhir** yang dipakai.
- Bunga harian yang dihitung di dua perangkat **tidak** tercatat dobel.

## Keamanan & cadangan

- Orang lain yang membuka alamat aplikasi hanya melihat Overview kosong. Login dengan akun lain ditolak.
- **Keluar**: data di perangkat disembunyikan sampai login lagi.
  **Keluar & hapus data**: salinan di perangkat dibuang, data di Drive tetap aman.
- Salinan di perangkat tidak dienkripsi. Pakai kunci layar di HP dan laptop.
- Folder Drive aplikasi tersembunyi dan **ikut terhapus** bila Anda mencabut akses aplikasi lewat
  pengaturan akun Google. Karena itu, sesekali tekan **⬇️ Unduh cadangan (.json)** dan simpan filenya.

## Mengubah kode

- Setelah mengubah file, naikkan `VERSION` di `sw.js` (mis. `bukukas-v2`) supaya perangkat mengambil versi baru.
  Perangkat memakai versi baru setelah aplikasi dibuka ulang (kadang perlu dua kali).
- Uji lokal tanpa Google (jalankan dari dalam folder `BukuKas-PWA`):
  ```bash
  py -m http.server 5600 --bind 127.0.0.1
  ```
  Buka `http://localhost:5600/?mock=1&nosw`. Login dan Drive memakai versi tiruan (hanya aktif di localhost).
  Tambahkan `&device=B` di tab lain untuk mensimulasikan perangkat kedua.

## Struktur

| File | Isi |
|---|---|
| `index.html` | Tampilan dashboard (dari versi aktif), ditambah tata letak HP |
| `js/backend.js` | Pengganti `main.py`: aturan transaksi, transfer, akun, kategori, deposito, bunga |
| `js/store.js` | Penyimpanan lokal (IndexedDB) |
| `js/sync.js` | Sinkron dengan Google Drive |
| `js/drive.js` | Akses folder aplikasi di Drive (+ Drive tiruan untuk uji) |
| `js/auth.js` | Login Google satu pemilik |
| `js/app-shell.js` | Mode tamu/pemilik, tombol sinkron, impor, cadangan, foto |
| `sw.js`, `manifest.webmanifest`, `icons/` | Supaya bisa dipasang dan dibuka offline |
| `tools/export_pg.py` | Ekspor sekali dari PostgreSQL lama |
