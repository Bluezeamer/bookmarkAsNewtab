// ADR-001 server 端星型中继: y-protocols 原语实现
// wire 格式 = y-protocols 标准 [type=0 sync][step1|step2|update],
// 与 y-websocket WebsocketProvider 完全互通（web/extension 客户端直接用它连）
// MVP 不支持 awareness(1)/auth(2) 消息（忽略）
import * as Y from "yjs";
import * as enc0 from "lib0/encoding";
import * as dec0 from "lib0/decoding";
import * as sp from "y-protocols/sync.js";

export type RelayClient = {
  send: (data: Uint8Array) => void;
  on: (ev: "message" | "close", cb: (...args: unknown[]) => void) => void;
};

// 消息级调试（RELAY_DEBUG=1 开启）: 排查客户端“连上了但数据不上去”这类问题时, 这是唯一能看见 wire 的窗口
const DEBUG = !!process.env.RELAY_DEBUG;

export function createRelay(doc: Y.Doc): {
  attach: (ws: RelayClient) => void;
  clients: Set<RelayClient>;
} {
  const clients = new Set<RelayClient>();

  function broadcast(update: Uint8Array, exclude: RelayClient | null): void {
    for (const c of clients) {
      if (c === exclude) continue;
      const enc = enc0.createEncoder();
      enc0.writeVarUint(enc, 0); // messageSync
      sp.writeUpdate(enc, update);
      c.send(enc0.toUint8Array(enc));
    }
  }

  // 枢纽: 任何 doc 更新 → 转发给其他所有 client
  // origin=ws(发送方) → 排除发送方; origin=doc(本地写) → 全量转发
  doc.on("update", (update, origin) => {
    broadcast(update, origin === doc ? null : (origin as RelayClient));
  });

  function attach(ws: RelayClient): void {
    clients.add(ws);
    if (DEBUG) console.log(`[relay] attach → clients=${clients.size}`);

    // 连接建立 → 发 Step1（本端状态向量）
    const enc1 = enc0.createEncoder();
    enc0.writeVarUint(enc1, 0);
    sp.writeSyncStep1(enc1, doc);
    ws.send(enc0.toUint8Array(enc1));

    ws.on("message", (data: unknown) => {
      const bytes = data as Uint8Array;
      const dec = dec0.createDecoder(bytes);
      const msgType = dec0.readVarUint(dec);
      if (DEBUG) console.log(`[relay] msg type=${msgType} len=${bytes.length}`);
      if (msgType !== 0) return; // 非 sync 消息, 忽略
      const enc = enc0.createEncoder();
      enc0.writeVarUint(enc, 0);
      // Step1 → 把 Step2 响应写进 enc; Step2/Update → 应用到 doc
      sp.readSyncMessage(dec, enc, doc, ws);
      const resp = enc0.toUint8Array(enc);
      if (DEBUG) console.log(`[relay] → resp len=${resp.length}`);
      if (resp.length > 1) ws.send(resp); // 有载荷才回发
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (DEBUG) console.log(`[relay] close → clients=${clients.size}`);
    });
  }

  return { attach, clients };
}
