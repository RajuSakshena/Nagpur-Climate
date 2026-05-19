"""
================================================================================
  NAGPUR DISTRICT — Boundary Export (GeoJSON + Shapefile)
  Google Earth Engine Python API
================================================================================

OUTPUT:
  Nagpur_Boundary_Exports/
    nagpur_boundary.geojson      ← Use this in React/Leaflet frontend
    nagpur_boundary.shp          ← Optional shapefile

PURPOSE:
  Exports the exact Nagpur district boundary from FAO GAUL 2015 Level-2 dataset.
  The GeoJSON is used in nagpur.tsx to draw a crisp black border overlay on the map,
  replacing the rough bounding-box rectangle currently used.

USAGE:
  py -3.12 nagpur_boundary.py               # export both GeoJSON + Drive
  py -3.12 nagpur_boundary.py --preview     # print coordinates only (no export)
  py -3.12 nagpur_boundary.py --local       # save geojson locally (no Drive)

FRONTEND USAGE (nagpur.tsx):
  1. Place nagpur_boundary.geojson in your /public folder
  2. Fetch it in the component:
       const res  = await fetch("/nagpur_boundary.geojson");
       const geoj = await res.json();
  3. Use with react-leaflet <GeoJSON> or raw Leaflet:
       L.geoJSON(geoj, {
         style: { color: "#000", weight: 2.5, fillOpacity: 0, dashArray: "" }
       }).addTo(map);

BOUNDARY SOURCES (priority order):
  1. FAO GAUL 2015 Level-2 → ADM1_NAME=Maharashtra, ADM2_NAME=Nagpur
  2. LSIB Detailed          → name=India + spatial filter
  3. Hardcoded fallback bbox (rectangle) — last resort

================================================================================
"""

import ee
import json
import argparse
import sys
import os

# ── Initialize ─────────────────────────────────────────────────────────────────
ee.Initialize(project="gee-pune-climate")


# ══════════════════════════════════════════════════════════════════════════════
#  BOUNDARY LOADER
# ══════════════════════════════════════════════════════════════════════════════

def get_nagpur_feature() -> ee.Feature:
    """
    Try multiple sources to get the Nagpur district boundary as an ee.Feature.
    Returns the best available feature with metadata properties.
    """

    # ── Source 1: FAO GAUL 2015 Level-2 (most accurate for Indian districts) ──
    try:
        gaul   = ee.FeatureCollection("FAO/GAUL/2015/level2")
        nagpur = gaul.filter(
            ee.Filter.And(
                ee.Filter.eq("ADM1_NAME", "Maharashtra"),
                ee.Filter.eq("ADM2_NAME", "Nagpur")
            )
        )
        count = nagpur.size().getInfo()
        if count > 0:
            print(f"✓ Source: FAO GAUL 2015 Level-2 — {count} feature(s) found")
            feat = nagpur.first()
            return feat.set({
                "source":   "FAO/GAUL/2015/level2",
                "district": "Nagpur",
                "state":    "Maharashtra",
                "country":  "India"
            })
    except Exception as e:
        print(f"  ✗ GAUL failed: {e}")

    # ── Source 2: LSIB Detailed (backup) ─────────────────────────────────────
    try:
        nagpur_bbox = ee.Geometry.Rectangle([78.60, 20.65, 79.75, 21.65])
        lsib = (
            ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017")
            .filterBounds(nagpur_bbox)
        )
        count = lsib.size().getInfo()
        if count > 0:
            print(f"⚠ Source: LSIB (country-level fallback) — {count} feature(s)")
            feat = lsib.first()
            return feat.set({
                "source":   "USDOS/LSIB_SIMPLE/2017 (country boundary — less precise)",
                "district": "Nagpur",
                "state":    "Maharashtra",
                "country":  "India"
            })
    except Exception as e:
        print(f"  ✗ LSIB failed: {e}")

    # ── Source 3: Hardcoded Nagpur bbox rectangle ─────────────────────────────
    print("⚠ Using hardcoded bounding box (rectangle fallback)")
    geom = ee.Geometry.Polygon([[
        [78.6500, 20.7000],
        [79.7000, 20.7000],
        [79.7000, 21.5800],
        [78.6500, 21.5800],
        [78.6500, 20.7000],
    ]])
    return ee.Feature(geom, {
        "source":   "hardcoded_bbox",
        "district": "Nagpur",
        "state":    "Maharashtra",
        "country":  "India"
    })


