/// 掛單簿上標出平台自己的單。市場參與者有權知道對手是誰：
/// 「平台做市」是營運方為維持流動性掛的單；「模擬」是測試鏈上虛擬人物的單。
export function ParticipantBadge({ tag }: { tag?: "mm" | "sim" | "op" | null }) {
  if (tag === "mm") {
    return <span className="rounded bg-tide/15 px-1.5 py-0.5 text-[10px] text-tide" title="平台做市帳戶的報價，規則見託管揭露頁" data-testid="tag-mm">平台做市</span>;
  }
  if (tag === "op") {
    return <span className="rounded bg-ink-600 px-1.5 py-0.5 text-[10px] text-ink-200" title="營運方自己的掛單" data-testid="tag-op">平台自營</span>;
  }
  if (tag === "sim") {
    return <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn" title="測試鏈上的模擬人物，不是真實參與者" data-testid="tag-sim">模擬</span>;
  }
  return null;
}
