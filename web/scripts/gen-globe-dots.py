#!/usr/bin/env python3
"""產生首頁地球的點陣：在真實地圖上按經緯度取樣，落在陸地上的取樣點就是一個圓點，並記下它屬於哪一國。

**取樣。** 緯度每 STEP 度一列；每一列的經度間距是 STEP / cos(緯度)，讓點在**地表上**等距
（等經度間距在高緯度會擠成一團）。每一列有幾個取樣點寫進檔案，前端照抄，不重算——
Python 與 JavaScript 的四捨五入在 .5 上不一樣，重算就會在某幾列差一個點，整列錯位。

**判斷陸地與國家。** 每個取樣點拿去比對 Natural Earth 1:50m 的國界多邊形，落在哪一國就是哪一國，
都不在就是海。同一國的多個環用奇偶規則（洞要扣掉：南非的多邊形中間挖掉賴索托）。

**小國。** 取樣間距大於國土的國家（新加坡、太平洋島國）一個取樣點都拿不到。
地圖上少了一個國家比密度不均難看得多，所以這些國家另外補**一個**點，放在國土裡。
補點與取樣點分開存，看得出哪些是補的。

輸出（lib/globe-dots.ts）：
  GLOBE_STEP / GLOBE_ROW_LAT0 / GLOBE_ROW_COUNTS  取樣的格線：第 r 列的緯度與點數
  GLOBE_COUNTRIES                                 國家表：[ISO 3166-1 alpha-2, 中文名]；索引 0 保留給海
  GLOBE_SAMPLES_B64   每個取樣點屬於國家表的第幾國（0＝海），一點一個位元組，RLE + deflate + base64
  GLOBE_EXTRA_B64     補點：(lon, lat 各 1/100 度 int16, 國家索引 uint8)，deflate + base64

來源（皆為公有領域／MIT，從 npm 取）：
  world-atlas@2           Natural Earth 1:50m 國界（TopoJSON，id 是 ISO 3166-1 數字碼）
  i18n-iso-countries      數字碼 → 二位字母碼
  國名：Node 內建的 Intl.DisplayNames（zh-Hant-TW），再套本站用語（見 NAME_OVERRIDE）

用法：
  mkdir -p /tmp/geo && cd /tmp/geo && npm pack world-atlas@2 i18n-iso-countries && for f in *.tgz; do tar xzf "$f" --one-top-level; done
  python3 scripts/gen-globe-dots.py /tmp/geo/world-atlas-*/package /tmp/geo/i18n-iso-countries-*/package > lib/globe-dots.ts
"""
import sys, json, math, base64, zlib, subprocess
import numpy as np
from matplotlib.path import Path

STEP = 0.6  # 度。赤道上約 67 公里；全球約 11 萬個取樣點，其中三萬多個在陸地上

# Natural Earth 沒有給 ISO 數字碼的幾塊。放進最常見的歸屬；錫亞琴冰川是爭議地區，不歸給任何一國
NO_ID = {
    "Somaliland": "SO", "Kosovo": "XK", "N. Cyprus": "CY", "Indian Ocean Ter.": "AU",
    "Siachen Glacier": None,
}
# 本站用語（與各頁、條款一致）。Intl 的預設是「台灣」「南韓」「中國香港特別行政區」。
# 與 lib/country-names.ts 的 NAME_OVERRIDE 是同一份，改一邊要改另一邊
NAME_OVERRIDE = {
    "TW": "臺灣", "KR": "韓國", "KP": "北韓", "HK": "香港", "MO": "澳門", "PS": "巴勒斯坦",
}

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
    feats = []
    for g in topo["objects"][obj_name]["geometries"]:
        rings = []
        if g["type"] == "Polygon":
            rings = [ring(r) for r in g["arcs"]]
        elif g["type"] == "MultiPolygon":
            for poly in g["arcs"]: rings.extend(ring(r) for r in poly)
        if rings: feats.append((g.get("id"), g["properties"].get("name", ""), rings))
    return feats

