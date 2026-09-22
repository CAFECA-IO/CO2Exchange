// 一個假的 OpenAI 相容端點，用來在**沒有金鑰**的情況下測完整條費思迴圈。
//
// 為什麼值得做：費思真正的風險不在模型講得好不好，而在
// 「模型講完之後，系統做了什麼」——工具迴圈有沒有跑、propose_action 有沒有被
// 伺服器重新驗算、確認卡上的數字是不是伺服器算的、沒按確認會不會送出。
// 那幾件事跟模型是誰完全無關，所以不該把它們的測試綁在一把金鑰上。
//
// 腳本是寫死的：依照請求裡最後一則使用者訊息挑一段回應。
import http from "node:http";

const reply = (content) => ({ choices: [{ message: { role: "assistant", content } }] });
const toolCall = (name, args) => ({
  choices: [{ message: { role: "assistant", content: null, tool_calls: [
    { id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ] } }],
});

export function startStub(port = 10099) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const msgs = j.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
      const toolResults = msgs.filter((m) => m.role === "tool");
      const called = new Set(msgs.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name)));

      let out;
      if (lastUser.includes("這一頁")) {
        out = called.has("page_guide")
          ? reply(`這一頁的說明我查到了：${JSON.stringify(toolResults.at(-1)?.content ?? "").slice(0, 60)}…`)
          : toolCall("page_guide", {});
      } else if (lastUser.includes("買")) {
        // 先查掛單簿，再提議買最便宜的那一張——跟真模型該走的路一樣。
        if (!called.has("order_book")) out = toolCall("order_book", { country: "TW", side: "ask" });
        else if (!called.has("propose_action")) {
          const book = JSON.parse(toolResults.find((t) => String(t.content).includes("asks"))?.content ?? "{}");
          const asks = book?.data?.asks ?? [];
          const cheapest = [...asks].sort((a, b) => Number(a.pricePerTonne) - Number(b.pricePerTonne))[0];
          out = toolCall("propose_action", {
            kind: "buy_listing",
            params: { orderId: cheapest?.orderId ?? 1, tonnes: 0.5 },
            why: "這是目前 TW 最低價的一張單。",
          });
        } else out = reply("好的。");
      } else if (lastUser.includes("轉走") || lastUser.includes("注入")) {
        // 模擬被注入之後的最壞情況：模型想做一件白名單裡沒有的事。
        out = toolCall("propose_action", { kind: "transfer_all", params: { to: "0x000000000000000000000000000000000000dEaD" } });
      } else if (lastUser.includes("帶我")) {
        out = toolCall("propose_action", { kind: "navigate", params: { path: "/retire" }, why: "註銷在這一頁。" });
      } else if (lastUser.includes("站外")) {
        out = toolCall("propose_action", { kind: "navigate", params: { path: "https://evil.example.com" } });
      } else {
        out = reply("我是費思。你可以問我這一頁在做什麼，或請我幫你下單。");
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startStub(Number(process.env.STUB_PORT ?? 10099));
  console.log("faith stub on", process.env.STUB_PORT ?? 10099);
}
