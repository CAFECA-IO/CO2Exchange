#!/usr/bin/env python3
"""產生地球點陣：底圖的陸地輪廓，以及九個轄區各自的色塊。

**為什麼分成兩層。** 均勻取樣的球面點陣畫得出澳洲，畫不出臺灣——
要讓臺灣拿到看得出形狀的點數，全球得鋪到六位數個點，那既跑不動也送不動。
所以底圖只負責「哪裡是陸地」，每個轄區另外用自己的密度取樣：
大國疏、小國密，每一國都拿到看得出形狀的一塊，而不是一個圓點。

輸出兩個編碼字串：
  GLOBE_GRID_B64    底圖。0.6 度的經緯格點，每一格只回答「是不是陸地」。
                    RLE + deflate，列優先（同一列相鄰的格子多半同為海或同為陸，
                    行優先會把每一段都切斷，壓出來大三成）。
  GLOBE_REGIONS_B64 各轄區的點，經緯度量化到 1/100 度存成 int16。

底圖為什麼是格點而不是費波那契球面：費波那契點的位置是算出來的，
海陸判斷交給程式庫（global_land_mask），實際畫出來的海岸線就是那個程式庫的解析度，
沒辦法拿一份地圖去核對。格點的每一格都在檔案裡，要對照真實世界是一件可以做的事。

來源：
  scripts/world-land-0.6deg.json.gz  0.6 度陸地格點（底圖）
  Natural Earth 1:50m 國界           各轄區的輪廓
用法：python3 scripts/gen-globe-mask.py <world-atlas 目錄> \
        [scripts/world-land-0.6deg.json.gz] > lib/globe-mask.ts
"""
import sys, os, json, math, gzip, base64, zlib
import numpy as np
from matplotlib.path import Path

# 追蹤的轄區，順序要跟前端的 JURISDICTIONS 一致。
# target = 希望這一國拿到幾個點：大到看得出形狀，小到不會糊成一塊。
TRACKED = [
    ("TW", 158, 150), ("JP", 392, 260), ("KR", 410, 150), ("TH", 764, 200),
    ("ID", 360, 340), ("AU", 36, 340), ("CN", 156, 340), ("IN", 356, 300),
    ("SG", 702, 90),
]

# 底圖格點。lat 由 LAT0 往北每 STEP 一列，lon 由 LON0 往東每 STEP 一行。
GRID_STEP = 0.6
GRID_LAT0, GRID_ROWS = -89.7, 289
GRID_LON0, GRID_COLS = -179.7, 600
DEFAULT_GRID = os.path.join(os.path.dirname(__file__), "world-land-0.6deg.json.gz")

