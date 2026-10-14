#!/usr/bin/env node
// 能力块 5 测试（ADR-005 自动分类）: 纯函数 + stub 模型服务器驱动的端到端
// 端口与其它测试错开（sync 18200+/web 19200+/19700+）
import assert from "node:assert";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const TOKEN = "classifier-test-token";
const APP_PORT = 20200 + (process.pid % 200);
const STUB_PORT = 20450 + (process.pid % 200);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-classifier-"));
const BASE = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

execSync(
  `${path.join(PKG, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js`,
  { cwd: PKG, stdio: "inherit" }
);
// 纯函数直接从编译产物引入（server 包是 type:commonjs, 源码 .ts 不能按 ESM 导入）
const CLASSIFIER_CJS = path.join(PKG, "dist/classifier.test.cjs"); // 放包内: --external:yjs 需要能解析到包内依赖
execSync(
  `${path.join(PKG, "node_modules/.bin/esbuild")} src/classifier.ts --bundle --platform=node --format=cjs --external:yjs --outfile=${CLASSIFIER_CJS}`,
  { cwd: PKG, stdio: "inherit" }
);
const { createClassifier, extractJsonObject, parseSuggestion, sanitizeTags } = createRequire(
  import.meta.url
)(CLASSIFIER_CJS);

// ---------- 1) 纯函数 ----------
await test("C1 extractJsonObject: 围栏/废话/嵌套/非 JSON", () => {
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObject('好的: {"a":{"b":2}} 完毕'), '{"a":{"b":2}}');
  assert.equal(extractJsonObject('{"s":"}"}'), '{"s":"}"}', "字符串内的括号不算深度");
  assert.equal(extractJsonObject("没有对象"), null);
  assert.equal(extractJsonObject('{"unclosed":'), null);
});

await test("C2 sanitizeTags: 限数量/长度/去重/去控制字符", () => {
  assert.deepEqual(sanitizeTags(["a", "a", " b ", "<x>"]), ["a", "b", "x"]);
  assert.equal(sanitizeTags(["1", "2", "3", "4", "5", "6"]).length, 5);
  assert.equal(sanitizeTags(["x".repeat(40)])[0].length, 24);
  assert.deepEqual(sanitizeTags("not-array"), []);
});

await test("C3 parseSuggestion: 归一化到现有夹 / 拒绝空建议", () => {
  const s1 = parseSuggestion('{"folder":"开发","tags":["代码"]}', ["开发", "阅读"]);
  assert.deepEqual(s1, { folder: "开发", tags: ["代码"] });
  // 大小写/空白归一 → 复用现有夹名（不产生重复夹）
  assert.deepEqual(parseSuggestion('{"folder":"  DEV "}', ["Dev"]), { folder: "Dev", tags: [] });
  // 新名保留（UI 接受时才创建）
  assert.deepEqual(parseSuggestion('{"folder":"新材料","tags":[]}', ["Dev"]), {
    folder: "新材料",
    tags: [],
  });
  assert.equal(parseSuggestion("{}", []), null, "空建议 → null");
  assert.equal(parseSuggestion("只有废话", []), null);
});

await test("C4 createClassifier: 未配置 → null（no-op）", () => {
  assert.equal(createClassifier({}), null);
  assert.equal(createClassifier({ CLASSIFIER_URL: "http://x" }), null, "缺模型名也是 no-op");
  assert.ok(createClassifier({ CLASSIFIER_URL: "http://x/v1", CLASSIFIER_MODEL: "m" }));
});

// ---------- 2) stub 模型服务器（按标题切换行为） ----------
const stubHits = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msgs = (JSON.parse(body || "{}").messages) || [];
    const userMsg = String(msgs.length ? msgs[msgs.length - 1].content ?? "" : "");
    stubHits.push(userMsg);
    const reply = (content) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    };
    if (userMsg.includes("GARBAGE")) return reply("抱歉, 我不能输出 JSON。");
    if (userMsg.includes("ERROR")) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "boom" }));
    }
    if (userMsg.includes("REASONING")) {
      // reasoning 模型: content 为空, 答案落在 reasoning_content
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: null, reasoning_content: '{"folder":"开发","tags":["推理"]}' } }],
        })
      );
    }
    return reply('```json\n{"folder":"开发","tags":["代码","工具","x","y","z","超出的第6个"]}\n```');
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