def get_nagpur_boundary_geojson() -> dict:
    """
    Fetch the Nagpur district boundary and return as a GeoJSON FeatureCollection dict.
    """
    print("\nFetching Nagpur district boundary from GEE...")
    feat     = get_nagpur_feature()

    # getInfo() returns a GeoJSON-compatible dict
    feat_info = feat.getInfo()
    if not feat_info:
        raise RuntimeError("No feature returned from GEE")

    # Wrap as FeatureCollection for maximum frontend compatibility
    geojson = {
        "type": "FeatureCollection",
        "name": "Nagpur District Boundary",
        "features": [feat_info],
        "metadata": {
            "district":    "Nagpur",
            "state":       "Maharashtra",
            "country":     "India",
            "exported_by": "nagpur_boundary.py",
            "use_in":      "nagpur.tsx — L.geoJSON boundary overlay",
            "style": {
                "color":       "#000000",
                "weight":      2.5,
                "fillOpacity": 0,
                "dashArray":   ""
            }
        }
    }
    return geojson


# ══════════════════════════════════════════════════════════════════════════════
#  LOCAL SAVE
# ══════════════════════════════════════════════════════════════════════════════

def save_local(geojson: dict, filename: str = "nagpur_boundary.geojson"):
    """Save GeoJSON to the local filesystem (next to this script)."""
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"\n✓ Saved locally: {out_path}  ({size_kb:.1f} KB)")
    print(f"  → Copy this file to your React project's /public folder")
    print(f"  → Then fetch('/nagpur_boundary.geojson') in nagpur.tsx")
    return out_path


# ══════════════════════════════════════════════════════════════════════════════
#  GOOGLE DRIVE EXPORT
# ══════════════════════════════════════════════════════════════════════════════

def export_to_drive(geojson: dict):
    """
    Export the boundary FeatureCollection to Google Drive as GeoJSON.
    GEE doesn't natively export GeoJSON via batch, so we use the
    table export with GeoJSON format.
    """
    print("\nSubmitting GEE export task to Google Drive...")
    feat     = get_nagpur_feature()
    fc       = ee.FeatureCollection([feat])

    task = ee.batch.Export.table.toDrive(
        collection=fc,
        description="Nagpur_Boundary",
        folder="Nagpur_GEE_Weekly_Exports",
        fileNamePrefix="nagpur_boundary",
        fileFormat="GeoJSON",
    )
    task.start()
    print(f"✓ Export task submitted!")
    print(f"  Monitor : https://code.earthengine.google.com/tasks")
    print(f"  Drive   : Nagpur_GEE_Weekly_Exports/nagpur_boundary.geojson")

    # Also export as Shapefile for GIS use
    task_shp = ee.batch.Export.table.toDrive(
        collection=fc,
        description="Nagpur_Boundary_SHP",
        folder="Nagpur_GEE_Weekly_Exports",
        fileNamePrefix="nagpur_boundary",
        fileFormat="SHP",
    )
    task_shp.start()
    print(f"✓ Shapefile task submitted!")
    print(f"  Drive   : Nagpur_GEE_Weekly_Exports/nagpur_boundary.shp")


# ══════════════════════════════════════════════════════════════════════════════
#  PREVIEW (print coords)
# ══════════════════════════════════════════════════════════════════════════════