def zh_names(codes):
    js = ("const d=new Intl.DisplayNames(['zh-Hant-TW'],{type:'region'});"
          "const c=JSON.parse(process.argv[1]);"
          "console.log(JSON.stringify(Object.fromEntries(c.map(x=>[x,d.of(x)]))))")
    out = subprocess.run(["node", "-e", js, json.dumps(codes)], capture_output=True, text=True, check=True)
    names = json.loads(out.stdout)
    names.update({k: v for k, v in NAME_OVERRIDE.items() if k in names})
    return names

def rows():
    """每一列的緯度與點數。點數 = 該緯度圈長 / STEP，至少一個（極點附近）。"""
    n_rows = round(180 / STEP)
    lat0 = -90 + STEP / 2
    out = []
    for r in range(n_rows):
        lat = lat0 + r * STEP
        n = max(1, int(round(360 * math.cos(math.radians(lat)) / STEP)))
        out.append((lat, n))
    return lat0, out

def row_lons(n):
    return -180 + (np.arange(n) + 0.5) * (360 / n)

def unwrap(ring):
    """把跨過換日線的環攤平成連續的經度（可能超出 ±180）。

    world-atlas 的環是球面上的環：俄羅斯本土從東經 130 度一路畫到 180、接著從 -180 繼續。
    拿平面的點在多邊形內判斷，那一跳會把整個北半球切錯。攤平之後經度連續，
    判斷時把取樣點也平移 ±360 度再試一次。

    繞著極點一圈的環（南極洲）攤平後頭尾差 360 度、不是封閉的——補兩個極點上的點把它封起來。
    """
    a = np.array(ring, dtype=float)
    lon = a[:, 0].copy()
    d = np.diff(lon)
    lon[1:] -= 360 * np.cumsum(np.round(d / 360))
    a[:, 0] = lon
    if abs(lon[-1] - lon[0]) > 180:
        pole = -90.0 if a[:, 1].mean() < 0 else 90.0
        a = np.vstack([a, [[lon[-1], pole], [lon[0], pole], [lon[0], a[0, 1]]]])
    return a

class Country:
    def __init__(self, code, rings):
        self.code = code
        self.rings = rings
        self.flat = [unwrap(r) for r in rings if len(r) >= 4]
        self.paths = [(Path(f), f[:, 0].min(), f[:, 1].min(), f[:, 0].max(), f[:, 1].max()) for f in self.flat]
    def contains(self, pts):
        """奇偶規則：落在奇數個環裡才算（洞要扣掉）。每個環都把取樣點平移 0、±360 度各試一次。"""
        res = np.zeros(len(pts), dtype=bool)
        for path, lo0, la0, lo1, la1 in self.paths:
            inside = np.zeros(len(pts), dtype=bool)
            for shift in (0.0, 360.0, -360.0):
                x = pts[:, 0] + shift
                m = (x >= lo0) & (x <= lo1) & (pts[:, 1] >= la0) & (pts[:, 1] <= la1)
                if not m.any(): continue
                sub = np.column_stack([x[m], pts[m, 1]])
                hit = np.zeros(len(pts), dtype=bool)
                hit[m] = path.contains_points(sub)
                inside |= hit
            res ^= inside
        return res
    def one_point(self):
        """國土裡的一個點：最大那一塊的格點中最靠近其中心的一個。"""
        big = max(self.rings, key=lambda r: abs(ring_area(r)))
        a = np.array(big); path = Path(a)
        lo0, la0 = a.min(0); lo1, la1 = a.max(0)
        cx, cy = (lo0 + lo1) / 2, (la0 + la1) / 2
        for k in (20, 60, 200):
            xs = np.linspace(lo0, lo1, k); ys = np.linspace(la0, la1, k)
            g = np.array([(x, y) for y in ys for x in xs])
            inside = g[path.contains_points(g)]
            if len(inside):
                return inside[np.argmin((inside[:, 0] - cx) ** 2 + (inside[:, 1] - cy) ** 2)]
        return a.mean(0)