// ---------- 3) 应用服务器（已配置分类器） ----------
const startApp = (env = {}) =>
  spawn("node", [path.join(PKG, "dist/index.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(APP_PORT),
      SYNC_TOKEN: TOKEN,
      DATA_DIR,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
const waitUp = async (base) => {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* 未起 */
    }
    if (Date.now() - t0 > 10000) throw new Error("server not up");
    await sleep(100);
  }
};

let app = startApp({
  CLASSIFIER_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
  CLASSIFIER_MODEL: "stub-model",
  CLASSIFIER_TIMEOUT_MS: "5000",
});
await waitUp(BASE);

// 种书签（含一条没有 meta 的 → 服务端必须补建）
const peerDoc = new Y.Doc();
const peer = new WebsocketProvider(`ws://127.0.0.1:${APP_PORT}`, `ws?token=${TOKEN}`, peerDoc);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("对端 bootstrap 超时")), 10000);
  const chk = () => {
    if (peerDoc.getMap("").get("bookmarks") instanceof Y.Map) {
      clearTimeout(t);
      res();
    }
  };
  peerDoc.getMap("").observeDeep(chk);
  chk();
});
const root = peerDoc.getMap("");
const bm = root.get("bookmarks");
const fm = root.get("folders");
// 正解形状: 书签节点必须是 Y.Map（嵌套 meta.auto 才能存活）
const mkNode = (title, url) => {
  const n = new Y.Map();
  n.set("title", title);
  n.set("url", url);
  n.set("folder", null);
  n.set("order", 0);
  n.set("created", new Date().toISOString());
  const m = new Y.Map();
  m.set("auto", new Y.Map());
  n.set("meta", m);
  return n;
};
peerDoc.transact(() => {
  fm.set("f-dev", { name: "开发", parent: null, order: 0 });
  bm.set("ok1", mkNode("OK 书签一", "https://ok1.example"));
  // 旧形状（普通对象, 无 meta）: 服务端必须迁移为 Y.Map 节点后才能写 meta.auto
  bm.set("ok2", { title: "OK 旧形状无 meta", url: "https://ok2.example", folder: null, order: 1, created: new Date().toISOString() });
  // 旧形状（普通对象 + 退化后的普通 meta.auto）
  bm.set("legacy2", {
    title: "OK 旧形状带 meta",
    url: "https://legacy2.example",
    folder: null,
    order: 2,
    created: new Date().toISOString(),
    meta: { auto: {} },
  });
  bm.set("garbage", mkNode("GARBAGE 书签", "https://garbage.example"));
  bm.set("error", mkNode("ERROR 书签", "https://error.example"));
  bm.set("reasoning", mkNode("REASONING 书签", "https://reasoning.example"));
});
await sleep(600);

const classify = (qs = "") =>
  fetch(`${BASE}/api/classify${qs}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }).then(
    (r) => r.json()
  );
const autoOf = (id) => {
  const v = bm.get(id);
  if (v instanceof Y.Map) {
    const m = v.get("meta");
    if (!(m instanceof Y.Map)) return undefined;
    const a = m.get("auto");
    return a instanceof Y.Map ? a : undefined;
  }
  return v?.meta?.auto ?? undefined; // 兼容旧形状读取
};

await test("C5 已配置: 批量分类写入 CRDT（含旧形状迁移 + 服务端补建 meta）", async () => {
  const r = await classify("?limit=10");
  assert.equal(r.enabled, true, JSON.stringify(r));
  assert.equal(r.classified, 4, `应分类 ok1/ok2/legacy2/reasoning, 实际 ${JSON.stringify(r)}`);
  assert.equal(r.failed, 2, `garbage/error 应失败, 实际 ${JSON.stringify(r)}`);
  await sleep(400);
  const a1 = autoOf("ok1");
  assert.equal(a1?.get("suggestedFolder"), "开发");
  assert.equal(a1?.get("tags"), "代码,工具,x,y,z", "标签限 5 个");
  assert.ok(String(a1?.get("suggestedAt")).length > 0);
  // 旧普通对象节点 → 迁移为 Y.Map（否则 meta.auto 无法存活）
  assert.ok(bm.get("ok2") instanceof Y.Map, "旧节点应被迁移为 Y.Map");
  assert.equal(autoOf("ok2")?.get("suggestedFolder"), "开发");
  assert.ok(bm.get("legacy2") instanceof Y.Map, "带退化 meta 的旧节点同样迁移");
  assert.equal(autoOf("legacy2")?.get("suggestedFolder"), "开发");
  assert.equal(autoOf("reasoning")?.get("suggestedFolder"), "开发", "reasoning_content 兜底");
  assert.equal(autoOf("garbage")?.get("suggestedFolder"), undefined, "垃圾输出不得写入");
  assert.equal(autoOf("error")?.get("suggestedFolder"), undefined, "模型 500 不得写入");
});

await test("C6 幂等: 已有建议默认跳过", async () => {
  const r = await classify("?limit=10");
  assert.equal(r.classified, 0);
  assert.ok(r.skipped >= 4, `应跳过已有建议的条目, 实际 ${JSON.stringify(r)}`);
});

await test("C7 force=1: 强制重算", async () => {
  const r = await classify("?force=1&limit=10");
  assert.ok(r.classified >= 4, `force 应重算, 实际 ${JSON.stringify(r)}`);
});

// ---------- 4) 未配置模型 → no-op ----------
await test("C8 未配置模型: enabled=false 且不写 CRDT", async () => {
  app.kill();
  await sleep(400);
  app = startApp(); // 不带 CLASSIFIER_*
  await waitUp(BASE);
  const r = await classify();
  assert.deepEqual(r, { enabled: false, classified: 0, skipped: 0, failed: 0 });
});

await test("C9 隐私: 只发送标题与 URL（请求体不含历史/凭据）", () => {
  const all = stubHits.join("\n");
  assert.ok(all.includes("https://ok1.example"));
  assert.ok(!/authorization|Bearer/i.test(all), "不得把 token 送进模型");
});

peer.destroy();
peerDoc.destroy();
app.kill();
stub.close();

console.log(`\n${9 - failed}/9 passed`);
process.exit(failed ? 1 : 0);
