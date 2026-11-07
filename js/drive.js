/*
 * drive.js — akses folder tersembunyi aplikasi di Google Drive (appDataFolder).
 * Hanya file yang dibuat aplikasi ini yang bisa dibaca/ditulis; file Drive lain tidak tersentuh.
 */
(function (global) {
  'use strict';

  class DriveAuthError extends Error {}
  class DriveError extends Error {}

  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  class DriveApi {
    /** @param {() => Promise<string|null>} getToken */
    constructor(getToken) { this.getToken = getToken; }

    async _fetch(url, opts = {}) {
      const token = await this.getToken();
      if (!token) throw new DriveAuthError('Perlu login ulang untuk sinkron.');
      let res;
      try {
        res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
      } catch (e) {
        throw new DriveError('Tidak ada koneksi internet.');
      }
      if (res.status === 401) throw new DriveAuthError('Sesi Google kedaluwarsa, perlu login ulang.');
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).error.message; } catch (e) { }
        throw new DriveError(`Google Drive menolak permintaan (HTTP ${res.status}) ${msg}`.trim());
      }
      return res;
    }

    async list() {
      const files = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,modifiedTime,size)', pageSize: '1000' });
        if (pageToken) q.set('pageToken', pageToken);
        const data = await (await this._fetch(`${API}?${q}`)).json();
        files.push(...(data.files || []));
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return files;
    }

    async downloadText(id) { return (await this._fetch(`${API}/${encodeURIComponent(id)}?alt=media`)).text(); }
    async downloadBlob(id) { return (await this._fetch(`${API}/${encodeURIComponent(id)}?alt=media`)).blob(); }

    /** Buat file baru (existingId kosong) atau timpa isinya. */
    async upload(name, blob, existingId) {
      if (existingId) {
        const res = await this._fetch(`${UPLOAD}/${encodeURIComponent(existingId)}?uploadType=media&fields=id,name,modifiedTime`, {
          method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
        });
        return res.json();
      }
      const boundary = 'bk' + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ]);
      const res = await this._fetch(`${UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
      return res.json();
    }

    async remove(id) {
      try { await this._fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
      catch (e) { if (!(e instanceof DriveError) || !/HTTP 404/.test(e.message)) throw e; }
    }
  }

  /** Drive tiruan di IndexedDB terpisah, untuk menguji sinkron antar "perangkat" di localhost. */
  class MockDrive {
    constructor(getToken) { this.getToken = getToken; this.dbp = null; this.offline = false; }
    _db() {
      if (!this.dbp) {
        this.dbp = new Promise((resolve, reject) => {
          const r = indexedDB.open('bukukas-mockdrive', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      }
      return this.dbp;
    }
    async _check() {
      if (this.offline || localStorage.getItem('bk-mock-offline') === '1') throw new DriveError('Tidak ada koneksi internet.');
      if (!(await this.getToken())) throw new DriveAuthError('Perlu login ulang untuk sinkron.');
    }
    async _tx(mode, fn) {
      const db = await this._db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('files', mode);
        const out = fn(tx.objectStore('files'));
        tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        tx.onerror = () => reject(tx.error);
      });
    }
    async list() {
      await this._check();
      const all = await this._tx('readonly', s => s.getAll());
      return all.map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, size: String(f.blob.size) }));
    }
    async _get(id) {
      await this._check();
      const f = await this._tx('readonly', s => s.get(id));
      if (!f) throw new DriveError('HTTP 404');
      return f;
    }
    async downloadText(id) { return (await this._get(id)).blob.text(); }
    async downloadBlob(id) { return (await this._get(id)).blob; }
    async upload(name, blob, existingId) {
      await this._check();
      const id = existingId || 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const modifiedTime = new Date(Date.now() + Math.random()).toISOString() + Math.random().toString(36).slice(2, 5);
      await this._tx('readwrite', s => s.put({ id, name, blob, modifiedTime }));
      return { id, name, modifiedTime };
    }
    async remove(id) { await this._check(); await this._tx('readwrite', s => s.delete(id)); }
  }

  global.BKDrive = { DriveApi, MockDrive, DriveAuthError, DriveError };
})(window);
