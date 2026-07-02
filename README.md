# Wario

> **异步 Code Review 收件箱** — Agent push,**异构 Agent 评审**,人类拍板,SQLite 持久化。

> 名字取自任天堂 **Wario** = 日语 **"Warui(悪い)"** + **Mario**。生来就是马里奥的**反面镜像**,天生的**批判者 / 挑剔者** —— 这正是 Code Review 该有的样子。

---

## TL;DR

```bash
pnpm install && pnpm run build
pnpm serve                     # 终端 A:起服务 http://127.0.0.1:7331
wario init                     # 终端 B:初始化 ~/.wario/ + default project

# 生产 Agent(claude code session 里):push,然后 long-poll 等决策
git diff HEAD~1 | wario push --title "登录页 UI 还原" --risk L2 \
  --source claude-code --session-id sess-123
# → Wario fire-and-forget 调 codex(异构)出评审报告
# → codex 评审完就退出,不等人类

# 人类侧:看异构 Agent 的评审报告
wario show rv_xxx --pretty        # 读 codex 的 findings + reviewSessionId

# 人类有疑问?resume 评审 Agent 继续交互(Wario 编排,findings 回写 DB)
wario review resume rv_xxx --question "第 2 条 finding 的 XSS 怎么触发?"
# → Wario spawn `codex exec resume <reviewSessionId>` 喂问题
# → 评审 Agent 在原上下文回答,append 到 preReview.resumeRounds

# 人类最终拍板
wario decide rv_xxx --verdict approve --reviewer alice

# 生产 Agent:long-poll 一直等到决策才返回,在原 session 里继续干
wario wait rv_xxx --timeout 600   # 阻塞等决策(人类不 decide 就一直等)
# wait 返回后,生产 Agent 在原 session 里拿决策继续
```

**核心模式**:
1. **生产 Agent push**(**sessionId 必填**)→ **long-poll 等决策**(不返回,直到人类 decide)
2. **异构 Agent 评审**(claude 写的 codex 评 / codex 写的 claude 评)→ 评审完就退出,Wario 捕获 session ID 存 DB
3. **人类看报告**,有疑问 → **`wario review resume`** 让 Wario spawn `claude --resume <sid>` / `codex exec resume <sid>`,回答 append 到 `preReview.resumeRounds`
4. **人类拍板** decide(approve / reject / comment)
5. **生产 Agent long-poll 返回** → 在原 session 里拿决策继续干

人类**不直接读 diff 找问题**,而是**审异构 Agent 的评审报告** —— 批量、聚焦、按 risk 分级。有疑问不用自己琢磨,直接 `wario review resume` 问评审 Agent。

---

## 是什么

Wario 是一个**独立、可插拔的 Code Review 聚合工作站**。**评审主体是异构 Agent**,人类做最终决策,有疑问可以 resume 评审 Agent 继续问。

```
生产 Agent            Wario            异构 Agent           人类
    │                   │                  │                  │
    │── push ──────────▶│                  │                  │
    │                   │── fire-and-forget│                  │
    │                   │   spawn reviewer │                  │
    │                   │─────────────────▶│                  │
    │                   │                  │── 评审 diff ──────│
    │                   │                  │   (requirement/  │
    │                   │                  │    plan/code)    │
    │                   │◀── findings ─────│                  │
    │                   │   (存 preReview) │                  │
    │                   │                  │ (评审 Agent 退出)│
    │                   │                  │                  │
    │── wait (long-poll)│                  │                  │
    │   阻塞等决策      │── list/show ────────────────────────▶│
    │                   │                  │                  │
    │                   │                  │   有疑问?       │
    │                   │                  │◀── resume ───────│
    │                   │                  │   (追问/补充)    │
    │                   │                  │── 补充 findings ─│
    │                   │                  │   (再退出)       │
    │                   │                  │                  │
    │                   │                  │   拍板           │
    │                   │◀── decide ──────────────────────────│
    │                   │   (存 decision)  │                  │
    │                   │                  │                  │
    │◀── wait 返回 ─────│                  │                  │
    │   (带 verdict)    │                  │                  │
    │                   │                  │                  │
    │ 在原 session 里   │                  │                  │
    │ 拿决策继续干      │                  │                  │
```

