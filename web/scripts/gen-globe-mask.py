#!/usr/bin/env python3
"""產生地球點陣：底圖的陸地輪廓，以及九個轄區各自的色塊。

**為什麼分成兩層。** 均勻取樣的球面點陣畫得出澳洲，畫不出臺灣——
要讓臺灣拿到看得出形狀的點數，全球得鋪到六位數個點，那既跑不動也送不動。
所以底圖只負責「哪裡是陸地」，每個轄區另外用自己的密度取樣：
大國疏、小國密，每一國都拿到看得出形狀的一塊，而不是一個圓點。

輸出兩個編碼字串：
  GLOBE_MASK_B64    底圖。沒有座標——前端用同一條費波那契球面公式把索引還原成
                    經緯度，這張表只回答第 i 點是不是陸地。RLE + deflate。
  GLOBE_REGIONS_B64 各轄區的點，經緯度量化到 1/100 度存成 int16。

來源：Natural Earth 1:50m 國界、GLOBE 地形陸海遮罩，皆為公有領域。
用法：python3 scripts/gen-globe-mask.py <world-atlas 目錄> > lib/globe-mask.ts
"""
import sys, json, math, base64, zlib
import numpy as np
from matplotlib.path import Path
from global_land_mask import globe as glm

# 追蹤的轄區，順序要跟前端的 JURISDICTIONS 一致。
# target = 希望這一國拿到幾個點：大到看得出形狀，小到不會糊成一塊。
TRACKED = [
    ("TW", 158, 150), ("JP", 392, 260), ("KR", 410, 150), ("TH", 764, 200),
    ("ID", 360, 340), ("AU", 36, 340), ("CN", 156, 340), ("IN", 356, 300),
    ("SG", 702, 90),
]
N_BASE = 32000

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

def fibonacci_sphere(n):
    i = np.arange(n, dtype=np.float64)
    z = 1.0 - (2.0 * i + 1.0) / n
    lat = np.degrees(np.arcsin(z))
    ga = math.pi * (3.0 - math.sqrt(5.0))
    lon = np.degrees(((i * ga) % (2 * math.pi)) - math.pi)
    return lat, lon

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

    lat, lon = fibonacci_sphere(N_BASE)
    land = glm.is_land(np.clip(lat, -89.9, 89.9), lon).astype(np.uint8)
    mask_b64 = b64z(rle_encode(land.tolist()))
    print(f"# 底圖陸地 {int(land.sum())}/{N_BASE}，{len(mask_b64)} 字元", file=sys.stderr)

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
/// 底圖裡沒有座標。前端用同一條費波那契球面公式把索引還原成經緯度，
/// GLOBE_MASK 只回答「第 i 點是不是陸地」——{N_BASE} 個點因此只花 {len(mask_b64)} 個字元。
///
/// 來源：Natural Earth 1:50m 國界、GLOBE 地形陸海遮罩，皆為公有領域。

export const GLOBE_POINTS = {N_BASE};
export const GLOBE_TRACKED = [{codes}] as const;
/// 每一國的點數，順序同 GLOBE_TRACKED；用來把 GLOBE_REGIONS 切成九段。
export const GLOBE_REGION_COUNTS = {counts};

/// RLE + deflate + base64 的陸地位元圖。
export const GLOBE_MASK_B64 =
{wrap(mask_b64)};

/// 各轄區的點，(lon, lat) 各量化到 1/100 度的 int16，小端序。
export const GLOBE_REGIONS_B64 =
{wrap(reg_b64)};
''')

main()
