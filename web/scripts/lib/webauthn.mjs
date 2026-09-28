// 測試用：產生一把 P-256 passkey，照 CAFECA README §5 的版面簽出 ERC-1271 簽章。
// 只給測試與本機工具用——真的 passkey 在使用者裝置裡，私鑰永遠不會離開。
import { p256 } from "@noble/curves/p256";
import { bytesToHex, concat, hexToBytes, sha256, toBytes } from "viem";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function newPasskey(rpId = "cafeca.io") {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false); // 04 ‖ x ‖ y
  return {
    priv,
    qx: bytesToHex(pub.slice(1, 33)),
    qy: bytesToHex(pub.slice(33, 65)),
    rpIdHash: sha256(toBytes(rpId)),
  };
}

/// digest → CAFECA 簽章的各欄位（再交給 encodeCafecaSignature 包起來）。
export function webauthnSign(key, digest, { flags = 0x05, origin = "https://cafeca.io" } = {}) {
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64url(hexToBytes(digest))}","origin":"${origin}","crossOrigin":false}`;
  const authenticatorData = concat([key.rpIdHash, `0x${flags.toString(16).padStart(2, "0")}`, "0x00000001"]);
  const msgHash = hexToBytes(sha256(concat([authenticatorData, sha256(toBytes(clientDataJSON))])));
  const sig = p256.sign(msgHash, key.priv, { prehash: false, lowS: true });
  const pad = (n) => `0x${n.toString(16).padStart(64, "0")}`;
  return {
    authenticatorData, clientDataJSON,
    challengeIndex: BigInt(clientDataJSON.indexOf('"challenge":"')),
    typeIndex: BigInt(clientDataJSON.indexOf('"type":"webauthn.get"')),
    r: pad(sig.r), s: pad(sig.s),
  };
}
