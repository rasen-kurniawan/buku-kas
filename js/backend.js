/*
 * backend.js — pengganti FastAPI (main.py) yang berjalan di perangkat.
 *
 * Semua endpoint lama (/api/transaksi, /api/akun, /api/kategori, /api/deposito, ...)
 * dilayani di sini dengan aturan validasi yang sama seperti main.py, tetapi datanya
 * disimpan di IndexedDB lewat BKStore. Setiap perubahan dicatat dengan waktu ubah dan
 * id perangkat sehingga bisa disinkronkan ke Google Drive.
 */
(function (global) {
  'use strict';

  const COLLS = ['transaksi', 'akun', 'kategori', 'deposito'];

  class ApiError extends Error {
    constructor(detail, status = 422) { super(detail); this.status = status; this.detail = detail; }
  }
  const bad = (detail, status = 422) => new ApiError(detail, status);

  /* ------------------------------------------------------------------ tanggal */
  const RE_TGL = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isoToMs(iso) { const m = RE_TGL.exec(iso); return Date.UTC(+m[1], +m[2] - 1, +m[3]); }
  function msToIso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(iso, n) { return msToIso(isoToMs(iso) + n * 86400000); }
  function daysDiff(a, b) { return Math.round((isoToMs(a) - isoToMs(b)) / 86400000); } // a - b
  function yearOf(iso) { return +iso.slice(0, 4); }
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function monthDays(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m: 1..12
  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function parseTanggal(value, label = 'Tanggal') {
    const v = String(value || '').trim();
    const m = RE_TGL.exec(v);
    if (!m) throw bad(`${label} tidak valid (format harus YYYY-MM-DD).`);
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (msToIso(ms) !== v) throw bad(`${label} tidak valid (format harus YYYY-MM-DD).`);
    return v;
  }
  function todayParam(value) {
    if (value) {
      const d = parseTanggal(value, 'Parameter today');
      if (yearOf(d) < 1990 || yearOf(d) > 2100) throw bad('Parameter today di luar rentang wajar.');
      return d;
    }
    return localToday();
  }

  const RE_WAKTU = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  function normWaktu(value) {
    if (value === null || value === undefined) return null;
    const v = String(value).trim();
    if (!v) return null;
    if (!RE_WAKTU.test(v)) throw bad('Waktu tidak valid (format harus JJ:MM).');
    return v.slice(0, 5);
  }

  function checkJumlah(value, bolehNegatif) {
    const v = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(v)) throw bad('Jumlah tidak valid.');
    if (v === 0) throw bad('Jumlah tidak boleh 0.');
    if (v < 0 && !bolehNegatif) throw bad('Jumlah harus lebih dari 0.');
    return v;
  }

  function cleanList(values) {
    const seen = new Set(), out = [];
    for (const v of values || []) {
      const s = String(v).trim();
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    }
    return out;
  }

  function toBool(v, def = true) {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v === 'boolean') return v;
    return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
  }

  /** Pembulatan setengah-ke-atas ke rupiah utuh, tahan galat floating point. */
  function roundHalfUp(x) {
    const clean = Math.round(x * 1e6) / 1e6;
    return clean >= 0 ? Math.floor(clean + 0.5) : -Math.floor(-clean + 0.5);
  }
  const r2 = x => Math.round(x * 100) / 100;

  /* ------------------------------------------------------------------ id */
  function fnv32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  /** Id deterministik di rentang [2^52, 2^53): sama di semua perangkat untuk kunci yang sama. */
  function stableId(key) {
    const hi = fnv32(key, 2166136261) & 0xFFFFF;        // 20 bit
    const lo = fnv32(key, 0x9747b28c);                  // 32 bit
    return 4503599627370496 + hi * 4294967296 + lo;     // 2^52 + ...
  }

  /* ------------------------------------------------------------------ deposito */
  const TENOR_INFO = {
    D14: { unit: 'days', step: 14, label: '14 hari' },
    D30: { unit: 'days', step: 30, label: '30 hari' },
    M1: { unit: 'months', step: 1, label: '1 bulan' },
    M3: { unit: 'months', step: 3, label: '3 bulan' },
    M6: { unit: 'months', step: 6, label: '6 bulan' },
    M12: { unit: 'months', step: 12, label: '12 bulan' },
  };
  const TENOR_BARU = ['D14', 'D30', 'M1', 'M3', 'M6', 'M12'];
  const MAX_PERIODE = 20000;

  function addMonthsClamped(anchor, months) {
    const y0 = yearOf(anchor), m0 = +anchor.slice(5, 7), d0 = +anchor.slice(8, 10);
    const total = y0 * 12 + (m0 - 1) + months;
    const y = Math.floor(total / 12), m = (total % 12) + 1;
    const d = Math.min(d0, monthDays(y, m));
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function tenorEnd(start, tenor, k) {
    const info = TENOR_INFO[tenor];
    return info.unit === 'days' ? addDays(start, info.step * k) : addMonthsClamped(start, info.step * k);
  }
  function hitungBunga(pokok, persen, hari, tahunMulai) {
    const basis = isLeap(tahunMulai) ? 366 : 365;
    return roundHalfUp(pokok * persen / 100 * hari / basis);
  }
  function buildSchedule(nominal, persen, start, tenor, overrides, asOf, proyeksi = true) {
    let pokok = Number(nominal) || 0;
    const p = Number(persen) || 0;
    const rows = [];
    let prevEnd = start;
    for (let k = 1; k <= MAX_PERIODE; k++) {
      const end = tenorEnd(start, tenor, k);
      const hari = daysDiff(end, prevEnd);
      const hitung = hitungBunga(pokok, p, hari, yearOf(prevEnd));
      const ov = overrides[k];
      const gain = ov !== undefined && ov !== null ? Number(ov) : hitung;
      const selesai = end <= asOf;
      if (!selesai && !proyeksi) break;
      rows.push({
        index: k, mulai: prevEnd, akhir: end, hari, gain_hitung: hitung, gain,
        override: ov !== undefined && ov !== null, selesai, akumulasi: r2(pokok + gain),
      });
      if (!selesai) break;
      pokok = r2(pokok + gain);
      prevEnd = end;
    }
    return rows;
  }
  function ringkas(nominal, rows, asOf) {
    const selesai = rows.filter(r => r.selesai);
    const akumulasi = selesai.length ? selesai[selesai.length - 1].akumulasi : Number(nominal);
    const berikut = rows.find(r => !r.selesai);
    const out = { akumulasi, gain: r2(akumulasi - Number(nominal)), periode_selesai: selesai.length, berikut: null };
    if (berikut) {
      out.berikut = {
        index: berikut.index, mulai: berikut.mulai, akhir: berikut.akhir, hari: berikut.hari,
        proyeksi_bunga: berikut.gain, akumulasi_proyeksi: berikut.akumulasi,
        sisa_hari: daysDiff(berikut.akhir, asOf),
      };
    }
    return out;
  }
  function efektif(row) {
    const start = row.tanggal_buka_awal || row.tanggal_buka;
    let tenor = row.tenor_kode || (row.jenis_tenor === 'DAYS_30' ? 'D30' : 'M1');
    if (!TENOR_INFO[tenor]) tenor = 'M1';
    return [start, tenor, row.status_deposito || 'AKTIF'];
  }
  function depositoOverrides(row) {
    const out = {};
    for (const [k, v] of Object.entries(row.overrides || {})) out[+k] = Number(v);
    return out;
  }
  function depositoView(row, hariIni) {
    const [start, tenor, status] = efektif(row);
    const ov = depositoOverrides(row);
    const base = {
      id: row.id, nama_bank: row.nama_bank, nominal: Number(row.nominal),
      tanggal_buka: start, tenor_kode: tenor, tenor_label: TENOR_INFO[tenor].label,
      bunga_persen: row.bunga_persen !== null && row.bunga_persen !== undefined ? Number(row.bunga_persen) : 0,
      catatan: row.catatan || null, status,
      tanggal_cair: null, bunga_cair: null, nominal_cair: null,
      jumlah_override: Object.keys(ov).length,
    };
    if (status === 'CAIR') {
      const nominalCair = Number(row.nominal_cair || row.nominal);
      Object.assign(base, {
        tanggal_cair: row.tanggal_cair || null,
        bunga_cair: Number(row.bunga_cair || 0),
        nominal_cair: nominalCair, akumulasi: nominalCair,
        gain: Number(row.bunga_cair || 0),
        periode_selesai: row.periode_cair || 0, berikut: null,
      });
      return base;
    }
    const rows = buildSchedule(row.nominal, row.bunga_persen, start, tenor, ov, hariIni);
    Object.assign(base, ringkas(row.nominal, rows, hariIni));
    return base;
  }

  /* ------------------------------------------------------------------ backend */
  class LocalBackend {
    /**
     * @param {BKStore} store
     * @param {object} hooks  { deviceId, savePhoto(file, tanggal, waktu) -> key, removePhoto(key) }
     */
    constructor(store, hooks) {
      this.store = store;
      this.hooks = hooks;
      this.deviceId = hooks.deviceId;
      this.data = {};      // coll -> Map(id -> record)
      this._lastU = 0;
      this._lastId = 0;
      this._pending = null;
      this.onChange = null; // dipanggil setelah ada perubahan lokal
    }

    async load() {
      COLLS.forEach(c => { this.data[c] = new Map(); });
      for (const rec of await this.store.allRecords()) {
        if (!this.data[rec.c]) this.data[rec.c] = new Map();
        this.data[rec.c].set(rec.id, rec);
        if (rec.d === this.deviceId && rec.u > this._lastU) this._lastU = rec.u;
      }
    }

    /** Dipanggil oleh sinkron setelah versi dari perangkat lain diterapkan. */
    applyRemote(recs) {
      for (const rec of recs) {
        if (!this.data[rec.c]) this.data[rec.c] = new Map();
        this.data[rec.c].set(rec.id, rec);
      }
    }

    isEmpty() { return COLLS.every(c => this.data[c].size === 0); }

    /* ---- akses data ---- */
    live(coll) { return Array.from(this.data[coll].values()).filter(r => !r.x).map(r => r.v); }
    get(coll, id) { const r = this.data[coll].get(Number(id)); return r && !r.x ? r.v : null; }

    nextU() { this._lastU = Math.max(Date.now(), this._lastU + 1); return this._lastU; }
    newId() {
      let id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      if (id <= this._lastId) id = this._lastId + 1;
      this._lastId = id;
      return id;
    }

    put(coll, v) {
      const rec = { k: `${coll}|${v.id}`, c: coll, id: v.id, v: JSON.parse(JSON.stringify(v)), u: this.nextU(), d: this.deviceId, x: false };
      this.data[coll].set(v.id, rec);
      this._pending.push(rec);
    }
    del(coll, id) {
      const rec = { k: `${coll}|${id}`, c: coll, id, v: null, u: this.nextU(), d: this.deviceId, x: true };
      this.data[coll].set(id, rec);
      this._pending.push(rec);
    }

    /** Jalankan satu operasi tulis: semua perubahan disimpan sekaligus, atau tidak sama sekali. */
    async mutate(fn) {
      const snapshot = {};
      COLLS.forEach(c => { snapshot[c] = new Map(this.data[c]); });
      const lastU = this._lastU;
      this._pending = [];
      let result;
      try {
        result = await fn();
        await this.store.writeLocal(this._pending);
      } catch (e) {
        this.data = snapshot; this._lastU = lastU; this._pending = null;
        throw e;
      }
      const n = this._pending.length;
      this._pending = null;
      if (n && this.onChange) this.onChange();
      return result;
    }

    /* ---- router ---- */
    async handle(method, rawPath, body) {
      const url = new URL(rawPath, 'http://local');
      const p = url.pathname.replace(/\/+$/, '');
      const q = url.searchParams;
      let m;
      const M = method.toUpperCase();

      if (p === '/api/transaksi' && M === 'GET') return this.getTransaksi();
      if (p === '/api/transaksi' && M === 'POST') return this.addTransaksi(body);
      if (p === '/api/transaksi/transfer' && M === 'POST') return this.addTransfer(body);
      if ((m = /^\/api\/transaksi\/transfer\/(\d+)$/.exec(p)) && M === 'PUT') return this.updateTransfer(+m[1], body);
      if ((m = /^\/api\/transaksi\/(\d+)$/.exec(p))) {
        if (M === 'PUT') return this.updateTransaksi(+m[1], body);
        if (M === 'DELETE') return this.deleteTransaksi(+m[1]);
      }

      if (p === '/api/deposito' && M === 'GET') return this.getDepositos(q.get('today'));
      if (p === '/api/deposito' && M === 'POST') return this.addDeposito(body);
      if ((m = /^\/api\/deposito\/(\d+)\/rekap$/.exec(p)) && M === 'GET') return this.rekapDeposito(+m[1], q.get('today'));
      if ((m = /^\/api\/deposito\/(\d+)\/cairkan$/.exec(p)) && M === 'POST') return this.cairkanDeposito(+m[1], body);
      if ((m = /^\/api\/deposito\/(\d+)\/batalkan-cair$/.exec(p)) && M === 'POST') return this.batalkanCair(+m[1]);
      if ((m = /^\/api\/deposito\/(\d+)\/overrides$/.exec(p))) {
        if (M === 'GET') return this.getOverrides(+m[1]);
        if (M === 'POST') return this.saveOverride(+m[1], body);
      }
      if ((m = /^\/api\/deposito\/(\d+)\/overrides\/(\d+)$/.exec(p)) && M === 'DELETE') return this.deleteOverride(+m[1], +m[2]);
      if ((m = /^\/api\/deposito\/(\d+)$/.exec(p))) {
        if (M === 'PUT') return this.updateDeposito(+m[1], body);
        if (M === 'DELETE') return this.deleteDeposito(+m[1]);
      }

      if (p === '/api/akun' && M === 'GET') return this.getAkun();
      if (p === '/api/akun' && M === 'POST') return this.createAkun(body);
      if (p === '/api/akun/proses-bunga' && M === 'POST') return this.prosesBunga(q.get('today'));
      if ((m = /^\/api\/akun\/(\d+)$/.exec(p))) {
        if (M === 'PUT') return this.updateAkun(+m[1], body);
        if (M === 'DELETE') return this.deleteAkun(+m[1]);
      }

      if (p === '/api/kategori' && M === 'GET') return this.getKategori();
      if (p === '/api/kategori' && M === 'POST') return this.createKategori(body);
      if ((m = /^\/api\/kategori\/(\d+)$/.exec(p))) {
        if (M === 'PUT') return this.updateKategori(+m[1], body);
        if (M === 'DELETE') return this.deleteKategori(+m[1]);
      }
      throw bad('Endpoint tidak dikenal: ' + M + ' ' + p, 404);
    }

    /* ================================================================ VALIDASI */
    akunByKode(kode) { return this.live('akun').find(a => a.kode === kode) || null; }
    tipeUangAkun(a) { return (a.tipe_uang && a.tipe_uang.length) ? a.tipe_uang : ['Umum']; }
    kategoriByNama(nama) { return this.live('kategori').find(k => k.nama === nama) || null; }

    validateWallet(akun, tipeUang, old, label = 'Akun') {
      const sameAkun = !!old && old.akun === akun;
      const ak = this.akunByKode(akun);
      if (!ak) { if (!sameAkun) throw bad(`${label} '${akun}' tidak ditemukan.`); return; }
      if (!ak.is_aktif && !sameAkun) throw bad(`${label} '${ak.nama}' sedang nonaktif.`);
      if (sameAkun && old.tipe_uang === tipeUang) return;
      if (!this.tipeUangAkun(ak).includes(tipeUang)) throw bad(`Tipe uang '${tipeUang}' tidak terdaftar pada akun '${ak.nama}'.`);
    }

    validateTransaksi(jenis, akun, tipeUang, kategori, subkategori, old) {
      if (!['EXPENSE', 'INCOME'].includes(jenis)) throw bad('Jenis transaksi harus EXPENSE (pengeluaran) atau INCOME (pemasukan).');
      this.validateWallet(akun, tipeUang, old);
      const sameKategori = !!old && old.kategori === kategori;
      const unchanged = sameKategori && old.jenis === jenis;
      const kat = this.kategoriByNama(kategori);
      if (!kat) { if (!unchanged) throw bad(`Kategori '${kategori}' tidak ditemukan.`); return; }
      if (!unchanged) {
        if (!kat.is_aktif && !sameKategori) throw bad(`Kategori '${kategori}' sedang nonaktif.`);
        if (kat.tipe !== jenis && kat.tipe !== 'BOTH') {
          const tipeTxt = kat.tipe === 'INCOME' ? 'pemasukan' : 'pengeluaran';
          const jenisTxt = jenis === 'INCOME' ? 'pemasukan' : 'pengeluaran';
          throw bad(`Kategori '${kategori}' khusus ${tipeTxt}, tidak bisa dipakai untuk ${jenisTxt}.`);
        }
      }
      if (subkategori) {
        if (sameKategori && old.subkategori === subkategori) return;
        if (!(kat.subkategori || []).includes(subkategori)) throw bad(`Subkategori '${subkategori}' tidak ada di kategori '${kategori}'.`);
      }
    }

    /* ================================================================ TRANSAKSI */
    getTransaksi() {
      return this.live('transaksi')
        .map(t => ({ ...t, jumlah: Number(t.jumlah) || 0 }))
        .sort((a, b) => (b.tanggal.localeCompare(a.tanggal)) || (b.id - a.id));
    }

    _formTx(fd) {
      const g = k => (fd.get(k) === null ? null : fd.get(k));
      const tanggal = parseTanggal(g('tanggal'));
      const waktu = normWaktu(g('waktu'));
      const jenis = String(g('jenis') || '').trim().toUpperCase();
      const akun = String(g('akun') || '').trim();
      const tipe_uang = String(g('tipe_uang') || '').trim();
      const kategori = String(g('kategori') || '').trim();
      const deskripsi = String(g('deskripsi') || '').trim();
      if (!deskripsi) throw bad('Deskripsi wajib diisi.');
      const jumlah = checkJumlah(g('jumlah'), true);
      const subRaw = g('subkategori');
      const subkategori = subRaw && String(subRaw).trim() ? String(subRaw).trim() : null;
      let is_utama = toBool(g('is_utama'), true);
      if (jenis === 'INCOME') is_utama = true;
      const foto = fd.get('foto');
      const hasFoto = foto && typeof foto === 'object' && foto.size > 0;
      return { tanggal, waktu, jenis, akun, tipe_uang, kategori, deskripsi, jumlah, subkategori, is_utama, foto: hasFoto ? foto : null, hapus_foto: toBool(g('hapus_foto'), false) };
    }

    async addTransaksi(fd) {
      const f = this._formTx(fd);
      this.validateTransaksi(f.jenis, f.akun, f.tipe_uang, f.kategori, f.subkategori, null);
      let fotoKey = null;
      if (f.foto) fotoKey = await this.hooks.savePhoto(f.foto, f.tanggal, f.waktu);
      try {
        return await this.mutate(async () => {
          const id = this.newId();
          this.put('transaksi', {
            id, tanggal: f.tanggal, jenis: f.jenis, akun: f.akun, tipe_uang: f.tipe_uang, kategori: f.kategori,
            is_utama: f.is_utama, jumlah: f.jumlah, deskripsi: f.deskripsi, waktu: f.waktu, foto: fotoKey,
            subkategori: f.subkategori, transfer_id: null,
          });
          return { message: 'Success', id };
        });
      } catch (e) {
        if (fotoKey) await this.hooks.removePhoto(fotoKey);
        throw e;
      }
    }

    async updateTransaksi(id, fd) {
      const f = this._formTx(fd);
      const old = this.get('transaksi', id);
      if (!old) throw bad('Transaksi tidak ditemukan.', 404);
      if (String(old.jenis).startsWith('TRANSFER')) throw bad('Transfer tidak bisa diubah lewat endpoint ini (gunakan edit transfer).', 409);
      this.validateTransaksi(f.jenis, f.akun, f.tipe_uang, f.kategori, f.subkategori, old);
      let newFoto = old.foto || null, savedNew = null, removeAfter = null;
      if (f.foto) {
        savedNew = await this.hooks.savePhoto(f.foto, f.tanggal, f.waktu);
        newFoto = savedNew; removeAfter = old.foto || null;
      } else if (f.hapus_foto && old.foto) {
        newFoto = null; removeAfter = old.foto;
      }
      try {
        await this.mutate(async () => {
          this.put('transaksi', {
            ...old, tanggal: f.tanggal, jenis: f.jenis, akun: f.akun, tipe_uang: f.tipe_uang, kategori: f.kategori,
            is_utama: f.is_utama, jumlah: f.jumlah, deskripsi: f.deskripsi, waktu: f.waktu, foto: newFoto, subkategori: f.subkategori,
          });
        });
      } catch (e) {
        if (savedNew) await this.hooks.removePhoto(savedNew);
        throw e;
      }
      if (removeAfter) await this.hooks.removePhoto(removeAfter);
      return { message: 'Updated' };
    }

    async deleteTransaksi(id) {
      const row = this.get('transaksi', id);
      if (!row) throw bad('Transaksi tidak ditemukan.', 404);
      const targets = row.transfer_id !== null && row.transfer_id !== undefined
        ? this.live('transaksi').filter(t => t.transfer_id === row.transfer_id || t.id === id)
        : [row];
      await this.mutate(async () => { targets.forEach(t => this.del('transaksi', t.id)); });
      for (const t of targets) if (t.foto) await this.hooks.removePhoto(t.foto);
      return { message: 'Deleted' };
    }

    _validateTransfer(item, oldOut, oldIn) {
      const tanggal = parseTanggal(item.tanggal);
      const waktu = normWaktu(item.waktu);
      const jumlah = checkJumlah(item.jumlah, false);
      const deskripsi = String(item.deskripsi || '').trim();
      if (!deskripsi) throw bad('Deskripsi wajib diisi.');
      if (item.akun_asal === item.akun_tujuan && item.tipe_uang_asal === item.tipe_uang_tujuan) {
        throw bad('Akun & tipe uang asal sama dengan tujuan - transfer ini tidak mengubah apa pun.');
      }
      this.validateWallet(item.akun_asal, item.tipe_uang_asal, oldOut, 'Akun asal');
      this.validateWallet(item.akun_tujuan, item.tipe_uang_tujuan, oldIn, 'Akun tujuan');
      return { tanggal, waktu, jumlah, deskripsi };
    }

    async addTransfer(item) {
      const v = this._validateTransfer(item || {});
      return this.mutate(async () => {
        const outId = this.newId(), inId = this.newId();
        const base = { tanggal: v.tanggal, kategori: 'Transfer', is_utama: true, jumlah: v.jumlah, deskripsi: v.deskripsi, waktu: v.waktu, foto: null, subkategori: null, transfer_id: outId };
        this.put('transaksi', { ...base, id: outId, jenis: 'TRANSFER_OUT', akun: item.akun_asal, tipe_uang: item.tipe_uang_asal });
        this.put('transaksi', { ...base, id: inId, jenis: 'TRANSFER_IN', akun: item.akun_tujuan, tipe_uang: item.tipe_uang_tujuan });
        return { message: 'Transfer berhasil', id: outId };
      });
    }

    async updateTransfer(transferId, item) {
      const legs = this.live('transaksi').filter(t => t.transfer_id === transferId).sort((a, b) => a.id - b.id);
      if (!legs.length) throw bad('Transfer tidak ditemukan.', 404);
      const outLeg = legs.find(l => l.jenis === 'TRANSFER_OUT') || null;
      const inLeg = legs.find(l => l.jenis === 'TRANSFER_IN') || null;
      const v = this._validateTransfer(item || {}, outLeg, inLeg);
      await this.mutate(async () => {
        for (const [leg, jenis, akun, tipe] of [
          [outLeg, 'TRANSFER_OUT', item.akun_asal, item.tipe_uang_asal],
          [inLeg, 'TRANSFER_IN', item.akun_tujuan, item.tipe_uang_tujuan],
        ]) {
          if (leg) {
            this.put('transaksi', { ...leg, tanggal: v.tanggal, akun, tipe_uang: tipe, jumlah: v.jumlah, deskripsi: v.deskripsi, waktu: v.waktu });
          } else {
            this.put('transaksi', {
              id: this.newId(), tanggal: v.tanggal, jenis, akun, tipe_uang: tipe, kategori: 'Transfer', is_utama: true,
              jumlah: v.jumlah, deskripsi: v.deskripsi, waktu: v.waktu, foto: null, subkategori: null, transfer_id: transferId,
            });
          }
        }
      });
      return { message: 'Transfer diperbarui' };
    }

    /* ================================================================ DEPOSITO */
    _getDeposito(id) {
      const row = this.get('deposito', id);
      if (!row) throw bad('Deposito tidak ditemukan.', 404);
      return row;
    }

    getDepositos(today) {
      const hariIni = todayParam(today);
      return this.live('deposito')
        .sort((a, b) => (a.nama_bank || '').localeCompare(b.nama_bank || '') || (b.tanggal_buka || '').localeCompare(a.tanggal_buka || '') || b.id - a.id)
        .map(r => depositoView(r, hariIni));
    }

    rekapDeposito(id, today) {
      const hariIni = todayParam(today);
      const row = this._getDeposito(id);
      const [start, tenor, status] = efektif(row);
      const [asOf, proyeksi] = status === 'CAIR' ? [row.tanggal_cair || hariIni, false] : [hariIni, true];
      const rows = buildSchedule(row.nominal, row.bunga_persen, start, tenor, depositoOverrides(row), asOf, proyeksi);
      return {
        deposito: depositoView(row, hariIni),
        as_of: asOf,
        baris: rows.map(r => ({ ...r })),
        ringkasan: ringkas(row.nominal, rows, asOf),
      };
    }

    _validateDeposito(item) {
      const nama = String(item.nama_bank || '').trim();
      if (!nama) throw bad('Nama bank wajib diisi.');
      const nominal = Number(item.nominal);
      if (!Number.isFinite(nominal) || nominal <= 0) throw bad('Nominal deposito harus lebih dari 0.');
      const start = parseTanggal(item.tanggal_buka, 'Tanggal buka');
      if (yearOf(start) < 1990 || yearOf(start) > 2100) throw bad('Tanggal buka di luar rentang wajar.');
      const bunga = item.bunga_persen === null || item.bunga_persen === undefined ? NaN : Number(item.bunga_persen);
      if (!Number.isFinite(bunga) || bunga < 0 || bunga > 100) throw bad('Bunga (% per tahun) harus diisi antara 0 sampai 100.');
      const catatan = item.catatan && String(item.catatan).trim() ? String(item.catatan).trim() : null;
      return { nama, nominal, start, bunga, catatan };
    }

    async addDeposito(item) {
      const v = this._validateDeposito(item || {});
      const tenor = String(item.tenor_kode || '').trim().toUpperCase();
      if (!TENOR_BARU.includes(tenor)) throw bad('Tenor wajib dipilih: 14 hari, 30 hari, 1 bulan, 3 bulan, 6 bulan, atau 12 bulan.');
      return this.mutate(async () => {
        const id = this.newId();
        this.put('deposito', {
          id, nama_bank: v.nama, nominal: v.nominal, tanggal_buka: v.start, tanggal_buka_awal: v.start,
          tenor_bulan: null, tanggal_jatuh_tempo: null, bunga_persen: v.bunga, catatan: v.catatan,
          jenis_tenor: 'MONTHLY', tenor_kode: tenor, status_deposito: 'AKTIF',
          tanggal_cair: null, bunga_cair: null, nominal_cair: null, periode_cair: null, overrides: {},
        });
        return { message: 'Success', id };
      });
    }

    async updateDeposito(id, item) {
      const v = this._validateDeposito(item || {});
      const row = this._getDeposito(id);
      const [, tenorLama, status] = efektif(row);
      if (status === 'CAIR') throw bad('Deposito yang sudah cair tidak bisa diubah. Batalkan pencairan dulu bila perlu.', 409);
      if (item.tenor_kode && String(item.tenor_kode).trim().toUpperCase() !== tenorLama) {
        throw bad('Tenor tidak bisa diubah. Cairkan deposito ini lalu buka deposito baru.', 409);
      }
      await this.mutate(async () => {
        this.put('deposito', { ...row, nama_bank: v.nama, nominal: v.nominal, tanggal_buka: v.start, tanggal_buka_awal: v.start, bunga_persen: v.bunga, catatan: v.catatan });
      });
      return { message: 'Deposito diperbarui' };
    }

    async cairkanDeposito(id, payload) {
      const tgl = parseTanggal((payload || {}).tanggal_cair, 'Tanggal cair');
      const row = this._getDeposito(id);
      const [start, tenor, status] = efektif(row);
      if (status === 'CAIR') throw bad('Deposito ini sudah dicairkan.', 409);
      if (tgl < start) throw bad('Tanggal cair tidak boleh sebelum tanggal buka.');
      if (tgl > addDays(localToday(), 1)) throw bad('Tanggal cair tidak boleh di masa depan.');
      const rows = buildSchedule(row.nominal, row.bunga_persen, start, tenor, depositoOverrides(row), tgl);
      const ring = ringkas(row.nominal, rows, tgl);
      const nominalCair = r2(Number(row.nominal) + ring.gain);
      await this.mutate(async () => {
        this.put('deposito', { ...row, status_deposito: 'CAIR', tanggal_cair: tgl, bunga_cair: ring.gain, nominal_cair: nominalCair, periode_cair: ring.periode_selesai });
      });
      return {
        message: 'Deposito dicairkan', tanggal_cair: tgl, bunga_cair: ring.gain, nominal_cair: nominalCair,
        periode_selesai: ring.periode_selesai, bunga_hangus: ring.berikut ? ring.berikut.proyeksi_bunga : 0,
      };
    }

    async batalkanCair(id) {
      const row = this._getDeposito(id);
      if (efektif(row)[2] !== 'CAIR') throw bad('Deposito ini belum dicairkan.', 409);
      await this.mutate(async () => {
        this.put('deposito', { ...row, status_deposito: 'AKTIF', tanggal_cair: null, bunga_cair: null, nominal_cair: null, periode_cair: null });
      });
      return { message: 'Pencairan dibatalkan, deposito aktif kembali' };
    }

    async deleteDeposito(id) {
      this._getDeposito(id);
      await this.mutate(async () => { this.del('deposito', id); });
      return { message: 'Deposito dihapus' };
    }

    getOverrides(id) { return depositoOverrides(this._getDeposito(id)); }

    async saveOverride(id, payload) {
      const k = Number((payload || {}).period_index), val = Number((payload || {}).gain_override);
      if (!Number.isInteger(k) || k < 1) throw bad('Nomor periode tidak valid.');
      if (!Number.isFinite(val) || val < 0) throw bad('Bunga koreksi tidak boleh negatif.');
      const row = this._getDeposito(id);
      if (efektif(row)[2] === 'CAIR') throw bad('Deposito yang sudah cair tidak bisa dikoreksi.', 409);
      await this.mutate(async () => {
        this.put('deposito', { ...row, overrides: { ...(row.overrides || {}), [k]: val } });
      });
      return { message: 'Override berhasil disimpan' };
    }

    async deleteOverride(id, k) {
      const row = this._getDeposito(id);
      if (efektif(row)[2] === 'CAIR') throw bad('Deposito yang sudah cair tidak bisa dikoreksi.', 409);
      const ov = { ...(row.overrides || {}) };
      delete ov[k];
      await this.mutate(async () => { this.put('deposito', { ...row, overrides: ov }); });
      return { message: 'Koreksi dihapus' };
    }

    /* ================================================================ AKUN */
    _akunPayload(p) {
      const nama = String(p.nama || '').trim();
      if (!nama) throw bad('Nama akun wajib diisi.');
      const saldo = Number(p.saldo_awal === undefined ? 0 : p.saldo_awal);
      if (!Number.isFinite(saldo)) throw bad('Saldo awal tidak valid.');
      const bunga = Number(p.bunga_harian === undefined ? 0 : p.bunga_harian);
      if (!Number.isFinite(bunga) || bunga < 0 || bunga > 100) throw bad('Bunga harian harus antara 0 dan 100 (% per hari).');
      return { nama, saldo, bunga, tipeUang: cleanList(p.tipe_uang) };
    }

    getAkun() {
      return this.live('akun')
        .sort((a, b) => (a.urutan || 0) - (b.urutan || 0) || a.id - b.id)
        .map(a => ({ ...a, tipe_uang: [...(a.tipe_uang || [])], saldo_awal: Number(a.saldo_awal || 0), bunga_harian: Number(a.bunga_harian || 0) }));
    }

    async createAkun(p) {
      const v = this._akunPayload(p || {});
      const kode = String(p.kode || '').trim();
      if (!kode) throw bad('Kode akun wajib diisi.');
      if (this.live('akun').some(a => a.kode.toLowerCase() === kode.toLowerCase())) throw bad(`Kode akun '${kode}' sudah dipakai.`, 409);
      return this.mutate(async () => {
        const id = this.newId();
        this.put('akun', {
          id, kode, nama: v.nama, tipe: p.tipe, saldo_awal: v.saldo, bunga_harian: v.bunga, is_aktif: true, urutan: 0,
          terakhir_hitung_bunga: v.bunga > 0 ? addDays(localToday(), -1) : null, tipe_uang: v.tipeUang,
        });
        return { message: 'Akun berhasil dibuat', id };
      });
    }

    async updateAkun(id, p) {
      const v = this._akunPayload(p || {});
      const akun = this.get('akun', id);
      if (!akun) throw bad('Akun tidak ditemukan.', 404);
      const kode = akun.kode;
      const lama = akun.tipe_uang || [];
      const baruSet = new Set(v.tipeUang);
      await this.mutate(async () => {
        const dipindah = new Set();
        for (const [oldName, newRaw] of Object.entries(p.tipe_uang_rename || {})) {
          const newName = String(newRaw || '').trim();
          if (lama.includes(oldName) && baruSet.has(newName) && !baruSet.has(oldName)) {
            this.live('transaksi').filter(t => t.akun === kode && t.tipe_uang === oldName)
              .forEach(t => this.put('transaksi', { ...t, tipe_uang: newName }));
            dipindah.add(oldName);
          }
        }
        for (const name of lama) {
          if (baruSet.has(name) || dipindah.has(name)) continue;
          const n = this.live('transaksi').filter(t => t.akun === kode && t.tipe_uang === name).length;
          if (n) throw bad(`Tipe uang '${name}' masih dipakai ${n} transaksi, tidak bisa dihapus. Ganti namanya (bukan menghapus) agar transaksi lama ikut berpindah.`, 409);
        }
        const aktif = p.is_aktif === undefined || p.is_aktif === null ? true : !!p.is_aktif;
        let baseline = akun.terakhir_hitung_bunga || null;
        if (v.bunga > 0 && !baseline) baseline = addDays(localToday(), -1);
        this.put('akun', { ...akun, nama: v.nama, tipe: p.tipe, saldo_awal: v.saldo, bunga_harian: v.bunga, is_aktif: aktif, terakhir_hitung_bunga: baseline, tipe_uang: v.tipeUang });
      });
      return { message: 'Akun berhasil diperbarui' };
    }

    async deleteAkun(id) {
      const akun = this.get('akun', id);
      if (!akun) throw bad('Akun tidak ditemukan.', 404);
      const n = this.live('transaksi').filter(t => t.akun === akun.kode).length;
      if (n) throw bad(`Akun '${akun.nama}' masih dipakai ${n} transaksi. Nonaktifkan saja agar riwayat tetap utuh.`, 409);
      await this.mutate(async () => { this.del('akun', id); });
      return { message: 'Akun berhasil dihapus' };
    }

    _ensureKategoriBunga() {
      for (const nama of ['Bunga', 'Bunga Harian']) {
        const row = this.live('kategori').find(k => k.nama.toLowerCase() === nama.toLowerCase());
        if (row && (row.tipe === 'INCOME' || row.tipe === 'BOTH')) return row.nama;
        if (!row) {
          // id deterministik: dua perangkat yang sama-sama offline membuat kategori yang sama, bukan duplikat
          this.put('kategori', { id: stableId('kategori|' + nama.toLowerCase()), nama, tipe: 'INCOME', icon: '🏦', is_aktif: true, urutan: 0, subkategori: [] });
          return nama;
        }
      }
      throw bad("Tidak bisa menyiapkan kategori pemasukan 'Bunga'. Buat kategori pemasukan secara manual.", 409);
    }

    async prosesBunga(today) {
      const hariIni = todayParam(today);
      const sampai = addDays(hariIni, -1);
      return this.mutate(async () => {
        const hasil = [];
        const akuns = this.live('akun').filter(a => a.is_aktif && Number(a.bunga_harian) > 0)
          .sort((a, b) => (a.urutan || 0) - (b.urutan || 0) || a.id - b.id);
        const kategori = akuns.length ? this._ensureKategoriBunga() : null;
        for (const a of akuns) {
          const last = a.terakhir_hitung_bunga;
          if (!last) {
            this.put('akun', { ...a, terakhir_hitung_bunga: sampai });
            hasil.push({ kode: a.kode, hari: 0, baris: 0, total: 0 });
            continue;
          }
          if (last >= sampai) { hasil.push({ kode: a.kode, hari: 0, baris: 0, total: 0 }); continue; }
          const netPerHari = new Map();
          for (const t of this.live('transaksi')) {
            if (t.akun !== a.kode) continue;
            const sign = (t.jenis === 'INCOME' || t.jenis === 'TRANSFER_IN') ? 1 : (t.jenis === 'EXPENSE' || t.jenis === 'TRANSFER_OUT') ? -1 : 0;
            netPerHari.set(t.tanggal, (netPerHari.get(t.tanggal) || 0) + sign * Number(t.jumlah));
          }
          let saldo = Number(a.saldo_awal) || 0;
          for (const [d, v] of netPerHari) if (d <= last) saldo += v;
          const tipeUang = this.tipeUangAkun(a)[0];
          const rate = Number(a.bunga_harian) / 100;
          const hari = Math.min(daysDiff(sampai, last), 400);
          let total = 0, baris = 0;
          for (let i = 1; i <= hari; i++) {
            const d = addDays(last, i);
            saldo += netPerHari.get(d) || 0;
            const bunga = roundHalfUp(saldo * rate);
            if (bunga > 0) {
              // id deterministik per akun+tanggal: perangkat lain yang menghitung hari yang sama menimpa, bukan menggandakan
              this.put('transaksi', {
                id: stableId(`bunga|${a.kode}|${d}`), tanggal: d, jenis: 'INCOME', akun: a.kode, tipe_uang: tipeUang,
                kategori, is_utama: true, jumlah: bunga, deskripsi: `Bunga harian ${a.nama}`, waktu: '23:59',
                foto: null, subkategori: null, transfer_id: null,
              });
              saldo += bunga; total += bunga; baris++;
            }
          }
          this.put('akun', { ...a, terakhir_hitung_bunga: addDays(last, hari) });
          hasil.push({ kode: a.kode, hari, baris, total });
        }
        return { message: 'Bunga harian diproses', akun: hasil };
      });
    }

    /* ================================================================ KATEGORI */
    _kategoriPayload(p) {
      const nama = String(p.nama || '').trim();
      if (!nama) throw bad('Nama kategori wajib diisi.');
      const tipe = String(p.tipe || '').trim().toUpperCase();
      if (!['EXPENSE', 'INCOME', 'BOTH'].includes(tipe)) throw bad('Tipe kategori harus EXPENSE, INCOME, atau BOTH.');
      return { nama, tipe, subs: cleanList(p.subkategori) };
    }

    getKategori() {
      return this.live('kategori')
        .sort((a, b) => (a.urutan || 0) - (b.urutan || 0) || a.id - b.id)
        .map(k => ({ ...k, subkategori: [...(k.subkategori || [])] }));
    }

    async createKategori(p) {
      const v = this._kategoriPayload(p || {});
      if (this.live('kategori').some(k => k.nama.toLowerCase() === v.nama.toLowerCase())) throw bad(`Kategori '${v.nama}' sudah ada.`, 409);
      return this.mutate(async () => {
        const id = this.newId();
        this.put('kategori', { id, nama: v.nama, tipe: v.tipe, icon: p.icon || '🏷️', is_aktif: true, urutan: 0, subkategori: v.subs });
        return { message: 'Kategori berhasil dibuat', id };
      });
    }

    async updateKategori(id, p) {
      const v = this._kategoriPayload(p || {});
      const kat = this.get('kategori', id);
      if (!kat) throw bad('Kategori tidak ditemukan.', 404);
      const namaLama = kat.nama;
      if (this.live('kategori').some(k => k.id !== id && k.nama.toLowerCase() === v.nama.toLowerCase())) throw bad(`Kategori '${v.nama}' sudah ada.`, 409);
      if (v.tipe === 'EXPENSE' || v.tipe === 'INCOME') {
        const lawan = v.tipe === 'EXPENSE' ? 'INCOME' : 'EXPENSE';
        const n = this.live('transaksi').filter(t => t.kategori === namaLama && t.jenis === lawan).length;
        if (n) throw bad(`Kategori ini masih dipakai ${n} transaksi ${lawan === 'INCOME' ? 'pemasukan' : 'pengeluaran'}. Ubah tipenya menjadi 'Keduanya'.`, 409);
      }
      await this.mutate(async () => {
        const subLama = kat.subkategori || [];
        const subsSet = new Set(v.subs);
        const dipindah = new Set();
        const subRename = new Map();
        for (const [oldName, newRaw] of Object.entries(p.subkategori_rename || {})) {
          const newName = String(newRaw || '').trim();
          if (subLama.includes(oldName) && subsSet.has(newName) && !subsSet.has(oldName)) { subRename.set(oldName, newName); dipindah.add(oldName); }
        }
        for (const sub of subLama) {
          if (subsSet.has(sub) || dipindah.has(sub)) continue;
          const n = this.live('transaksi').filter(t => t.kategori === namaLama && t.subkategori === sub).length;
          if (n) throw bad(`Subkategori '${sub}' masih dipakai ${n} transaksi, tidak bisa dihapus. Ganti namanya (bukan menghapus) agar transaksi lama ikut berpindah.`, 409);
        }
        const renamed = v.nama !== namaLama;
        for (const t of this.live('transaksi')) {
          if (t.kategori !== namaLama) continue;
          const newSub = t.subkategori && subRename.has(t.subkategori) ? subRename.get(t.subkategori) : t.subkategori;
          if (renamed || newSub !== t.subkategori) this.put('transaksi', { ...t, kategori: v.nama, subkategori: newSub });
        }
        const aktif = p.is_aktif === undefined || p.is_aktif === null ? true : !!p.is_aktif;
        this.put('kategori', { ...kat, nama: v.nama, tipe: v.tipe, icon: p.icon || '🏷️', is_aktif: aktif, subkategori: v.subs });
      });
      return { message: 'Kategori berhasil diperbarui' };
    }

    async deleteKategori(id) {
      const kat = this.get('kategori', id);
      if (!kat) throw bad('Kategori tidak ditemukan.', 404);
      const n = this.live('transaksi').filter(t => t.kategori === kat.nama).length;
      if (n) throw bad(`Kategori '${kat.nama}' masih dipakai ${n} transaksi. Nonaktifkan saja agar riwayat tetap utuh.`, 409);
      await this.mutate(async () => { this.del('kategori', id); });
      return { message: 'Kategori berhasil dihapus' };
    }

    /* ================================================================ IMPOR */
    /**
     * Impor ekspor dari PostgreSQL (tools/export_pg.py). Id lama dipertahankan.
     * fotoMap: Map(nama file lama -> key foto baru) untuk transaksi yang fotonya ikut diimpor.
     */
    async importLegacy(dump, fotoMap) {
      const t = dump.tables || {};
      const byId = (rows, key) => { const m = new Map(); (rows || []).forEach(r => { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
      const sortU = list => list.sort((a, b) => (a.urutan || 0) - (b.urutan || 0) || (a.id || 0) - (b.id || 0)).map(r => r.nama);
      const tuByAkun = byId(t.akun_tipe_uang, 'akun_id');
      const subByKat = byId(t.subkategori, 'kategori_id');
      const ovByDep = byId(t.deposito_overrides, 'deposito_id');
      const dateOnly = v => (v ? String(v).slice(0, 10) : null);
      const counts = { akun: 0, kategori: 0, transaksi: 0, deposito: 0, foto: 0 };

      await this.mutate(async () => {
        for (const a of t.akun || []) {
          this.put('akun', {
            id: Number(a.id), kode: a.kode, nama: a.nama, tipe: a.tipe, saldo_awal: Number(a.saldo_awal || 0),
            bunga_harian: Number(a.bunga_harian || 0), is_aktif: a.is_aktif !== false, urutan: Number(a.urutan || 0),
            terakhir_hitung_bunga: dateOnly(a.terakhir_hitung_bunga), tipe_uang: sortU(tuByAkun.get(a.id) || []),
          });
          counts.akun++;
        }
        for (const k of t.kategori || []) {
          this.put('kategori', {
            id: Number(k.id), nama: k.nama, tipe: k.tipe, icon: k.icon || '🏷️', is_aktif: k.is_aktif !== false,
            urutan: Number(k.urutan || 0), subkategori: sortU(subByKat.get(k.id) || []),
          });
          counts.kategori++;
        }
        for (const x of t.transaksi || []) {
          let foto = null;
          if (x.foto) {
            const base = String(x.foto).split(/[\\/]/).pop();
            if (fotoMap && fotoMap.has(base)) { foto = fotoMap.get(base); counts.foto++; }
          }
          const waktu = x.waktu ? String(x.waktu).slice(0, 5) : null;
          this.put('transaksi', {
            id: Number(x.id), tanggal: dateOnly(x.tanggal), jenis: x.jenis, akun: x.akun, tipe_uang: x.tipe_uang,
            kategori: x.kategori, is_utama: x.is_utama === null || x.is_utama === undefined ? true : !!x.is_utama,
            jumlah: Number(x.jumlah), deskripsi: x.deskripsi, waktu, foto, subkategori: x.subkategori || null,
            transfer_id: x.transfer_id === null || x.transfer_id === undefined ? null : Number(x.transfer_id),
          });
          counts.transaksi++;
        }
        for (const d of t.deposito || []) {
          const ov = {};
          (ovByDep.get(d.id) || []).forEach(o => { ov[Number(o.period_index)] = Number(o.gain_override); });
          this.put('deposito', {
            id: Number(d.id), nama_bank: d.nama_bank, nominal: Number(d.nominal), tanggal_buka: dateOnly(d.tanggal_buka),
            tanggal_buka_awal: dateOnly(d.tanggal_buka_awal), tenor_bulan: d.tenor_bulan ?? null,
            tanggal_jatuh_tempo: dateOnly(d.tanggal_jatuh_tempo), bunga_persen: d.bunga_persen === null ? null : Number(d.bunga_persen),
            catatan: d.catatan || null, jenis_tenor: d.jenis_tenor || null, tenor_kode: d.tenor_kode || null,
            status_deposito: d.status_deposito || 'AKTIF', tanggal_cair: dateOnly(d.tanggal_cair),
            bunga_cair: d.bunga_cair === null || d.bunga_cair === undefined ? null : Number(d.bunga_cair),
            nominal_cair: d.nominal_cair === null || d.nominal_cair === undefined ? null : Number(d.nominal_cair),
            periode_cair: d.periode_cair ?? null, overrides: ov,
          });
          counts.deposito++;
        }
      });
      return counts;
    }

    /** Cadangan JSON berisi semua data yang masih ada (tanpa foto). */
    exportBackup() {
      const out = { format: 'bukukas-backup', versi: 1, dibuat: new Date().toISOString(), data: {} };
      COLLS.forEach(c => { out.data[c] = this.live(c); });
      return out;
    }

    async restoreBackup(backup) {
      if (!backup || backup.format !== 'bukukas-backup') throw bad('File ini bukan cadangan Buku Kas.');
      let n = 0;
      await this.mutate(async () => {
        for (const c of COLLS) for (const v of (backup.data[c] || [])) { this.put(c, v); n++; }
      });
      return n;
    }
  }

  LocalBackend.ApiError = ApiError;
  LocalBackend._internal = { buildSchedule, hitungBunga, addMonthsClamped, tenorEnd, depositoView, stableId, roundHalfUp };
  global.BKBackend = LocalBackend;
})(window);
