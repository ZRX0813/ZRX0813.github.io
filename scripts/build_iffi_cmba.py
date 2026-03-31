#!/usr/bin/env python3
"""Merge IFFI open-data PIFF / polygon layers, clip to GMBA Southern Apennines mask, export for web."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely import make_valid
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
CMBA = ROOT / "MB-NetV3/data/gmba_southern_apennines_italy.geojson"
IFFI = ROOT / "layer/IFFI"
OUT_PIFF = ROOT / "MB-NetV3/data/iffi_piff_cmba.geojson"
OUT_POLY = ROOT / "MB-NetV3/data/iffi_poly_cmba.geojson"

KEEP_COLS = [
    "id_frana",
    "tipo_movimento",
    "nome_tipo",
    "regione",
    "nome_reg",
    "provincia",
    "nome_prov",
    "comune",
    "nome_com",
    "autorita_distretto",
    "nome_distr",
]


def mask_gdf() -> gpd.GeoDataFrame:
    cmba = gpd.read_file(CMBA)
    geom = unary_union(cmba.geometry)
    return gpd.GeoDataFrame(geometry=[geom], crs=cmba.crs)


def safe_geom(series):
    return series.apply(lambda x: make_valid(x) if x is not None and not x.is_empty else x)


def clip_merge(pattern: str, out_path: Path, fix_poly: bool) -> None:
    mask = mask_gdf()
    parts: list[gpd.GeoDataFrame] = []
    for f in sorted(IFFI.glob(pattern)):
        print("read", f.name, flush=True)
        g = gpd.read_file(f)
        if g.crs is None:
            g = g.set_crs(4326)
        if not g.crs.equals(mask.crs):
            g = g.to_crs(mask.crs)
        if fix_poly:
            g = g.copy()
            g["geometry"] = safe_geom(g.geometry)
        try:
            cl = gpd.clip(g, mask)
        except Exception as exc:
            print("  clip fallback (intersection):", exc, flush=True)
            m = unary_union(mask.geometry)
            cl = g[g.intersects(m)].copy()
            cl["geometry"] = cl.geometry.intersection(m)
        if len(cl) == 0:
            continue
        keep = [c for c in KEEP_COLS if c in cl.columns]
        cl = cl[keep + ["geometry"]]
        parts.append(cl)
    if not parts:
        print("no features for", pattern)
        sys.exit(1)
    out = pd.concat(parts, ignore_index=True)
    out = out[out.geometry.notna() & ~out.geometry.is_empty]
    tmp = out_path.with_suffix(".tmp.geojson")
    out.to_file(tmp, driver="GeoJSON")
    cmd = ["ogr2ogr", "-f", "GeoJSON", "-lco", "COORDINATE_PRECISION=5"]
    if fix_poly:
        cmd += ["-simplify", "0.001"]
    cmd += [str(out_path), str(tmp)]
    subprocess.run(cmd, check=True)
    tmp.unlink()
    print(out_path.name, "features", len(out), "size", out_path.stat().st_size, flush=True)


def main() -> None:
    if not CMBA.exists():
        sys.exit("missing CMBA geojson: " + str(CMBA))
    if not IFFI.is_dir():
        sys.exit("missing IFFI dir: " + str(IFFI))
    clip_merge("frane_piff_*_opendata.json", OUT_PIFF, fix_poly=False)
    clip_merge("frane_poly_*_opendata.json", OUT_POLY, fix_poly=True)


if __name__ == "__main__":
    main()