def topo_decode(topo, obj_name):
    tr = topo["transform"]; sx, sy = tr["scale"]; dx, dy = tr["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0; pts = []
        for ax, ay in arc:
            x += ax; y += ay
            pts.append((x * sx + dx, y * sy + dy))
        arcs.append(pts)
    def ring(idxs):
        out = []
        for i in idxs:
            a = arcs[~i][::-1] if i < 0 else arcs[i]
            out.extend(a if not out else a[1:])
        return out
    out = {}
    for g in topo["objects"][obj_name]["geometries"]:
        gid = g.get("id")
        if gid is None: continue
        rings = []
        if g["type"] == "Polygon":
            rings = [ring(r) for r in g["arcs"]]
        elif g["type"] == "MultiPolygon":
            for poly in g["arcs"]: rings.extend(ring(r) for r in poly)
        out.setdefault(str(int(gid)), []).extend(rings)
    return out

def load_grid(path):
    """把 [{lat, lng}, ...] 讀成 ROWS×COLS 的 0/1 陣列。

    來源檔是一份「哪些 0.6 度格子是陸地」的清單，沒有順序也沒有結構；
    落在格線以外的座標代表檔案跟這裡假設的格線不同，寧可停下來也不要默默四捨五入
    ——那會讓海岸線整體偏移半格，而畫面上看起來只是「有點怪」。
    """
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        pts = json.load(f)
    g = np.zeros((GRID_ROWS, GRID_COLS), np.uint8)
    for p in pts:
        fr = (p["lat"] - GRID_LAT0) / GRID_STEP
        fc = (p["lng"] - GRID_LON0) / GRID_STEP
        r, c = round(fr), round(fc)
        if abs(fr - r) > 1e-6 or abs(fc - c) > 1e-6:
            raise SystemExit(f"座標不在 {GRID_STEP} 度格線上：{p}")
        if not (0 <= r < GRID_ROWS and 0 <= c < GRID_COLS):
            raise SystemExit(f"座標超出格線範圍：{p}")
        g[r, c] = 1
    return g

def sample_country(rings, target):
    """在多邊形內取樣到接近 target 個點。經度間距依緯度放大，讓點在地表上等距。"""
    allp = np.vstack([np.array(r) for r in rings])
    lo0, la0 = allp[:, 0].min(), allp[:, 1].min()
    lo1, la1 = allp[:, 0].max(), allp[:, 1].max()
    paths = [Path(np.array(r)) for r in rings if len(r) >= 4]
    step = max(la1 - la0, lo1 - lo0) / 12 or 0.1
    best = np.empty((0, 2))
    for _ in range(40):
        lats = np.arange(la0, la1 + step, step)
        rows = []
        for la in lats:
            k = max(math.cos(math.radians(la)), 0.15)
            lons = np.arange(lo0, lo1 + step / k, step / k)
            rows.append(np.column_stack([lons, np.full(len(lons), la)]))
        pts = np.vstack(rows) if rows else np.empty((0, 2))
        if len(pts) > 400000: break
        inside = np.zeros(len(pts), dtype=bool)
        for p in paths: inside |= p.contains_points(pts)
        got = pts[inside]
        if len(got) >= len(best): best = got
        if len(got) >= target: return got
        step *= 0.78
    return best

# 底圖自我檢查。格線對齊了不代表內容是對的——來源檔若南北顛倒或經度差 180 度，
# 每一格都還是落在格線上，畫出來也還是一顆有大陸的球，只是那不是地球。
# 各挑幾個一定是陸地、一定是海的地方，錯了就停下來。
SPOT_LAND = [
    ("臺北", 25.0, 121.5), ("東京", 35.7, 139.7), ("新加坡", 1.35, 103.8),
    ("雪梨", -33.9, 151.2), ("開羅", 30.0, 31.2), ("聖保羅", -23.5, -46.6),
    ("芝加哥", 41.9, -87.6), ("巴黎", 48.9, 2.35), ("南極點", -89.5, 0.0),
]
SPOT_SEA = [
    ("北太平洋", 30.0, -160.0), ("南太平洋", -30.0, -120.0), ("南大西洋", -30.0, -20.0),
    ("印度洋", -20.0, 80.0), ("北冰洋", 88.0, 0.0), ("孟加拉灣", 15.0, 88.0),
]

def check_grid(g):
    def at(la, lo):
        r = round((la - GRID_LAT0) / GRID_STEP); c = round((lo - GRID_LON0) / GRID_STEP)
        r = min(max(r, 0), GRID_ROWS - 1); c = min(max(c, 0), GRID_COLS - 1)
        # 容一格：0.6 度的格子放不下新加坡，城市座標落在隔壁格是正常的
        return g[max(0, r-1):r+2, max(0, c-1):c+2].any()
    bad = [f"{n} 應該是陸地" for n, la, lo in SPOT_LAND if not at(la, lo)]
    bad += [f"{n} 應該是海" for n, la, lo in SPOT_SEA if at(la, lo)]
    if bad:
        raise SystemExit("底圖對不上真實世界：" + "、".join(bad))

def rle_encode(vals):
    out = bytearray(); prev, run = vals[0], 0
    def flush(v, r):
        out.append(v & 0x0F)
        while True:
            b = r & 0x7F; r >>= 7
            out.append(b | (0x80 if r else 0))
            if not r: break
    for v in vals:
        if v == prev: run += 1
        else: flush(prev, run); prev, run = v, 1
    flush(prev, run)
    return bytes(out)

def b64z(b): return base64.b64encode(zlib.compress(b, 9)).decode()

def main():
    topo = json.load(open(f"{sys.argv[1]}/countries-50m.json"))
    polys = topo_decode(topo, "countries")

    grid = load_grid(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_GRID)
    check_grid(grid)
    grid_b64 = b64z(rle_encode(grid.flatten().tolist()))
    print(f"# 底圖 {GRID_ROWS}×{GRID_COLS} 格，陸地 {int(grid.sum())} 格，"
          f"{len(grid_b64)} 字元", file=sys.stderr)

    counts, buf = [], bytearray()
    for code, iso, target in TRACKED:
        rings = polys.get(str(iso))
        if not rings:
            print(f"# 找不到 {code} (ISO {iso})", file=sys.stderr); counts.append(0); continue
        pts = sample_country(rings, target)
        q = np.round(pts * 100).astype(np.int16)  # lon, lat 各 1/100 度
        buf.extend(q.astype("<i2").tobytes())
        counts.append(len(q))
        print(f"# {code}: {len(q)} 點", file=sys.stderr)
    reg_b64 = b64z(bytes(buf))
    print(f"# 轄區共 {sum(counts)} 點，{len(reg_b64)} 字元", file=sys.stderr)

    codes = ", ".join(f'"{c}"' for c, _, _ in TRACKED)
    def wrap(s, w=100):
        return "\n".join('  "' + s[i:i+w] + '" +' for i in range(0, len(s), w))[:-2].rstrip()
    print(f'''/// 地球點陣——由 scripts/gen-globe-mask.py 產生，請勿手改。
///
/// 分成兩層是有原因的。均勻取樣的球面點陣畫得出澳洲，畫不出臺灣——
/// 要讓臺灣拿到看得出形狀的點數，全球得鋪到六位數個點，那既跑不動也送不動。
/// 所以底圖只負責陸地輪廓，每個轄區另外用自己的密度取樣：大國疏、小國密，
/// 每一國都是看得出形狀的一塊，而不是一個圓點。
///
/// 底圖是 {GRID_STEP} 度的經緯格點，一格一個位元，只回答「這一格是不是陸地」——
/// {GRID_ROWS}×{GRID_COLS} 格因此只花 {len(grid_b64)} 個字元。座標不存，
/// 前端用下面四個常數從索引算回經緯度。畫面上要幾個點是**顯示**的事，
/// 在 lib/globe.ts 抽稀，不在這裡先砍掉——資料留全份，才對得上地圖。
///
/// 來源：0.6 度陸地格點（scripts/world-land-0.6deg.json.gz）、
///       Natural Earth 1:50m 國界，皆為公有領域。

/// 底圖格線：第 (r, c) 格的中心是 (GLOBE_GRID_LAT0 + r×STEP, GLOBE_GRID_LON0 + c×STEP)。
export const GLOBE_GRID_STEP = {GRID_STEP};
export const GLOBE_GRID_LAT0 = {GRID_LAT0};
export const GLOBE_GRID_LON0 = {GRID_LON0};
export const GLOBE_GRID_ROWS = {GRID_ROWS};
export const GLOBE_GRID_COLS = {GRID_COLS};

export const GLOBE_TRACKED = [{codes}] as const;
/// 每一國的點數，順序同 GLOBE_TRACKED；用來把 GLOBE_REGIONS 切成九段。
export const GLOBE_REGION_COUNTS = {counts};

/// RLE + deflate + base64 的陸地位元圖，列優先（由南到北，每列由西到東）。
export const GLOBE_GRID_B64 =
{wrap(grid_b64)};

/// 各轄區的點，(lon, lat) 各量化到 1/100 度的 int16，小端序。
export const GLOBE_REGIONS_B64 =
{wrap(reg_b64)};
''')

main()
