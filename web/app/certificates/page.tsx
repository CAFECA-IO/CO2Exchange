"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Card, Notice, fmtKg } from "@/components/ui";
import { PURPOSE_LABEL } from "@/lib/deployment";

type Cert = {
  certId: number; batchId: number; amountKg: number; beneficiary: string; purpose: number; memo: string;
  retiredBy: string; retiredAt: number; documentHash: string; txHash: string; beneficiaryHash: string;
  /// 官方註銷（由代辦方向環境部申請後回填）
  officialNo: string; officialAnnouncedAt: number; claimableFrom: number | null;
};

export default function CertificatesPage() {
  const { credential, userId } = useAccount();
  const [certs, setCerts] = useState<Cert[] | null>(null);
  useEffect(() => {
    if (!credential) return;
    fetch(`/api/certificates?account=${credential.address}`).then((r) => r.json()).then((j) => setCerts(j.certificates ?? []));
  }, [credential]);

  if (!userId || !credential) return <AccountGate />;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">我的註銷憑證</h1>
      {!certs ? <p className="text-sm text-ink-300">讀取中…</p> : certs.length === 0 ? <Notice>尚無憑證。到<Link className="underline" href="/trade">交易</Link>買進，再到<Link className="underline" href="/retire">註銷</Link>完成第一筆。</Notice> : (
        <div className="grid gap-4 md:grid-cols-2">
          {certs.map((c) => (
            <Card key={c.certId} title={`憑證 #${c.certId}`}>
              <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
                <dt className="text-ink-300">數量</dt><dd data-testid="cert-kg">{fmtKg(c.amountKg)}（{c.amountKg.toLocaleString()} kg）</dd>
                <dt className="text-ink-300">批次</dt><dd>#{c.batchId}</dd>
                <dt className="text-ink-300">受益人</dt><dd>{c.beneficiary || "—"}</dd>
                <dt className="text-ink-300">用途</dt><dd>{PURPOSE_LABEL[c.purpose]}</dd>
                <dt className="text-ink-300">備註</dt><dd>{c.memo || "—"}</dd>
                <dt className="text-ink-300">註銷時間</dt><dd>{new Date(c.retiredAt * 1000).toLocaleString("zh-TW")}</dd>
                <dt className="text-ink-300">執行者</dt><dd className="font-mono text-xs break-all">{c.retiredBy}</dd>
                <dt className="text-ink-300">交易</dt><dd className="font-mono text-xs break-all">{c.txHash}</dd>
                <dt className="text-ink-300">官方註銷</dt>
                <dd>
                  {c.officialNo
                    ? <>已完成 · <span className="font-mono text-xs">{c.officialNo}</span></>
                    : <span className="text-warn">辦理中（鏈上已註銷，官方移轉與註銷由卡菲卡代辦）</span>}
                </dd>
                <dt className="text-ink-300">可對外宣告</dt>
                <dd>
                  {c.claimableFrom
                    ? <>{new Date(c.claimableFrom * 1000).toLocaleDateString("zh-TW")} 起</>
                    : <span className="text-ink-300">待主管機關公開後起算五個工作日</span>}
                </dd>
                <dt className="text-ink-300">正式文件</dt><dd className="font-mono text-xs break-all">{/^0x0+$/.test(c.documentHash) ? "待營運方回寫 PDF hash" : <><a className="underline" href={`/api/certificates/${c.certId}/pdf`} target="_blank">下載 PDF</a> · {c.documentHash}</>}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
