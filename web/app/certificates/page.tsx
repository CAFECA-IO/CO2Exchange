"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { Card, Notice, fmtKg } from "@/components/ui";
import { PURPOSE_LABEL } from "@/lib/deployment";

type Cert = { certId: number; batchId: number; amountKg: number; beneficiary: string; purpose: number; memo: string; retiredBy: string; retiredAt: number; documentHash: string; txHash: string; beneficiaryHash: string };

export default function CertificatesPage() {
  const { credential, userId } = useAccount();
  const [certs, setCerts] = useState<Cert[] | null>(null);
  useEffect(() => {
    if (!credential) return;
    fetch(`/api/certificates?account=${credential.address}`).then((r) => r.json()).then((j) => setCerts(j.certificates ?? []));
  }, [credential]);

  if (!userId) return <Notice>請先在<Link className="underline" href="/">首頁</Link>登入。</Notice>;
  if (!credential) return <Notice>請先在<Link className="underline" href="/">首頁</Link>建立鏈上帳戶。</Notice>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">我的註銷憑證</h1>
      {!certs ? <p className="text-sm text-ink-300">讀取中…</p> : certs.length === 0 ? <Notice>尚無憑證。到<Link className="underline" href="/trade">購買與註銷</Link>完成第一筆。</Notice> : (
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
                <dt className="text-ink-300">正式文件</dt><dd className="font-mono text-xs break-all">{/^0x0+$/.test(c.documentHash) ? "待營運方回寫 PDF hash" : <><a className="underline" href={`/api/certificates/${c.certId}/pdf`} target="_blank">下載 PDF</a> · {c.documentHash}</>}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
