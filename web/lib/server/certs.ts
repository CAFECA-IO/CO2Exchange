import "server-only";
import type { CertData } from "./certpdf";
import { ledgerCertData } from "./ledger/registry";

/// 註銷憑證的內容。設計 v4：憑證是帳本裡的 retire 事件，文件雜湊由 DOCUMENT_SIGNER 另簽一筆事件錨定。
export async function certData(certId: number): Promise<CertData> {
  return ledgerCertData(certId);
}