**关键设计**:
- **异构 Agent 评审是主流程** — claude 生产的由 codex 评,codex 生产的由 claude 评。同构容易自我确认盲点,异构能互补。
- **评审 Agent 评审完就退出** — fire-and-forget,不阻塞 push。人类有疑问时再 `--resume` 拉起原 session 继续聊。
- **生产 Agent push 后 long-poll 等决策** — 不轮询、不返回,直到人类 decide 才由 Wario 主动推送决策返回。
- **人类只做最终决策** — 不读全 diff,只读异构 Agent 的 findings,按 riskLevel 分级处理。L1 可能看一眼就批,L3 才细看或 resume 追问。
- **Push,不是 Pull** — Agent 主动 push,Wario 不扫文件系统
- **只介入评审环节** — 前面生产、后面部署都不归 Wario 管
- **决策留痕** — 评审报告 + 追问交互 + 决策都是结构化产物,SQLite 持久化

---

## 安装

```bash
git clone <repo> wario
cd wario
pnpm install      # better-sqlite3 需要 native build
pnpm run build    # tsc → dist/
```

**要求**:Node 22+、pnpm。本机需要装 `claude` 和 `codex` CLI(异构评审用)。

**全局安装(可选)**:
```bash
pnpm link --global   # 之后可直接 wario <command>
```

---

## 快速开始

### 1. 初始化

```bash
wario init
```

输出:
```
Home:      ~/.wario/
  config:  ~/.wario/config.json
  logs:    ~/.wario/logs/
  run:     ~/.wario/run/
  skill:   ~/.wario/skill/
DB:        ~/.wario/data.db
Project:   default (p_xxx)
Server:    http://127.0.0.1:7331
```

### 2. 启动服务

```bash
pnpm serve                # 或:wario serve
# Server listening at http://127.0.0.1:7331
```

服务只绑 `127.0.0.1`,不对外。

### 3. 推一条 review(Agent 侧)

```bash
# diff 从 stdin 读
git diff HEAD~1 | wario push \
  --title "登录页 UI 还原" \
  --risk L2 \
  --tags ui-restore,frontend \
  --source claude-code \
  --source-ref task-123 \
  --session-id sess-abc-001

# 返回
{
  "id": "rv_fc92ebe0-...",
  "status": "pending",
  ...
}
```

push 完成后 Wario **立刻 fire-and-forget 调异构 Agent**(claude producer → codex reviewer)出评审报告。Agent 不用等评审完就可以返回。

### 4. 人类看报告 + 决策

**浏览器**:打开 `http://127.0.0.1:7331/` → 选 project → 看 pending 列表 → 点开行展开异构 Agent 的 findings → approve/reject。

**CLI**:
```bash
wario list --status pending           # 看队列(含 riskLevel)
wario show rv_xxx --pretty            # 读异构 Agent 的 findings
wario decide rv_xxx \
  --verdict approve \
  --comment "按 codex 建议改了 XSS" \
  --reviewer alice
```

**关键变化**:人类不读 diff,读**异构 Agent 的评审报告**。L1 可直接批,L2/L3 按 findings 决定 approve / reject / comment。

### 5. Agent 拿到决策

```bash
wario wait rv_xxx --timeout 600
# 阻塞最多 10 分钟,有人 decide 后立即返回
{
  "id": "rv_xxx",
  "status": "decided",
  "decision": {
    "reviewer": "alice",
    "verdict": "approve",
    "comment": "...",
    "decidedAt": "..."
  }
}
```

超时返回非零退出码 + 错误消息,Agent 自己决定重试或退出。

---

## CLI 速查

| 命令 | 用途 |
|------|------|
| `wario init` | 初始化 `~/.wario/` + 创建 default project |
| `wario home` | 打印 Wario home 目录路径 |
| `wario config` | 打印生效配置(JSON) |
| `wario serve [-p 7331] [-H 127.0.0.1]` | 启动 HTTP server |
| `wario project create <slug> [-n name] [-d desc]` | 新建 project |
| `wario project list` | 列所有 project |
| `wario project show <slug>` | 看 project 详情 |
| `wario push --title <t> [...]` | 推 review(走 HTTP) |
| `wario list [--project default] [--status pending\|decided] [--limit 50]` | 列 review |
| `wario show <id> [--pretty]` | 看 review 详情(含异构评审报告) |
| `wario wait <id> --timeout <sec>` | 阻塞等决策(long-poll) |
| `wario decide <id> --verdict approve\|reject\|comment [--comment <c>] [--reviewer <name>]` | 决策 |
| `wario review resume <id> --question <q>` | resume 评审 Agent 问问题,findings 回写 DB |