def ring_area(r):
    a = np.array(r); x, y = a[:, 0], a[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))

# 自我檢查：資料南北顛倒、經度差 180 度、或國界與代碼對錯，畫出來還是一顆有大陸的球，
# 只是那不是地球。挑幾個一定在某國、一定是海的地方，錯了就停下來。
SPOT = [
    ("臺北", 25.03, 121.56, "TW"), ("高雄", 22.63, 120.30, "TW"), ("東京", 35.68, 139.69, "JP"),
    ("首爾", 37.57, 126.98, "KR"), ("曼谷", 13.75, 100.50, "TH"), ("雅加達", -6.2, 106.85, "ID"),
    ("雪梨", -33.87, 151.21, "AU"), ("北京", 39.9, 116.4, "CN"), ("新德里", 28.61, 77.21, "IN"),
    ("莫斯科", 55.76, 37.62, "RU"), ("楚科奇", 66.0, -172.0, "RU"), ("斐濟", -17.8, 178.0, "FJ"),
    ("賴索托", -29.5, 28.2, "LS"), ("約翰尼斯堡", -26.2, 28.05, "ZA"), ("開羅", 30.04, 31.24, "EG"),
    ("聖保羅", -23.55, -46.63, "BR"), ("芝加哥", 41.88, -87.63, "US"), ("巴黎", 48.86, 2.35, "FR"),
    ("南極點附近", -89.0, 0.0, "AQ"),
    ("北太平洋", 30.0, -160.0, None), ("南大西洋", -30.0, -20.0, None), ("印度洋", -20.0, 80.0, None),
    ("臺灣海峽", 24.3, 119.6, None),
]

