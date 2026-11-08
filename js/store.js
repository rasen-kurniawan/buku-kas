/*
 * store.js — penyimpanan lokal (IndexedDB) untuk Buku Kas.
 *
 * Object store:
 *   records : tampilan gabungan semua data   { k, c, id, v, u, d, x }
 *   mine    : versi terakhir yang DITULIS perangkat ini (diunggah ke Drive)
 *   blobs   : foto struk                      { key, data (ArrayBuffer), type, size, up }
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

    /* ---------- blobs (foto) ----------
     * Foto disimpan sebagai ArrayBuffer (bytes), BUKAN objek Blob/File.
     * Chrome Android kadang gagal menyimpan Blob dari kamera/galeri ke IndexedDB
     * ("Failed to write blobs / Invalid blob"); bytes biasa selalu bisa disimpan.
     * Data lama yang masih berbentuk { blob } tetap terbaca.
     * Daftar foto yang belum terunggah disimpan di meta 'pendingFoto' supaya tidak perlu
     * memuat seluruh isi foto hanya untuk menghitungnya. */
    async _pendingSet() {
      let list = await this.getMeta('pendingFoto');
      if (!Array.isArray(list)) {
        const tx = this.db.transaction('blobs');
        const all = await reqP(tx.objectStore('blobs').getAll());
        list = all.filter(b => !b.up).map(b => b.key);
        await this.setMeta('pendingFoto', list);
      }
      return new Set(list);
    }
    async _setPending(key, pending) {
      const set = await this._pendingSet();
      const had = set.has(key);
      if (pending && !had) set.add(key);
      else if (!pending && had) set.delete(key);
      else return;
      await this.setMeta('pendingFoto', Array.from(set));
    }

    async putBlob(key, blob, uploaded = false) {
      let data;
      try {
        data = await blob.arrayBuffer();
      } catch (e) {
        throw new Error('Foto tidak bisa dibaca dari perangkat. Coba pilih ulang fotonya (atau ambil dari galeri, bukan langsung dari aplikasi lain).');
      }
      const tx = this.db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ key, data, type: blob.type || 'application/octet-stream', size: data.byteLength, up: uploaded });
      await txDone(tx);
      await this._setPending(key, !uploaded);
    }
    async getBlob(key) {
      const tx = this.db.transaction('blobs');
      const v = await reqP(tx.objectStore('blobs').get(key));
      if (!v) return null;
      if (v.data) return { key: v.key, blob: new Blob([v.data], { type: v.type }), up: v.up };
      return v;
    }
    async deleteBlob(key) {
      const tx = this.db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(key);
      await txDone(tx);
      await this._setPending(key, false);
    }
    async blobKeys() {
      const tx = this.db.transaction('blobs');
      return reqP(tx.objectStore('blobs').getAllKeys());
    }
    async pendingUploads() {
      return Array.from(await this._pendingSet());
    }
    async markUploaded(key) {
      const tx = this.db.transaction('blobs', 'readwrite');
      const st = tx.objectStore('blobs');
      const v = await reqP(st.get(key));
      if (v) { v.up = true; st.put(v); }
      await txDone(tx);
      await this._setPending(key, false);
    }
  }

  Store.newer = newer;
  global.BKStore = Store;
})(window);