### `wario push` 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `-t, --title <title>` | ✅ | review 标题 |
| `--project <slug>` | — | 默认 `default` |
| `-d, --description <desc>` | — | 描述 |
| `--diff <path>` | — | diff 文件路径,`-` 表示 stdin(默认) |
| `--risk <L1\|L2\|L3>` | — | Agent 自评风险等级 |
| `--content-type <requirement\|plan\|code>` | — | 默认 `code`,决定评审 prompt |
| `--tags <t1,t2>` | — | 逗号分隔 |
| `--source <name>` | — | 来源系统(claude-code / codex / ...)。**决定异构评审路由** |
| `--source-ref <ref>` | — | 来源系统的关联 ID |
| `--session-id <id>` | ✅ | Agent 会话 ID(必填),Dashboard 按此分组。也读 `WARIO_SESSION_ID` 环境变量 |
| `--by <pushedBy>` | — | 推送者标识,默认 `$USER` |

---

## REST API

所有端点无鉴权,只绑 loopback。

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 列项目 |
| GET | `/api/projects/:slug` | 看项目 |
| POST | `/api/projects/:slug/reviews` | push review(触发异构评审) |
| GET | `/api/projects/:slug/reviews?status=&limit=` | list review |
| GET | `/api/reviews/:id[?wait=N&interval=ms]` | show / long-poll |
| POST | `/api/reviews/:id/decide` | decide |
| POST | `/api/reviews/:id/resume` | resume 评审 Agent,findings 回写 |
| GET | `/` | Dashboard HTML |

### push 示例

```bash
curl -X POST http://127.0.0.1:7331/api/projects/default/reviews \
  -H "content-type: application/json" \
  -d '{
    "projectSlug": "default",
    "pushedBy": "claude-code",
    "sessionId": "sess-abc",
    "title": "登录页 UI 还原",
    "diff": "+ added line",
    "selfAssessedRisk": "L2",
    "contentType": "code",
    "tags": ["ui", "frontend"],
    "source": "claude-code"
  }'
# → push 返回 pending review
# → 后台 fire-and-forget 调 codex 评审(因 source=claude-code)
# → 评审完成后 review.preReview 字段被填充
```

### wait 示例(long-poll)

```bash
# 最多等 60 秒,每 1 秒查一次
curl "http://127.0.0.1:7331/api/reviews/rv_xxx?wait=60&interval=1000"
# 已 decided → 200 + review JSON
# 超时未 decide → 408
# id 不存在 → 404
```

---

## 异构 Agent 评审(主流程)

**这是 Wario 的核心**。不是辅助、不是预审,是**主评审**。

### 为什么异构

- **claude 写的代码用 claude 评** — 同模型同训练偏好,容易自我确认盲点
- **claude 写的用 codex 评** — 不同模型、不同偏好、不同失败模式,互补
- 反之亦然

### 路由规则

| Producer(谁生产的) | Reviewer(谁评审的) | Reason |
|---------------------|---------------------|--------|
| claude              | codex               | heterogeneous |
| codex               | claude               | heterogeneous |
| 其他 / 未识别       | `WARIO_DEFAULT_REVIEWER` | fallback(同构) |

**检测方式**:看 `source` + `pushedBy` 字段里是否含 `claude` 或 `codex` 字样。

### 三种 contentType 的评审重点

| contentType | 评审重点 |
|-------------|----------|
| `requirement` | 完整性、歧义、漏掉的边界 case、不可验证的断言 |
| `plan` | 可行性、缺失依赖、副作用、回滚策略、被低估的风险 |
| `code` | 正确性、安全、性能、风格、缺失测试 |

### 评审输出结构

异构 Agent 输出 JSON,Wario 解析后写入 `review.preReview`:
```json
{
  "byAgent": "codex",
  "riskLevel": "L1|L2|L3",
  "summary": "1-2 句结论",
  "findings": [
    {
      "severity": "low|medium|high|critical",
      "category": "security|correctness|style|perf|a11y",
      "description": "问题是什么",
      "location": "file:line",
      "suggestion": "怎么修"
    }
  ],
  "createdAt": "..."
}
```

### 人类如何用评审报告

- **L1 + findings 为空**:盲批(可能 Dashboard 一键批所有 L1)
- **L2 + 少量 findings**:扫一眼 findings,按建议改或 approve
- **L3 + critical findings**:细看每条 finding + 原始 diff,决定 approve/reject

人类**不再做发现问题的主力**,而是做**最终把关**。

### 触发机制

- push 后 **fire-and-forget** 触发,不阻塞 push 返回
- claude 走 `claude -p --output-format json <prompt>`,解析单 JSON 输出取 `result` + `session_id`
- codex 走 `codex exec --json --skip-git-repo-check <prompt>`,解析 JSONL 取 `thread_id` + `agent_message.text`
- 评审 Agent 的 session ID 存 DB `review_session_id` 列 + `preReview.reviewSessionId` 字段
- 超时 `SIGTERM` 杀子进程(默认 120 秒)
- 评审失败不阻塞 review(只打 warn 日志,`preReview` 字段保持空,人类直接看 diff)
- 输出无法解析时不写 `preReview`,人类降级为直接看 diff

