import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import * as GeoTIFF from "geotiff";
import L from "leaflet";
import {
  Layers, Thermometer, Map,
  Activity, Satellite, Globe, Database, Info, X, ChevronRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type MapType   = "osm" | "satellite" | "hybrid";
type LayerType = "lst" | "ndvi" | "rain" | "soil" | "water" | "lulc";

interface RealStats {
  avg: number; min: number; max: number;
  hotPct: number; modPct: number; coolPct: number; count: number;
}

interface AnnualMeans {
  ndvi: number; lst: number; rain: number; soil: number; water: number;
}

// ─── WEEKLY Band Layout ───────────────────────────────────────────────────────

const BANDS_PER_WEEK = 6;
const N_WEEKS        = 52;

const BAND_OFFSET: Record<LayerType, number> = {
  ndvi: 0, lst: 1, rain: 2, soil: 3, water: 4, lulc: 5,
};

const NODATA = -9999.0;

function getWeekIndex(date: Date): number {
  const start  = new Date(date.getFullYear(), 0, 1);
  const dayIdx = Math.floor((date.getTime() - start.getTime()) / 86400000);
  return Math.min(Math.floor(dayIdx / 7), N_WEEKS - 1);
}

function dateFromWeek(year: number, weekIndex: number): Date {
  const start = new Date(year, 0, 1);
  start.setDate(1 + weekIndex * 7);
  return start;
}

function dateEndFromWeek(year: number, weekIndex: number): Date {
  const d = dateFromWeek(year, weekIndex);
  d.setDate(d.getDate() + 6);
  if (d.getFullYear() > year) return new Date(year, 11, 31);
  return d;
}

function getBandIdx(weekIndex: number, layer: LayerType): number {
  return weekIndex * BANDS_PER_WEEK + BAND_OFFSET[layer];
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function formatDateShort(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function daysInMonth(m: number, y: number): number {
  return new Date(y, m + 1, 0).getDate();
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LAYER_META: Record<LayerType, { name: string; desc: string; dotColor: string; emoji: string; label: string }> = {
  lst:   { name: "Temperature", desc: "Land Surface Temp",  dotColor: "#f97316", emoji: "🌡",  label: "Temp"  },
  ndvi:  { name: "NDVI",        desc: "Vegetation Index",   dotColor: "#16a34a", emoji: "🌿",  label: "NDVI"  },
  rain:  { name: "Rainfall",    desc: "Weekly Rainfall",    dotColor: "#0284c7", emoji: "🌧",  label: "Rain"  },
  soil:  { name: "Soil Moist.", desc: "Soil Moisture",      dotColor: "#65a30d", emoji: "🌱",  label: "Soil"  },
  water: { name: "Water Cover", desc: "Surface Water %",    dotColor: "#06b6d4", emoji: "💧",  label: "Water" },
  lulc:  { name: "Land Use",    desc: "LULC Class",         dotColor: "#8b5cf6", emoji: "🗺",  label: "LULC"  },
};

const LAYER_LEGEND: Record<LayerType, { gradient: string; lowLabel: string; highLabel: string }> = {
  lst:   { gradient: "linear-gradient(to right,#3b82f6,#93c5fd,#fde047,#fb923c,#ef4444,#dc2626)", lowLabel: "Cool", highLabel: "Hot" },
  ndvi:  { gradient: "linear-gradient(to right,#7f1d1d,#fde047,#16a34a)", lowLabel: "Low Veg", highLabel: "High Veg" },
  rain:  { gradient: "linear-gradient(to right,#bae6fd,#38bdf8,#0369a1)", lowLabel: "Low Rain", highLabel: "Heavy Rain" },
  soil:  { gradient: "linear-gradient(to right,#fde047,#84cc16,#166534)", lowLabel: "Dry", highLabel: "Wet" },
  water: { gradient: "linear-gradient(to right,#e0f2fe,#38bdf8,#0369a1)", lowLabel: "0%", highLabel: "100%" },
  lulc:  { gradient: "linear-gradient(to right,#1d4ed8,#22c55e,#ca8a04,#f97316,#7c3aed,#6b7280)", lowLabel: "Water", highLabel: "Bare/Snow" },
};

const BASEMAPS: { id: MapType; label: string; icon: React.ElementType }[] = [
  { id: "osm",       label: "OSM", icon: Globe },
  { id: "satellite", label: "SAT", icon: Satellite },
  { id: "hybrid",    label: "HYB", icon: Map },
];

const DATA_SOURCES = [
  { label: "NDVI",          value: "Sentinel-2 SR Harmonized + Landsat 7/8/9", dot: "#16a34a" },
  { label: "LULC",          value: "Dynamic World V1 + ESA WorldCover",         dot: "#7c3aed" },
  { label: "Water Cover",   value: "JRC Monthly Surface Water v1.4",            dot: "#0891b2" },
  { label: "LST (Temp)",    value: "MODIS Terra/Aqua Day+Night + ERA5-Land",    dot: "#ea580c" },
  { label: "Rainfall",      value: "CHIRPS Daily (weekly sum)",                  dot: "#0284c7" },
  { label: "Soil Moisture", value: "TerraClimate (normalized ÷ 500)",            dot: "#65a30d" },
];

const LULC_CLASSES = [
  { label: "0 Water",    color: "#1d4ed8" },
  { label: "1 Trees",    color: "#15803d" },
  { label: "2 Grass",    color: "#86efac" },
  { label: "3 Flooded",  color: "#67e8f9" },
  { label: "4 Crops",    color: "#ca8a04" },
  { label: "5 Shrub",    color: "#84cc16" },
  { label: "6 Built",    color: "#f97316" },
  { label: "7 Bare",     color: "#a16207" },
  { label: "8 Snow/Ice", color: "#e0f2fe" },
];

const YEARS       = [2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025];
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEK_MONTH_LABELS = Array.from({ length: N_WEEKS }, (_, i) => {
  const d = new Date(2024, 0, 1 + i * 7);
  return MONTH_NAMES[d.getMonth()];
});

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#374151",
  marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em",
};

// ─── Layer Info ───────────────────────────────────────────────────────────────

interface LayerInfoDetail {
  title: string; emoji: string; accentColor: string; bgColor: string;
  source: string; sourceShort: string; dataset: string; resolution: string;
  calculation: string; calcSteps: string[]; unit: string;
  valueRanges: { range: string; meaning: string; color: string }[];
  chartExplain: string; notes: string;
}

const LAYER_INFO: Record<LayerType, LayerInfoDetail> = {
  ndvi: {
    title: "NDVI — Normalized Difference Vegetation Index",
    emoji: "🌿", accentColor: "#16a34a", bgColor: "#f0fdf4",
    source: "Sentinel-2 SR Harmonized (primary) + Landsat 9/8/7 fallback",
    sourceShort: "Sentinel-2 + Landsat",
    dataset: "COPERNICUS/S2_SR_HARMONIZED · LANDSAT/LC09 · LANDSAT/LC08 · LANDSAT/LE07",
    resolution: "10m (S2) / 30m (Landsat) → 500m export",
    calculation: "NDVI = (NIR − RED) / (NIR + RED)",
    calcSteps: [
      "S2 images filtered: ±7 days around week, cloud% < 70",
      "Sorted by CLOUDY_PIXEL_PERCENTAGE → best real mosaic (no averaging)",
      "NIR = B8 (842nm), RED = B4 (665nm) for Sentinel-2",
      "Landsat 9/8: SR_B5/SR_B4; LS7: SR_B4/SR_B3",
      "Priority chain: S2 → LS9 → LS8 → LS7 via .unmask()",
      "NODATA = −9999; valid range: −1 to +1",
    ],
    unit: "Dimensionless index (−1 to +1)",
    valueRanges: [
      { range: "< 0.0",       meaning: "Water, barren land, urban surfaces",    color: "#7f1d1d" },
      { range: "0.0 – 0.15",  meaning: "Sparse vegetation, bare soil",          color: "#b45309" },
      { range: "0.15 – 0.30", meaning: "Degraded/dry vegetation, fallow land",  color: "#ca8a04" },
      { range: "0.30 – 0.50", meaning: "Moderate vegetation, growing crops",    color: "#65a30d" },
      { range: "0.50 – 0.70", meaning: "Dense vegetation, healthy crops",       color: "#16a34a" },
      { range: "> 0.70",      meaning: "Very dense forest / peak crop season",  color: "#14532d" },
    ],
    chartExplain: "% bar shows area with NDVI > 0.3 (moderate-to-dense vegetation). Nagpur peaks in monsoon (Jul–Sep) and Rabi season (Jan–Mar).",
    notes: "Nagpur is known for orange orchards (Vidarbha region). NDVI peaks in monsoon when forests and crops are fully green. Summer (Apr–Jun) shows steep decline.",
  },
  lulc: {
    title: "LULC — Land Use / Land Cover Classification",
    emoji: "🗺", accentColor: "#7c3aed", bgColor: "#f5f3ff",
    source: "Google Dynamic World V1 (2016+) + ESA WorldCover v200 (2015)",
    sourceShort: "Dynamic World",
    dataset: "GOOGLE/DYNAMICWORLD/V1 · ESA/WorldCover/v200",
    resolution: "10m Dynamic World → 500m export",
    calculation: "mode() of Dynamic World labels for the week",
    calcSteps: [
      "Dynamic World filtered by bounds + week date range",
      "Band 'label' (0–8 class integer) selected",
      ".mode() → most frequent real class for the week",
      "For 2015: ESA WorldCover v200 remapped to 0–8 classes",
      "NODATA filled with class 7 (Bare) via .unmask(7)",
    ],
    unit: "Discrete class integer (0–8)",
    valueRanges: LULC_CLASSES.map(c => ({ range: c.label, meaning: c.label.split(" ").slice(1).join(" "), color: c.color })),
    chartExplain: "LULC shows land cover class per pixel. Nagpur is predominantly agricultural with forested areas in the east near Pench/Tadoba.",
    notes: "Nagpur has Vidarbha cotton belt agriculture, city core (built-up), and forested areas. Dynamic World provides near-weekly updates.",
  },
  water: {
    title: "Water Cover — Surface Water Occurrence",
    emoji: "💧", accentColor: "#0891b2", bgColor: "#ecfeff",
    source: "JRC Global Surface Water v1.4 — Monthly History + Permanent Water",
    sourceShort: "JRC Surface Water",
    dataset: "JRC/GSW1_4/MonthlyHistory · JRC/GSW1_4/GlobalSurfaceWater",
    resolution: "30m JRC → 500m export",
    calculation: "Water % = closest monthly image remapped (water=100%, else 0)",
    calcSteps: [
      "JRC MonthlyHistory: closest month to week (±31 days)",
      "Pixel values: 0=no water, 1=water, 2=no data",
      "Remapped: water(1)→100%, no water(0)→0%, no data→0%",
      "Permanent occurrence layer fills where monthly = 0",
      "Final range: 0–100% water presence",
    ],
    unit: "% water presence (0–100)",
    valueRanges: [
      { range: "0%",        meaning: "No surface water",                 color: "#e0f2fe" },
      { range: "1 – 20%",   meaning: "Seasonal/episodic water bodies",   color: "#7dd3fc" },
      { range: "20 – 50%",  meaning: "Seasonal wetlands, river margins", color: "#38bdf8" },
      { range: "50 – 80%",  meaning: "Semi-permanent water bodies",      color: "#0284c7" },
      { range: "80 – 100%", meaning: "Permanent water — lakes, rivers",  color: "#1d4ed8" },
    ],
    chartExplain: "% bar = area with >20% water presence. Nagpur's reservoirs (Gorewada, Ambazari) and rivers fill post-monsoon (Sep–Oct).",
    notes: "Nagpur has several reservoirs and is near Kanhan & Pench rivers. Surface water peaks post-monsoon and drops in summer.",
  },
  lst: {
    title: "LST — Land Surface Temperature",
    emoji: "🌡", accentColor: "#ea580c", bgColor: "#fff7ed",
    source: "MODIS Terra+Aqua Day+Night mosaic + 8-day composites + ERA5-Land fill",
    sourceShort: "MODIS + ERA5",
    dataset: "MODIS/061/MOD11A1 · MODIS/061/MYD11A1 · MODIS/061/MOD11A2 · MODIS/061/MYD11A2 · ECMWF/ERA5_LAND",
    resolution: "1km MODIS → 500m export",
    calculation: "LST °C = raw × 0.02 − 273.15  (mosaic, no averaging)",
    calcSteps: [
      "Terra Day LST_Day_1km (MOD11A1): × 0.02 − 273.15",
      "Terra Night, Aqua Day, Aqua Night merged",
      "8-day composites (MOD11A2/MYD11A2) as fallback",
      "mosaic() = first valid real pixel, NO averaging",
      "ERA5 temperature_2m − 273.15 fills only fully masked pixels",
      "NODATA = −9999; valid range: ~5–55°C for Nagpur",
    ],
    unit: "Degrees Celsius (°C)",
    valueRanges: [
      { range: "< 10°C",    meaning: "Very cool — rare Nagpur winter nights",       color: "#1d4ed8" },
      { range: "10 – 20°C", meaning: "Cool — Dec–Jan morning temperatures",         color: "#38bdf8" },
      { range: "20 – 30°C", meaning: "Moderate — Spring/Autumn transition",         color: "#86efac" },
      { range: "30 – 40°C", meaning: "Warm — Pre-monsoon, urban heat",              color: "#facc15" },
      { range: "40 – 48°C", meaning: "Hot — May–Jun peak; Nagpur known for 45°C+",  color: "#f97316" },
      { range: "> 48°C",    meaning: "Extreme heat — rare peak summer days",        color: "#dc2626" },
    ],
    chartExplain: "Hot Zones % = pixels where LST > (avg + 5°C). Moderate = within ±5°C. Cool = below (avg − 5°C). Nagpur is one of India's hottest cities.",
    notes: "Nagpur ('Orange City') regularly records some of India's highest temperatures. Urban heat island effect is strong. Forest areas near Pench stay 5–8°C cooler.",
  },
  rain: {
    title: "Rainfall — Weekly Precipitation Total",
    emoji: "🌧", accentColor: "#0284c7", bgColor: "#f0f9ff",
    source: "CHIRPS Daily — Climate Hazards Group InfraRed Precipitation with Station data",
    sourceShort: "CHIRPS Daily",
    dataset: "UCSB-CHG/CHIRPS/DAILY · Google Earth Engine",
    resolution: "~5km native → 500m export",
    calculation: "Weekly Rain (mm) = sum of daily CHIRPS for the 7-day window",
    calcSteps: [
      "CHIRPS Daily filtered: bounds + 7-day window (t0 → t1)",
      "Band 'precipitation' (mm/day) selected",
      ".sum() across 7 daily images = real weekly total",
      "Missing pixels filled with 0.0 via .unmask(0.0)",
    ],
    unit: "Millimetres (mm) — weekly total",
    valueRanges: [
      { range: "0 mm",           meaning: "No rain — dry week",                      color: "#e0f2fe" },
      { range: "0.1 – 10 mm",   meaning: "Trace/light weekly total",                color: "#7dd3fc" },
      { range: "10 – 30 mm",    meaning: "Moderate rain week",                      color: "#38bdf8" },
      { range: "30 – 60 mm",    meaning: "Heavy rain — active monsoon week",        color: "#0284c7" },
      { range: "60 – 120 mm",   meaning: "Very heavy — intense monsoon event",      color: "#1d4ed8" },
      { range: "> 120 mm",      meaning: "Extreme — flood-risk level",              color: "#1e3a8a" },
    ],
    chartExplain: "% bar = area that received >20mm that week. Nagpur receives ~1,100mm annually, mostly Jun–Sep.",
    notes: "Nagpur lies in Vidarbha, known for erratic monsoon with intense rainfall events. Normal onset: ~15 June. Peak: July–August.",
  },
  soil: {
    title: "Soil Moisture — Relative Water Content",
    emoji: "🌱", accentColor: "#65a30d", bgColor: "#f7fee7",
    source: "TerraClimate — University of Idaho Monthly Climate Dataset",
    sourceShort: "TerraClimate",
    dataset: "IDAHO_EPSCOR/TERRACLIMATE · Google Earth Engine",
    resolution: "~4km native → 500m export",
    calculation: "Soil Fraction = closest monthly value ÷ 500 (no averaging)",
    calcSteps: [
      "TerraClimate filtered: ±2 months around week",
      "Band 'soil' (plant extractable water content, mm)",
      ".first() of sorted-by-time collection = closest real month",
      "Divided by 500 to normalize to 0–1 fraction",
      "Clamped: max(0.0).min(1.0); missing filled with 0.0",
    ],
    unit: "Fraction 0–1 (0% = completely dry, 100% = field capacity)",
    valueRanges: [
      { range: "0 – 0.10",  meaning: "Very dry — Nagpur summer drought stress", color: "#fde047" },
      { range: "0.10 – 0.25", meaning: "Dry — pre-monsoon / post-harvest",      color: "#a3e635" },
      { range: "0.25 – 0.45", meaning: "Moderate — adequate for crops",         color: "#84cc16" },
      { range: "0.45 – 0.65", meaning: "Moist — active monsoon / irrigation",   color: "#4ade80" },
      { range: "0.65 – 0.80", meaning: "Wet — post-monsoon saturated soil",     color: "#16a34a" },
      { range: "> 0.80",      meaning: "Saturated — waterlogged risk",          color: "#166534" },
    ],
    chartExplain: "% bar = area with soil moisture > 0.3 (30% field capacity). TerraClimate is monthly so values change smoothly week to week.",
    notes: "Nagpur's black cotton soil (Vertisols) has high water retention. Stays dry Apr–Jun, peaks Sep–Oct post-monsoon.",
  },
};

// ─── Color Scales ─────────────────────────────────────────────────────────────

function interp(stops: [number,number,number,number][], r: number): [number,number,number] {
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (r >= stops[i][0] && r <= stops[i+1][0]) { lo = stops[i]; hi = stops[i+1]; break; }
  }
  const f = (r - lo[0]) / ((hi[0] - lo[0]) || 1);
  return [Math.round(lo[1]+f*(hi[1]-lo[1])), Math.round(lo[2]+f*(hi[2]-lo[2])), Math.round(lo[3]+f*(hi[3]-lo[3]))];
}
function nrm(v: number, lo: number, hi: number) { return Math.max(0, Math.min(1, (v-lo)/((hi-lo)||1))); }
function tempToColor(v: number, mn: number, mx: number): [number,number,number] {
  return interp([[0,13,2,33],[0.15,59,7,100],[0.30,124,13,110],[0.46,160,30,50],[0.60,231,76,60],[0.74,243,156,18],[0.87,241,196,15],[1,255,253,231]], nrm(v,mn,mx));
}
function ndviToColor(v: number, mn: number, mx: number): [number,number,number] {
  return interp([[0,127,29,29],[0.5,253,224,71],[1,22,163,74]], nrm(v,mn,mx));
}
function rainToColor(v: number, mn: number, mx: number): [number,number,number] {
  return interp([[0,186,230,253],[0.5,56,189,248],[1,3,105,161]], nrm(v,mn,mx));
}
function soilToColor(v: number, mn: number, mx: number): [number,number,number] {
  return interp([[0,253,224,71],[0.5,132,204,22],[1,22,101,52]], nrm(v,mn,mx));
}
function waterToColor(v: number, mn: number, mx: number): [number,number,number] {
  return interp([[0,224,242,254],[0.5,56,189,248],[1,3,105,161]], nrm(v,mn,mx));
}
function lulcToColor(v: number): [number,number,number] {
  const c: [number,number,number][] = [[29,78,216],[21,128,61],[134,239,172],[103,232,249],[202,138,4],[132,204,22],[249,115,22],[161,98,7],[224,242,254]];
  const cls = Math.round(v);
  return (cls >= 0 && cls <= 8) ? c[cls] : [156,163,175];
}
function getColor(v: number, layer: LayerType, mn: number, mx: number): [number,number,number] {
  switch (layer) {
    case "ndvi":  return ndviToColor(v, mn, mx);
    case "rain":  return rainToColor(v, mn, mx);
    case "soil":  return soilToColor(v, mn, mx);
    case "water": return waterToColor(v, mn, mx);
    case "lulc":  return lulcToColor(v);
    default:      return tempToColor(v, mn, mx);
  }
}

// ─── Layer Ranges ─────────────────────────────────────────────────────────────

const LAYER_RANGE: Record<LayerType, { min: number; max: number }> = {
  lst:   { min: 5,    max: 55  },
  ndvi:  { min: -0.2, max: 0.9 },
  rain:  { min: 0,    max: 120 },
  soil:  { min: 0,    max: 1   },
  water: { min: 0,    max: 100 },
  lulc:  { min: 0,    max: 8   },
};

function computeRange(band: any, hintMin: number, hintMax: number): [number, number] {
  const vals: number[] = [];
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (v == null || isNaN(v) || v <= NODATA + 1) continue;
    vals.push(v);
  }
  if (!vals.length) return [hintMin, hintMax];
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[Math.floor(vals.length * 0.98)];
  return (!isFinite(lo) || !isFinite(hi) || lo === hi) ? [hintMin, hintMax] : [lo, hi];
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", ...style }}>
      {children}
    </div>
  );
}

