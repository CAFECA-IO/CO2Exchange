/// 地球的幾何：把遮罩解回點、把經緯度投影到畫布。
///
/// 全部是純函式，沒有 canvas、沒有 React——可以單獨測，也可以在 worker 裡跑。
/// 用正交投影（orthographic）而不是透視投影：正交投影下地球的輪廓永遠是正圓，
/// 不會因為視距而變形，而且每個點的縮放係數都一樣，柱子的長度才有可比性。

import {
  GLOBE_MASK_B64, GLOBE_POINTS, GLOBE_REGIONS_B64, GLOBE_REGION_COUNTS, GLOBE_TRACKED,
} from "./globe-mask";

export type Dot = {
  /// 單位球面上的座標
  x: number; y: number; z: number;
  /// -1 = 一般陸地，其餘是 GLOBE_TRACKED 的索引
  region: number;
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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

function rleDecode(buf: Uint8Array, n: number): Uint8Array {
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

/// 解出整顆地球的點。底圖用費波那契球面還原座標，轄區用存下來的經緯度。
export async function buildDots(): Promise<Dot[]> {
  const [maskRaw, regionRaw] = await Promise.all([
    inflate(b64ToBytes(GLOBE_MASK_B64)),
    inflate(b64ToBytes(GLOBE_REGIONS_B64)),
  ]);
  const mask = rleDecode(maskRaw, GLOBE_POINTS);

  const dots: Dot[] = [];
  for (let i = 0; i < GLOBE_POINTS; i++) {
    if (!mask[i]) continue;
    const z = 1 - (2 * i + 1) / GLOBE_POINTS;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = i * GOLDEN_ANGLE;
    // 費波那契球面的 z 是「高度」，這裡對應到 y（北極朝上）
    dots.push({ x: r * Math.cos(theta), y: z, z: r * Math.sin(theta), region: -1 });
  }

  const view = new DataView(regionRaw.buffer, regionRaw.byteOffset, regionRaw.byteLength);
  let off = 0;
  GLOBE_REGION_COUNTS.forEach((count, region) => {
    for (let k = 0; k < count; k++) {
      const lon = view.getInt16(off, true) / 100;
      const lat = view.getInt16(off + 2, true) / 100;
      off += 4;
      const [x, y, z] = lonLatToXyz(lon, lat);
      dots.push({ x, y, z, region });
    }
  });
  return dots;
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

export const TRACKED = GLOBE_TRACKED;
