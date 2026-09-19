import { registryAbi } from "@/lib/abis";
import { deployment, isAddress, publicClient } from "@/lib/server/chain";
import { all, insert, saveUpload } from "@/lib/server/store";
import type { IssuanceRequest } from "@/lib/server/issuance";
import { handle, me, requireRole } from "@/lib/server/roles";

/// GET ?owner= | ?status=（查驗機構可看全部）
export async function GET(req: Request) {
  try {
    const m = await me();
    if (!m) return Response.json({ error: "unauthenticated" }, { status: 401 });
    const q = new URL(req.url).searchParams;
    const owner = q.get("owner"); const status = q.get("status");
    let rows = all<IssuanceRequest>("issuance-requests");
    if (isAddress(owner)) rows = rows.filter((r) => r.owner.toLowerCase() === owner.toLowerCase());
    else if (!m.isVerifier && !m.isAdmin) return Response.json({ error: "owner required" }, { status: 403 });
    if (status) rows = rows.filter((r) => r.status === status);
    return Response.json({ requests: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  } catch (e) { return handle(e); }
}

/// POST multipart: projectId, owner, monitoringStart, monitoringEnd, amountTonnes, note, report(PDF) → 核發申請
export async function POST(req: Request) {
  try {
    const m = await requireRole("user");
    const fd = await req.formData();
    const projectId = Number(fd.get("projectId"));
    const owner = String(fd.get("owner"));
    const monitoringStart = String(fd.get("monitoringStart"));
    const monitoringEnd = String(fd.get("monitoringEnd"));
    const amountKg = Math.round(Number(fd.get("amountTonnes")) * 1000);
    const note = String(fd.get("note") ?? "").slice(0, 500);
    const report = fd.get("report");
    if (!isAddress(owner) || !Number.isInteger(projectId) || projectId < 1) throw new Error("projectId / owner");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(monitoringStart) || !/^\d{4}-\d{2}-\d{2}$/.test(monitoringEnd) || monitoringEnd <= monitoringStart) throw new Error("監測期間格式錯誤或結束早於開始");
    if (!(amountKg > 0)) throw new Error("噸數必須大於 0");
    if (!(report instanceof File) || report.size === 0) throw new Error("需要上傳查驗報告");
    if (report.size > 20 * 1024 * 1024) throw new Error("報告超過 20MB");
    const d = deployment();
    const p = await publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [BigInt(projectId)] });
    if (p.owner.toLowerCase() !== owner.toLowerCase()) throw new Error("此帳戶不是該專案擁有者");
    if (!p.active) throw new Error("專案已停用");
    const buf = Buffer.from(await report.arrayBuffer());
    const ext = report.name.toLowerCase().endsWith(".pdf") ? ".pdf" : "";
    const saved = saveUpload(buf, ext);
    const row = insert<IssuanceRequest>("issuance-requests", {
      projectId, projectName: p.name, owner, submittedBy: m.email, monitoringStart, monitoringEnd, amountKg,
      reportFile: saved.name, reportHash: saved.sha256, reportName: report.name, note, status: "pending",
    });
    return Response.json(row);
  } catch (e) { return handle(e); }
}