def main():
    atlas, iso_dir = sys.argv[1], sys.argv[2]
    topo = json.load(open(f"{atlas}/countries-50m.json"))
    num2a2 = {row[2]: row[0] for row in json.load(open(f"{iso_dir}/codes.json"))}

    # 同一個代碼的多塊合在一起（澳洲本土與阿什莫爾－卡地爾群島都是 036）
    by_code = {}
    for gid, name, rings in topo_decode(topo, "countries"):
        code = num2a2.get(gid) if gid is not None else NO_ID.get(name, "?")
        if code == "?": raise SystemExit(f"不知道 {name}（id {gid}）是哪一國，請加進 NO_ID")
        if code is None: continue
        by_code.setdefault(code, []).extend(rings)
    codes = sorted(by_code)
    if len(codes) > 255: raise SystemExit("國家超過 255 個，一個位元組放不下")
    names = zh_names(codes)
    countries = {c: Country(c, by_code[c]) for c in codes}
    index = {c: i + 1 for i, c in enumerate(codes)}  # 0 = 海

    lat0, rs = rows()
    pts = np.vstack([np.column_stack([row_lons(n), np.full(n, lat)]) for lat, n in rs])
    owner = np.zeros(len(pts), dtype=np.uint8)
    for c in codes:
        hit = countries[c].contains(pts) & (owner == 0)
        owner[hit] = index[c]
    print(f"# 取樣 {len(pts)} 點，陸地 {int((owner > 0).sum())} 點，{len(codes)} 國", file=sys.stderr)

    # 自我檢查用最近的取樣點，容許一格的誤差（新加坡比一格還小）
    def lookup(la, lo):
        d = (pts[:, 1] - la) ** 2 + ((pts[:, 0] - lo) * math.cos(math.radians(la))) ** 2
        near = np.argsort(d)[:4]  # 海岸城市（曼谷、雪梨）最近的取樣點可能剛好在海上
        return {codes[owner[i] - 1] if owner[i] else None for i in near}
    bad = [f"{n} 應該是 {want or '海'}，附近的取樣點是 {sorted(map(str, lookup(la, lo)))}"
           for n, la, lo, want in SPOT if want not in lookup(la, lo) or (want is None and len(lookup(la, lo)) > 1)]
    if bad: raise SystemExit("點陣對不上真實世界：" + "；".join(bad))

    present = set(int(v) for v in np.unique(owner) if v)
    extra = bytearray()
    added = []
    for c in codes:
        if index[c] in present: continue
        lon, lat = countries[c].one_point()
        extra += np.array([round(lon * 100), round(lat * 100)], dtype="<i2").tobytes() + bytes([index[c]])
        added.append(c)
    print(f"# 取樣點拿不到的 {len(added)} 國各補一點：{' '.join(added)}", file=sys.stderr)

    samples_b64 = b64z(rle_encode(owner.tolist()))
    extra_b64 = b64z(bytes(extra))
    counts_per = {c: int((owner == index[c]).sum()) for c in ("TW", "JP", "KR", "TH", "ID", "AU", "CN", "IN", "SG")}
    print(f"# 轄區點數 {counts_per}；取樣 {len(samples_b64)} 字元，補點 {len(extra_b64)} 字元", file=sys.stderr)

    table = ",\n".join(f'  ["{c}", "{names.get(c, c)}"]' for c in codes)
    def wrap(s, w=100):
        return "\n".join('  "' + s[i:i+w] + '" +' for i in range(0, len(s), w))[:-2].rstrip()
    print(f'''/// 首頁地球的點陣——由 scripts/gen-globe-dots.py 產生，請勿手改。
///
/// 在真實地圖上按經緯度取樣：緯度每 {STEP} 度一列，經度間距 {STEP}/cos(緯度)（點在地表上等距）。
/// 取樣點落在某一國的國界裡，就是一個屬於那一國的圓點；都不在就是海，不畫。
/// 國土比取樣間距小、一個取樣點都拿不到的國家另外補一點（GLOBE_EXTRA_B64）。
///
/// 來源：Natural Earth 1:50m 國界（world-atlas@2），國名取 Intl.DisplayNames（zh-Hant-TW）並套本站用語。

export const GLOBE_STEP = {STEP};
/// 第 r 列的緯度 = GLOBE_ROW_LAT0 + r × GLOBE_STEP；該列有 GLOBE_ROW_COUNTS[r] 個取樣點，
/// 第 k 個的經度 = -180 + (k + 0.5) × 360 / 點數。
export const GLOBE_ROW_LAT0 = {lat0!r};
export const GLOBE_ROW_COUNTS = {json.dumps([n for _, n in rs])};

/// 國家表：[ISO 3166-1 alpha-2, 中文名]。取樣點存的是這張表的索引 + 1（0 = 海）。
export const GLOBE_COUNTRIES: readonly (readonly [string, string])[] = [
{table},
];

/// 每個取樣點屬於哪一國（國家表索引 + 1，0 = 海），依列由南到北、列內由西到東。RLE + deflate + base64。
export const GLOBE_SAMPLES_B64 =
{wrap(samples_b64)};

/// 補點：每點 5 個位元組——lon、lat 各量化到 1/100 度的 int16（小端序），加上國家索引 + 1。deflate + base64。
export const GLOBE_EXTRA_B64 =
{wrap(extra_b64) if extra_b64 else '  ""'};
''')

def rle_encode(vals):
    """(值, 長度) 一組：值一個位元組，長度用 7 位元一組的變長整數。"""
    out = bytearray(); prev, run = vals[0], 0
    def flush(v, r):
        out.append(v)
        while True:
            b = r & 0x7F; r >>= 7
            out.append(b | (0x80 if r else 0))
            if not r: break
    for v in vals:
        if v == prev: run += 1
        else: flush(prev, run); prev, run = v, 1
    flush(prev, run)
    return bytes(out)

def b64z(b): return base64.b64encode(zlib.compress(b, 9)).decode() if b else ""

main()
