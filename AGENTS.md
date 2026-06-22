# AGENTS.md

指南给在本仓库工作的 coding agent(Codex / Claude Code / 其他)。读完后你应该能独立完成 feature、修 bug、跑测试、推 review。

## 这是什么

**Wario** —— 异步 Code Review 收件箱。Agent 推 review request(push title + diff + 元数据),Wario fire-and-forget 跑**异构 Agent 预审**(claude 写的 codex 评 / codex 写的 claude 评),人类在 Dashboard 拍板,生产 Agent long-poll 等决策。SQLite 持久化,仅绑 loopback,无鉴权(v1)。

名字:Wario = "Warui(悪い)" + Mario,生来是马里奥的反面镜像,天生的挑剔者 —— Code Review 该有的样子。

## 技术栈

- **Node 22+ / TypeScript**(ESM,strict)— import 必须带 `.js` 扩展名(tsc 不做 path rewriting)
- **Fastify** 4.x — REST API
- **better-sqlite3** — DB 在 `~/.wario/data.db`,migration 在 `src/db/migrations.ts`
- **commander.js** — CLI(`bin/wario.js` Node ESM launcher,优先 `dist/`,fallback `tsx src/`)
- **child_process.spawn** — 调 claude/codex/ocr CLI
- 单 HTML + **Tailwind CDN** — Dashboard,无前端构建链路

## 常用命令

```bash
pnpm install          # 装依赖(better-sqlite3 需要 native build)
pnpm run build        # tsc → dist/ + 复制 dashboard HTML
pnpm run test         # node:test 跑 tests/*.test.ts
pnpm serve            # 起服务 127.0.0.1:7331

node bin/wario.js init      # 初始化 ~/.wario/ + 创建 default project
node bin/wario.js home      # 打印 home 路径
node bin/wario.js config    # 打印生效配置
```

测试 74 个,跑完约 2 分钟(有几个 waitForDecision 异步测试)。改了 prereview 相关代码后**务必本地跑一遍** `pnpm run test`。

## 运行时目录 `~/.wario/`

```
~/.wario/
├── config.json   # 端口 / DB / pre-review 配置
├── data.db       # SQLite
├── logs/
├── run/          # pid 等
└── skill/        # 预留
```

可用 `WARIO_HOME` 覆盖 home,`WARIO_DB` 覆盖 DB 路径。demo / 测试时常用:

```bash
WARIO_HOME=/tmp/wario-demo WARIO_DB=/tmp/wario-demo.db WARIO_PORT=7331 node dist/server.js
```

## 源码导览

| 路径 | 职责 |
|------|------|
| `bin/wario.js` | Node ESM launcher,优先 `dist/`,fallback `tsx src/` |
| `src/cli/wario.ts` | CLI 入口,review 相关命令走 HTTP,init/project 直连 DB |
| `src/server.ts` | Fastify 服务,绑 127.0.0.1;`/api/health` + Dashboard `/` |
| `src/config.ts` | `warioHome()` / `loadConfig()` / `initHome()`,环境变量覆盖 |
| `src/db/index.ts` + `src/db/migrations.ts` | SQLite 连接 + migration runner(migration 必须幂等,用 `PRAGMA table_info` 检查列是否存在再 ALTER) |
| `src/domain/project.ts` + `src/domain/review.ts` | 业务逻辑(push/list/show/decide/wait),`rowToReview` 反序列化 |
| `src/api/projects.ts` + `src/api/reviews.ts` | REST handlers |
| `src/prereview/router.ts` | 检测 producer(claude/codex/unknown),异构路由 |
| `src/prereview/prompts.ts` | requirement / plan / code 三种 prompt 模板 |
| `src/prereview/runner.ts` | spawn claude CLI + `runReviewerCli` 分发,**codex 走 `codex-server.ts`** |
| `src/prereview/codex-server.ts` | codex app-server JSON-RPC 2.0 client(参考 rotom) |
| `src/prereview/ocr.ts` | spawn `ocr review --format json --audience agent` |
| `src/prereview/index.ts` | orchestrator:detect producer → pick reviewer → spawn → parse → 写回 DB + status |
| `src/shared/types.ts` | 所有共享类型 |
| `src/public/index.html` | Dashboard 单页(项目下拉 + 按 sessionId 分组 + pre-review/ocr 可折叠) |
| `tests/*.test.ts` | node:test |

## 关键约定

### 数据模型
- **无鉴权**(v1),仅绑 loopback,schema 不预留 tokens 表
- **多 project**:`projects` 表 + `review_requests.project_id`,CLI 默认 `--project default`
- **sessionId**:Agent 同一会话的多次 push 用同一 `--session-id`,Dashboard 按 session 分组
- **决策不可改**:已 decided 的 review 再 decide 返回 409

### Pre-review(异构 agent)
- push 后 fire-and-forget 跑(默认开,`WARIO_PREREVIEW=disabled` 关)
- 路由:claude producer → codex reviewer;codex producer → claude reviewer;其他 → `WARIO_DEFAULT_REVIEWER`(默认 claude)
- **codex 调用方式**:`codex app-server --listen stdio://` 走 JSON-RPC 2.0,**不是** `codex exec`。参考 `/Users/kong/ai-work/rotom/src/executor/executors/codex.ts`
- **claude 调用方式**:`claude -p --output-format json <prompt>`,响应是一个 JSON 对象 `{result, session_id}`
- 超时:`WARIO_PREREVIEW_TIMEOUT`(秒,默认 120)
- **状态持久化**:push 后立刻写 `attempted_reviewer` + `prereview_status='running'`,完成写 `succeeded` / `failed` / `timeout`。Dashboard 头部显示 `reviewer: codex running/succeeded/failed/timeout` 徽章,不用翻日志
- `resumeReview`:`POST /api/reviews/:id/resume`,带 `resumeSessionId` 走 `thread/resume`(codex)或 `--resume`(claude),在原 session 继续对话,findings 回写 `preReview.resumeRounds[]`