### 人类 resume 评审 Agent

```bash
wario review resume <reviewId> --question "..."
```

Wario 内部:
1. 从 DB 读 `preReview.reviewSessionId` + `preReview.byAgent`
2. spawn `claude --resume <sid>` 或 `codex exec resume <sid>`,把 question 作为 prompt 喂进去
3. 解析输出,构造 `ResumeRound { question, answer, findings?, at }`
4. append 到 `preReview.resumeRounds` 数组,UPDATE DB
5. 返回更新后的 review

如果 review 不存在 → 404;没有 `preReview`(评审 Agent 没跑或失败)→ 409。

### 关闭异构评审

如果你想纯人工评审(不推荐,违背 Wario 设计):

```bash
WARIO_PREREVIEW=disabled wario serve
```

---

## 配置

### `~/.wario/config.json`

`wario init` 生成,可手动编辑。所有字段都可用环境变量覆盖。

```json
{
  "port": 7331,
  "host": "127.0.0.1",
  "dbPath": "~/.wario/data.db",
  "preReview": {
    "enabled": true,
    "claudeCmd": "claude",
    "codexCmd": "codex",
    "defaultReviewer": "claude",
    "timeoutSec": 120
  }
}
```

### 环境变量(覆盖 config.json)

| 变量 | 默认 | 说明 |
|------|------|------|
| `WARIO_HOME` | `~/.wario` | Wario home 目录 |
| `WARIO_PORT` | `7331` | 服务端口 |
| `WARIO_HOST` | `127.0.0.1` | 绑定地址 |
| `WARIO_DB` | `<home>/data.db` | SQLite 路径 |
| `WARIO_BASE_URL` | `http://127.0.0.1:7331` | CLI 走 HTTP 时的 base url |
| `WARIO_PREREVIEW` | `enabled` | 设为 `disabled` 关闭异构评审 |
| `WARIO_CLAUDE_CMD` | `claude` | claude CLI 命令 |
| `WARIO_CODEX_CMD` | `codex` | codex CLI 命令 |
| `WARIO_DEFAULT_REVIEWER` | `claude` | 同构 fallback 时用谁 |
| `WARIO_PREREVIEW_TIMEOUT` | `120` | 异构评审超时(秒) |
| `WARIO_SESSION_ID` | — | push 时默认的 session id |

---

## Dashboard

浏览器开 `http://127.0.0.1:7331/`。

**功能**:
- 项目下拉切换
- 按 sessionId 分组展示(同会话的多次 push 折叠在一起)
- 每行显示:Agent 自评 risk、**异构 Agent 评的 riskLevel**、findings 数量、age、tags
- 异构评审报告可折叠(byAgent、reviewSessionId、summary、findings 列表)
- "追问 Reviewer" 按钮 → prompt 输入 question → 调 `POST /api/reviews/:id/resume` → 刷新
- resumeRounds 历史可折叠(每轮 question + answer + 补充 findings)
- 行内 approve / reject 按钮
- 每 5 秒自动刷新

**没做**:多选批量、详情弹窗、深色模式、过滤器 UI(v1.1)。

---

## 数据模型

### `projects` 表
```sql
id TEXT PRIMARY KEY                  -- p_<uuid>
slug TEXT NOT NULL UNIQUE            -- URL-safe 标识
name TEXT NOT NULL
description TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### `review_requests` 表
```sql
id TEXT PRIMARY KEY                  -- rv_<uuid>
project_id TEXT NOT NULL             -- FK → projects.id
pushed_by TEXT NOT NULL
session_id TEXT NOT NULL             -- 生产 Agent 会话 ID(必填,连接键)
title TEXT NOT NULL
description TEXT
diff TEXT
tags TEXT                            -- JSON array
source TEXT
source_ref TEXT
self_assessed_risk TEXT              -- L1 | L2 | L3 (Agent 自评)
content_type TEXT                    -- requirement | plan | code
status TEXT NOT NULL DEFAULT 'pending'  -- pending | decided
pre_review TEXT                      -- JSON RiskReport(异构 Agent 评审)
review_session_id TEXT               -- 评审 Agent 的 session ID(用于 resume)
decision TEXT                        -- JSON ReviewDecision
created_at TEXT NOT NULL
decided_at TEXT

