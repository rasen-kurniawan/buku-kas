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
      if (applied.length) {
        this.backend.applyRemote(applied);
        summary.masuk = applied.length;
      }
      await this.store.setMeta('seen', seen);

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

      for (const key of await this.store.pendingUploads()) {
        const name = FOTO_PREFIX + key;
        if (!byName.has(name)) {
          const b = await this.store.getBlob(key);
          if (!b) continue;
          const up = await this.drive.upload(name, b.blob, null);
          byName.set(name, up);
          summary.fotoNaik++;
        }
        await this.store.markUploaded(key);
      }

      const needed = new Set(this.backend.live('transaksi').map(t => t.foto).filter(Boolean));
      const local = new Set(await this.store.blobKeys());
      for (const key of needed) {
        if (local.has(key)) continue;
        const f = byName.get(FOTO_PREFIX + key);
        if (!f) continue; // belum diunggah perangkat asalnya; coba lagi nanti
        const blob = await this.drive.downloadBlob(f.id);
        await this.store.putBlob(key, blob, true);
        summary.fotoTurun++;
      }

      // Bersihkan salinan lokal foto yang sudah tidak dipakai transaksi mana pun (dan sudah aman di Drive).
      for (const key of local) {
        if (needed.has(key)) continue;
        const b = await this.store.getBlob(key);
        if (b && b.up) await this.store.deleteBlob(key);
      }

      if (applied.length) this.onRemoteChange(applied);
      return summary;
    }
  }

  global.BKSync = SyncEngine;
})(window);
