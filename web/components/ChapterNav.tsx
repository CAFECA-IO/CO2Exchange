"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/// 長文的章節導覽：目錄、現在讀到哪、以及**在全文裡找**。
///
/// /about 是七千多字。原本頁首有一排章節 chip，往下捲兩頁之後就看不到了——
/// 於是「我想知道國外額度能不能扣碳費」只剩兩條路：從頭捲回去，或用瀏覽器的
/// Ctrl-F（找得到字，但不會告訴你那句話屬於哪一章，也不會讓你知道還有別章也提到）。
///
/// 三件事分開做：
///   · **目錄**常駐在側邊，捲到哪裡都看得到，並標出現在這一章。
///   · **搜尋**查的是**全文**，不是章節標題——讀者記得的通常是內容裡的字眼
///     （「碳費」「5%」「J-Credit」），不是我們給那一章取的名字。
///   · **命中**直接跳到那一段並短暫標起來，不是只跳到章節開頭讓人自己再找一次。
///
/// 索引直接從**畫面上已經渲染出來的 DOM** 讀，不另外維護一份資料檔。
/// 維護兩份的話，改了內文而忘了改索引，搜尋就會安靜地找不到東西——
/// 而「找不到」看起來跟「本來就沒寫」一模一樣。

type Hit = { id: string; title: string; text: string; el: HTMLElement };
type Chapter = { id: string; title: string; eyebrow: string };

/// 建索引的時機：**第一次要用的時候**，不是掛載的時候。
/// 掃 DOM 對每一個只是路過的讀者都是白工，而且在 effect 裡同步 setState
/// 會多一輪渲染（React 的 set-state-in-effect 規則正是在擋這個）。
function buildIndex(): { chapters: Chapter[]; blocks: Hit[] } {
  const chapters: Chapter[] = [];
  const blocks: Hit[] = [];
  for (const sec of document.querySelectorAll<HTMLElement>("section[id]")) {
    const title = sec.querySelector("h2")?.textContent?.trim() ?? "";
    if (!title) continue;
    const eyebrow = sec.querySelector("p")?.textContent?.trim() ?? "";
    chapters.push({ id: sec.id, title, eyebrow: eyebrow === title ? "" : eyebrow });
    for (const el of sec.querySelectorAll<HTMLElement>("p, li, h3, td, dd")) {
      // 巢狀元素會被算兩次（<li> 裡面包 <p>）。只取最內層那一個，
      // 否則同一句話在結果裡出現兩遍，而使用者不知道差別在哪。
      if (el.querySelector("p, li, h3, td, dd")) continue;
      const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length < 8) continue;
      blocks.push({ id: sec.id, title, text, el });
    }
  }
  return { chapters, blocks };
}

function search(blocks: Hit[], q: string): Hit[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 1) return [];
  const out: Hit[] = [];
  const perChapter = new Map<string, number>();
  for (const b of blocks) {
    if (!b.text.toLowerCase().includes(needle)) continue;
    // 一章最多三筆。某一章反覆提到同一個詞時，不該把其他章的命中擠出畫面——
    // 而「還有哪幾章提到」正是這個搜尋要回答的問題。
    const n = perChapter.get(b.id) ?? 0;
    if (n >= 3) continue;
    perChapter.set(b.id, n + 1);
    out.push(b);
    if (out.length >= 24) break;
  }
  return out;
}

/// 命中的那一句：只顯示關鍵字前後各一小段，並把關鍵字本身標起來。
function Snippet({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return <>{text.slice(0, 90)}</>;
  const from = Math.max(0, i - 28);
  const to = Math.min(text.length, i + q.length + 62);
  return (
    <>
      {from > 0 && "…"}
      {text.slice(from, i)}
      <mark className="rounded-sm bg-tide/25 px-0.5 text-ink-50">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length, to)}
      {to < text.length && "…"}
    </>
  );
}