def preview_boundary():
    """Print boundary info without exporting."""
    print("\n── Nagpur Boundary Preview ──────────────────────────────────")
    feat      = get_nagpur_feature()
    feat_info = feat.getInfo()
    props     = feat_info.get("properties", {})
    geom      = feat_info.get("geometry", {})

    print(f"  Source   : {props.get('source', 'unknown')}")
    print(f"  District : {props.get('district', 'Nagpur')}")
    print(f"  State    : {props.get('state', 'Maharashtra')}")
    print(f"  Geom type: {geom.get('type', 'unknown')}")

    coords = geom.get("coordinates", [])
    if coords:
        # Flatten to get all points for bbox
        all_pts = []
        def flatten(c):
            if isinstance(c[0], list):
                for sub in c: flatten(sub)
            else:
                all_pts.append(c)
        flatten(coords)
        lngs = [p[0] for p in all_pts]
        lats = [p[1] for p in all_pts]
        print(f"  BBox     : [{min(lngs):.4f}, {min(lats):.4f}, {max(lngs):.4f}, {max(lats):.4f}]")
        print(f"  Points   : {len(all_pts)} coordinate pairs")
    print("─────────────────────────────────────────────────────────────")


# ══════════════════════════════════════════════════════════════════════════════
#  FRONTEND INTEGRATION GUIDE
# ══════════════════════════════════════════════════════════════════════════════

FRONTEND_GUIDE = """
════════════════════════════════════════════════════════════
  HOW TO USE nagpur_boundary.geojson IN nagpur.tsx
════════════════════════════════════════════════════════════

1. PLACE FILE:
   Copy nagpur_boundary.geojson → your-project/public/nagpur_boundary.geojson

2. ADD COMPONENT (replace BBoxBoundaryLayer):

   const NagpurBoundaryLayer = React.memo(() => {
     const map = useMap();
     useEffect(() => {
       let layer: L.GeoJSON | null = null;
       fetch("/nagpur_boundary.geojson")
         .then(r => r.json())
         .then(geojson => {
           layer = L.geoJSON(geojson, {
             style: {
               color:       "#000000",   // black border
               weight:      2.5,         // border thickness
               fillOpacity: 0,           // transparent fill
               dashArray:   "",          // solid line
             }
           });
           layer.addTo(map);
         })
         .catch(err => console.warn("Boundary load failed:", err));
       return () => { if (layer) map.removeLayer(layer); };
     }, [map]);
     return null;
   });

3. USE IN MAP:
   <NagpurBoundaryLayer />   ← add inside <MapContainer>

4. STYLE OPTIONS:
   color:       "#000000"  → black border (recommended, shows on all basemaps)
   weight:      2.5        → 2–3px recommended
   fillOpacity: 0          → transparent (to see raster under it)
   dashArray:   "6 3"      → dashed outline (optional, for aesthetics)
   opacity:     0.85       → slight transparency for the border itself

════════════════════════════════════════════════════════════
"""


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Nagpur District — Boundary Export (GeoJSON + Shapefile via GEE)"
    )
    parser.add_argument("--preview", action="store_true",
                        help="Print boundary info only, no export")
    parser.add_argument("--local",   action="store_true",
                        help="Save GeoJSON locally only (no Drive upload)")
    args = parser.parse_args()

    print("""
══════════════════════════════════════════════════════════════
  NAGPUR DISTRICT — Boundary Export
  Source : FAO/GAUL/2015/level2 (Maharashtra → Nagpur)
  Output : nagpur_boundary.geojson + .shp
  Use    : React/Leaflet black border overlay in nagpur.tsx
══════════════════════════════════════════════════════════════""")

    if args.preview:
        preview_boundary()
        print(FRONTEND_GUIDE)
        sys.exit(0)

    # Fetch GeoJSON
    geojson = get_nagpur_boundary_geojson()

    # Always save locally
    local_path = save_local(geojson)

    if not args.local:
        # Also export to Drive
        export_to_drive(geojson)

    print(FRONTEND_GUIDE)

    print(f"""
── Summary ──────────────────────────────────────────────────
  Local file : {local_path}
  Drive      : Nagpur_GEE_Weekly_Exports/nagpur_boundary.geojson
  Next step  : Copy to /public folder, add NagpurBoundaryLayer to nagpur.tsx
─────────────────────────────────────────────────────────────
""")


if __name__ == "__main__":
    main()