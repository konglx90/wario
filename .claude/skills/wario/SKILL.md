---
name: wario
description: Wario — 异步 Code Review 队列(位于 /Users/kong/ai-work/wario)。当用户提到"wario"、"review queue"、"代码评审聚合"或要求给 wario 加新功能/修 bug 时使用。
---

# Wario

异步 Code Review 收件箱,位置 `/Users/kong/ai-work/wario/`。Agent 推 review,人类批量 decide,SQLite 持久化。内置异构 Agent 预审(claude → codex / codex → claude,无法识别则 fallback 同构)。

## 常用命令
```bash
cd /Users/kong/ai-work/wario
pnpm install          # 装依赖(better-sqlite3 需要 native build)
pnpm run build        # tsc → dist/ + 复制 dashboard
pnpm run test         # node:test 跑全部
pnpm serve            # 起服务(127.0.0.1:7331)
node bin/wario.js init   # 初始化 ~/.wario/ + 创建 default project
node bin/wario.js home   # 打印 home 路径
node bin/wario.js config # 打印生效配置
```

## Agent 自动化核心:wait 协议
Agent 推完 review 后 **必须 wait**,否则拿不到决策:
```bash
wario push --title "..." --risk L2 --tags ui,frontend --source claude-code --session-id sess-123
wario wait <reviewId> --timeout 600   # 阻塞直到人类决策
# 输出 JSON: { verdict, comment, reviewer, decidedAt, ... }
# Agent 读到 verdict 后继续(merge / fix / 通知)
```
HTTP 等价:`GET /api/reviews/:id?wait=N&interval=1000`(超时返回 408)。

## 技术栈
- Node 22+ / TypeScript(ESM, strict)
- Fastify(REST API)
- better-sqlite3(DB 在 `~/.wario/data.db`,可用 `WARIO_DB` 覆盖;home 用 `WARIO_HOME` 覆盖)
- commander.js(CLI)
- 单 HTML + Tailwind CDN(Dashboard)
- child_process.spawn 调 claude/codex CLI(异构预审)

## 运行时目录 `~/.wario/`
```
~/.wario/
├── config.json   # 端口 / DB / pre-review 配置
├── data.db       # SQLite(better-sqlite3)
├── logs/         # 日志
├── run/          # 运行时文件(pid 等)
└── skill/        # 预留,放给 Agent 的 skill 文档
```

## 源码导览
- `src/cli/wario.ts` — CLI 入口,review 相关命令走 HTTP,init/project 直连 DB
- `src/server.ts` — Fastify 服务,绑 127.0.0.1;`/api/health` + Dashboard `/`
- `src/config.ts` — `warioHome()` / `loadConfig()` / `initHome()`,环境变量覆盖
- `src/db/index.ts` + `src/db/migrations.ts` — SQLite 连接 + migration runner
- `src/domain/project.ts` + `src/domain/review.ts` — 业务逻辑(push/list/show/decide/wait)
- `src/api/projects.ts` + `src/api/reviews.ts` — REST handlers
- `src/prereview/router.ts` — 检测 producer,异构 vs 同构 fallback
- `src/prereview/prompts.ts` — requirement/plan/code 三种 prompt 模板
- `src/prereview/runner.ts` — child_process.spawn + 超时 SIGTERM
- `src/prereview/index.ts` — orchestrator:detect producer → pick reviewer → spawn CLI → parse → 写回 DB
- `src/public/index.html` — Dashboard 单页(项目下拉 + 按 sessionId 分组 + pre-review 可折叠)
- `tests/db.test.ts` + `tests/review.test.ts` + `tests/api.test.ts` + `tests/prereview.test.ts` — node:test

## 关键约定
- **无鉴权**(v1),仅绑 loopback,schema 不预留 tokens 表
- **多 project** 从 v1 起:`projects` 表 + `review_requests.project_id`,CLI 默认 `--project default`
- **sessionId**:Agent 同一会话的多次 push 用同一 `--session-id`,Dashboard 按 session 分组
- **pre-review**:push 后 fire-and-forget 跑异构 Agent 预审(默认开),结果存 `review_requests.pre_review`
  - claude producer → codex reviewer;codex producer → claude reviewer;其他 → `WARIO_DEFAULT_REVIEWER`(默认 claude)
  - 关闭:`WARIO_PREREVIEW=disabled`;超时:`WARIO_PREREVIEW_TIMEOUT`(秒,默认 120)
- **diff 从 stdin 读**(默认)避免 shell 转义;`--diff <path>` 走文件
- **contentType**:`requirement` / `plan` / `code`(默认),决定 prompt 模板
- **端口 7331**(`WARIO_PORT` 覆盖);**base url** 走 `WARIO_BASE_URL`(默认 `http://127.0.0.1:7331`)
- **publish 形态**:npm 包(`bin/wario.js` Node ESM launcher,优先 `dist/`,fallback `tsx src/`) + 单二进制(Node SEA,v1.1)
- **决策不可改**:已 decided 的 review 再 decide 返回 409

## REST 速查
| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 列项目 |
| GET | `/api/projects/:slug` | 看项目 |
| POST | `/api/projects/:slug/reviews` | push review |
| GET | `/api/projects/:slug/reviews?status=&limit=` | list review |
| GET | `/api/reviews/:id[?wait=N&interval=ms]` | show / long-poll |
| POST | `/api/reviews/:id/decide` | decide(verdict: approve/reject/comment) |
| GET | `/` | Dashboard HTML |

## 完整设计
见 `/Users/kong/ai-work/wario/README.md`(数据模型、协议、MVP scope、未来迭代)。