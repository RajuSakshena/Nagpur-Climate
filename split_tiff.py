"""
split_tiff.py - FIXED VERSION
"""

import rasterio
import numpy as np
from pathlib import Path

YEARS        = [2025]                    # Change as needed
INPUT_DIR    = Path("public")
OUTPUT_DIR   = Path("public")
BANDS_PER_DAY = 6

PARTS = [
    {"name": "part1", "label": "Jan–Apr", "doy_start": 1,   "doy_end": 120},
    {"name": "part2", "label": "May–Aug", "doy_start": 121, "doy_end": 243},
    {"name": "part3", "label": "Sep–Dec", "doy_start": 244, "doy_end": 365},
]

def is_leap(year):
    return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)

def process_year(year):
    src_path = INPUT_DIR / f"Nagpur_{year}.tif"
    if not src_path.exists():
        print(f"[SKIP] {src_path} not found.")
        return

    total_days = 366 if is_leap(year) else 365
    parts = [p.copy() for p in PARTS]
    parts[2]["doy_end"] = total_days

    print(f"\n{'='*60}")
    print(f"Processing: {src_path}  ({src_path.stat().st_size / 1024**2:.1f} MB)")
    print(f"{'='*60}")

    with rasterio.open(src_path) as src:
        print(f"Source: {src.width}×{src.height}, {src.count} bands, CRS={src.crs}")

        for part in parts:
            doy_s = part["doy_start"]
            doy_e = min(part["doy_end"], total_days)

            band_s = (doy_s - 1) * BANDS_PER_DAY + 1
            band_e = min(doy_e * BANDS_PER_DAY, src.count)
            n_bands = band_e - band_s + 1

            out_path = OUTPUT_DIR / f"Nagpur_{year}_{part['name']}.tif"
            print(f"  {part['name']} ({part['label']}): bands {band_s}-{band_e} ({n_bands} bands) → {out_path.name}")

            band_indices = list(range(band_s, band_e + 1))

            profile = src.profile.copy()
            profile.update(
                count=n_bands,
                compress="deflate",
                predictor=1,           # ← CRITICAL FIX: No predictor
                tiled=False,
                bigtiff="IF_SAFER",
                nodata=-9999.0,
            )

            with rasterio.open(out_path, "w", **profile) as dst:
                CHUNK = 60
                out_band = 1
                for i in range(0, len(band_indices), CHUNK):
                    chunk = band_indices[i:i+CHUNK]
                    data = src.read(chunk)
                    for b in range(data.shape[0]):
                        dst.write(data[b], out_band)
                        out_band += 1

            print(f"    ✓ Done ({out_path.stat().st_size / 1024**2:.1f} MB)")

    print(f"✅ Year {year} completed — 3 part files created.\n")

if __name__ == "__main__":
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for yr in YEARS:
        process_year(yr)
    print("🎉 All years processed!")