function SummaryGrid({ items }: {
  items: { label: string; value: string; accent: string; bg: string; icon: React.ElementType }[];
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: items.length > 2 ? "1fr 1fr" : "1fr", gap: 8 }}>
      {items.map(({ label, value, accent, bg, icon: Icon }) => (
        <Card key={label} style={{ padding: "10px 12px", background: bg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <Icon size={11} color={accent} />
            <span style={{ fontSize: 9.5, color: accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
          </div>
          <p style={{ fontSize: 15, fontWeight: 800, color: "#111827", fontFamily: "monospace" }}>{value}</p>
        </Card>
      ))}
    </div>
  );
}

// ─── Annual Means Panel ───────────────────────────────────────────────────────

function AnnualMeansPanel({ means, year }: { means: AnnualMeans | null; year: number }) {
  if (!means) {
    return (
      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>{year} Annual Means</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0,1,2,3,4].map(i => <div key={i} style={{ height: 28, background: "#f1f5f9", borderRadius: 8 }} />)}
          <p style={{ fontSize: 10, color: "#9ca3af", textAlign: "center" }}>Computing annual means…</p>
        </div>
      </Card>
    );
  }
  const rows = [
    { label: "🌿 NDVI",          value: means.ndvi.toFixed(3),              note: "avg greenness", color: "#16a34a", bg: "#f0fdf4" },
    { label: "🌡️ Temperature",   value: `${means.lst.toFixed(1)} °C`,        note: "avg LST",       color: "#ea580c", bg: "#fff7ed" },
    { label: "🌧️ Rain",          value: `${means.rain.toFixed(1)} mm/wk`,    note: "avg weekly",    color: "#0284c7", bg: "#f0f9ff" },
    { label: "🌱 Soil Moisture",  value: `${(means.soil*100).toFixed(1)} %`, note: "avg fraction",  color: "#65a30d", bg: "#f7fee7" },
    { label: "💧 Water Cover",    value: `${means.water.toFixed(1)} %`,       note: "avg water",     color: "#0891b2", bg: "#ecfeff" },
  ];
  return (
    <Card style={{ padding: "14px 16px" }}>
      <p style={sectionLabel}>{year} Annual Means</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: r.bg, borderRadius: 9, padding: "7px 10px" }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>{r.label}</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af", marginLeft: 5 }}>{r.note}</span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: r.color, fontFamily: "monospace" }}>{r.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Data Sources Panel ───────────────────────────────────────────────────────

function DataSourcesPanel() {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Database size={12} color="#7c3aed" />
        <p style={{ ...sectionLabel, marginBottom: 0, color: "#7c3aed" }}>Data Sources · GEE</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {DATA_SOURCES.map(s => (
          <div key={s.label} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", background: "#fafafa", borderRadius: 8, border: "1px solid #f1f5f9" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot, flexShrink: 0, marginTop: 3, display: "inline-block" }} />
            <div>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#374151", display: "block" }}>{s.label}</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af" }}>{s.value}</span>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 4, padding: "5px 8px", background: "#f5f3ff", borderRadius: 7, border: "1px solid #ede9fe" }}>
          <span style={{ fontSize: 9, color: "#7c3aed", fontWeight: 600 }}>Scale: 500m · CRS: EPSG:4326</span><br />
          <span style={{ fontSize: 9, color: "#9ca3af" }}>6 bands × 52 weeks = 312 bands/year</span><br />
          <span style={{ fontSize: 9, color: "#9ca3af" }}>Band formula: week_index × 6 + offset</span>
        </div>
      </div>
    </Card>
  );
}

// ─── Info Tab ─────────────────────────────────────────────────────────────────

function InfoTab({ activeLayer, onClose }: { activeLayer: LayerType; onClose: () => void }) {
  const info = LAYER_INFO[activeLayer];
  return (
    <div style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 340, zIndex: 2000, background: "#fff", borderRight: `3px solid ${info.accentColor}`, boxShadow: "4px 0 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", fontFamily: "'Inter', system-ui, sans-serif", overflowY: "auto", animation: "slideInLeft 0.22s cubic-bezier(0.22,1,0.36,1)" }}>
      <style>{`@keyframes slideInLeft{from{transform:translateX(-100%);opacity:0}to{transform:translateX(0);opacity:1}} .info-scroll::-webkit-scrollbar{width:4px} .info-scroll::-webkit-scrollbar-thumb{background:${info.accentColor};border-radius:4px}`}</style>
      <div style={{ background: `linear-gradient(135deg, ${info.accentColor}22 0%, ${info.accentColor}08 100%)`, borderBottom: `1px solid ${info.accentColor}33`, padding: "16px 16px 14px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 26 }}>{info.emoji}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: info.accentColor, textTransform: "uppercase", letterSpacing: "0.08em" }}>Layer Info</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#111827", lineHeight: 1.3 }}>{info.title}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, background: info.accentColor, color: "#fff", borderRadius: 6, padding: "3px 8px" }}>{info.sourceShort}</span>
              <span style={{ fontSize: 11, fontWeight: 600, background: "#f5f3ff", color: "#7c3aed", borderRadius: 6, padding: "3px 8px" }}>{info.resolution}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: 8 }}><X size={14} color="#6b7280" /></button>
        </div>
      </div>
      <div className="info-scroll" style={{ flex: 1, overflowY: "auto", padding: "14px 14px 20px" }}>
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fafafa", borderRadius: 10, border: "1px solid #e5e7eb" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Dataset Source</div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827", lineHeight: 1.5 }}>{info.source}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "monospace" }}>{info.dataset}</div>
        </div>
        <div style={{ marginBottom: 14, padding: "10px 12px", background: `${info.accentColor}0d`, borderRadius: 10, border: `1px solid ${info.accentColor}22` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: info.accentColor, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Calculation Formula</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", fontFamily: "monospace", background: "#fff", borderRadius: 7, padding: "7px 10px", border: `1px solid ${info.accentColor}33` }}>{info.calculation}</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>Processing Steps (Google Earth Engine)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {info.calcSteps.map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: info.accentColor, borderRadius: "50%", width: 20, height: 20, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{i+1}</span>
                <span style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 14, padding: "8px 12px", background: "#f8fafc", borderRadius: 9, border: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
          <ChevronRight size={14} color={info.accentColor} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>Unit</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{info.unit}</div>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>Value Ranges &amp; Meaning</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {info.valueRanges.map((vr, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: vr.color, flexShrink: 0, display: "inline-block" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#111827", fontFamily: "monospace" }}>{vr.range}</span>
                  <span style={{ fontSize: 11.5, color: "#6b7280", marginLeft: 6 }}>— {vr.meaning}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fffbeb", borderRadius: 10, border: "1px solid #fde68a" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>📊 What does the % bar mean?</div>
          <div style={{ fontSize: 12, color: "#78350f", lineHeight: 1.6 }}>{info.chartExplain}</div>
        </div>
        <div style={{ padding: "10px 12px", background: "#f0f9ff", borderRadius: 10, border: "1px solid #bae6fd" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>📝 Field Notes — Nagpur</div>
          <div style={{ fontSize: 12, color: "#0c4a6e", lineHeight: 1.6 }}>{info.notes}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Analytics Content ────────────────────────────────────────────────────────

function AnalyticsContent({ stats, activeLayer, weekIndex, year, annualMeans }: {
  stats: RealStats | null; activeLayer: LayerType; weekIndex: number; year: number; annualMeans: AnnualMeans | null;
}) {
  const donutData = useMemo(() => {
    if (!stats) return null;
    return [
      { name: "Hot",      value: Math.round(stats.hotPct  * 10) / 10, color: "#ef4444" },
      { name: "Moderate", value: Math.round(stats.modPct  * 10) / 10, color: "#facc15" },
      { name: "Cool",     value: Math.round(stats.coolPct * 10) / 10, color: "#3b82f6" },
    ];
  }, [stats]);

  const meta = LAYER_META[activeLayer];

  if (!stats) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {[0,1,2].map(i => (
          <Card key={i} style={{ padding: "14px 16px", background: "#f8fafc" }}>
            <div style={{ height: 10, background: "#e5e7eb", borderRadius: 6, marginBottom: 8, width: "55%" }} />
            <div style={{ height: 26, background: "#e5e7eb", borderRadius: 6, width: "38%" }} />
          </Card>
        ))}
        <p style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 4 }}>Loading data…</p>
        <DataSourcesPanel />
      </div>
    );
  }

  const d1 = dateFromWeek(year, weekIndex);
  const d2 = dateEndFromWeek(year, weekIndex);
  const dateStr = `${formatDateShort(d1)} – ${formatDateShort(d2)} ${year}`;

  const fmtVal = (v: number): string => {
    switch (activeLayer) {
      case "lst":   return `${v.toFixed(1)}°C`;
      case "ndvi":  return v.toFixed(3);
      case "rain":  return `${v.toFixed(1)} mm`;
      case "soil":  return `${(v * 100).toFixed(1)}%`;
      case "water": return `${v.toFixed(1)}%`;
      case "lulc":  return `cls ${Math.round(v)}`;
      default:      return v.toFixed(2);
    }
  };

  const accentColor = LAYER_INFO[activeLayer].accentColor;
  const bgColor     = LAYER_INFO[activeLayer].bgColor;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ padding: "12px 14px", background: bgColor, border: `1px solid ${accentColor}33` }}>
        <p style={{ ...sectionLabel, color: accentColor, marginBottom: 8 }}>{meta.emoji} {meta.name} · Active Layer</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            { label: "Average", value: fmtVal(stats.avg), accent: accentColor },
            { label: "Pixels",  value: stats.count.toLocaleString(), accent: "#6b7280" },
            { label: "Min",     value: fmtVal(stats.min), accent: "#3b82f6" },
            { label: "Max",     value: fmtVal(stats.max), accent: "#dc2626" },
          ].map(r => (
            <div key={r.label} style={{ background: "#fff", borderRadius: 9, padding: "8px 10px", border: "1px solid #f1f5f9" }}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{r.label}</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: r.accent, fontFamily: "monospace" }}>{r.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {activeLayer === "lst" && (
        <>
          <SummaryGrid items={[
            { label: "Avg Temp",  value: `${stats.avg.toFixed(1)}°C`,   accent: "#f97316", bg: "#fff7ed", icon: Thermometer },
            { label: "Hot Zones", value: `${stats.hotPct.toFixed(1)}%`,  accent: "#dc2626", bg: "#fef2f2", icon: Activity    },
            { label: "Moderate",  value: `${stats.modPct.toFixed(1)}%`,  accent: "#ca8a04", bg: "#fefce8", icon: Activity    },
            { label: "Cool",      value: `${stats.coolPct.toFixed(1)}%`, accent: "#3b82f6", bg: "#eff6ff", icon: Activity    },
          ]} />
          <SummaryGrid items={[
            { label: "Min Temp", value: `${stats.min.toFixed(1)}°C`, accent: "#3b82f6", bg: "#eff6ff", icon: Thermometer },
            { label: "Max Temp", value: `${stats.max.toFixed(1)}°C`, accent: "#dc2626", bg: "#fef2f2", icon: Thermometer },
          ]} />
        </>
      )}

      {activeLayer === "lst" && donutData && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Temperature Distribution</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 96, height: 96, flexShrink: 0 }}>
              <svg viewBox="0 0 96 96" width={96} height={96}>
                {(() => {
                  const total = donutData.reduce((s, d) => s + d.value, 0) || 100;
                  let cursor = -90;
                  const cx = 48, cy = 48, r = 38, ir = 22;
                  return donutData.map((d, idx) => {
                    const angle    = (d.value / total) * 360;
                    const sRad     = (cursor * Math.PI) / 180;
                    const eRad     = ((cursor + angle) * Math.PI) / 180;
                    const x1 = cx + r  * Math.cos(sRad), y1 = cy + r  * Math.sin(sRad);
                    const x2 = cx + r  * Math.cos(eRad), y2 = cy + r  * Math.sin(eRad);
                    const ix1= cx + ir * Math.cos(sRad), iy1= cy + ir * Math.sin(sRad);
                    const ix2= cx + ir * Math.cos(eRad), iy2= cy + ir * Math.sin(eRad);
                    const large = angle > 180 ? 1 : 0;
                    const path  = `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} L${ix2} ${iy2} A${ir} ${ir} 0 ${large} 0 ${ix1} ${iy1}Z`;
                    cursor += angle;
                    return <path key={idx} d={path} fill={d.color} />;
                  });
                })()}
              </svg>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {donutData.map(d => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: d.color, flexShrink: 0, display: "inline-block" }} />
                  <span style={{ fontSize: 11, color: "#475569" }}>{d.name}</span>
                  <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto", paddingLeft: 8 }}>{d.value.toFixed(1)}%</span>
                </div>
              ))}
              <div style={{ marginTop: 4, padding: "5px 7px", background: "#fff7ed", borderRadius: 6, border: "1px solid #fed7aa" }}>
                <span style={{ fontSize: 9, color: "#92400e", lineHeight: 1.5, display: "block" }}>
                  Hot = LST &gt; avg+5°C<br />Cool = LST &lt; avg−5°C<br />Moderate = within ±5°C
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card style={{ padding: "12px 14px" }}>
        <p style={sectionLabel}>Data Info · Week {weekIndex + 1}/52</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { label: "Period",      value: dateStr },
            { label: "Valid Pixels",value: stats.count.toLocaleString() },
            { label: "Min",         value: fmtVal(stats.min) },
            { label: "Max",         value: fmtVal(stats.max) },
            { label: "Average",     value: fmtVal(stats.avg) },
            { label: "Band idx",    value: `${getBandIdx(weekIndex, activeLayer)} (0-based)` },
          ].map(r => (
            <div key={r.label} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10.5, color: "#6b7280" }}>{r.label}</span>
              <span style={{ fontSize: 10.5, color: "#111827", fontWeight: 600, fontFamily: "monospace" }}>{r.value}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>Layer Overview</p>
        {[
          { label: "NDVI",        pct: annualMeans ? Math.round(Math.max(0, Math.min(100, (annualMeans.ndvi / 0.85) * 100))) : 52, color: "#22c55e", explain: annualMeans ? `Annual avg NDVI ${annualMeans.ndvi.toFixed(3)}` : "~52% area has NDVI > 0.3" },
          { label: "LST Hot",     pct: Math.min(100, Math.round(stats.hotPct + stats.modPct)), color: "#f97316", explain: `${Math.min(100, Math.round(stats.hotPct + stats.modPct))}% area is moderate-to-hot` },
          { label: "Rainfall",    pct: annualMeans ? Math.round(Math.max(0, Math.min(100, (annualMeans.rain / 80) * 100))) : 44, color: "#38bdf8", explain: annualMeans ? `Annual avg rain ${annualMeans.rain.toFixed(1)} mm/week` : "" },
          { label: "Soil Moist.", pct: annualMeans ? Math.round(Math.max(0, Math.min(100, annualMeans.soil * 100))) : 38, color: "#84cc16", explain: annualMeans ? `Annual avg soil ${(annualMeans.soil * 100).toFixed(1)}%` : "" },
          { label: "Water Cover", pct: annualMeans ? Math.round(Math.max(0, Math.min(100, annualMeans.water))) : 12, color: "#06b6d4", explain: annualMeans ? `Annual avg water ${annualMeans.water.toFixed(1)}%` : "" },
        ].map(r => (
          <div key={r.label} style={{ marginBottom: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{r.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>{r.pct}%</span>
            </div>
            <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden", marginBottom: 4 }}>
              <div style={{ height: "100%", width: `${r.pct}%`, background: r.color, borderRadius: 99, transition: "width 0.6s" }} />
            </div>
            <div style={{ fontSize: 9.5, color: "#9ca3af", lineHeight: 1.4 }}>{r.explain}</div>
          </div>
        ))}
      </Card>

      <AnnualMeansPanel means={annualMeans} year={year} />
      <DataSourcesPanel />
    </div>
  );
}

// ─── Basemap Tiles ─────────────────────────────────────────────────────────────

function BasemapTiles({ mapType }: { mapType: MapType }) {
  if (mapType === "osm") return <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />;
  if (mapType === "satellite") return <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} attribution="© Esri" />;
  return <>
    <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} attribution="© Esri" />
    <TileLayer url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}" maxZoom={22} opacity={0.9} />
  </>;
}

