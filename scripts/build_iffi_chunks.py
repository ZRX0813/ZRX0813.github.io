#!/usr/bin/env python3
"""
Split IFFI GeoJSON (already CMBA-clipped) into Web-Mercator tiles at fixed Z for browser on-demand loading.
Each feature is assigned to exactly one tile via geometry centroid.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import mercantile

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "MB-NetV3/data"
Z_DEFAULT = 9

# Tune: higher Z => smaller files, more HTTP requests per pan
CHUNK_SPECS = [
    {"src": "iffi_piff_cmba.geojson", "out_dir": "iffi_piff", "z": Z_DEFAULT},
    {"src": "iffi_poly_cmba.geojson", "out_dir": "iffi_poly", "z": Z_DEFAULT},
]


def tile_key_for_geom(geom, z: int) -> str:
    c = geom.centroid
    t = mercantile.tile(float(c.x), float(c.y), z)
    return f"{t.x}_{t.y}"


def chunk_one(src_name: str, out_name: str, z: int) -> None:
    src = DATA / src_name
    if not src.exists():
        print("skip (missing):", src, file=sys.stderr)
        return
    print("chunking", src_name, "z=", z, flush=True)
    g = gpd.read_file(src)
    if g.crs is None:
        g = g.set_crs(4326)
    g = g.to_crs(4326)

    buckets: dict[str, list] = defaultdict(list)
    for _, row in g.iterrows():
        key = tile_key_for_geom(row.geometry, z)
        buckets[key].append(row)

    base = DATA / "chunks" / out_name / str(z)
    base.mkdir(parents=True, exist_ok=True)
    keys = []
    for key, rows in buckets.items():
        sub = gpd.GeoDataFrame(rows, crs=g.crs)
        out_path = base / f"{key}.geojson"
        sub.to_file(out_path, driver="GeoJSON")
        keys.append(key)

    west, south, east, north = g.total_bounds
    index = {
        "z": z,
        "tiles": sorted(keys),
        "bounds4326": [float(west), float(south), float(east), float(north)],
        "featureCount": len(g),
    }
    index_path = DATA / "chunks" / out_name / "index.json"
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    print("  ->", len(keys), "tiles,", len(g), "features ->", base.relative_to(ROOT), flush=True)


def main() -> None:
    for spec in CHUNK_SPECS:
        chunk_one(spec["src"], spec["out_dir"], spec["z"])


if __name__ == "__main__":
    main()
