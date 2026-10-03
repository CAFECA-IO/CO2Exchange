"use client";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Notice } from "@/components/ui";

/// 帳戶與安全。
///
/// ## 這一頁在改用 CAFECA 之後大部分被搬走了，而那是重點
///
/// 它以前是「裝置與安全」：列出所有 passkey、核准或拒絕新裝置、撤掉遺失的那一把、
/// 掛失凍結、否決復原提案。那些操作全部需要**本站有能力改變使用者的帳戶控制權**。
///
/// 現在錢包是使用者的 CAFECA 身分合約，那些操作在 CAFECA 錢包裡做。本站做不到。
/// 這不是功能退步，是邊界劃對了：一個能凍結任何人身分的交易所，
/// 就是一個能凍結任何人身分的交易所，不管它承諾不會這麼做。
///
/// 所以這一頁現在只做三件事：告訴你這裡認得的你是誰、你現在能不能交易、
/// 以及出事時該去哪裡。最後一項最重要——出事的當下沒有人會回來讀說明書，
/// 所以那個連結要一直在。
export default function AccountPage() {
  const { userId, wallet, me, tier, channelOpen, busy, refreshWallet, recheckChannel } = useAccount();

  if (!userId || !wallet) return <AccountGate />;

  const tierLabel = ["未驗證", "自然人", "法人"][tier] ?? "未驗證";

  return (
    <div className="space-y-6">
      {/* 出事時先看到的東西放最上面。急的時候沒有人會往下捲。 */}
      {wallet.recoveryPending && (
        <Notice kind="warn">
          <b>這個身分正在恢復中。</b>
          有人正在主張這個帳戶是他的。交易與註銷已暫停。
          如果這不是你發起的，<b>立刻</b>到 CAFECA 錢包否決它——恢復一旦完成，控制權就換人了。
        </Notice>
      )}
      {channelOpen === false && (
        <Notice kind="warn">
          簽章通道沒有開啟，所以現在下不了單、也送不出交易。持倉與紀錄不受影響。
          回<Link href="/#login" className="mx-1 underline">首頁</Link>重新登入一次就會徵詢你是否開啟。
        </Notice>
      )}

      <Card title="你的帳戶">
        <dl className="space-y-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-ink-300">CAFECA 身分合約</dt>
            <dd className="tnum break-all font-mono text-ink-50">{wallet.address}</dd>
          </div>
          {me.handle && (
            <div className="flex justify-between gap-4">
              <dt className="text-ink-300">CAFECA 代稱</dt>
              <dd className="text-ink-50">{me.handle}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-ink-300">實名等級（CAFECA）</dt>
            <dd className="text-ink-50">
              {wallet.kycLevel >= 2
                ? `${wallet.kyc?.subjectType === "entity" ? "公司（商工登記）" : "已通過證件＋臉部驗證"}${wallet.kyc?.signerClass === "prototype" ? "・原型簽章" : ""}`
                : "未實名"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-300">本站身分等級</dt>
            <dd className="text-ink-50">{tierLabel}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-300">鏈上狀態</dt>
            <dd className="text-ink-50">{wallet.exists ? "帳戶已部署" : "尚未部署（第一次動作時自動建立）"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-300">簽章通道</dt>
            <dd className={channelOpen ? "text-ink-50" : "text-warn"}>
              {channelOpen === null ? "檢查中…" : channelOpen ? "已開啟" : "未開啟"}
            </dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { refreshWallet(); recheckChannel(); }} disabled={!!busy}>
            {busy ?? "重新整理狀態"}
          </Button>
          <Link href="/kyc"><Button variant="secondary">身分驗證</Button></Link>
        </div>
      </Card>

      <Card title="金鑰、裝置與掛失">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            這些都在你的 CAFECA 錢包裡，<b>本站碰不到</b>：新增或撤銷裝置、掛失、
            以實體卡或備援金鑰恢復、以及關閉本站的簽章通道。
          </p>
          <ul className="space-y-1.5 border-l-2 border-ink-500 pl-4 text-ink-300">
            <li><b>手機掉了、別台還在</b> → 到 CAFECA 撤掉那把金鑰。即時，不需要任何人同意。</li>
            <li><b>全部裝置都掉了</b> → 走 CAFECA 的恢復程序（實體卡或備援金鑰）。</li>
            <li><b>不想再讓本站請你簽字</b> → CAFECA 的「安全 → 以 CAFECA 登入的網站」關掉通道。
              關掉之後你仍然登得進來、看得到持倉，只是下不了單。</li>
          </ul>
          <p className="text-ink-300">
            為什麼本站不提供這些：它們決定的是<b>誰控制這個身分</b>。
            一個交易所如果做得到，那它就做得到——對誰都一樣，不管它怎麼承諾。
            把這條線劃在這裡，是這次改用 CAFECA 最主要的理由。
          </p>
        </div>
        <div className="mt-4">
          <a href={wallet.manageUrl} target="_blank" rel="noreferrer">
            <Button>到 CAFECA 管理</Button>
          </a>
        </div>
      </Card>

      <Card title="交易怎麼簽">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            下單時你簽的是一份 EIP-712 委託單（誰、哪一批、多少、什麼價、到什麼時候）。
            買賣與註銷則是由<b>你自己的帳戶</b>送出的鏈上交易，gas 由平台贊助。
          </p>
          <p className="text-ink-300">
            每一筆都會在 CAFECA 錢包顯示我們寫的說明，以及錢包自己解析出來的實際內容，
            由你核對後才簽。兩者對不起來就不要簽——那代表這個網站在說一件事、做另一件事。
          </p>
        </div>
      </Card>
    </div>
  );
}
