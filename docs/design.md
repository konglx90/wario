# Wario(设计文档)

> **异步评审收件箱** — 把 Code Review 从"被卡住"变成"批处理"

> 名字取自任天堂 **Wario**（瓦力欧）。**Wario** = 日语 **"Warui（悪い）"**（意为"坏"）+ **"Mario"** —— 生来就是马里奥的**反面镜像**与**竞争对手**。

> 在评测文化里，"挑刺"、"批判"、"找缺点" 是核心动作。瓦里奥天生就是 **批判者** 和 **挑剔者**：他不像马里奥那样永远正能量满满，他更现实、更尖锐、更敢说真话（哪怕是为了钱或嫉妒）。这正是 Code Review 该有的样子 —— **不客气地指出问题，不留情面地暴露风险**。

> **W-A-R-I-O** vs **R-E-V-I-E-W** —— 同样五个字母，藏着 R / I / W 的三连。巧合，但不是偶然。

---

## TL;DR

- **项目定位**：一个**独立、可插拔的 Code Review 聚合工作站**。Agent 把待评审内容 push 进来，Wario 攒成一队列，人类按风险 / 等待时长批量处理。
- **核心模式**：`Agent push → Wario 队列聚合 → Human 批量 decide → 决策回写 Agent`，**异步 by default**。
- **技术栈**：Node 22 + TypeScript + SQLite + Fastify + 极简 HTML Dashboard。
- **解耦原则**：**zero dependency on rotom**。不 import rotom 任何代码，不复用 rotom Master/Executor/Dashboard。rotom E2ED 未来可以 opt-in 通过 HTTP 调用，但这是 rotom 的事。

---

## 一、起源：用户原话与意图

> 「用户可以用 claude code 或者用 codex 起 n 个任务，但这些任务里都有可能触发评审，会被我的服务采集到，采集后可以聚合在一起去一起评审。」

> 「我只想去做评审的科学的事情...到了需要评审的环节，我们可以统一收集，统一给他评审，然后统一通过，进入到下一阶段。」

> 「我要做一个单独的工具，不要跟 rotom 耦合。」

**核心需求拆解**：
1. 任何 Agent（Claude Code / Codex / rotom E2ED / 其他）**主动 push** 待评审内容
2. Wario **统一收集 + 持久化**
3. 人类评审者**批量处理**（按 risk 排序、批量 approve）
4. 决策**回写到原任务**
5. 完全**独立于 rotom**

---

## 二、为什么要做这件事（背景）

### 行业数据：瓶颈已经转移

