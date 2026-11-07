/*
 * auth.js — login Google untuk SATU pemilik.
 *
 * Lapisan pengaman:
 *   1. Google OAuth (status "Testing", hanya email pemilik yang terdaftar sebagai test user)
 *      -> akun lain ditolak oleh Google sendiri.
 *   2. Aplikasi mencocokkan hash SHA-256 email login dengan OWNER_EMAIL_SHA256 di config.js
 *      -> email pemilik tidak tertulis polos di kode publik.
 *
 * "Sesi pemilik" disimpan di perangkat sehingga aplikasi bisa dipakai offline.
 * Token Drive (±1 jam) hanya dibutuhkan saat sinkron.
 */
(function (global) {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`) && global.google && google.accounts) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Tidak bisa memuat layanan login Google. Periksa koneksi internet.'));
      document.head.appendChild(s);
    });
  }

  class AuthError extends Error {}

  class GoogleAuth {
    constructor(cfg, sessionKey) {
      this.cfg = cfg;
      this.sessionKey = sessionKey;
      this.token = null;       // { access_token, exp }
      this.client = null;
      this._pending = null;
      try {
        const t = JSON.parse(sessionStorage.getItem(sessionKey + ':token') || 'null');
        if (t && t.exp > Date.now() + 60000) this.token = t;
      } catch (e) { }
    }

    get configured() { return !!(this.cfg.GOOGLE_CLIENT_ID && this.cfg.OWNER_EMAIL_SHA256); }

    session() {
      try { return JSON.parse(localStorage.getItem(this.sessionKey) || 'null'); } catch (e) { return null; }
    }
    isOwner() {
      const s = this.session();
      return !!(s && s.h && s.h === String(this.cfg.OWNER_EMAIL_SHA256).toLowerCase());
    }
    hasToken() { return !!(this.token && this.token.exp > Date.now() + 60000); }

    async _client() {
      if (this.client) return this.client;
      await loadScript(GIS_SRC);
      this.client = google.accounts.oauth2.initTokenClient({
        client_id: this.cfg.GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: resp => {
          const p = this._pending; this._pending = null;
          if (!p) return;
          if (resp.error) p.reject(new AuthError(resp.error_description || resp.error));
          else p.resolve(resp);
        },
        error_callback: err => {
          const p = this._pending; this._pending = null;
          if (p) p.reject(new AuthError(err && err.type === 'popup_closed' ? 'Jendela login ditutup.' : 'Login dibatalkan atau diblokir browser.'));
        },
      });
      return this.client;
    }

    async _requestToken(prompt) {
      const client = await this._client();
      const s = this.session();
      const resp = await new Promise((resolve, reject) => {
        this._pending = { resolve, reject };
        client.requestAccessToken({ prompt, login_hint: s && s.e ? s.e : undefined });
      });
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/drive.appdata')) {
        throw new AuthError('Izin akses Google Drive tidak diberikan. Centang izin Drive saat login.');
      }
      return resp;
    }

    async _verify(resp) {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + resp.access_token } });
      if (!r.ok) throw new AuthError('Gagal membaca identitas akun Google.');
      const info = await r.json();
      const email = String(info.email || '').trim().toLowerCase();
      const h = await sha256Hex(email);
      if (!email || info.email_verified === false || h !== String(this.cfg.OWNER_EMAIL_SHA256).toLowerCase()) {
        try { google.accounts.oauth2.revoke(resp.access_token, () => { }); } catch (e) { }
        throw new AuthError('Akun ini tidak punya akses ke dashboard ini.');
      }
      return { email, h };
    }

    _saveToken(resp) {
      this.token = { access_token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
      try { sessionStorage.setItem(this.sessionKey + ':token', JSON.stringify(this.token)); } catch (e) { }
    }

    /** Login interaktif (harus dipanggil dari klik tombol). */
    async login() {
      if (!this.configured) throw new AuthError('Aplikasi belum dikonfigurasi (GOOGLE_CLIENT_ID / OWNER_EMAIL_SHA256 di js/config.js).');
      const resp = await this._requestToken('select_account');
      const who = await this._verify(resp);
      this._saveToken(resp);
      localStorage.setItem(this.sessionKey, JSON.stringify({ h: who.h, e: who.email, at: Date.now() }));
      return who;
    }

    /** Token untuk Drive. interactive=true boleh membuka popup (hanya dari klik pengguna). */
    async getToken(interactive) {
      if (this.hasToken()) return this.token.access_token;
      if (!interactive) return null;
      const resp = await this._requestToken('');
      await this._verify(resp);
      this._saveToken(resp);
      return this.token.access_token;
    }

    dropToken() {
      this.token = null;
      try { sessionStorage.removeItem(this.sessionKey + ':token'); } catch (e) { }
    }

    logout() {
      const t = this.token;
      this.dropToken();
      localStorage.removeItem(this.sessionKey);
      if (t && global.google && google.accounts) { try { google.accounts.oauth2.revoke(t.access_token, () => { }); } catch (e) { } }
    }
  }

  /** Login tiruan untuk pengujian di localhost (?mock=1). Tidak aktif di domain lain. */
  class MockAuth {
    constructor(sessionKey) { this.sessionKey = sessionKey; this.configured = true; }
    session() { try { return JSON.parse(localStorage.getItem(this.sessionKey) || 'null'); } catch (e) { return null; } }
    isOwner() { return !!this.session(); }
    hasToken() { return this.isOwner() && localStorage.getItem(this.sessionKey + ':notoken') !== '1'; }
    async login() {
      localStorage.setItem(this.sessionKey, JSON.stringify({ h: 'mock', e: 'pemilik@contoh.test', at: Date.now() }));
      localStorage.removeItem(this.sessionKey + ':notoken');
      return { email: 'pemilik@contoh.test' };
    }
    async getToken(interactive) {
      if (this.hasToken()) return 'mock-token';
      if (interactive) { localStorage.removeItem(this.sessionKey + ':notoken'); return 'mock-token'; }
      return null;
    }
    dropToken() { localStorage.setItem(this.sessionKey + ':notoken', '1'); }
    logout() { localStorage.removeItem(this.sessionKey); localStorage.removeItem(this.sessionKey + ':notoken'); }
  }

  global.BKAuth = { GoogleAuth, MockAuth, AuthError, sha256Hex };
})(window);
