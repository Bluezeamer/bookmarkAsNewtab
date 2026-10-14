# bookmarkAsNewtab

把书签变成新标签页：浏览器扩展自动汇入你的书签与浏览历史，newtab 成为个人导航起点。

自托管：一个 Node server + 静态前端 + Chrome 扩展，数据全部留在你自己的机器上。

## 快速开始

### Docker

```sh
git clone https://github.com/Bluezeamer/bookmarkAsNewtab.git
cd bookmarkAsNewtab
SYNC_TOKEN=$(openssl rand -hex 32) docker compose up -d --build
```

打开 `http://localhost:3000`，输入上面那个 `SYNC_TOKEN` 即可。数据持久化在 `./data`。

### 源码

```sh
pnpm install
pnpm -r build
SYNC_TOKEN=<一个长随机值> node packages/server/dist/index.js
```

默认监听 `127.0.0.1:8090`。应用本身只绑回环，公网访问请在前面放一层反向代理。

## 环境变量

| 变量                    | 默认                   | 说明                                                          |
| ----------------------- | ---------------------- | ------------------------------------------------------------- |
| `SYNC_TOKEN`            | 无（必填）             | 访问 `/api` 与 `/ws` 的 Bearer token；未设置时全部拒绝        |
| `HOST`                  | `127.0.0.1`            | 监听地址                                                      |
| `PORT`                  | `8090`                 | 监听端口                                                      |
| `DATA_DIR`              | `packages/server/data` | 数据目录（CRDT 快照 + 历史 JSONL）                            |
| `OWNER_NAME`            | 空                     | 页首问候语里的名字；不设置则问候语不带名字                    |
| `CLASSIFIER_URL`        | 空                     | 自动分类的 OpenAI 兼容端点（到 `/v1` 为止）；不设置则功能关闭 |
| `CLASSIFIER_MODEL`      | 空                     | 分类模型名                                                    |
| `CLASSIFIER_API_KEY`    | 空                     | 端点鉴权（可选）                                              |
| `CLASSIFIER_TIMEOUT_MS` | `30000`                | 分类请求超时                                                  |
| `CLASSIFIER_MAX_TOKENS` | `512`                  | 分类输出预算                                                  |
| `RELAY_DEBUG`           | 空                     | 设为 `1` 打印 WS 消息级日志                                   |

## 使用

1. **打开应用**：访问你的部署地址
2. **输入 token**：上面设置的 `SYNC_TOKEN`
3. **安装扩展**（可选，自动数据入口）：
   - 点页面头部「⬇ 扩展」下载 `extension.zip`
   - 解压 → `chrome://extensions` → 开开发者模式 → **Load unpacked** 选解压目录
   - 新标签页输入同样的 server 地址 + token → 书签自动汇入，历史自动上报
4. **日常**：
   - **书签** tab：列表/卡片双视图、拖拽排序与移夹、搜索、新建/编辑/删除、主题与壁纸
   - **历史** tab：关键词 / 域名 / 时间段筛选；可编辑「排除域名」（多端同步，扩展采集端即时生效）
   - 手机/平板：直接访问同一地址（可「添加到主屏幕」作为 PWA 安装）
   - 可选：点「✨ 自动分类」让模型给书签提建议（需配置 `CLASSIFIER_*`，见下）

## 可选：自动分类

server 侧配置环境变量即可启用（不配置则功能完全 no-op）：

```ini
CLASSIFIER_URL=http://localhost:8000/v1   # 任意 OpenAI 兼容端点（到 /v1 为止）
CLASSIFIER_MODEL=Qwen3.8-27B
# CLASSIFIER_API_KEY=
# CLASSIFIER_MAX_TOKENS=512               # reasoning 模型需给足预算，否则 content 为空
```

配置后网页会出现「✨ 自动分类」按钮：按需分类未被建议的书签，建议写入 CRDT（多端一致），
用户逐个「接受 / 忽略」。

## 架构

```
Chrome 扩展(MV3) ──书签/历史──► Node server ──Yjs CRDT 星型中继──► Web 应用(newtab 展示)
        └──────────────┬──────────────────────────────┘
                  Yjs Doc(持久化文件) + History(JSONL)
```

- **数据**：Yjs CRDT（内存 doc + 文件快照，2s 防抖）；浏览历史走 append-only JSONL（去重 `url|visitedAt`，上限 1 万条）
- **包结构**：`packages/{server,web,extension}`

## 开发

```sh
pnpm install
pnpm -r test        # 全量测试（纯逻辑 + 自举 server 集成 + stub 模型）
pnpm lint && pnpm typecheck && pnpm -r build
python3 scripts/gen-icons.py   # 重新生成 PWA 图标（仅需 stdlib）
```

浏览器验收测试需要本机 Chrome；可用 `CHROME_BIN=/path/to/chrome` 指定。

## License

[MIT](./LICENSE)