参考 [Addy Osmani - Code Review in 2026](https://addyosmani.com/blog/code-review-in-2026) 等数据：

| 来源 | 数据 |
|------|------|
| GitClear | AI 时代代码量 **4x**，但交付价值只 **+10%** |
| Faros AI (2026/3) | 审查时间中位数 **+441.5%**，零审查合并 PR **+31.3%** |
| Anthropic Code Review | 实质审查覆盖率 **16% → 54%**（用工具之后） |
| CodeRabbit | AI 写的代码问题数是人工的 **1.7x** |

**核心论点**（Addy Osmani 原文）：

> "The bottleneck of software engineering has moved from 'writing code' to 'verifying code'."

> "Triage is the new core activity."

> "Stop reviewing everything with the same depth. Tier by risk."

> "Human on the loop, not in the loop."

### 我们自己的痛点

rotom 项目（`/Users/kong/ai-work/rotom`）的 E2ED 模块已经实现：
- Claude 生产 + Codex 评审（异构 Agent）
- 8 状态机 + 评分体系（80/50/0 三档）
- `--fix` 修复闭环

但 E2ED 太重：必须从它开始、中间用它、最后用它结束。**真实场景下"评审"是独立环节**——Agent 可能在 Claude Code 里直接写代码，方案可能写在 Notion 里，这些工作流根本不愿用 E2ED 这套重系统。

**机会**：把"评审"这个**最稀缺、人类最不可替代**的环节单独抽出来，做成**轻量、异步、可插拔**的工作站。

---

## 三、核心模式：异步评审收件箱

Wario 的本质是一个**持久化的待办队列**——Agent 是发件人，人类是处理人，Wario 是中间那个邮箱。

```
┌──────────────┐  push   ┌──────────────┐  list+decide  ┌──────────────┐
│  Claude Code │ ──────▶ │              │ ────────────▶ │   人类评审者 │
│  (任务1完成) │         │              │               │  (批量处理)  │
├──────────────┤  push   │    Wario     │               ├──────────────┤
│  Codex       │ ──────▶ │   (收件箱)   │               │  决策回写    │
│  (任务2完成) │         │              │               │              │
├──────────────┤  push   │              │               │              │
│  rotom E2ED │ ──────▶ │              │               │              │
│  (未来可选)  │         │              │               │              │
├──────────────┤  push   │              │               │              │
│  其他工具    │ ──────▶ │              │               │              │
└──────────────┘         └──────┬───────┘               └──────┬───────┘
                                │                              │
                                │     wait / status            │
                                └──────────◀───────────────────┘
                                          决策回到原任务
```

**关键原则**：
- **Push vs Pull**：Agent 主动 push，Wario 不用扫文件系统
- **同步 vs 异步决策**：异步为主（人类速度 < Agent 速度，强行同步会卡死 Agent）
- **不绑定工作流**：只介入"评审"环节，前后端都可以是任何东西
- **决策留痕**：评审结果本身就是结构化产物

---

## 四、架构

### 4.1 组件

```
┌────────────────────────────────────────────────────────┐
│                    Wario Server                         │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ REST API │  │  SQLite  │  │  Auth    │  │  Hooks   │ │
│  │ Fastify  │  │ better-  │  │ Bearer   │  │ (v2+)    │ │
│  └────┬────┘  │ sqlite3  │  │ token    │  └──────────┘ │
│       │        └────┬─────┘  └──────────┘                │
│       │             │                                    │
│  ┌────▼─────────────▼──────────────────────────────┐    │
│  │  Business Logic                                  │    │
│  │  • push  • list  • show  • decide  • batch       │    │
│  │  • pre-review trigger (v2)  • risk classifier   │    │
│  └──────────────────────────────────────────────────┘    │
│       │                                                   │
│  ┌────▼──────────────────────────────────────────────┐    │
│  │  Embedded HTML Dashboard (vanilla + Tailwind)     │    │
│  └───────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────┘
            ▲                                ▲
            │ HTTP / CLI                     │ CLI
            │                                │
   ┌────────┴────────┐                ┌───────┴──────┐
   │  Any Agent      │                │  Human via   │
   │  (HTTP/curl)    │                │  CLI / Web   │
   └─────────────────┘                └──────────────┘
```

### 4.2 协议

| 渠道 | 形态 | 用途 |
|------|------|------|
| **CLI** | `wario <subcmd>` | Agent push、人类 list/decide |
| **HTTP REST** | `POST /api/reviews` 等 | 任意语言 / 工具集成 |
| **WebSocket** (v2) | `/ws` | 实时推送新 review 通知 |
| **Dashboard** | 单页 HTML | 人类评审主界面 |

### 4.3 鉴权

- **API token (Bearer)** — Agent 推 review 用
- **Cookie session** (Dashboard 用，可选)
- 单一 token / 多 token / OAuth 留作 v2 决策

---

## 五、三个核心调用点

### 5.1 Agent 侧 — push

```bash
wario push \
  --title "登录页 UI 还原" \
  --context "需求: 实现 Figma xxx 登录页" \
  --diff <(git diff HEAD~1) \
  --tags "ui-restore,frontend" \
  --risk self-assessed:L2 \
  --token $WARIO_TOKEN

# 返回
{
  "reviewId": "rv_abc123",
  "status": "pending",
  "createdAt": "2026-06-21T21:00:00Z"
}
```

**关键设计**：
- `push` 必须**极轻**（1 个 HTTP call 完事）
- `diff` 可选从 stdin 读（避免 shell 转义问题）
- `self-assessed risk` 由 Agent 自评（Wario 可在 v2 用异构 Agent 复核）
- 必填：title；其他都是 optional

### 5.2 人类侧 — list / show / decide / batch

```bash
# 看队列
wario list --status pending --sort risk --limit 20

# 看详情
wario show rv_abc123 --pretty

# 单条决策
wario decide rv_abc123 --verdict approve --comment "LGTM"
wario decide rv_xyz789 --verdict reject --comment "登录态校验漏了"

# 批量（v1 就要支持）
wario batch --verdict approve --ids rv_1,rv_2,rv_5
wario batch --verdict reject --ids rv_3 --comment "需要重构"
```

**Dashboard 视图**（待设计）：
- 按 risk / 等待时长排序
- 多选 + 批量 approve 按钮
- 显示 self-assessed risk + (v2) AI pre-review
- 一键 "Mark all L1 as approved"

### 5.3 Agent 侧 — wait / status

```bash
# 同步等（带超时）
wario wait rv_abc123 --timeout 600
# 阻塞直到有人 decide，或超时
# 返回: { verdict, comment, decidedAt, reviewer }

# 异步查
wario status rv_abc123
# 返回当前状态

# WebSocket 订阅（v2）
wario subscribe rv_abc123
# 收到决策时立即推送
```

**为什么默认异步**：
- 人类批处理速度 < Agent 完成速度
- Agent 不应该阻塞在评审上
- Agent 可以"做完一波就退出"，决策由人工后续处理

---

## 六、数据模型

### 6.1 TypeScript 接口

```typescript
type RiskLevel = 'L1' | 'L2' | 'L3';
type Verdict = 'approve' | 'reject' | 'comment';

interface ReviewRequest {
  id: string;                       // "rv_<uuid>"
  pushedBy: string;                 // agent name / system tag
  context: {
    title: string;
    description?: string;
    diff?: string;                  // 完整 diff 文本
    artifacts?: Array<{
      name: string;
      uri?: string;
      mimeType?: string;
    }>;
    tags?: string[];
    source?: string;                // 哪个上游系统（"rotom-e2ed" / "claude-code" / ...）
    sourceRef?: string;             // 上游系统的关联 ID
  };
  selfAssessedRisk?: RiskLevel;
  status: 'pending' | 'decided';
  preReview?: RiskReport;           // v2: 异构 Agent 预审结果
  decision?: ReviewDecision;
  createdAt: string;                // ISO 8601
  decidedAt?: string;
}

interface RiskReport {
  byAgent: string;                  // 哪个 Agent 出的预审
  riskLevel: RiskLevel;
  summary: string;
  findings: Array<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;               // 'security' / 'correctness' / 'style' / 'perf' / 'a11y' ...
    description: string;
    location?: string;              // file:line
    suggestion?: string;
  }>;
  createdAt: string;
}

interface ReviewDecision {
  reviewer: string;                 // 人类评审者 ID
  verdict: Verdict;
  comment?: string;
  decidedAt: string;
}
```

### 6.2 SQLite Schema (draft)

```sql
CREATE TABLE review_requests (
  id TEXT PRIMARY KEY,
  pushed_by TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  diff TEXT,
  artifacts TEXT,                 -- JSON array
  tags TEXT,                      -- JSON array
  source TEXT,
  source_ref TEXT,
  self_assessed_risk TEXT,        -- 'L1' | 'L2' | 'L3'
  status TEXT NOT NULL DEFAULT 'pending',
  pre_review TEXT,                -- JSON RiskReport
  decision TEXT,                  -- JSON ReviewDecision
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX idx_review_requests_status ON review_requests(status);
CREATE INDEX idx_review_requests_created_at ON review_requests(created_at);
CREATE INDEX idx_review_requests_self_assessed_risk ON review_requests(self_assessed_risk);
CREATE INDEX idx_review_requests_pushed_by ON review_requests(pushed_by);

-- v2+ 预留
CREATE TABLE review_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  event TEXT NOT NULL,            -- 'pushed' / 'pre-reviewed' / 'decided' / ...
  actor TEXT NOT NULL,
  payload TEXT,                   -- JSON
  at TEXT NOT NULL
);
```

---

## 七、MVP Scope

### 7.1 IN (v1, 目标 1-2 周)

- [ ] CLI: `push / list / show / decide / batch / wait / status`
- [ ] Fastify HTTP server: `POST /api/reviews`, `GET /api/reviews`, `GET /api/reviews/:id`, `POST /api/reviews/:id/decide`
- [ ] SQLite 表 + migrations
- [ ] API token 鉴权（Bearer）
- [ ] 极简 HTML Dashboard（单页 + Tailwind CDN）
  - 队列列表（按 risk / 时间排序）
  - 多选 + 批量 approve/reject
  - 单条详情查看（diff 渲染、context 展示）
- [ ] 基础测试（CLI 端到端、API 集成）
- [ ] 单二进制打包（`wario` 直接跑）

### 7.2 OUT (v2+)

- 异构 Agent 预审（Claude + Codex 双视角，v1 push 时可选触发）
- 自动 risk 分级（v1 仅 self-assessed，v2 异构 Agent 复核）
- WebSocket 实时推送
- GitHub PR 自动捕获（webhook）
- 通知（Slack / Email / Webhook）
- 团队 / 多 project 隔离
- OAuth / 多 token 管理
- 决策回写协议（push 端订阅决策事件）

---

## 八、技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| Runtime | Node 22 + TypeScript | 跟 rotom 一致，生态成熟 |
| HTTP | Fastify | 比 express 快 2-3x，schema-first（用 Zod/TypeBox） |
| DB | SQLite (better-sqlite3) | 嵌入式，零运维，单机够用 |
| CLI | commander.js | 简单稳，不花哨 |
| Test | node --import tsx --test | 内置 runner，零依赖 |
| UI | 单页 HTML + Tailwind CDN | 无需 SPA 框架，1 个 HTML 文件搞定 |
| Build | tsc → dist/ | 标准 TS 工作流 |
| Package | 单二进制（`wario` 脚本） + npm 包 | 两手准备 |

**目录结构草案**：

```
wario/
├── README.md                # 本文档
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── server.ts            # Fastify 启动入口
│   ├── db.ts                # SQLite + migrations
│   ├── auth.ts              # token 校验
│   ├── api/
│   │   └── reviews.ts       # REST endpoints
│   ├── cli/
│   │   └── wario.ts         # CLI 入口（commander）
│   ├── domain/
│   │   ├── review.ts        # 核心逻辑（push/list/decide）
│   │   └── risk.ts          # risk 分级规则
│   ├── public/              # 静态资源（dashboard）
│   │   └── index.html       # 单页 Dashboard
│   └── shared/
│       └── types.ts         # 共享 TS 类型
├── tests/
│   ├── review.test.ts
│   └── api.test.ts
└── dist/                    # 编译产物
```

---

## 九、跟 rotom 的关系

**完全解耦**：
- Wario **不 import** rotom 任何代码
- **不依赖** rotom Master / Executor / Dashboard
- 数据库、协议、UI 都是独立的

**未来 rotom E2ED 可以 opt-in 调用 Wario**（可选，非必须）：

```
rotom E2ED 当前流程：
  Claude 生产 → Codex 评审 → 评分 → --fix 循环

rotom E2ED 未来（可选）：
  Claude 生产 → POST 到 Wario → Wario 异构预审 + 人工 decide
                                   ↓
                            决策回写到 rotom E2ED
```

**Wario 的 review prompt 可以参考** rotom E2ED 的 `src/e2ed/prompts.ts`（四维度评分、结构化 verdict JSON），但**这是借鉴，不是依赖**。

---

## 十、待讨论（Open Questions）

- [ ] **发布形态**：单二进制 vs npm 包 vs 都要？
- [ ] **鉴权**：v1 一个全局 token 够用吗？还是一开始就要多 token / per-project？
- [ ] **WebSocket**：v1 就要还是 v2？
- [ ] **命名空间**：默认单 project 还是多 project（v1 怎么取舍）？
- [ ] **diff 大小**：超长 diff 怎么存（截断 / 文件引用 / 外链）？
- [ ] **回写协议**：Agent 怎么收到决策？轮询 / 长连 / Webhook 哪种？
- [ ] **Dashboard 范围**：v1 单页够用吗？还是直接上 Vue/React SPA？

---

## 十一、Next Steps（启动下一轮 Claude Code 时）

1. **先拍板技术栈**：v1 范围、发布形态、鉴权方式
2. **脚手架搭建**：`package.json` + `tsconfig.json` + 目录结构
3. **数据层先行**：SQLite schema + migrations + 基础 CRUD
4. **CLI 落地**：`push / list / show` 三个最常用命令先打通
5. **REST 端点**：跟 CLI 共用底层逻辑
6. **Dashboard**：单页 HTML，先 list + 详情
7. **批量操作**：`batch decide`
8. **测试**：CLI 端到端 + API 集成
9. **README / 部署文档**

---

## 十二、参考资料

### 12.1 行业文章
- [Addy Osmani - Code Review in 2026](https://addyosmani.com/blog/code-review-in-2026) — 本项目立项的核心驱动
- [Addy Osmani - The Verification Bottleneck](https://addyosmani.com/blog/verification-bottleneck)
- [Addy Osmani - Loop Engineering](https://addyosmani.com/blog/loop-engineering/)
- [Faros AI - AI Acceleration Whiplash](https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways)
- [CodeRabbit - State of AI vs Human Code Generation](https://www.coderabbit.ai/)
- [GitClear - AI Tool Impact on Developer Output](https://www.gitclear.com/research/ai_tool_impact_on_developer_productive_output_from_2022_to_2025)
- [GitHub - Agent Pull Requests](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/)

### 12.2 相关项目
- [rotom E2ED 设计文档](file:///Users/kong/ai-work/rotom/docs/e2ed.md) — Wario 的"前身"思路
- [rotom 异构评审论证](file:///Users/kong/ai-work/rotom/docs/review.md) — 为何要异构 Agent 评审
- [rotom E2E Harness 七维度](file:///Users/kong/ai-work/rotom/docs/e2e_harness.md) — AI Agent 工程化框架
- [rotom 主仓 README](file:///Users/kong/ai-work/rotom/README.md) — rotom 整体设计

### 12.3 技术参考
- [Fastify](https://fastify.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [commander.js](https://github.com/tj/commander.js)
