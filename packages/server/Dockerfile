# 多阶段构建（能力块 13 · ①）
# 背景: 原 Dockerfile 只跑 `pnpm --filter server build` —— 容器里没有 web 产物、没有 extension.zip,
# 于是 /extension.zip 落到 HTML 兜底页 → 用户下载到 201 字节 HTML = "插件格式损坏"（其他机器部署时复现）。
# 现在: builder 构建 server + web（含扩展 zip）, runner 只带产物（server bundle 是单文件 CJS, 无需 node_modules）。

# ---------- builder ----------
FROM node:24-alpine AS builder
WORKDIR /app
# zip/unzip 用于打包与自检扩展（与 CI 同款; 必须**保留目录结构**: vite 产物含 assets/ 子目录）
RUN apk add --no-cache zip unzip
RUN corepack enable
COPY . .
# 注意: .dockerignore 排除了 **/dist → 扩展产物必须**在这里构建**（否则 zip 无输入、test -f 必挂）
# 注意: pnpm --filter 名字写错会**静默退出 0**（本仓库坑点）→ 扩展包名是 @bnt/extension, 不是 extension
RUN pnpm install --frozen-lockfile \
  && pnpm --filter server build \
  && pnpm --filter web build \
  && pnpm --filter @bnt/extension build \
  && test -f packages/extension/dist/manifest.json \
  && (cd packages/extension/dist && zip -qr /app/packages/web/dist/extension.zip .) \
  && node scripts/check-ext-zip.mjs packages/web/dist/extension.zip \
  && test -f packages/web/dist/extension.zip \
  && test -f packages/web/dist/index.html

# ---------- runner ----------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# 保持 packages/{server,web}/dist 的相对布局: server 以 __dirname 推导 web 产物路径（../../web/dist）
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist ./packages/web/dist
# 说明: server 默认端口是 8090（PORT ?? 8090）; docker-compose.yml 里显式设 PORT=3000 + HOST=0.0.0.0
# → 这里的 EXPOSE 与 compose 保持一致; 直接 docker run 时请自行传 PORT/HOST
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
