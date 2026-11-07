/*
 * store.js — penyimpanan lokal (IndexedDB) untuk Buku Kas.
 *
 * Object store:
 *   records : tampilan gabungan semua data   { k, c, id, v, u, d, x }
 *   mine    : versi terakhir yang DITULIS perangkat ini (diunggah ke Drive)
 *   blobs   : foto struk                      { key, blob, up }
 *   meta    : pengaturan perangkat (deviceId, status sinkron, dll.)
 *
 *   k = "<koleksi>|<id>", c = koleksi, v = isi data, u = waktu ubah (ms),
 *   d = id perangkat penulis, x = true bila sudah dihapus (tombstone).
 */
(function (global) {
  'use strict';

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaksi IndexedDB dibatalkan'));
    });
  }

  /** Urutan versi: waktu ubah lebih baru menang; seri -> id perangkat terbesar. */
  function newer(a, b) {
    if (!b) return true;
    if (a.u !== b.u) return a.u > b.u;
    return String(a.d) > String(b.d);
  }

  class Store {
    constructor(name) {
      this.name = name;
      this.db = null;
    }

    async open() {
      if (this.db) return this;
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('mine')) db.createObjectStore('mine', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      this.db = await reqP(req);
      return this;
    }

    close() { if (this.db) { this.db.close(); this.db = null; } }

    async destroy() {
      this.close();
      await reqP(indexedDB.deleteDatabase(this.name));
    }

    /* ---------- meta ---------- */
    async getMeta(key, fallback = null) {
      const tx = this.db.transaction('meta');
      const v = await reqP(tx.objectStore('meta').get(key));
      return v === undefined ? fallback : v;
    }
    async setMeta(key, value) {
      const tx = this.db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(value, key);
      await txDone(tx);
    }

    /* ---------- records ---------- */
    async allRecords() {
      const tx = this.db.transaction('records');
      return reqP(tx.objectStore('records').getAll());
    }
    async allMine() {
      const tx = this.db.transaction('mine');
      return reqP(tx.objectStore('mine').getAll());
    }

    /** Tulis perubahan lokal: masuk ke 'records' dan 'mine' sekaligus (atomik). */
    async writeLocal(recs) {
      if (!recs.length) return;
      const tx = this.db.transaction(['records', 'mine', 'meta'], 'readwrite');
      const r = tx.objectStore('records'), m = tx.objectStore('mine');
      for (const rec of recs) { r.put(rec); m.put(rec); }
      tx.objectStore('meta').put(true, 'mineDirty');
      await txDone(tx);
    }

    /** Terapkan versi dari perangkat lain; hanya yang lebih baru yang menang. Mengembalikan yang diterapkan. */
    async mergeRemote(recs) {
      if (!recs.length) return [];
      const tx = this.db.transaction('records', 'readwrite');
      const st = tx.objectStore('records');
      const applied = [];
      for (const rec of recs) {
        const cur = await reqP(st.get(rec.k));
        if (newer(rec, cur)) { st.put(rec); applied.push(rec); }
      }
      await txDone(tx);
      return applied;
    }

    async clearAll() {
      const tx = this.db.transaction(['records', 'mine', 'blobs', 'meta'], 'readwrite');
      ['records', 'mine', 'blobs', 'meta'].forEach(n => tx.objectStore(n).clear());
      await txDone(tx);
    }

    /* ---------- blobs (foto) ---------- */
    async putBlob(key, blob, uploaded = false) {
      const tx = this.db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ key, blob, up: uploaded });
      await txDone(tx);
    }
    async getBlob(key) {
      const tx = this.db.transaction('blobs');
      const v = await reqP(tx.objectStore('blobs').get(key));
      return v || null;
    }
    async deleteBlob(key) {
      const tx = this.db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(key);
      await txDone(tx);
    }
    async blobKeys() {
      const tx = this.db.transaction('blobs');
      return reqP(tx.objectStore('blobs').getAllKeys());
    }
    async pendingUploads() {
      const tx = this.db.transaction('blobs');
      const all = await reqP(tx.objectStore('blobs').getAll());
      return all.filter(b => !b.up).map(b => b.key);
    }
    async markUploaded(key) {
      const tx = this.db.transaction('blobs', 'readwrite');
      const st = tx.objectStore('blobs');
      const v = await reqP(st.get(key));
      if (v) { v.up = true; st.put(v); }
      await txDone(tx);
    }
  }

  Store.newer = newer;
  global.BKStore = Store;
})(window);
