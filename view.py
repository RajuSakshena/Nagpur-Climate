import rasterio
import numpy as np
from pathlib import Path

FILES = [
    ("public/Nagpur_2025_part1.tif", 1),
    ("public/Nagpur_2025_part2.tif", 121),
    ("public/Nagpur_2025_part3.tif", 244),
]

BANDS_PER_DAY = 6
LST_OFFSET = 3   # NDVI=0 LULC=1 WATER=2 LST=3


for path, start_doy in FILES:

    print("\n" + "=" * 70)
    print(path)
    print("=" * 70)

    with rasterio.open(path) as src:

        total_days = src.count // BANDS_PER_DAY

        print(f"bands={src.count}")
        print(f"days ={total_days}")

        bad = []

        for local_doy in range(total_days):

            # rasterio uses 1-based indexing
            lst_band = local_doy * 6 + LST_OFFSET + 1

            arr = src.read(
                lst_band,
                out_shape=(1, 16, 16)
            )

            if np.max(arr) <= -9998:

                actual_doy = start_doy + local_doy
                bad.append(actual_doy)

        print(f"\nMissing LST days = {len(bad)}")

        if bad:
            print("First 50:")
            print(bad[:50])