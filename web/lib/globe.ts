/// 地球的幾何：把點陣解回球面上的點、把經緯度投影到畫布。
///
/// 全部是純函式，沒有 canvas、沒有 React——可以單獨測，也可以在 worker 裡跑。
/// 用正交投影（orthographic）而不是透視投影：正交投影下地球的輪廓永遠是正圓，
/// 不會因為視距而變形，而且每個點的縮放係數都一樣，柱子的長度才有可比性。
///
/// 點陣在 lib/globe-dots.ts（scripts/gen-globe-dots.py 產生）：在真實地圖上按經緯度取樣，
/// 落在陸地上的取樣點就是一個點，每個點都記著它屬於哪一國。

import {
  GLOBE_COUNTRIES, GLOBE_EXTRA_B64, GLOBE_ROW_COUNTS, GLOBE_ROW_LAT0, GLOBE_SAMPLES_B64, GLOBE_STEP,
} from "./globe-dots.ts";

/// 國家表：索引 → [ISO 3166-1 alpha-2, 中文名]
export const COUNTRIES = GLOBE_COUNTRIES;

/// 整顆地球的點，欄位分開存成型別陣列：每一幀都要把三萬多個點轉一次，
/// 物件陣列會讓每一幀產生三萬多次屬性查找與垃圾回收的壓力。
export type DotField = {
  n: number;
  /// 單位球面上的座標
  x: Float32Array; y: Float32Array; z: Float32Array;
  /// 經緯度（度）
  lon: Float32Array; lat: Float32Array;
  /// 屬於 COUNTRIES 的第幾國
  country: Uint16Array;
};

function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/// 瀏覽器原生的 deflate 解壓。DecompressionStream 是非同步的，
/// 所以整個載入流程都是非同步的——這也剛好讓地球不會擋住首次繪製。
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "function") {
    const ds = new DecompressionStream("deflate");
    const buf = await new Response(
      new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds),
    ).arrayBuffer();
    return new Uint8Array(buf);
  }
  const { inflateSync } = await import("node:zlib");
  return new Uint8Array(inflateSync(bytes));
}

/// (值, 長度) 一組：值一個位元組，長度是 7 位元一組的變長整數。
export function rleDecode(buf: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0, p = 0;
  while (p < buf.length && i < n) {
    const v = buf[p++];
    let run = 0, shift = 0;
    for (;;) {
      const b = buf[p++];
      run |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const end = Math.min(i + run, n);
    if (v) out.fill(v, i, end);
    i = end;
  }
  return out;
}

function lonLatToXyz(lonDeg: number, latDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const c = Math.cos(lat);
  // y 朝上（北極），z 朝向鏡頭時經度 0 在正中間
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)];
}

/// 解出整顆地球的點：取樣點（落在陸地上的）＋取樣拿不到的小國補點。
export async function buildDots(): Promise<DotField> {
  const total = GLOBE_ROW_COUNTS.reduce((a, b) => a + b, 0);
  const [sampleRaw, extraRaw] = await Promise.all([
    inflate(b64ToBytes(GLOBE_SAMPLES_B64)),
    GLOBE_EXTRA_B64 ? inflate(b64ToBytes(GLOBE_EXTRA_B64)) : Promise.resolve(new Uint8Array()),
  ]);
  const owner = rleDecode(sampleRaw, total);

  let land = 0;
  for (let i = 0; i < total; i++) if (owner[i]) land++;
  const nExtra = Math.floor(extraRaw.length / 5);
  const n = land + nExtra;
  const f: DotField = {
    n,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    lon: new Float32Array(n), lat: new Float32Array(n), country: new Uint16Array(n),
  };
  const put = (k: number, lon: number, lat: number, idx: number) => {
    const [x, y, z] = lonLatToXyz(lon, lat);
    f.x[k] = x; f.y[k] = y; f.z[k] = z; f.lon[k] = lon; f.lat[k] = lat; f.country[k] = idx;
  };

  let s = 0, k = 0;
  GLOBE_ROW_COUNTS.forEach((count, r) => {
    const lat = GLOBE_ROW_LAT0 + r * GLOBE_STEP;
    for (let j = 0; j < count; j++, s++) {
      const v = owner[s];
      if (v) put(k++, -180 + ((j + 0.5) * 360) / count, lat, v - 1);
    }
  });
  const view = new DataView(extraRaw.buffer, extraRaw.byteOffset, extraRaw.byteLength);
  for (let e = 0; e < nExtra; e++) {
    const off = e * 5;
    put(k++, view.getInt16(off, true) / 100, view.getInt16(off + 2, true) / 100, view.getUint8(off + 4) - 1);
  }
  return f;
}

/// 這個經緯度落在哪一國：取最近的點（在 maxKm 以內），沒有就是海。
/// 點陣的間距約 67 公里，所以預設容許一個間距。
export function countryAt(f: DotField, lonDeg: number, latDeg: number, maxKm = 70): string | null {
  const [px, py, pz] = lonLatToXyz(lonDeg, latDeg);
  let best = -1, bestDot = Math.cos(maxKm / 6371);
  for (let i = 0; i < f.n; i++) {
    const d = f.x[i] * px + f.y[i] * py + f.z[i] * pz;
    if (d > bestDot) { bestDot = d; best = i; }
  }
  return best < 0 ? null : COUNTRIES[f.country[best]][0];
}

export type Camera = {
  /// 自轉角（弧度）。往東轉，跟地球一致。
  yaw: number;
  /// 傾角。正值把北半球轉向鏡頭。
  pitch: number;
};

/// 旋轉後的座標。z > 0 表示在朝向鏡頭的那一面。
export function rotate(d: { x: number; y: number; z: number }, cam: Camera) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const x1 = d.x * cy + d.z * sy;
  const z1 = -d.x * sy + d.z * cy;
  const y2 = d.y * cp - z1 * sp;
  const z2 = d.y * sp + z1 * cp;
  return { x: x1, y: y2, z: z2 };
}

export function lonLatToUnit(lonDeg: number, latDeg: number) {
  const [x, y, z] = lonLatToXyz(lonDeg, latDeg);
  return { x, y, z };
}

/// 把某一點轉到正對鏡頭所需的 yaw。用在「點清單裡的國家，地球轉過去」。
export function yawFor(lonDeg: number): number {
  return -(lonDeg * Math.PI) / 180;
}
