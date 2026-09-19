import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { type Hex } from "viem";
import { PURPOSE_LABEL } from "@/lib/deployment";

export type CertData = {
  certId: number; chainId: number; certificateContract: string; batchId: number; amountKg: number; beneficiary: string; beneficiaryHash: Hex;
  purpose: number; memo: string; retiredBy: string; retiredAt: number; txHash: Hex; owner: string;
  project: { id: number; name: string; methodology: string; location: string }; vintageYear: number; monitoringStart: number; monitoringEnd: number;
  verifier: string; serialHash: Hex; reportHash: Hex;
};

const DIR = path.join(process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"), "certificates");
const FONT = process.env.CERT_FONT_PATH ?? path.resolve(process.cwd(), "fonts", "NotoSansTC-Subset.otf");

export function pdfPath(certId: number) { return path.join(DIR, `certificate-${certId}.pdf`); }
export function existingPdf(certId: number) {
  const p = pdfPath(certId);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return { buf, sha256: `0x${crypto.createHash("sha256").update(buf).digest("hex")}` as Hex };
}

const d = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export async function generateCertificatePdf(c: CertData) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const cjk = fs.existsSync(FONT) ? await doc.embedFont(fs.readFileSync(FONT), { subset: true }) : await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage([595.28, 841.89]); // A4
  const { width } = page.getSize();
  const green = rgb(0.02, 0.47, 0.34);
  let y = 780;
  const text = (s: string, x: number, size = 11, font = cjk, color = rgb(0.1, 0.1, 0.1)) => { page.drawText(s, { x, y, size, font, color }); };
  const line = (label: string, value: string, monoValue = false) => {
    text(label, 56, 10.5, cjk, rgb(0.4, 0.4, 0.4));
    if (monoValue) { for (const chunk of value.match(/.{1,58}/g) ?? [""]) { text(chunk, 200, 9.5, mono); y -= 13; } y -= 5; }
    else { text(value, 200, 11); y -= 20; }
  };

  page.drawRectangle({ x: 40, y: 40, width: width - 80, height: 761.89, borderColor: green, borderWidth: 1.5 });
  text("減量額度註銷憑證", 56, 22, cjk, green); y -= 16;
  text("Carbon Credit Retirement Certificate", 56, 11, cjk, rgb(0.35, 0.35, 0.35)); y -= 14;
  text(`No. ${c.certId}`, width - 56 - mono.widthOfTextAtSize(`No. ${c.certId}`, 12), 12, mono, green);
  y -= 30;

  line("受益人", c.beneficiary || "（未填）");
  line("註銷數量", `${(c.amountKg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 公噸 CO2e（${c.amountKg.toLocaleString()} kg）`);
  line("用途", PURPOSE_LABEL[c.purpose] ?? String(c.purpose));
  line("備註", c.memo || "—");
  line("註銷時間 (UTC)", new Date(c.retiredAt * 1000).toISOString().replace("T", " ").slice(0, 19));
  y -= 10;
  page.drawLine({ start: { x: 56, y }, end: { x: width - 56, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) }); y -= 22;
  text("額度來源", 56, 12, cjk, green); y -= 22;
  line("專案", `#${c.project.id} ${c.project.name}`);
  line("方法學", c.project.methodology);
  line("地點", c.project.location);
  line("監測期間", `${d(c.monitoringStart)} 至 ${d(c.monitoringEnd)}（年份 ${c.vintageYear}）`);
  line("批次 / 序號雜湊", `#${c.batchId}`); y += 6;
  line("", c.serialHash, true);
  line("查驗機構", c.verifier, true);
  line("查驗報告雜湊", c.reportHash, true);
  y -= 6;
  page.drawLine({ start: { x: 56, y }, end: { x: width - 56, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) }); y -= 22;
  text("鏈上紀錄", 56, 12, cjk, green); y -= 22;
  line("鏈 ID / 憑證合約", `${c.chainId}`); y += 6;
  line("", c.certificateContract, true);
  line("憑證持有帳戶", c.owner, true);
  line("執行註銷帳戶", c.retiredBy, true);
  line("受益人身分雜湊", c.beneficiaryHash, true);
  line("註銷交易", c.txHash, true);
  y -= 8;
  const note = "本文件內容以鏈上紀錄為準。文件檔案之 SHA-256 雜湊由營運方回寫至憑證合約 documentHash 欄位，任何人可重新計算雜湊並與鏈上比對以驗證本文件未經竄改。";
  for (const chunk of note.match(/.{1,40}/g) ?? []) { text(chunk, 56, 9.5, cjk, rgb(0.35, 0.35, 0.35)); y -= 14; }
  text(`產生時間 ${new Date().toISOString()}`, 56, 8.5, cjk, rgb(0.5, 0.5, 0.5));

  const bytes = await doc.save();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(pdfPath(c.certId), bytes);
  return { sha256: `0x${crypto.createHash("sha256").update(bytes).digest("hex")}` as Hex, bytes };
}