// ─── Map Controls ─────────────────────────────────────────────────────────────

function MapControls({ mapType, setMapType }: { mapType: MapType; setMapType: (m: MapType) => void }) {
  const map = useMap();
  return (
    <div style={{ position: "absolute", top: 16, right: 16, zIndex: 700, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {[{ label: "+", fn: () => map.zoomIn() }, { label: "−", fn: () => map.zoomOut() }].map(({ label, fn }) => (
          <button key={label} onClick={fn} style={{ display: "block", width: 36, height: 36, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: "#374151", lineHeight: 1, borderBottom: label === "+" ? "1px solid #f1f5f9" : "none" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>{label}</button>
        ))}
      </div>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {BASEMAPS.map(({ id, label, icon: Icon }) => {
          const active = mapType === id;
          return (
            <button key={id} onClick={() => setMapType(id)} title={label}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "none", cursor: "pointer", background: active ? "#f0f9ff" : "transparent", borderBottom: id !== "hybrid" ? "1px solid #f1f5f9" : "none" }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
              <Icon size={14} color={active ? "#0284c7" : "#9ca3af"} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Canvas Layer ─────────────────────────────────────────────────────────────

const CanvasLayer = React.memo(({ band, width, height, bbox, minVal, maxVal, layerType }: {
  band: any; width: number; height: number; bbox: number[];
  minVal: number; maxVal: number; layerType: LayerType;
}) => {
  const map = useMap();
  const overlayRef = useRef<L.ImageOverlay | null>(null);

  useEffect(() => {
    if (!band || !width || !height || !bbox.length) return;

    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx    = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(width, height);
    const px = imgData.data;
    for (let i = 0; i < width * height; i++) {
      const v = band[i] as number;
      if (v == null || isNaN(v) || v <= NODATA + 1) { px[i*4+3] = 0; continue; }
      const [r, g, b] = getColor(v, layerType, minVal, maxVal);
      px[i*4]=r; px[i*4+1]=g; px[i*4+2]=b; px[i*4+3]=172;
    }
    ctx.putImageData(imgData, 0, 0);

    const bounds: L.LatLngBoundsExpression = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    const dataUrl = canvas.toDataURL();

    // Reuse overlay if it already exists on map, just update url
    if (overlayRef.current) {
      map.removeLayer(overlayRef.current);
    }
    const ov = L.imageOverlay(dataUrl, bounds, { opacity: 1, zIndex: 250 });
    ov.addTo(map);
    overlayRef.current = ov;

    return () => {
      if (overlayRef.current) {
        map.removeLayer(overlayRef.current);
        overlayRef.current = null;
      }
    };
  }, [band, width, height, bbox, minVal, maxVal, layerType, map]);

  return null;
});

// ─── GeoJSON Boundary Layer ───────────────────────────────────────────────────

const NagpurBoundaryLayer = React.memo(() => {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);

  useEffect(() => {
    // Fetch real boundary geojson; fall back to bbox polygon if unavailable
    let cancelled = false;

    const addFallback = () => {
      if (cancelled || layerRef.current) return;
      const NAGPUR_BBOX = [78.65, 20.70, 79.70, 21.58];
      const coords: L.LatLngTuple[] = [
        [NAGPUR_BBOX[1], NAGPUR_BBOX[0]],
        [NAGPUR_BBOX[1], NAGPUR_BBOX[2]],
        [NAGPUR_BBOX[3], NAGPUR_BBOX[2]],
        [NAGPUR_BBOX[3], NAGPUR_BBOX[0]],
        [NAGPUR_BBOX[1], NAGPUR_BBOX[0]],
      ];
      const polygon = L.polygon(coords, {
        color: "#38bdf8",
        weight: 2,
        fillOpacity: 0,
        dashArray: "6 4",
        opacity: 0.85,
      });
      polygon.addTo(map);
      layerRef.current = polygon as unknown as L.GeoJSON;
    };

    fetch("/nagpur_boundary.geojson")
      .then(r => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then(geojson => {
        if (cancelled) return;
        const layer = L.geoJSON(geojson, {
          style: {
            color: "#38bdf8",
            weight: 2.5,
            fillOpacity: 0,
            opacity: 0.9,
            dashArray: undefined,
          },
        });
        layer.addTo(map);
        layerRef.current = layer;
      })
      .catch(() => { addFallback(); });

    return () => {
      cancelled = true;
      if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null; }
    };
  }, [map]);

  return null;
});

// ─── Hover Tooltip (compact, optimized) ──────────────────────────────────────
// LST layer  → multi-layer two-column tooltip (all 6 bands)
// All others → single-layer lightweight tooltip (active band only)

const TOOLTIP_STYLE = `<style>.nagpur-tooltip .leaflet-popup-content-wrapper{border-radius:10px!important;box-shadow:0 4px 16px rgba(0,0,0,0.14)!important;padding:0!important;border:1px solid #e5e7eb;overflow:hidden}.nagpur-tooltip .leaflet-popup-content{margin:0!important;width:auto!important}.nagpur-tooltip .leaflet-popup-tip-container{display:none}</style>`;

const HoverTooltip = React.memo(({ currentWeekBands, width, height, bbox, weekIndex, year, annualMeans, activeLayer }: {
  currentWeekBands: any[] | null; width: number; height: number; bbox: number[];
  weekIndex: number; year: number; annualMeans: AnnualMeans | null; activeLayer: LayerType;
}) => {
  const popupRef   = useRef<L.Popup | null>(null);
  const isDragging = useRef(false);
  const lastPxRef  = useRef<{ x: number; y: number } | null>(null);
  const map = useMap();

  useEffect(() => {
    const onStart = () => {
      isDragging.current = true;
      try { if (popupRef.current) map.closePopup(popupRef.current); } catch (_) {}
    };
    const onEnd = () => { isDragging.current = false; };
    map.on("dragstart", onStart);
    map.on("dragend", onEnd);
    return () => { map.off("dragstart", onStart); map.off("dragend", onEnd); };
  }, [map]);

  useMapEvents({
    mousemove(e) {
      if (isDragging.current || !currentWeekBands || !width || !height || !bbox.length) return;
      const { lat, lng } = e.latlng;
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) {
        try { if (popupRef.current) map.closePopup(popupRef.current); } catch (_) {}
        lastPxRef.current = null;
        return;
      }

      const x = Math.max(0, Math.min(width  - 1, Math.floor(((lng - bbox[0]) / (bbox[2] - bbox[0])) * width)));
      const y = Math.max(0, Math.min(height - 1, Math.floor(((bbox[3] - lat) / (bbox[3] - bbox[1])) * height)));

      // Skip if same pixel — avoids unnecessary DOM updates
      if (lastPxRef.current && lastPxRef.current.x === x && lastPxRef.current.y === y) return;
      lastPxRef.current = { x, y };

      // Read one band value at pixel (x, y)
      const readPx = (layer: LayerType): number | null => {
        const band = currentWeekBands[BAND_OFFSET[layer]];
        if (!band) return null;
        const idx = y * width + x;
        if (idx < 0 || idx >= band.length) return null;
        const v = band[idx];
        return (v == null || !Number.isFinite(v) || Number.isNaN(v) || v <= NODATA + 1) ? null : v as number;
      };

      const d1 = dateFromWeek(year, weekIndex);
      const d2 = dateEndFromWeek(year, weekIndex);
      const weekStr = `${formatDateShort(d1)}–${formatDateShort(d2)}`;

      // Shared header HTML
      const header = `
<div style="padding:7px 10px;background:#1e293b;display:flex;align-items:center;justify-content:space-between;gap:8px">
  <div>
    <div style="font-size:11px;font-weight:700;color:#fff">📍 Nagpur</div>
    <div style="font-size:9px;color:rgba(255,255,255,0.45);margin-top:1px">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</div>
  </div>
  <div style="background:rgba(249,115,22,0.18);border:1px solid rgba(249,115,22,0.3);border-radius:5px;padding:2px 7px;text-align:center;flex-shrink:0">
    <div style="font-size:8px;color:#fb923c;font-weight:700">WK</div>
    <div style="font-size:12px;font-weight:900;color:#f97316;font-family:monospace;line-height:1.1">${String(weekIndex+1).padStart(2,"0")}/52</div>
    <div style="font-size:7.5px;color:rgba(255,255,255,0.35)">${weekStr}</div>
  </div>
</div>`;

      const footer = `<div style="padding:3px 10px 5px;border-top:1px solid #f1f5f9"><span style="font-size:8px;color:#d1d5db">▲▼ vs ${year} annual avg · px(${x},${y})</span></div>`;

      // Helper: format annual diff arrow
      const diff = (val: number, annual: number | undefined, fmt: (v: number) => string): string => {
        if (annual == null) return "";
        const d = val - annual;
        const col = d > 0 ? "#ef4444" : "#22c55e";
        const abs = Math.abs(d);
        const str = abs < 0.001 ? "0.0" : abs < 1 ? abs.toFixed(3) : abs.toFixed(1);
        return ` <span style="color:${col};font-size:9px">${d >= 0 ? "▲" : "▼"}${str}</span>`;
      };

      if (!popupRef.current) {
        popupRef.current = L.popup({ closeButton: false, offset: [0, -4], maxWidth: 260, className: "nagpur-tooltip", autoPan: false });
      }

      // ── LST layer: show ALL bands in two-column layout ─────────────────────
      if (activeLayer === "lst") {
        const lst   = readPx("lst");
        const ndvi  = readPx("ndvi");
        const rain  = readPx("rain");
        const soil  = readPx("soil");
        const water = readPx("water");
        const lulc  = readPx("lulc");
        const am    = annualMeans;

        const lulcCls   = lulc !== null ? Math.round(lulc) : null;
        const lulcLabel = lulcCls !== null && lulcCls >= 0 && lulcCls <= 8 ? LULC_CLASSES[lulcCls].label : "—";

        // Left column: LST (hero) + Rain + LULC
        const leftCol = [
          lst !== null
            ? `<div style="margin-bottom:6px">
                <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌡 Temp</div>
                <div style="font-size:17px;font-weight:900;color:#ea580c;font-family:monospace;line-height:1.15">${lst.toFixed(1)}°C${diff(lst, am?.lst, v => v.toFixed(1)+"°C")}</div>
               </div>`
            : `<div style="margin-bottom:6px"><div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase">🌡 Temp</div><div style="font-size:13px;color:#d1d5db;font-family:monospace">—</div></div>`,
          rain !== null
            ? `<div style="margin-bottom:6px">
                <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌧 Rain</div>
                <div style="font-size:13px;font-weight:700;color:#0284c7;font-family:monospace">${rain.toFixed(1)} mm${diff(rain, am?.rain, v => v.toFixed(1))}</div>
               </div>`
            : "",
          lulc !== null
            ? `<div>
                <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🗺 LULC</div>
                <div style="font-size:11px;font-weight:700;color:#7c3aed;font-family:monospace">${lulcLabel}</div>
               </div>`
            : "",
        ].join("");

        // Right column: NDVI + Soil + Water
        const rightCol = [
          ndvi !== null
            ? `<div style="margin-bottom:6px">
                <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌿 NDVI</div>
                <div style="font-size:13px;font-weight:700;color:#16a34a;font-family:monospace">${ndvi.toFixed(3)}${diff(ndvi, am?.ndvi, v => v.toFixed(3))}</div>
               </div>`
            : "",
          soil !== null
            ? `<div style="margin-bottom:6px">
                <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌱 Soil</div>
                <div style="font-size:13px;font-weight:700;color:#65a30d;font-family:monospace">${(soil*100).toFixed(1)}%${diff(soil, am?.soil, v => (v*100).toFixed(1)+"%")}</div>
               </div>`
            : "",
          water !== null
            ? `<div>
                <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">💧 Water</div>
                <div style="font-size:13px;font-weight:700;color:#0891b2;font-family:monospace">${water.toFixed(1)}%${diff(water, am?.water, v => v.toFixed(1)+"%")}</div>
               </div>`
            : "",
        ].join("");

        popupRef.current.setLatLng([lat, lng]).setContent(`
${TOOLTIP_STYLE}
<div style="font-family:system-ui,-apple-system,sans-serif;width:240px;background:#fff">
  ${header}
  <div style="display:flex;padding:8px 10px 6px;gap:0;align-items:flex-start">
    <div style="flex:1;min-width:0;padding-right:8px">${leftCol || "<span style='font-size:11px;color:#d1d5db'>—</span>"}</div>
    <div style="width:1px;background:#f1f5f9;flex-shrink:0;align-self:stretch"></div>
    <div style="flex:1;min-width:0;padding-left:8px">${rightCol || "<span style='font-size:11px;color:#d1d5db'>—</span>"}</div>
  </div>
  ${footer}
</div>`).openOn(map);
        return;
      }

      // ── All other layers: single-value lightweight tooltip ─────────────────
      const val = readPx(activeLayer);
      const am  = annualMeans;

      let valDisplay = "—";
      let annualDisplay = "—";
      let accentColor = "#374151";

      if (activeLayer === "ndvi") {
        accentColor = "#16a34a";
        valDisplay    = val !== null ? `${val.toFixed(3)}${diff(val, am?.ndvi, v => v.toFixed(3))}` : "—";
        annualDisplay = am ? am.ndvi.toFixed(3) : "—";
      } else if (activeLayer === "rain") {
        accentColor = "#0284c7";
        valDisplay    = val !== null ? `${val.toFixed(1)} mm${diff(val, am?.rain, v => v.toFixed(1))}` : "—";
        annualDisplay = am ? `${am.rain.toFixed(1)} mm` : "—";
      } else if (activeLayer === "soil") {
        accentColor = "#65a30d";
        valDisplay    = val !== null ? `${(val*100).toFixed(1)}%${diff(val, am?.soil, v => (v*100).toFixed(1)+"%")}` : "—";
        annualDisplay = am ? `${(am.soil*100).toFixed(1)}%` : "—";
      } else if (activeLayer === "water") {
        accentColor = "#0891b2";
        valDisplay    = val !== null ? `${val.toFixed(1)}%${diff(val, am?.water, v => v.toFixed(1)+"%")}` : "—";
        annualDisplay = am ? `${am.water.toFixed(1)}%` : "—";
      } else if (activeLayer === "lulc") {
        accentColor = "#7c3aed";
        const cls   = val !== null ? Math.round(val) : null;
        valDisplay  = cls !== null && cls >= 0 && cls <= 8 ? LULC_CLASSES[cls].label : "—";
        annualDisplay = "—"; // no annual mean for LULC
      }

      const meta = LAYER_META[activeLayer];

      popupRef.current.setLatLng([lat, lng]).setContent(`
${TOOLTIP_STYLE}
<div style="font-family:system-ui,-apple-system,sans-serif;width:190px;background:#fff">
  ${header}
  <div style="padding:9px 12px 7px">
    <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">${meta.emoji} ${meta.name}</div>
    <div style="font-size:20px;font-weight:900;color:${accentColor};font-family:monospace;line-height:1.2">${valDisplay}</div>
    ${activeLayer !== "lulc" ? `<div style="margin-top:5px;font-size:9px;color:#9ca3af">avg ${year}: <span style="color:#374151;font-weight:600">${annualDisplay}</span></div>` : ""}
  </div>
  ${footer}
</div>`).openOn(map);
    },
    mouseout() {
      try { if (popupRef.current) map.closePopup(popupRef.current); } catch (_) {}
      lastPxRef.current = null;
    },
  });

  return null;
});

// ─── Layer Switcher ───────────────────────────────────────────────────────────

const LAYER_ORDER: LayerType[] = ["lst","ndvi","rain","soil","water","lulc"];
const LAYER_ACTIVE_COLORS: Record<LayerType, { bg: string; border: string; text: string }> = {
  lst:   { bg: "#fff7ed", border: "#fed7aa", text: "#ea580c" },
  ndvi:  { bg: "#f0fdf4", border: "#bbf7d0", text: "#16a34a" },
  rain:  { bg: "#f0f9ff", border: "#bae6fd", text: "#0284c7" },
  soil:  { bg: "#f7fee7", border: "#d9f99d", text: "#65a30d" },
  water: { bg: "#ecfeff", border: "#a5f3fc", text: "#0891b2" },
  lulc:  { bg: "#f5f3ff", border: "#ddd6fe", text: "#7c3aed" },
};

// ─── Week Navigator ──────────────────────────────────────────────────────────

function WeekNavigator({ weekIndex, year, setWeekIndex, setYear }: {
  weekIndex: number; year: number;
  setWeekIndex: (w: number) => void; setYear: (y: number) => void;
}) {
  const [open, setOpen]               = React.useState(false);
  const dropRef                       = React.useRef<HTMLDivElement>(null);
  const [pickerYear,  setPickerYear]  = React.useState(year);
  const [pickerMonth, setPickerMonth] = React.useState(0);
  const [pickerWeek,  setPickerWeek]  = React.useState(weekIndex);

  React.useEffect(() => {
    setPickerYear(year);
    setPickerWeek(weekIndex);
    const d = dateFromWeek(year, weekIndex);
    setPickerMonth(d.getMonth());
  }, [weekIndex, year]);

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const d1 = dateFromWeek(year, weekIndex);
  const d2 = dateEndFromWeek(year, weekIndex);

  const weeksInMonth = useMemo(() => {
    const result: { wi: number; label: string }[] = [];
    for (let wi = 0; wi < N_WEEKS; wi++) {
      const d = dateFromWeek(pickerYear, wi);
      if (d.getMonth() === pickerMonth) {
        result.push({ wi, label: `Wk ${wi + 1} (${formatDateShort(d)}–${formatDateShort(dateEndFromWeek(pickerYear, wi))})` });
      }
    }
    return result;
  }, [pickerYear, pickerMonth]);

  const applyWeek = (wi: number, y: number) => {
    setYear(y);
    setWeekIndex(Math.max(0, Math.min(N_WEEKS - 1, wi)));
    setOpen(false);
  };

  return (
    <div ref={dropRef} style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 700 }}>
      <style>{`.ndate::-webkit-scrollbar{width:4px}.ndate::-webkit-scrollbar-thumb{background:#f97316;border-radius:4px}`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => { if (weekIndex > 0) setWeekIndex(weekIndex - 1); else if (year > 2015) { setYear(year - 1); setWeekIndex(N_WEEKS - 1); } }}
          style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.08)",flexShrink:0 }}
          onMouseEnter={e=>(e.currentTarget.style.background="#f8fafc")} onMouseLeave={e=>(e.currentTarget.style.background="#fff")}>
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7l5 5" stroke="#374151" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        <button onClick={() => setOpen(o => !o)} style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:18,boxShadow:"0 4px 20px rgba(0,0,0,0.12)",padding:"10px 20px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",userSelect:"none",minWidth:300 }}>
          <div style={{ display:"flex",flexDirection:"column",alignItems:"center",minWidth:46,flexShrink:0 }}>
            <span style={{ fontSize:22,fontWeight:900,color:"#111827",fontFamily:"monospace",lineHeight:1,letterSpacing:"-1px" }}>{year}</span>
            <span style={{ fontSize:9,color:"#f97316",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.12em",marginTop:2 }}>YEAR</span>
          </div>
          <div style={{ width:1,height:38,background:"#e5e7eb",flexShrink:0 }} />
          <div style={{ flex:1,textAlign:"left" }}>
            <span style={{ fontSize:11,color:"#9ca3af",display:"block",marginBottom:2,textTransform:"uppercase",letterSpacing:"0.08em" }}>Week {weekIndex + 1} / 52</span>
            <span style={{ fontSize:15,fontWeight:700,color:"#111827" }}>
              {formatDateShort(d1)}
              <span style={{ fontSize:12,color:"#9ca3af",marginLeft:4,fontWeight:400 }}>– {formatDateShort(d2)}</span>
            </span>
          </div>
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ flexShrink:0,transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)" }}>
            <path d="M4 6l4 4 4-4" stroke="#f97316" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <button onClick={() => { if (weekIndex < N_WEEKS - 1) setWeekIndex(weekIndex + 1); else if (year < 2025) { setYear(year + 1); setWeekIndex(0); } }}
          style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.08)",flexShrink:0 }}
          onMouseEnter={e=>(e.currentTarget.style.background="#f8fafc")} onMouseLeave={e=>(e.currentTarget.style.background="#fff")}>
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none"><path d="M5 2l5 5-5 5" stroke="#374151" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      {open && (
        <div className="ndate" style={{ position:"absolute",bottom:"calc(100% + 10px)",left:"50%",transform:"translateX(-50%)",background:"#fff",border:"1px solid #e5e7eb",borderRadius:16,boxShadow:"0 -8px 40px rgba(0,0,0,0.15)",padding:"16px",minWidth:320,zIndex:900,maxHeight:420,overflowY:"auto" }}>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8 }}>Select Year</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
              {YEARS.map(y => <button key={y} onClick={() => setPickerYear(y)}
                style={{ padding:"5px 12px",borderRadius:8,border:`1.5px solid ${pickerYear===y?"#f97316":"#e5e7eb"}`,background:pickerYear===y?"#fff7ed":"#f8fafc",color:pickerYear===y?"#f97316":"#374151",fontSize:12,fontWeight:700,cursor:"pointer" }}>{y}</button>)}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8 }}>Select Month</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
              {MONTH_NAMES.map((mn,mi) => <button key={mn} onClick={() => { setPickerMonth(mi); setPickerWeek(weeksInMonth.find(w => w.wi >= 0)?.wi ?? 0); }}
                style={{ padding:"5px 10px",borderRadius:8,border:`1.5px solid ${pickerMonth===mi?"#f97316":"#e5e7eb"}`,background:pickerMonth===mi?"#fff7ed":"#f8fafc",color:pickerMonth===mi?"#f97316":"#374151",fontSize:11,fontWeight:700,cursor:"pointer" }}>{mn}</button>)}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8 }}>Select Week</div>
            <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
              {weeksInMonth.map(({ wi, label }) => (
                <button key={wi} onClick={() => setPickerWeek(wi)}
                  style={{ padding:"7px 12px",borderRadius:8,border:`1.5px solid ${pickerWeek===wi?"#f97316":"#e5e7eb"}`,background:pickerWeek===wi?"#fff7ed":"#f8fafc",color:pickerWeek===wi?"#f97316":"#374151",fontSize:11,fontWeight:600,cursor:"pointer",textAlign:"left" }}>{label}</button>
              ))}
            </div>
          </div>
          <button onClick={() => applyWeek(pickerWeek, pickerYear)}
            style={{ width:"100%",padding:"10px",background:"#f97316",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:4 }}>
            Go to Week {pickerWeek + 1} · {pickerYear}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Year Timeline ────────────────────────────────────────────────────────────

