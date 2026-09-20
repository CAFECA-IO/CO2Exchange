import { byCountry } from "@/lib/server/by-country";
import { handle } from "@/lib/server/roles";

/// 公開的各轄區統計：首頁的地球直接讀，不需登入。
export async function GET(req: Request) {
  try {
    const h = Number(new URL(req.url).searchParams.get("hours") ?? 24 * 365);
    const rangeHours = Number.isFinite(h) && h > 0 && h <= 24 * 365 ? h : 24 * 365;
    return Response.json(await byCountry(rangeHours));
  } catch (e) {
    return handle(e);
  }
}