### OCR 对比评审
- `WARIO_OCR=enabled` 时,push code 类 review 且带 `repoPath`/`gitFrom`/`gitTo`,并行跑 Alibaba `ocr review --format json --audience agent`
- 三字段不持久化,只在 push 那一刻的内存对象上用;缺任一或 `contentType≠code` 则跳过
- OCR 无 severity/riskLevel,wario 派生:severity 全标 `medium`,riskLevel 按 findings 数(0=L1, 1-2=L2, 3+=L3)
- 失败(超时/退出码非 0/不可解析)静默 warn,不影响异构 agent review
- 状态写 `ocr_status` 列,Dashboard 显示 `reviewer: ocr *` 徽章

### CLI / HTTP
- **diff 从 stdin 读**(默认,`--diff -`)避免 shell 转义;`--diff <path>` 走文件
- **contentType**:`requirement` / `plan` / `code`(默认),决定 prompt 模板
- **端口 7331**(`WARIO_PORT` 覆盖);**base url** 走 `WARIO_BASE_URL`(默认 `http://127.0.0.1:7331`)

## 环境变量速查

| 变量 | 默认 | 作用 |
|------|------|------|
| `WARIO_HOME` | `~/.wario` | home 目录 |
| `WARIO_DB` | `<home>/data.db` | SQLite 路径 |
| `WARIO_PORT` | `7331` | 服务端口 |
| `WARIO_BASE_URL` | `http://127.0.0.1:7331` | CLI 连服务用 |
| `WARIO_PREREVIEW` | (未设=开) | `disabled` 关 pre-review |
| `WARIO_PREREVIEW_TIMEOUT` | `120` | 秒 |
| `WARIO_DEFAULT_REVIEWER` | `claude` | unknown producer 的 fallback |
| `WARIO_CLAUDE_CMD` | `claude` | claude 二进制 |
| `WARIO_CODEX_CMD` | `codex` | codex 二进制 |
| `WARIO_OCR` | (未设=关) | `enabled` 开 OCR 对比 |
| `WARIO_OCR_CMD` | `ocr` | ocr 二进制 |
| `WARIO_OCR_TIMEOUT` | `300` | 秒(OCR 多文件并发,比单 agent 调用慢) |
| `WARIO_OCR_MODEL` | (未设) | 透传 `--model` |

## REST 速查

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 列项目 |
| GET | `/api/projects/:slug` | 看项目 |
| POST | `/api/projects/:slug/reviews` | push review(fire-and-forget 触发 pre-review + ocr) |
| GET | `/api/projects/:slug/reviews?status=&limit=` | list |
| GET | `/api/reviews/:id?wait=N&interval=ms` | show / long-poll(超时返回 408) |
| POST | `/api/reviews/:id/decide` | decide(verdict: approve/reject/comment) |
| POST | `/api/reviews/:id/resume` | 追问 reviewer |
| GET | `/` | Dashboard HTML |

## Agent 自动化核心:wait 协议

Agent 推完 review 后 **必须 wait**,否则拿不到决策:

```bash
wario push --title "..." --risk L2 --tags ui,frontend --source claude-code --session-id sess-123 \
  --content-type code \
  --repo-path "$(pwd)" --git-from main --git-to HEAD   # 可选,触发 OCR 对比
wario wait <reviewId> --timeout 600   # 阻塞直到人类决策
# 输出 JSON: { verdict, comment, reviewer, decidedAt, ... }
```

## 改动检查清单

提 PR / commit 前自检:

- [ ] `pnpm run build` 绿(tsc strict)
- [ ] `pnpm run test` 74 个全绿
- [ ] 改了 DB schema → 加新 migration(`id` 递增,`PRAGMA table_info` 幂等检查)
- [ ] 改了 `shared/types.ts` → `domain/review.ts` 的 `ReviewRow` + `rowToReview` 同步
- [ ] 改了 prompt 模板 → `tests/prereview.test.ts` 的 `buildPrompt` 断言可能要更新
- [ ] 改了 Dashboard 渲染 → `renderReport(report, opts)` 是共用的,pre-review 和 ocr 都走它
- [ ] 改了 codex 调用 → 参考 rotom 的 `codex.ts`,`app-server` JSON-RPC,不要回退到 `exec`
- [ ] 新增 env 变量 → 更新本文件 + `.claude/skills/wario/SKILL.md`

## 不要做

- 不要用 `codex exec` —— 程序化驱动必须走 `codex app-server --listen stdio://` JSON-RPC。`exec` 是 shell 一次性调用,会报 "Reading additional input from stdin..." 且无法稳定拿 sessionId
- 不要在 migration 里假设列不存在就直接 `ALTER TABLE` —— 用 `PRAGMA table_info` 检查,旧 DB 可能已经手动加过列
- 不要把 `repoPath`/`gitFrom`/`gitTo` 持久化到 DB —— 这三字段只在 push 那一刻的内存对象上用,给 `runOcrReview` 消费
- 不要给 pre-review / ocr 失败抛异常 —— fire-and-forget 必须静默 warn + 写 `failed` status,不能影响 push 响应
- 不要给 Dashboard 引入前端构建链路 —— 单 HTML + Tailwind CDN 是刻意的,保持零构建
- 不要加鉴权 / 跨网络暴露 —— v1 仅 loopback,schema 不预留 tokens 表

## 完整设计文档

见 `README.md`(数据模型、协议、MVP scope、未来迭代)和 `.claude/skills/wario/SKILL.md`(skill 视角的速查)。`demos/` 有三个 contentType 的真实 push 示例 + 执行结果。
