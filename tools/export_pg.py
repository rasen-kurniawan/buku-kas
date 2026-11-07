"""
Ekspor data lama Buku Kas dari PostgreSQL ke satu file JSON untuk diimpor ke aplikasi PWA.

Hanya MEMBACA database (tidak ada yang diubah). Koneksi memakai variabel lingkungan yang sama
dengan main.py lama: DB_NAME, DB_USER, DB_PASSWORD, DB_HOST, DB_PORT.

Pemakaian (dari folder mana saja):
    py tools/export_pg.py                       -> ..\\BukuKas-export\\bukukas-export-<tanggal>.json
    py tools/export_pg.py D:\\cadangan\\data.json

File hasil berisi data keuangan Anda: JANGAN taruh di dalam folder repo / jangan di-commit.
Secara bawaan file disimpan di folder BukuKas-export di LUAR folder aplikasi.
"""
import datetime as dt
import decimal
import json
import os
import sys

import psycopg2
from psycopg2.extras import RealDictCursor

TABLES = ["akun", "akun_tipe_uang", "kategori", "subkategori", "transaksi", "deposito", "deposito_overrides"]


def to_json(v):
    if isinstance(v, decimal.Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, dt.datetime):
        return v.isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, dt.time):
        return v.strftime("%H:%M")
    return v


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "..", "BukuKas-export",
                               f"bukukas-export-{dt.date.today():%Y%m%d}.json")
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else default_out)

    conn = psycopg2.connect(
        dbname=os.environ.get("DB_NAME", "Catatan_Keuangan"),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASSWORD", "admin123"),
        host=os.environ.get("DB_HOST", "localhost"),
        port=os.environ.get("DB_PORT", "5432"),
    )
    conn.set_session(readonly=True)
    data = {"format": "bukukas-pg-export", "versi": 1, "dibuat": dt.datetime.now().isoformat(), "tables": {}}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            for t in TABLES:
                cur.execute("SELECT to_regclass(%s) AS t;", (f"public.{t}",))
                if cur.fetchone()["t"] is None:
                    print(f"  (tabel {t} tidak ada, dilewati)")
                    data["tables"][t] = []
                    continue
                cur.execute(f'SELECT * FROM "{t}";')
                rows = [{k: to_json(v) for k, v in r.items()} for r in cur.fetchall()]
                data["tables"][t] = rows
                print(f"  {t:20s} {len(rows):6d} baris")
    finally:
        conn.close()

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    fotos = sum(1 for r in data["tables"].get("transaksi", []) if r.get("foto"))
    print(f"\nSelesai: {out}")
    print(f"Transaksi dengan foto: {fotos}. Saat impor, pilih juga file-file di folder 'uploads' lama.")


if __name__ == "__main__":
    main()
