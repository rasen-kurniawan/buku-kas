/*
 * sync.js — sinkron antar perangkat lewat Google Drive (appDataFolder).
 *
 * Isi folder Drive:
 *   dev-<idPerangkat>.json : semua versi data yang ditulis perangkat itu (hanya perangkat itu yang menulis file ini)
 *   foto-<key>             : foto struk (satu file per foto)
 *
 * Langkah sinkron:
 *   1. Unduh file dev-*.json milik perangkat lain yang berubah sejak sinkron terakhir,
 *      gabungkan: per data, versi dengan waktu ubah terbaru yang menang (hapus juga dicatat).
 *   2. Unggah file dev-<perangkat ini>.json bila ada perubahan lokal.
 *   3. Unggah foto baru, hapus foto yang sudah tidak dipakai, unduh foto yang belum ada di perangkat.
 * Karena tiap perangkat hanya menulis filenya sendiri, dua perangkat tidak pernah saling menimpa.
 */
(function (global) {
  'use strict';

  const DEV_PREFIX = 'dev-';
  const FOTO_PREFIX = 'foto-';

  class SyncEngine {
    constructor({ store, backend, drive, deviceId, onRemoteChange, onStatus }) {
      this.store = store;
      this.backend = backend;
      this.drive = drive;
      this.deviceId = deviceId;
      this.onRemoteChange = onRemoteChange || (() => { });
      this.onStatus = onStatus || (() => { });
      this.running = null;
      this.again = false;
    }

    myFileName() { return `${DEV_PREFIX}${this.deviceId}.json`; }

    /** Jalankan sinkron; panggilan saat sinkron sedang berjalan dijadwalkan ulang setelahnya. */
    sync() {
      if (this.running) { this.again = true; return this.running; }
      this.running = (async () => {
        let result;
        try {
          do {
            this.again = false;
            result = await this._syncOnce();
          } while (this.again);
          await this.store.setMeta('lastSync', Date.now());
          this.onStatus({ state: 'ok', at: Date.now(), result });
          return result;
        } catch (e) {
          const auth = e instanceof BKDrive.DriveAuthError;
          this.onStatus({ state: auth ? 'auth' : 'error', error: e });
          throw e;
        } finally {
          this.running = null;
        }
      })();
      this.onStatus({ state: 'syncing' });
      return this.running;
    }

    async _syncOnce() {
      const files = await this.drive.list();
      const byName = new Map();
      // Bila ada nama ganda (mis. dua unggahan bersamaan), pakai yang terbaru.
      for (const f of files) {
        const cur = byName.get(f.name);
        if (!cur || String(f.modifiedTime) > String(cur.modifiedTime)) byName.set(f.name, f);
      }
      const seen = await this.store.getMeta('seen', {});
      const summary = { masuk: 0, keluar: 0, fotoNaik: 0, fotoTurun: 0, fotoHapus: 0 };

      /* 1. tarik perubahan dari perangkat lain */
      const applied = [];
      for (const f of byName.values()) {
        if (!f.name.startsWith(DEV_PREFIX) || f.name === this.myFileName()) continue;
        if (seen[f.name] === f.modifiedTime) continue;
        const text = await this.drive.downloadText(f.id);
        let doc;
        try { doc = JSON.parse(text); } catch (e) { continue; } // file rusak/terpotong: lewati, coba lagi nanti
        const recs = (doc.records || []).filter(r => r && r.k && r.c && typeof r.u === 'number');
        const got = await this.store.mergeRemote(recs);
        applied.push(...got);
        seen[f.name] = f.modifiedTime;
      }
      await this.store.setMeta('seen', seen);
      if (applied.length) {
        this.backend.applyRemote(applied);
        summary.masuk = applied.length;
        // Segarkan tampilan SEKARANG, jangan tunggu foto-foto selesai diunduh.
        try { this.onRemoteChange(applied); } catch (e) { console.error(e); }
      }

      /* 2. dorong perubahan lokal */
      if (await this.store.getMeta('mineDirty', false)) {
        await this.store.setMeta('mineDirty', false);
        try {
          const mine = await this.store.allMine();
          const doc = { format: 'bukukas-sync', versi: 1, device: this.deviceId, ditulis: new Date().toISOString(), records: mine };
          const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
          const existing = byName.get(this.myFileName());
          const up = await this.drive.upload(this.myFileName(), blob, existing && existing.id);
          byName.set(this.myFileName(), up);
          summary.keluar = mine.length;
        } catch (e) {
          await this.store.setMeta('mineDirty', true);
          throw e;
        }
      }

      /* 3. foto */
      const pendingDeletes = await this.store.getMeta('photoDeletes', []);
      const stillDeleting = [];
      for (const key of pendingDeletes) {
        const f = byName.get(FOTO_PREFIX + key);
        try {
          if (f) { await this.drive.remove(f.id); summary.fotoHapus++; byName.delete(FOTO_PREFIX + key); }
        } catch (e) { stillDeleting.push(key); if (!(e instanceof BKDrive.DriveError)) throw e; }
      }
      await this.store.setMeta('photoDeletes', stillDeleting);

      // Satu foto yang gagal tidak boleh menggagalkan seluruh sinkron; coba lagi di sinkron berikutnya.
      // Hanya masalah login (DriveAuthError) yang menghentikan proses.
      const tolerate = e => { if (e instanceof BKDrive.DriveAuthError) throw e; summary.fotoGagal++; console.warn('Foto dilewati:', e); };
      summary.fotoGagal = 0;

      const toUpload = await this.store.pendingUploads();
      for (let i = 0; i < toUpload.length; i++) {
        const key = toUpload[i];
        const name = FOTO_PREFIX + key;
        this.onStatus({ state: 'syncing', detail: `Mengunggah foto ${i + 1}/${toUpload.length}` });
        try {
          if (!byName.has(name)) {
            const b = await this.store.getBlob(key);
            if (!b) { await this.store.markUploaded(key); continue; }
            const up = await this.drive.upload(name, b.blob, null);
            byName.set(name, up);
            summary.fotoNaik++;
          }
          await this.store.markUploaded(key);
        } catch (e) { tolerate(e); }
      }

      const needed = new Set(this.backend.live('transaksi').map(t => t.foto).filter(Boolean));
      const local = new Set(await this.store.blobKeys());
      // belum diunggah perangkat asalnya -> lewati, coba lagi nanti
      const toDownload = Array.from(needed).filter(key => !local.has(key) && byName.has(FOTO_PREFIX + key));
      for (let i = 0; i < toDownload.length; i++) {
        const key = toDownload[i];
        this.onStatus({ state: 'syncing', detail: `Mengunduh foto ${i + 1}/${toDownload.length}` });
        try {
          const blob = await this.drive.downloadBlob(byName.get(FOTO_PREFIX + key).id);
          await this.store.putBlob(key, blob, true);
          summary.fotoTurun++;
        } catch (e) { tolerate(e); }
      }

      // Bersihkan salinan lokal foto yang sudah tidak dipakai transaksi mana pun (dan sudah aman di Drive).
      for (const key of local) {
        if (needed.has(key)) continue;
        const b = await this.store.getBlob(key);
        if (b && b.up) await this.store.deleteBlob(key);
      }

      return summary;
    }
  }

  global.BKSync = SyncEngine;
})(window);