export function ChapterNav() {
  const [index, setIndex] = useState<{ chapters: Chapter[]; blocks: Hit[] } | null>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string>("");
  const [open, setOpen] = useState(false); // 手機版的章節抽屜
  const inputRef = useRef<HTMLInputElement>(null);

  const ensure = useCallback(() => {
    // 已經建過就沿用。內文是靜態的，不需要重建；真的改了的話重新整理即可。
    setIndex((cur) => cur ?? buildIndex());
  }, []);

  // 現在讀到哪。用捲動位置算最接近的那一章，不用 IntersectionObserver——
  // 章節長短差很多，IO 的「可見比例」在一章佔滿整個視窗時會全部落空。
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const line = 140; // 視窗頂端往下一點：讀者的視線落點，不是螢幕邊緣
      let best = "";
      for (const sec of document.querySelectorAll<HTMLElement>("section[id]")) {
        if (sec.getBoundingClientRect().top <= line) best = sec.id;
      }
      setActive(best);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const goto = useCallback((el: HTMLElement) => {
    setOpen(false);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // 跳過去之後把那一段標起來兩秒。沒有這個，使用者落在一片文字中間，
    // 還要自己再找一次剛才搜到的那句話——等於搜尋只做了一半。
    el.classList.add("nav-flash");
    window.setTimeout(() => el.classList.remove("nav-flash"), 2000);
  }, []);

  const gotoId = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setOpen(false);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const chapters = index?.chapters ?? [];
  const hits = index && q.trim() ? search(index.blocks, q) : [];
  const searching = q.trim().length > 0;
  const activeTitle = chapters.find((c) => c.id === active)?.title;

  const body = (
    <>
      <div className="relative">
        <input
          ref={inputRef}
          type="search"
          value={q}
          onFocus={ensure}
          onChange={(e) => { ensure(); setQ(e.target.value); }}
          placeholder="在全文裡找：碳費、5%、J-Credit…"
          aria-label="搜尋這一頁的內容"
          data-testid="chapter-search"
          className="w-full rounded-[--radius-ctl] border border-ink-500 bg-ink-800 px-3 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-300 focus:border-tide"
        />
      </div>

      {searching ? (
        <div className="mt-3" data-testid="chapter-results">
          {hits.length === 0 ? (
            <p className="px-1 text-xs leading-6 text-ink-300">
              這一頁沒有提到「{q.trim()}」。
              <br />
              制度與法規的細節也可能寫在<Link className="text-tide underline" href="/agreements">契約</Link>裡。
            </p>
          ) : (
            <>
              <p className="px-1 pb-2 text-[11px] text-ink-300">
                {hits.length} 筆，分布在 {new Set(hits.map((h) => h.id)).size} 個章節
              </p>
              <ul className="space-y-1">
                {hits.map((h, i) => (
                  <li key={`${h.id}-${i}`}>
                    <button
                      onClick={() => goto(h.el)}
                      className="block w-full rounded-[--radius-ctl] px-2 py-1.5 text-left transition hover:bg-ink-600"
                    >
                      <span className="block text-[11px] text-tide">{h.title}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-ink-200">
                        <Snippet text={h.text} q={q} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <ol className="mt-3 space-y-0.5" data-testid="chapter-list">
          {chapters.map((c, i) => {
            const on = c.id === active;
            return (
              <li key={c.id}>
                <button
                  onClick={() => gotoId(c.id)}
                  aria-current={on ? "true" : undefined}
                  className={`flex w-full gap-2 rounded-[--radius-ctl] px-2 py-1.5 text-left text-xs leading-5 transition ${
                    on ? "bg-ink-600 font-medium text-ink-50" : "text-ink-300 hover:bg-ink-600 hover:text-ink-50"
                  }`}
                >
                  <span className={`tabular-nums ${on ? "text-tide" : "text-ink-300"}`}>{i + 1}</span>
                  <span>{c.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );

  return (
    <>
      {/* ── 桌機：側邊常駐 ─────────────────────────────────
          sticky 而不是 fixed：它屬於這一頁的內容，不是浮在所有東西上的工具列。
          max-height + overflow 讓章節多的時候自己捲，不會把頁尾頂出去。 */}
      {/* `!open` 不是為了好看：手機抽屜打開時，如果桌機那一份也還在 DOM 裡，
          畫面上就同時存在兩個 data-testid 相同、aria-label 相同的搜尋框。
          螢幕閱讀器會念到兩個「搜尋這一頁的內容」，瀏覽器的自動填入也會困惑。
          桌機上 `open` 永遠是 false（開啟鈕是 lg:hidden），所以這個條件不影響桌機。 */}
      {!open && (
        <nav
          aria-label="本頁章節"
          className="sticky top-20 hidden max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 lg:block"
          onMouseEnter={ensure}
        >
          {body}
        </nav>
      )}

      {/* ── 手機：頂端一條，點開才是完整清單 ─────────────────
          小螢幕上把目錄常駐等於吃掉半個畫面。這裡只留「你在第幾章」這一件事，
          需要跳章或搜尋時才展開。 */}
      <div className="sticky top-[57px] z-30 -mx-4 mb-4 border-b border-ink-500 bg-ink-800/95 px-4 py-2 backdrop-blur lg:hidden">
        <button
          onClick={() => { ensure(); setOpen(true); }}
          data-testid="chapter-open"
          className="flex w-full items-center justify-between gap-3 text-left text-xs"
        >
          <span className="truncate text-ink-200">
            <span className="text-ink-300">章節：</span>
            {activeTitle ?? "認識碳權"}
          </span>
          <span className="shrink-0 rounded-[--radius-ctl] border border-ink-500 px-2 py-1 text-ink-300">目錄・搜尋</span>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-ink-800/95 backdrop-blur lg:hidden" role="dialog" aria-modal="true" aria-label="章節目錄">
          <div className="flex items-center justify-between border-b border-ink-500 px-4 py-3">
            <span className="font-display text-sm font-semibold text-ink-50">章節目錄</span>
            <button onClick={() => setOpen(false)} className="rounded-[--radius-ctl] border border-ink-500 px-3 py-1 text-xs text-ink-200">
              關閉
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">{body}</div>
        </div>
      )}
    </>
  );
}
