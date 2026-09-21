/// 地球的幾何：把遮罩解回點、把經緯度投影到畫布。
///
/// 全部是純函式，沒有 canvas、沒有 React——可以單獨測，也可以在 worker 裡跑。
/// 用正交投影（orthographic）而不是透視投影：正交投影下地球的輪廓永遠是正圓，
/// 不會因為視距而變形，而且每個點的縮放係數都一樣，柱子的長度才有可比性。

import {
  GLOBE_GRID_B64, GLOBE_GRID_COLS, GLOBE_GRID_LAT0, GLOBE_GRID_LON0, GLOBE_GRID_ROWS,
  GLOBE_GRID_STEP, GLOBE_REGIONS_B64, GLOBE_REGION_COUNTS, GLOBE_TRACKED,
} from "./globe-mask";

export type Dot = {
  /// 單位球面上的座標
  x: number; y: number; z: number;
  /// -1 = 一般陸地，其餘是 GLOBE_TRACKED 的索引
  region: number;
};

/// 底圖抽稀：每 BASE_POOL 格取一個點。
///
/// 0.6 度的格子在赤道上約 67 公里，整顆球鋪滿是三萬六千個點——畫得出來，
/// 但每一幀都要轉三萬六千次矩陣再畫三萬六千個圓，手機上就掉幀了。
/// 取 2 得到 1.2 度（約 133 公里），九千多個點，跟抽稀前的形狀一樣認得出來。
const BASE_POOL = 2;

/// 一塊最多跨幾格經度。純按 1/cos(緯度) 放大，到了南極圈一塊會寬達兩百多度——
/// 一個點代表半圈地球，放在哪裡都是錯的。極區因此比等面積該有的密一點，
/// 那是刻意的：那裡本來就只是背景。
const MAX_SPAN = 30;

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

/// 解出整顆地球的點。底圖是經緯格點抽稀後的結果，轄區用存下來的經緯度。
export async function buildDots(): Promise<Dot[]> {
  const [gridRaw, regionRaw] = await Promise.all([
    inflate(b64ToBytes(GLOBE_GRID_B64)),
    inflate(b64ToBytes(GLOBE_REGIONS_B64)),
  ]);
  const grid = rleDecode(gridRaw, GLOBE_GRID_ROWS * GLOBE_GRID_COLS);

  const dots: Dot[] = [];
  for (let r = 0; r < GLOBE_GRID_ROWS; r += BASE_POOL) {
    const rows = Math.min(BASE_POOL, GLOBE_GRID_ROWS - r);
    const lat = GLOBE_GRID_LAT0 + (r + (rows - 1) / 2) * GLOBE_GRID_STEP;
    // 等經度間距在高緯度會擠成一團——極區的一度只有赤道的幾十分之一寬。
    // 除以 cos(緯度) 把經度方向拉開，點在**地表上**才是等距的。
    const cos = Math.max(Math.cos((lat * Math.PI) / 180), 1e-3);
    const span = Math.max(1, Math.min(MAX_SPAN, Math.round(BASE_POOL / cos)));
    for (let c = 0; c < GLOBE_GRID_COLS; c += span) {
      const cols = Math.min(span, GLOBE_GRID_COLS - c);
      // 整塊裡只要有一格是陸地就留一個點，位置取塊內**離中心最近的那一格陸地**。
      //
      // 兩件事各有原因。只看每 span 格的那一格就丟掉其餘的話，日本、中美洲、
      // 島鏈這種一格寬的地形會整段消失——地圖上不見一個國家，比密度不均難看得多。
      // 而點放在塊的幾何中心、不管那裡是不是陸地的話，海岸線會往海裡糊出去半塊，
      // 在極區（一塊很寬）甚至會把點放到外海。
      let best = -1, bestD = Infinity;
      const mid = (cols - 1) / 2;
      for (let dc = 0; dc < cols; dc++) {
        const d = Math.abs(dc - mid);
        if (d >= bestD) continue;
        for (let dr = 0; dr < rows; dr++) {
          if (grid[(r + dr) * GLOBE_GRID_COLS + c + dc]) { best = dc; bestD = d; break; }
        }
      }
      if (best < 0) continue;
      const lon = GLOBE_GRID_LON0 + (c + best) * GLOBE_GRID_STEP;
      const [x, y, z] = lonLatToXyz(lon, lat);
      dots.push({ x, y, z, region: -1 });
    }
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