CREATE INDEX idx_review_requests_project_status ON review_requests(project_id, status);
CREATE INDEX idx_review_requests_created_at ON review_requests(created_at);
CREATE INDEX idx_review_requests_session_id ON review_requests(session_id);
CREATE INDEX idx_review_requests_review_session_id ON review_requests(review_session_id);
```

---

## 开发

```bash
pnpm run build        # tsc → dist/ + 复制 dashboard
pnpm run test         # node:test,54 个用例
pnpm serve            # 起服务
```

### 目录结构

```
wario/
├── bin/wario.js                # Node ESM launcher(优先 dist,fallback tsx)
├── src/
│   ├── cli/wario.ts            # commander 入口
│   ├── server.ts               # Fastify 启动
│   ├── config.ts               # ~/.wario/ + config.json + env 覆盖
│   ├── db/
│   │   ├── index.ts            # better-sqlite3 + migration runner
│   │   └── migrations.ts       # SQL migrations
│   ├── domain/
│   │   ├── project.ts          # project CRUD
│   │   └── review.ts           # push/list/show/decide/wait
│   ├── api/
│   │   ├── projects.ts         # REST handlers
│   │   └── reviews.ts
│   ├── prereview/              # 异构 Agent 评审(核心)
│   │   ├── router.ts           # detectProducer + pickReviewer(异构)
│   │   ├── prompts.ts          # 三种 contentType 的 prompt 模板
│   │   ├── runner.ts           # spawn + timeout + parseRiskReport
│   │   └── index.ts            # orchestrator
│   ├── shared/types.ts         # TS 类型
│   └── public/index.html       # Dashboard
├── tests/
│   ├── db.test.ts
│   ├── review.test.ts
│   ├── api.test.ts
│   └── prereview.test.ts
└── .claude/skills/wario/SKILL.md
```

### 技术栈

| 层 | 选型 |
|----|------|
| Runtime | Node 22+ / TypeScript(ESM, strict) |
| HTTP | Fastify 4 |
| DB | better-sqlite3(WAL,foreign keys on) |
| CLI | commander 12 |
| Test | node --import tsx --test |
| UI | 单 HTML + Tailwind CDN |
| 异构评审 | child_process.spawn 调 claude / codex CLI |

---

## 跟 rotom 的关系

**完全解耦**:
- 不 import rotom 任何代码
- 不依赖 rotom Master / Executor / Dashboard
- 数据库、协议、UI 都是独立的

Wario 的异构评审 prompt 借鉴了 rotom E2ED 的思路(结构化 verdict JSON、四维度评审),但**这是借鉴,不是依赖**。

---

## 已实现 vs 规划

### v1 已实现
- ✅ CLI: `init / serve / home / config / project / push / list / show / wait / decide / review resume`
- ✅ Fastify HTTP server + 10 个 REST 端点(含 resume)
- ✅ SQLite 表 + 4 个 migration(含 review_session_id 列 + 删 artifacts)
- ✅ 无鉴权(仅绑 loopback)
- ✅ 单页 HTML Dashboard(列表 + 行内决策 + session 分组 + 评审报告折叠 + 追问按钮 + resume 历史)
- ✅ **异构 Agent 评审**(claude ↔ codex,fallback 同构)— 主流程
- ✅ 评审 Agent session ID 捕获(claude `--output-format json` / codex `--json` 输出解析)
- ✅ `wario review resume` 编排:spawn `claude --resume` / `codex exec resume`,findings 回写 DB
- ✅ 三种 contentType(requirement / plan / code)
- ✅ 生产 Agent sessionId 必填(连接键 + Dashboard 分组)
- ✅ `~/.wario/` 运行时目录
- ✅ 67 个测试用例全绿

### v1.1+ 规划
- `batch` 批量 decide CLI + Dashboard 多选("一键批所有 L1 + 无 findings")
- `status` 单独命令(非阻塞查)
- 单二进制打包(Node SEA)
- Bearer token 鉴权(需要对外暴露时)
- WebSocket 实时推送(替代 long-poll)
- GitHub PR webhook 自动捕获
- Slack / Email 通知
- 决策回写协议(支持 callback URL,不用 Agent 主动 wait)
- per-project 鉴权 / 多 token 管理
- Dashboard 详情弹窗、过滤器 UI、深色模式
- **L1 无 findings 自动 approve**(v1.1 可选开关)
- **L3 critical findings 自动 reject**(v1.1 可选开关)

---

## 设计文档

本 README 是使用文档。设计背景(行业数据、为什么要做、跟 rotom 的关系、Open Questions、MVP scope 取舍)见 [docs/design.md](./docs/design.md)。

---

## License

MIT
