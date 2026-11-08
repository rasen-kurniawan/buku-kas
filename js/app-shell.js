/*
 * app-shell.js — perekat antara tampilan lama (index.html) dan penyimpanan lokal + sinkron.
 *
 *  - Mode TAMU  : belum login. Overview tampil kosong, tab lain & semua aksi simpan meminta login.
 *  - Mode PEMILIK: sudah login dengan akun pemilik. Data dari IndexedDB, sinkron ke Google Drive.
 *
 * Pengujian di localhost: tambahkan ?mock=1 (login & Drive tiruan), dan &device=B untuk
 * mensimulasikan perangkat kedua di tab lain. Mode tiruan tidak aktif di domain selain localhost.
 */
(function (global) {
  'use strict';

  const cfg = global.BK_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const MOCK = isLocalHost && params.has('mock');
  const SUFFIX = MOCK && params.get('device') ? '-' + params.get('device').replace(/[^\w-]/g, '') : '';
  const STORE_NAME = 'bukukas-data' + SUFFIX;
  const SESSION_KEY = 'bk-session' + SUFFIX;

  const auth = MOCK ? new BKAuth.MockAuth(SESSION_KEY) : new BKAuth.GoogleAuth(cfg, SESSION_KEY);

  let store = null, backend = null, engine = null, deviceId = null;
  let syncState = { state: 'idle' };
  const photoUrlCache = new Map();

  const loginRequired = () => { const e = new Error('Login untuk mengakses dashboard ini.'); e.loginRequired = true; return e; };

  /* ------------------------------------------------------------ mode tamu */
  const guestBackend = {
    async handle(method, path) {
      if (method.toUpperCase() !== 'GET') throw loginRequired();
      const p = path.split('?')[0];
      if (['/api/transaksi', '/api/akun', '/api/kategori', '/api/deposito'].includes(p)) return [];
      throw loginRequired();
    },
    live() { return []; },
  };

  /* ------------------------------------------------------------ foto */
  async function compressImage(file, maxDim = 1600, quality = 0.8) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close && bmp.close();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size < file.size) return blob;
    } catch (e) { /* format tidak didukung: simpan apa adanya */ }
    return file;
  }

  async function savePhoto(file) {
    if (file.size > 10 * 1024 * 1024) throw new BKBackend.ApiError('Ukuran foto maksimal 10 MB.', 413);
    if (!String(file.type || '').startsWith('image/')) throw new BKBackend.ApiError('Format foto tidak didukung (gunakan JPG, PNG, WEBP, GIF, atau BMP).');
    const blob = await compressImage(file);
    const ext = blob.type === 'image/jpeg' ? '.jpg' : (blob.type === 'image/png' ? '.png' : (blob.type === 'image/webp' ? '.webp' : '.img'));
    const key = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + ext;
    await store.putBlob(key, blob, false);
    return key;
  }

  async function removePhoto(key) {
    if (!key) return;
    await store.deleteBlob(key);
    const q = await store.getMeta('photoDeletes', []);
    if (!q.includes(key)) { q.push(key); await store.setMeta('photoDeletes', q); }
    const u = photoUrlCache.get(key);
    if (u) { URL.revokeObjectURL(u); photoUrlCache.delete(key); }
  }

  async function photoObjectUrl(key) {
    if (!store || !key) return null;
    if (photoUrlCache.has(key)) return photoUrlCache.get(key);
    const b = await store.getBlob(key);
    if (!b) return null;
    const u = URL.createObjectURL(b.blob);
    photoUrlCache.set(key, u);
    return u;
  }

  function fotoUrl(key) { return '#foto:' + encodeURIComponent(key); }

  /* ------------------------------------------------------------ API pengganti fetch */
  async function api(path, opts = {}) {
    await ready;
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
    try {
      const out = await (backend || guestBackend).handle(method, path, body);
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    } catch (e) {
      if (e.loginRequired) {
        showLoginModal();
        const err = new Error(e.message); err.network = true; throw err;
      }
      if (e instanceof BKBackend.ApiError) { const err = new Error(e.detail); err.status = e.status; throw err; }
      console.error(e);
      throw new Error('Terjadi kesalahan di perangkat: ' + (e && e.message ? e.message : e));
    }
  }

  /* ------------------------------------------------------------ sinkron */
  let syncTimer = null;
  function scheduleSync(delay = 4000) {
    if (!engine) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => runSync(false), delay);
  }

  async function runSync(interactive) {
    if (!engine) return;
    if (interactive && !auth.hasToken()) {
      try { await auth.getToken(true); }
      catch (e) { toast(e.message || 'Login Google gagal.'); return; }
    }
    if (!auth.hasToken()) { setStatus({ state: 'auth' }); return; }
    try {
      const r = await engine.sync();
      if (interactive) {
        const parts = [];
        if (r.masuk) parts.push(`${r.masuk} perubahan masuk`);
        if (r.keluar) parts.push('perubahan lokal terkirim');
        if (r.fotoNaik) parts.push(`${r.fotoNaik} foto terunggah`);
        if (r.fotoTurun) parts.push(`${r.fotoTurun} foto terunduh`);
        if (r.fotoGagal) parts.push(`${r.fotoGagal} foto gagal (dicoba lagi nanti)`);
        toast(parts.length ? 'Sinkron selesai: ' + parts.join(', ') + '.' : 'Sudah tersinkron, tidak ada perubahan.', 'success');
      }
    } catch (e) {
      if (e instanceof BKDrive.DriveAuthError) auth.dropToken();
      if (interactive) toast(e.message);
    }
  }

  function setStatus(s) {
    syncState = s;
    renderSyncChip();
    renderSyncCard();
  }

  async function onRemoteChange() {
    try {
      if (typeof global.fetchAkun === 'function') {
        await Promise.all([global.fetchAkun(), global.fetchKategori()]);
        await global.fetchTransactions();
        const dep = document.getElementById('page-deposito');
        if (dep && dep.classList.contains('active')) await global.fetchDepositos();
      }
    } catch (e) { console.error(e); }
  }

  /* ------------------------------------------------------------ inisialisasi */
  async function initOwner() {
    store = await new BKStore(STORE_NAME).open();
    deviceId = await store.getMeta('deviceId');
    if (!deviceId) {
      deviceId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 16);
      await store.setMeta('deviceId', deviceId);
    }
    backend = new BKBackend(store, { deviceId, savePhoto, removePhoto });
    await backend.load();
    backend.onChange = () => { renderSyncChip(); scheduleSync(); };
    const DriveCls = MOCK ? BKDrive.MockDrive : BKDrive.DriveApi;
    const drive = new DriveCls(() => auth.getToken(false));
    engine = new BKSync({ store, backend, drive, deviceId, onRemoteChange, onStatus: setStatus });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  }

  const ready = (async () => {
    if (auth.isOwner()) {
      try { await initOwner(); }
      catch (e) { console.error(e); alert('Gagal membuka penyimpanan lokal: ' + e.message); store = backend = engine = null; }
    }
  })();

  /* ------------------------------------------------------------ UI */
  function toast(msg, type = 'error') {
    if (typeof global.showToast === 'function') global.showToast(msg, type);
    else alert(msg);
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  function showLoginModal() {
    let m = document.getElementById('bk-login-modal');
    if (!m) {
      m = el(`
        <div class="modal-overlay" id="bk-login-modal">
          <div class="modal-card pop-anim" style="max-width:400px; text-align:center;">
            <div class="confirm-icon-wrap">🔐</div>
            <h3>Login untuk mengakses dashboard ini</h3>
            <p style="margin:8px 0 16px; line-height:1.5;">Hanya pemilik yang bisa melihat data dan mencatat transaksi.</p>
            <div id="bk-login-error" style="display:none; color:var(--brand-danger); font-size:12.5px; margin-bottom:12px;"></div>
            <div class="modal-actions" style="justify-content:center;">
              <button type="button" class="btn-modal btn-cancel" data-act="close">Batal</button>
              <button type="button" class="btn-modal btn-primary" data-act="login">${MOCK ? 'Masuk (mode uji)' : 'Masuk dengan Google'}</button>
            </div>
          </div>
        </div>`);
      document.body.appendChild(m);
      m.addEventListener('click', async e => {
        const act = e.target.closest('[data-act]');
        if (e.target === m || (act && act.dataset.act === 'close')) { m.classList.remove('active'); return; }
        if (act && act.dataset.act === 'login') {
          const errBox = m.querySelector('#bk-login-error');
          errBox.style.display = 'none';
          act.disabled = true; act.textContent = '⏳ Menunggu Google...';
          try {
            await auth.login();
            location.reload();
          } catch (err) {
            errBox.textContent = err.message || 'Login gagal.';
            errBox.style.display = 'block';
          } finally {
            act.disabled = false; act.textContent = MOCK ? 'Masuk (mode uji)' : 'Masuk dengan Google';
          }
        }
      });
    }
    m.querySelector('#bk-login-error').style.display = 'none';
    m.classList.add('active');
  }

  function fmtTime(ms) {
    if (!ms) return 'belum pernah';
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return today ? `hari ini ${hm}` : `${d.toLocaleDateString('id-ID')} ${hm}`;
  }

  async function renderSyncChip() {
    const chip = document.getElementById('bk-sync-chip');
    if (!chip || !store) return;
    const dirty = await store.getMeta('mineDirty', false);
    const pendingFoto = (await store.pendingUploads()).length;
    const unsynced = dirty || pendingFoto > 0;
    let icon = '☁️', text = 'Tersinkron', cls = 'ok';
    switch (syncState.state) {
      case 'syncing': icon = '🔄'; text = syncState.detail || 'Menyinkron…'; cls = 'busy'; break;
      case 'auth': icon = '🔑'; text = 'Ketuk untuk sinkron'; cls = 'warn'; break;
      case 'error': {
        const offline = !navigator.onLine || /koneksi/i.test(String(syncState.error && syncState.error.message));
        icon = offline ? '📴' : '⚠️'; text = offline ? 'Offline · tersimpan lokal' : 'Gagal sinkron'; cls = 'warn'; break;
      }
      case 'idle': icon = '☁️'; text = auth.hasToken() ? 'Siap sinkron' : 'Ketuk untuk sinkron'; cls = auth.hasToken() ? 'ok' : 'warn'; break;
      default: break;
    }
    if (unsynced && !['syncing', 'auth'].includes(syncState.state) && !/Offline/.test(text)) { text = 'Belum tersinkron'; cls = 'warn'; }
    chip.className = 'bk-chip ' + cls;
    chip.innerHTML = `<span>${icon}</span><span class="bk-chip-text">${esc(text)}</span>`;
    chip.title = 'Sinkron terakhir: ' + fmtTime(await store.getMeta('lastSync')) + ' — ketuk untuk sinkron sekarang';
  }

  async function renderSyncCard() {
    const box = document.getElementById('bk-sync-status');
    if (!box || !store) return;
    const s = auth.session() || {};
    const dirty = await store.getMeta('mineDirty', false);
    const pendingFoto = (await store.pendingUploads()).length;
    box.innerHTML = `
      <div>Akun: <b>${esc(s.e || '-')}</b></div>
      <div>Perangkat ini: <code>${esc(deviceId)}</code></div>
      <div>Sinkron terakhir: <b>${esc(fmtTime(await store.getMeta('lastSync')))}</b></div>
      <div>Perubahan belum terkirim: <b>${dirty ? 'ada' : 'tidak ada'}</b> · Foto menunggu unggah: <b>${pendingFoto}</b></div>
      ${MOCK ? '<div style="color:var(--brand-warning,#E89D42)">Mode uji: login & Google Drive tiruan (hanya di localhost).</div>' : ''}`;
  }

  function injectStyles() {
    document.head.appendChild(el(`<style>
      .bk-chip { display:inline-flex; align-items:center; gap:6px; padding:8px 12px; border-radius:10px; border:1px solid var(--border); background:var(--bg-surface); color:var(--text-primary); font-size:12.5px; font-weight:700; cursor:pointer; white-space:nowrap; }
      .bk-chip.warn { border-color: var(--brand-warning, #E89D42); }
      .bk-chip.busy span:first-child { display:inline-block; animation: bkspin 1s linear infinite; }
      @keyframes bkspin { to { transform: rotate(360deg); } }
      .bk-login-btn { padding:8px 14px; border-radius:10px; border:1px solid var(--border-accent, var(--border)); background:var(--brand-primary); color:#fff; font-size:13px; font-weight:700; cursor:pointer; }
      .bk-sync-card .bk-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
      .bk-sync-card .bk-row button, .bk-sync-card .bk-row label.btn-modal { cursor:pointer; }
      #bk-sync-status { font-size:12.5px; line-height:1.8; color:var(--text-secondary); }
      #bk-sync-status code { font-size:11px; }
      .bk-import-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
      @media (max-width: 640px) {
        .bk-import-grid { grid-template-columns:1fr; }
        .bk-chip .bk-chip-text { display:none; }
        .header-actions { gap:6px; }
      }
      #bk-lightbox { position:fixed; inset:0; background:rgba(0,0,0,.85); display:none; align-items:center; justify-content:center; z-index:9999; padding:16px; }
      #bk-lightbox.active { display:flex; }
      #bk-lightbox img { max-width:100%; max-height:100%; border-radius:10px; }
      #bk-lightbox button { position:absolute; top:14px; right:14px; background:#DC2626; color:#fff; border:none; border-radius:50%; width:36px; height:36px; font-size:18px; cursor:pointer; }
    </style>`));
  }

  function injectHeader() {
    const actions = document.querySelector('.header-actions');
    if (!actions) return;
    if (backend) {
      const chip = el(`<button type="button" id="bk-sync-chip" class="bk-chip">☁️ <span class="bk-chip-text">…</span></button>`);
      chip.addEventListener('click', () => runSync(true));
      actions.insertBefore(chip, actions.firstChild);
      renderSyncChip();
    } else {
      const btn = el(`<button type="button" class="bk-login-btn">🔐 Masuk</button>`);
      btn.addEventListener('click', showLoginModal);
      actions.insertBefore(btn, actions.firstChild);
    }
  }

  function injectSyncCard() {
    const page = document.getElementById('page-settings');
    if (!page || !backend) return;
    const card = el(`
      <div class="card bk-sync-card" style="margin-bottom:18px;">
        <h3>☁️ Sinkron & Cadangan</h3>
        <div id="bk-sync-status"></div>
        <div class="bk-row">
          <button type="button" class="btn-modal btn-primary" data-act="sync">🔄 Sinkron sekarang</button>
          <button type="button" class="btn-modal btn-cancel" data-act="backup">⬇️ Unduh cadangan (.json)</button>
          <label class="btn-modal btn-cancel">♻️ Pulihkan dari cadangan<input type="file" accept="application/json,.json" data-act="restore" hidden></label>
        </div>

        <details style="margin-top:16px;">
          <summary style="cursor:pointer; font-weight:700; font-size:13px;">📥 Impor data lama (PostgreSQL)</summary>
          <p style="font-size:12px; color:var(--text-muted); margin-top:8px; line-height:1.6;">
            Jalankan <code>tools/export_pg.py</code> di laptop, lalu pilih file JSON hasilnya. Foto struk lama ikut diimpor bila Anda memilih
            file-file di folder <code>uploads</code> (boleh pilih semuanya sekaligus). Data dengan id yang sama akan ditimpa, jadi aman diulang.
          </p>
          <div class="bk-import-grid">
            <div class="form-group"><label>File ekspor (.json)</label><input type="file" id="bk-import-json" accept="application/json,.json"></div>
            <div class="form-group"><label>Foto struk lama (opsional)</label><input type="file" id="bk-import-foto" accept="image/*" multiple></div>
          </div>
          <div class="bk-row"><button type="button" class="btn-modal btn-primary" data-act="import">Mulai impor</button><span id="bk-import-progress" style="font-size:12px; align-self:center; color:var(--text-muted);"></span></div>
        </details>

        <div class="bk-row" style="margin-top:18px; border-top:1px solid var(--border); padding-top:14px;">
          <button type="button" class="btn-modal btn-cancel" data-act="logout">🚪 Keluar</button>
          <button type="button" class="btn-modal btn-danger" data-act="wipe">🗑️ Keluar & hapus data dari perangkat ini</button>
        </div>
        <div class="field-hint" style="margin-top:8px;">Keluar: data tetap tersimpan di perangkat tetapi disembunyikan sampai Anda login lagi. Hapus: salinan di perangkat ini dibuang; data di Google Drive tetap aman.</div>
      </div>`);
    const target = page.querySelector('.card') ? page.querySelector('.card').parentElement : page;
    target.insertBefore(card, target.firstChild);

    card.addEventListener('click', async e => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'sync') runSync(true);
      if (act.dataset.act === 'backup') downloadBackup();
      if (act.dataset.act === 'import') runImport();
      if (act.dataset.act === 'logout') doLogout(false);
      if (act.dataset.act === 'wipe') doLogout(true);
    });
    card.querySelector('[data-act="restore"]').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const n = await backend.restoreBackup(JSON.parse(await f.text()));
        toast(`${n} data dipulihkan dari cadangan.`, 'success');
        await onRemoteChange();
      } catch (err) { toast(err.detail || err.message); }
    });
    renderSyncCard();
  }

  function downloadBackup() {
    const data = backend.exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `bukukas-cadangan-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function runImport() {
    const jf = document.getElementById('bk-import-json').files[0];
    const photos = Array.from(document.getElementById('bk-import-foto').files || []);
    const prog = document.getElementById('bk-import-progress');
    if (!jf) { toast('Pilih file JSON hasil export_pg.py dulu.'); return; }
    let dump;
    try { dump = JSON.parse(await jf.text()); } catch (e) { toast('File JSON tidak bisa dibaca.'); return; }
    if (!dump || dump.format !== 'bukukas-pg-export') { toast('File ini bukan hasil export_pg.py.'); return; }

    const needed = new Set((dump.tables.transaksi || []).filter(t => t.foto).map(t => String(t.foto).split(/[\\/]/).pop()));
    const fotoMap = new Map();
    let i = 0;
    for (const f of photos) {
      i++;
      if (!needed.has(f.name)) continue;
      prog.textContent = `Memproses foto ${i}/${photos.length}…`;
      try {
        const blob = await compressImage(f);
        const ext = blob.type === 'image/jpeg' ? '.jpg' : (f.name.match(/\.\w+$/) || ['.img'])[0].toLowerCase();
        const key = 'lama-' + f.name.replace(/\.\w+$/, '') + ext;
        await store.putBlob(key, blob, false);
        fotoMap.set(f.name, key);
      } catch (e) { console.warn('Foto dilewati', f.name, e); }
    }
    prog.textContent = 'Menyimpan data…';
    try {
      const c = await backend.importLegacy(dump, fotoMap);
      const tanpaFoto = needed.size - fotoMap.size;
      prog.textContent = '';
      toast(`Impor selesai: ${c.transaksi} transaksi, ${c.akun} akun, ${c.kategori} kategori, ${c.deposito} deposito, ${c.foto} foto` +
        (tanpaFoto > 0 ? ` (${tanpaFoto} foto tidak ditemukan di file yang dipilih).` : '.'), 'success');
      await onRemoteChange();
      renderSyncCard();
    } catch (e) {
      prog.textContent = '';
      toast('Impor gagal: ' + (e.detail || e.message));
    }
  }

  async function doLogout(wipe) {
    const dirty = await store.getMeta('mineDirty', false);
    const pendingFoto = (await store.pendingUploads()).length;
    const warn = (dirty || pendingFoto) ? '\n\nPERHATIAN: ada perubahan yang BELUM tersinkron ke Google Drive' + (wipe ? ' dan akan HILANG.' : '.') : '';
    const msg = wipe
      ? 'Keluar dan hapus semua data dari perangkat ini? Data di Google Drive tidak ikut terhapus.' + warn
      : 'Keluar dari dashboard? Data di perangkat ini akan disembunyikan sampai Anda login lagi.' + warn;
    const ok = typeof global.showConfirm === 'function'
      ? await global.showConfirm(msg, { title: wipe ? 'Hapus data perangkat?' : 'Keluar?', icon: '🚪', okText: wipe ? 'Ya, hapus' : 'Ya, keluar' })
      : confirm(msg);
    if (!ok) return;
    auth.logout();
    if (wipe) { store.close(); await new BKStore(STORE_NAME).destroy(); }
    location.reload();
  }

  function injectLightbox() {
    const box = el(`<div id="bk-lightbox"><button type="button" aria-label="Tutup">✕</button><img alt="Foto struk"></div>`);
    document.body.appendChild(box);
    box.addEventListener('click', e => { if (e.target.tagName !== 'IMG') box.classList.remove('active'); });
    document.addEventListener('click', async e => {
      const a = e.target.closest('a[href^="#foto:"]');
      if (!a) return;
      e.preventDefault();
      const key = decodeURIComponent(a.getAttribute('href').slice(6));
      const url = await photoObjectUrl(key);
      if (!url) { toast('Foto belum ada di perangkat ini. Sinkron dulu saat online.'); return; }
      box.querySelector('img').src = url;
      box.classList.add('active');
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    if (isLocalHost && params.has('nosw')) return; // pengembangan: selalu ambil file terbaru
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('Service worker gagal:', e));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await ready;
    injectStyles();
    injectHeader();
    injectSyncCard();
    injectLightbox();
    registerServiceWorker();
    if (!backend) {
      // Tamu: tombol simpan apa pun langsung meminta login (sebelum validasi form browser muncul).
      document.addEventListener('click', e => {
        if (e.target.closest('button[type="submit"], .btn-submit')) { e.preventDefault(); e.stopPropagation(); showLoginModal(); }
      }, true);
    }
    if (engine) {
      setStatus({ state: 'idle' });
      if (auth.hasToken()) scheduleSync(800);
      global.addEventListener('online', () => scheduleSync(500));
      global.addEventListener('offline', () => setStatus({ state: 'error', error: new Error('Tidak ada koneksi internet.') }));
      setInterval(() => { if (document.visibilityState === 'visible' && auth.hasToken()) runSync(false); }, 3 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && auth.hasToken()) scheduleSync(1000); });
    }
  });

  global.BK = {
    ready, api, fotoUrl, photoObjectUrl, showLoginModal, runSync,
    isOwner: () => !!backend,
    get backend() { return backend; },
    get store() { return store; },
    _mock: MOCK,
  };
})(window);