function YearTimeline({ year, setYear, weekIndex, setWeekIndex }: {
  year: number; setYear: (y: number) => void; weekIndex: number; setWeekIndex: (w: number) => void;
}) {
  return (
    <div style={{ position:"absolute",top:16,left:"50%",transform:"translateX(-50%)",zIndex:600,pointerEvents:"auto" }}>
      <div style={{ background:"rgba(255,255,255,0.97)",border:"1px solid #e5e7eb",borderRadius:999,padding:"6px 10px",boxShadow:"0 2px 12px rgba(0,0,0,0.08)",display:"flex",alignItems:"center",gap:4 }}>
        {YEARS.map(y => (
          <button key={y} onClick={() => { setYear(y); setWeekIndex(Math.min(weekIndex, N_WEEKS - 1)); }}
            style={{ padding:"4px 10px",borderRadius:999,border:"none",background:y===year?"#f97316":"transparent",color:y===year?"#fff":"#6b7280",fontSize:11,fontWeight:700,cursor:"pointer",transition:"all 0.15s" }}
            onMouseEnter={e => { if (y!==year) (e.currentTarget as HTMLButtonElement).style.background="#f8fafc"; }}
            onMouseLeave={e => { if (y!==year) (e.currentTarget as HTMLButtonElement).style.background="transparent"; }}
          >{y}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Layer Legend ─────────────────────────────────────────────────────────────

function LayerLegend({ activeLayer }: { activeLayer: LayerType }) {
  const meta   = LAYER_META[activeLayer];
  const legend = LAYER_LEGEND[activeLayer];
  if (activeLayer === "lulc") {
    return (
      <div style={{ position:"absolute",bottom:100,left:16,zIndex:500 }}>
        <Card style={{ padding:"10px 14px",minWidth:180 }}>
          <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:6 }}>
            <Activity size={13} color="#0ea5e9" />
            <span style={{ fontSize:11,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em" }}>LULC Classes</span>
          </div>
          <p style={{ fontSize:13,fontWeight:700,color:"#111827",marginBottom:8 }}>{meta.emoji} {meta.name}</p>
          <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
            {LULC_CLASSES.map(c => (
              <div key={c.label} style={{ display:"flex",alignItems:"center",gap:6 }}>
                <span style={{ width:10,height:10,borderRadius:2,background:c.color,flexShrink:0,display:"inline-block" }} />
                <span style={{ fontSize:10,color:"#374151" }}>{c.label}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }
  return (
    <div style={{ position:"absolute",bottom:100,left:16,zIndex:500 }}>
      <Card style={{ padding:"10px 14px",minWidth:190 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:6 }}>
          <Activity size={13} color="#0ea5e9" />
          <span style={{ fontSize:11,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em" }}>Colour Legend</span>
        </div>
        <p style={{ fontSize:13,fontWeight:700,color:"#111827",marginBottom:8 }}>{meta.emoji} {meta.name}</p>
        <div style={{ height:12,borderRadius:99,background:legend.gradient,boxShadow:"inset 0 1px 3px rgba(0,0,0,0.12)",marginBottom:6 }} />
        <div style={{ display:"flex",justifyContent:"space-between" }}>
          <span style={{ fontSize:11,color:"#6b7280",fontWeight:600 }}>{legend.lowLabel}</span>
          <span style={{ fontSize:11,color:"#6b7280",fontWeight:600 }}>{legend.highLabel}</span>
        </div>
      </Card>
    </div>
  );
}

// ─── Map Instance ─────────────────────────────────────────────────────────────

function MapInstance({ setMap }: { setMap: (map: any) => void }) {
  const map = useMap();
  useEffect(() => { setMap(map); }, [map, setMap]);
  return null;
}

// ─── On-Demand Weekly GeoTIFF Loader ─────────────────────────────────────────

function OnDemandGeoTiffLayer({ year, weekIndex, activeLayer, onMetadata, onWeekBandsLoaded, onStatsUpdated, onAnnualMeansUpdated, onMockMode }: {
  year: number; weekIndex: number; activeLayer: LayerType;
  onMetadata: (width: number, height: number, bbox: number[]) => void;
  onWeekBandsLoaded: (bands: any[]) => void;
  onStatsUpdated: (stats: RealStats) => void;
  onAnnualMeansUpdated: (means: AnnualMeans) => void;
  onMockMode?: (isMock: boolean) => void;
}) {
  const tiffCache           = useRef<Record<number, any>>({});
  const [meta, setMeta]     = useState<{ width: number; height: number; bbox: number[] } | null>(null);
  const [useMock, setUseMock] = useState(false);
  const annualMeansComputed = useRef<Set<number>>(new Set());

  const NAGPUR_BBOX = [78.65, 20.70, 79.70, 21.58];
  const MOCK_W = 220, MOCK_H = 180;

  const loadTiff = useCallback(async (yr: number): Promise<any | null> => {
    if (tiffCache.current[yr]) return tiffCache.current[yr];
    const url = `/Nagpur_Weekly_${yr}.tif`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf  = await res.arrayBuffer();
      const tiff = await GeoTIFF.fromArrayBuffer(buf);
      const img  = await tiff.getImage();
      tiffCache.current[yr] = img;
      return img;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setUseMock(false);
    setMeta(null);
    annualMeansComputed.current.delete(year);

    const init = async () => {
      const img = await loadTiff(year);
      if (cancelled) return;
      if (!img) {
        setMeta({ width: MOCK_W, height: MOCK_H, bbox: NAGPUR_BBOX });
        setUseMock(true);
        onMockMode?.(true);
        onMetadata(MOCK_W, MOCK_H, NAGPUR_BBOX);
        return;
      }
      const width  = img.getWidth();
      const height = img.getHeight();
      const bbox   = img.getBoundingBox();
      setMeta({ width, height, bbox });
      onMockMode?.(false);
      onMetadata(width, height, bbox);
    };
    init();
    return () => { cancelled = true; };
  }, [year]);

  const readBand = async (img: any, bandIdx: number, W: number, H: number): Promise<Float32Array | null> => {
    const STRIP_H = 64;
    const out = new Float32Array(W * H);
    try {
      for (let row = 0; row < H; row += STRIP_H) {
        const rowEnd = Math.min(row + STRIP_H, H);
        const strip  = await img.readRasters({
          window: [0, row, W, rowEnd],
          samples: [bandIdx],
          interleave: false,
        });
        if (!strip || !strip[0]) return null;
        out.set(strip[0] as Float32Array, row * W);
      }
      let valid = 0;
      for (let i = 0; i < out.length; i++) {
        if (Number.isFinite(out[i]) && out[i] > NODATA + 1) valid++;
      }
      if (valid === 0) return null;
      return out;
    } catch {
      return null;
    }
  };

  const generateMockBands = (W: number, H: number, wi: number): any[] => {
    const size   = W * H;
    const season = Math.sin((wi / N_WEEKS) * 2 * Math.PI);
    const bands: Float32Array[] = Array.from({ length: BANDS_PER_WEEK }, () => new Float32Array(size));
    for (let i = 0; i < size; i++) {
      const row = Math.floor(i / W), col = i % W;
      const sp  = Math.sin(row / 10) * Math.cos(col / 10) * 0.3;
      bands[0][i] = Math.max(-0.1, Math.min(0.85, 0.35 + season * 0.25 + sp * 0.2));
      const p1 = Math.cos((wi/52 - 0.37) * 2 * Math.PI) * 11;
      const monsoonDip = (wi >= 22 && wi <= 37) ? -6 : 0;
      bands[1][i] = Math.max(12, Math.min(55, 38 + p1 + monsoonDip + sp * 3 + (Math.random()-0.5)*2));
      bands[2][i] = Math.max(0, (season > 0.3 ? season * 30 : 0) + (Math.random()-0.5)*5);
      bands[3][i] = Math.max(0, Math.min(1, 0.3 + season * 0.3));
      bands[4][i] = Math.max(0, Math.min(100, 5 + Math.max(0, season) * 20));
      bands[5][i] = [4, 4, 6, 1, 4, 4, 6, 1, 4][Math.floor(Math.random() * 9)];
    }
    return bands as any[];
  };

  const processBand = (band: Float32Array, layer: LayerType): RealStats | null => {
    const raw: number[] = [];
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (!Number.isFinite(v) || isNaN(v) || v <= NODATA + 1) continue;
      raw.push(v);
    }
    if (!raw.length) return null;
    const sorted = [...raw].sort((a, b) => a - b);
    const p2  = sorted[Math.floor(sorted.length * 0.02)];
    const p98 = sorted[Math.floor(sorted.length * 0.98)];
    const vals = raw.filter(v => v >= p2 && v <= p98);
    if (!vals.length) return null;
    const avg  = vals.reduce((a,b) => a+b,0) / vals.length;
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const hot  = layer === "lst" ? vals.filter(v => v > avg + 5).length : 0;
    const cool = layer === "lst" ? vals.filter(v => v < avg - 5).length : 0;
    const mod  = vals.length - hot - cool;
    return {
      avg, min: minV, max: maxV,
      hotPct:  hot  / vals.length * 100,
      modPct:  mod  / vals.length * 100,
      coolPct: cool / vals.length * 100,
      count: vals.length,
    };
  };

  useEffect(() => {
    if (!meta) return;
    let cancelled = false;

    const load = async () => {
      const { width: W, height: H } = meta;

      if (useMock) {
        await new Promise(r => setTimeout(r, 80));
        if (!cancelled) {
          const bands = generateMockBands(W, H, weekIndex);
          onWeekBandsLoaded(bands);
          const stats = processBand(bands[BAND_OFFSET[activeLayer]], activeLayer);
          if (stats) onStatsUpdated(stats);
        }
        return;
      }

      const img = tiffCache.current[year];
      if (!img) return;

      const activeBandIdx = getBandIdx(weekIndex, activeLayer);
      const activeBand = await readBand(img, activeBandIdx, W, H);
      if (cancelled) return;

      if (activeBand) {
        const placeholder = new Array(BANDS_PER_WEEK).fill(null);
        placeholder[BAND_OFFSET[activeLayer]] = activeBand;
        onWeekBandsLoaded(placeholder);
        const stats = processBand(activeBand, activeLayer);
        if (stats && !cancelled) onStatsUpdated(stats);
      }

      const full = new Array(BANDS_PER_WEEK).fill(null);
      if (activeBand) full[BAND_OFFSET[activeLayer]] = activeBand;

      for (let offset = 0; offset < BANDS_PER_WEEK; offset++) {
        if (offset === BAND_OFFSET[activeLayer] || cancelled) continue;
        const entry = Object.entries(BAND_OFFSET).find(([, v]) => v === offset);
        if (!entry) continue;
        const bi   = getBandIdx(weekIndex, entry[0] as LayerType);
        const band = await readBand(img, bi, W, H);
        if (band && !cancelled) { full[offset] = band; onWeekBandsLoaded([...full]); }
      }
    };

    load();
    return () => { cancelled = true; };
  }, [meta, useMock, year, weekIndex, activeLayer]);

  // ── Annual means: sample 12 weeks (one per month) ─────────────────────────
  useEffect(() => {
    if (!meta || useMock || annualMeansComputed.current.has(year)) return;
    annualMeansComputed.current.add(year);
    let cancelled = false;

    const SAMPLE_WEEKS = [1, 5, 9, 14, 18, 22, 27, 31, 35, 40, 44, 49];

    const bandMean = (band: Float32Array | null, mn: number, mx: number): number | null => {
      if (!band) return null;
      let s = 0, c = 0;
      for (let i = 0; i < band.length; i++) {
        const v = band[i];
        if (Number.isFinite(v) && !isNaN(v) && v > NODATA + 1 && v >= mn && v <= mx) { s += v; c++; }
      }
      return c > 0 ? s / c : null;
    };

    const run = async () => {
      const img = await loadTiff(year);
      if (!img || cancelled) return;
      const W = meta.width, H = meta.height;
      let sumN=0, sumL=0, sumR=0, sumS=0, sumW=0, valid=0;

      for (const wi of SAMPLE_WEEKS) {
        if (cancelled) return;
        const bN = await readBand(img, getBandIdx(wi, "ndvi"),  W, H); if (cancelled) return;
        const bL = await readBand(img, getBandIdx(wi, "lst"),   W, H); if (cancelled) return;
        const bR = await readBand(img, getBandIdx(wi, "rain"),  W, H); if (cancelled) return;
        const bS = await readBand(img, getBandIdx(wi, "soil"),  W, H); if (cancelled) return;
        const bW = await readBand(img, getBandIdx(wi, "water"), W, H); if (cancelled) return;

        const mN = bandMean(bN, -1,    1);
        const mL = bandMean(bL, -9998, 99999);
        const mR = bandMean(bR, 0,     500);
        const mS = bandMean(bS, 0,     1);
        const mW = bandMean(bW, 0,     100);
        if (mN !== null && mL !== null && mR !== null && mS !== null && mW !== null) {
          sumN+=mN; sumL+=mL; sumR+=mR; sumS+=mS; sumW+=mW; valid++;
        }
        await new Promise(r => setTimeout(r, 0));
      }
      if (!cancelled && valid > 0) {
        onAnnualMeansUpdated({ ndvi: sumN/valid, lst: sumL/valid, rain: sumR/valid, soil: sumS/valid, water: sumW/valid });
      }
    };
    run();
    return () => { cancelled = true; };
  }, [meta, useMock, year]);

  return null;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Nagpur() {
  const [year,        setYearRaw]    = useState<number>(2025);
  const [weekIndex,   setWeekRaw]    = useState<number>(0);
  const [loading,     setLoading]    = useState(true);
  const [mapType,     setMapType]    = useState<MapType>("osm");
  const [activeLayer, setActiveLayer]= useState<LayerType>("lst");
  const [infoOpen,    setInfoOpen]   = useState(false);
  const [layerOpen,   setLayerOpen]  = useState(false);

  const [tiffWidth,  setTiffWidth]   = useState(0);
  const [tiffHeight, setTiffHeight]  = useState(0);
  const [tiffBbox,   setTiffBbox]    = useState<number[]>([]);
  const [isMockMode, setIsMockMode]  = useState(false);

  const [currentWeekBands, setCurrentWeekBands] = useState<any[] | null>(null);
  const [currentBand,      setCurrentBand]       = useState<any>(null);
  const [bandMin,          setBandMin]            = useState(0);
  const [bandMax,          setBandMax]            = useState(0);
  const [realStats,        setRealStats]          = useState<RealStats | null>(null);
  const [annualMeans,      setAnnualMeans]        = useState<AnnualMeans | null>(null);

  const setYear = useCallback((y: number) => {
    setYearRaw(y);
    setLoading(true);
    setRealStats(null);
    setAnnualMeans(null);
    setCurrentWeekBands(null);
    setCurrentBand(null);
  }, []);

  const setWeekIndex = useCallback((w: number) => {
    setWeekRaw(w);
    setLoading(true);
    setRealStats(null);
    setCurrentWeekBands(null);
    setCurrentBand(null);
  }, []);

  useEffect(() => {
    if (!currentWeekBands) { setCurrentBand(null); return; }
    const band = currentWeekBands[BAND_OFFSET[activeLayer]];
    if (!band) { setCurrentBand(null); return; }
    const hint = LAYER_RANGE[activeLayer];
    const [lo, hi] = computeRange(band, hint.min, hint.max);
    setBandMin(lo);
    setBandMax(hi);
    setCurrentBand(band);
    setLoading(false);
  }, [currentWeekBands, activeLayer]);

  const handleMetadata    = useCallback((w: number, h: number, bbox: number[]) => { setTiffWidth(w); setTiffHeight(h); setTiffBbox(bbox); }, []);
  const handleBandsLoaded = useCallback((bands: any[]) => { setCurrentWeekBands(bands); }, []);
  const handleStats       = useCallback((stats: RealStats) => { setRealStats(stats); }, []);
  const handleAnnualMeans = useCallback((means: AnnualMeans) => { setAnnualMeans(means); }, []);

  const meta = LAYER_META[activeLayer];
  const info = LAYER_INFO[activeLayer];
  const d1   = dateFromWeek(year, weekIndex);
  const d2   = dateEndFromWeek(year, weekIndex);

  return (
    <div style={{ display:"flex", height:"100vh", width:"100%", fontFamily:"'Inter',system-ui,sans-serif", overflow:"hidden", background:"#f1f5f9" }}>
      {infoOpen && <InfoTab activeLayer={activeLayer} onClose={() => setInfoOpen(false)} />}
      <div style={{ flex:1, position:"relative", cursor:"crosshair" }}>
        {loading && (
          <div style={{ position:"absolute", inset:0, zIndex:1000, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"rgba(248,250,252,0.84)", backdropFilter:"blur(6px)" }}>
            <div style={{ animation:"spin 1s linear infinite", display:"flex", marginBottom:10 }}><Layers size={32} color="#0ea5e9" /></div>
            <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
            <p style={{ color:"#475569", fontSize:13, fontWeight:500 }}>Loading {meta.name} · Week {weekIndex + 1} · {year}…</p>
          </div>
        )}

        <MapContainer bounds={[[20.70, 78.65], [21.58, 79.70]]} zoom={10} style={{ width:"100%", height:"100vh" }} zoomControl={false} maxZoom={18} minZoom={7}>
          <MapInstance setMap={() => {}} />
          <BasemapTiles mapType={mapType} />
          <OnDemandGeoTiffLayer
            year={year}
            weekIndex={weekIndex}
            activeLayer={activeLayer}
            onMetadata={handleMetadata}
            onWeekBandsLoaded={handleBandsLoaded}
            onStatsUpdated={handleStats}
            onAnnualMeansUpdated={handleAnnualMeans}
            onMockMode={setIsMockMode}
          />
          {currentBand && tiffWidth > 0 && tiffHeight > 0 && tiffBbox.length === 4 && (
            <CanvasLayer band={currentBand} width={tiffWidth} height={tiffHeight} bbox={tiffBbox} minVal={bandMin} maxVal={bandMax} layerType={activeLayer} />
          )}
          <NagpurBoundaryLayer />
          <HoverTooltip currentWeekBands={currentWeekBands} width={tiffWidth} height={tiffHeight} bbox={tiffBbox} weekIndex={weekIndex} year={year} annualMeans={annualMeans} activeLayer={activeLayer} />
          <MapControls mapType={mapType} setMapType={setMapType} />
        </MapContainer>

        {/* Layer Switcher */}
        <div style={{ position:"absolute", top:16, left:infoOpen?356:16, zIndex:700, transition:"left 0.22s cubic-bezier(0.22,1,0.36,1)" }}>
          <div style={{ background:"rgba(255,255,255,0.97)", border:"1px solid #e5e7eb", borderRadius:14, boxShadow:"0 4px 20px rgba(0,0,0,0.10)", padding:"6px 8px", display:"flex", flexDirection:"column", gap:0, minWidth:110 }}>
            <button onClick={() => setLayerOpen(o => !o)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:6, padding:"5px 4px 6px", background:"transparent", border:"none", cursor:"pointer", width:"100%", borderRadius:8 }}
              onMouseEnter={e=>(e.currentTarget.style.background="#f8fafc")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:15, lineHeight:1 }}>{LAYER_META[activeLayer].emoji}</span>
                <span style={{ fontSize:11, fontWeight:700, color:LAYER_ACTIVE_COLORS[activeLayer].text, whiteSpace:"nowrap" }}>{LAYER_META[activeLayer].label}</span>
              </div>
              <svg width={12} height={12} viewBox="0 0 12 12" fill="none" style={{ transition:"transform 0.2s", transform:layerOpen?"rotate(180deg)":"rotate(0deg)", flexShrink:0 }}>
                <path d="M2 4l4 4 4-4" stroke="#9ca3af" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {layerOpen && (
              <div style={{ display:"flex", flexDirection:"column", gap:2, marginTop:2, borderTop:"1px solid #f1f5f9", paddingTop:6 }}>
                {LAYER_ORDER.filter(l => l !== activeLayer).map(layer => {
                  const lm = LAYER_META[layer]; const ac = LAYER_ACTIVE_COLORS[layer];
                  return (
                    <button key={layer} onClick={() => { setActiveLayer(layer); setLayerOpen(false); }} title={lm.name}
                      style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 8px", borderRadius:9, border:"1px solid transparent", background:"transparent", cursor:"pointer", transition:"all 0.15s", width:"100%" }}
                      onMouseEnter={e=>{(e.currentTarget as HTMLButtonElement).style.background=ac.bg; (e.currentTarget as HTMLButtonElement).style.border=`1px solid ${ac.border}`;}}
                      onMouseLeave={e=>{(e.currentTarget as HTMLButtonElement).style.background="transparent"; (e.currentTarget as HTMLButtonElement).style.border="1px solid transparent";}}>
                      <span style={{ fontSize:15, lineHeight:1, flexShrink:0 }}>{lm.emoji}</span>
                      <span style={{ fontSize:10.5, fontWeight:500, color:"#6b7280", whiteSpace:"nowrap" }}>{lm.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Info button */}
        <div style={{ position:"absolute", bottom:220, left:infoOpen?356:16, zIndex:700, transition:"left 0.22s cubic-bezier(0.22,1,0.36,1)" }}>
          <button onClick={() => setInfoOpen(o => !o)} title="Layer Information"
            style={{ width:38, height:38, background:infoOpen?info.accentColor:"#fff", border:`1.5px solid ${infoOpen?info.accentColor:"#e5e7eb"}`, borderRadius:10, boxShadow:"0 4px 16px rgba(0,0,0,0.10)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.18s" }}>
            <Info size={16} color={infoOpen?"#fff":info.accentColor} />
          </button>
        </div>

        {/* Mock mode warning */}
        {isMockMode && !loading && (
          <div style={{ position:"absolute", top:56, left:"50%", transform:"translateX(-50%)", zIndex:650, pointerEvents:"none" }}>
            <div style={{ background:"rgba(251,191,36,0.97)", border:"1px solid #f59e0b", borderRadius:999, padding:"4px 14px", boxShadow:"0 2px 8px rgba(0,0,0,0.10)", display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ fontSize:12 }}>⚠️</span>
              <span style={{ fontSize:11, fontWeight:700, color:"#92400e" }}>Demo/simulated data — place <code style={{fontFamily:"monospace",fontSize:10}}>/Nagpur_Weekly_{year}.tif</code> in public folder</span>
            </div>
          </div>
        )}

        {/* Status pill */}
        <div style={{ position:"absolute", top:60, left:"50%", transform:"translateX(-50%)", zIndex:600, pointerEvents:"none" }}>
          <div style={{ background:"rgba(255,255,255,0.95)", border:"1px solid #e5e7eb", borderRadius:999, padding:"5px 14px", boxShadow:"0 2px 12px rgba(0,0,0,0.08)", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:meta.dotColor, display:"inline-block" }} />
            <span style={{ fontSize:11.5, fontWeight:600, color:"#374151" }}>{meta.emoji} {meta.name}</span>
            <span style={{ fontSize:10, color:"#9ca3af" }}>· {meta.desc}</span>
            <span style={{ fontSize:10, color:"#9ca3af" }}>· Week {weekIndex + 1} · {formatDateShort(d1)}–{formatDateShort(d2)}</span>
            {realStats && activeLayer === "lst" && (
              <span style={{ fontSize:10, color:"#f97316", fontWeight:600 }}>· {realStats.avg.toFixed(1)}°C avg</span>
            )}
          </div>
        </div>

        <YearTimeline year={year} setYear={setYear} weekIndex={weekIndex} setWeekIndex={setWeekIndex} />
        <LayerLegend activeLayer={activeLayer} />
        <WeekNavigator weekIndex={weekIndex} year={year} setWeekIndex={setWeekIndex} setYear={setYear} />
      </div>

      {/* Analytics sidebar */}
      <aside style={{ width:272, flexShrink:0, display:"flex", flexDirection:"column", background:"#f8fafc", borderLeft:"1px solid #e5e7eb", overflowY:"auto", zIndex:10 }}>
        <div style={{ padding:"18px 16px 12px", borderBottom:"1px solid #e5e7eb", background:"#fff" }}>
          <p style={{ fontSize:13, fontWeight:700, color:"#111827" }}>Analytics</p>
          <p style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>Nagpur District · {year}{realStats && <span style={{ color:"#22c55e", fontWeight:700 }}> · {isMockMode ? "⚠️ Simulated" : "Live ✓"}</span>}</p>
        </div>
        <div style={{ padding:"12px 12px 20px" }}>
          <AnalyticsContent stats={realStats} activeLayer={activeLayer} weekIndex={weekIndex} year={year} annualMeans={annualMeans} />
        </div>
      </aside>
    </div>
  );
}