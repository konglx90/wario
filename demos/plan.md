# Demo: plan 类 review

场景:Agent 拿到需求后产出实现方案,push 给 wario 做方案评审(可行性 / 副作用 / 遗漏)。producer 还是 claude-code,reviewer 还是异构的 codex。

## Push 命令

```bash
curl -sS -X POST http://127.0.0.1:7331/api/projects/default/reviews \
  -H 'content-type: application/json' \
  -d '{
    "title": "方案:登录失败锁定实现",
    "description": "在 users 表加 failCount INT DEFAULT 0 和 lockedUntil TIMESTAMP NULL。login(email,pwd) 流程:1) SELECT user;2) 若 lockedUntil > NOW() 直接返回 locked;3) verifyPassword,失败则 failCount+1,达到 5 设 lockedUntil=NOW()+30min;成功则 failCount=0。并发用 SELECT ... FOR UPDATE 行锁。管理员解封走 admin 接口 UPDATE lockedUntil=NULL, failCount=0。不做 Redis,计数走 DB。不引入新表。 risks: 1) FOR UPDATE 在高并发登录场景可能成瓶颈;2) 时区依赖 DB 的 NOW();3) failCount 永不清零(只在成功时清),长期用户若偶尔失败累计可能误锁。",
    "pushedBy": "claude-code",
    "sessionId": "sess-demo-plan",
    "source": "claude-code",
    "contentType": "plan",
    "selfAssessedRisk": "L2",
    "tags": ["auth", "security"]
  }'
```

## 路由

- producer = `claude-code` → reviewer = `codex`(异构)
- `contentType=plan` → 走方案评审 prompt(强调可行性 / 副作用 / 遗漏)
- OCR 不触发(只 `contentType=code` 才跑)

## 执行结果

**Push 响应(HTTP 201)**:

```json
{
  "id": "rv_7ccf347b-8116-4023-9c03-fb27f8a99167",
  "pushedBy": "claude-code",
  "sessionId": "sess-demo-plan",
  "context": {
    "title": "方案:登录失败锁定实现",
    "description": "在 users 表加 failCount INT DEFAULT 0……",
    "tags": ["auth", "security"],
    "source": "claude-code"
  },
  "selfAssessedRisk": "L2",
  "contentType": "plan",
  "status": "pending",
  "attemptedReviewer": "codex",
  "preReviewStatus": "running",
  "createdAt": "2026-06-22T07:30:47.547Z"
}
```

**~30s 后最终状态**:

```json
{
  "id": "rv_7ccf347b-8116-4023-9c03-fb27f8a99167",
  "contentType": "plan",
  "status": "pending",
  "attemptedReviewer": "codex",
  "preReviewStatus": "failed",
  "preReview": null
}
```

和 requirement demo 一样,本次 codex LLM 端点不通,`preReviewStatus=failed`。Dashboard 徽章:`reviewer: codex failed`。

服务端日志:

```
[codex] error notification: stream disconnected before completion: error sending request for url (http://127.0.0.1:8787/responses)
[prereview] codex exited 1 for rv_7ccf347b-...:
```

## 与 requirement demo 的差异

| 维度 | requirement | plan |
|------|-------------|------|
| `contentType` | `requirement` | `plan` |
| prompt 模板 | 强调完整性 / 歧义 / 边界 | 强调可行性 / 副作用 / 遗漏 |
| 期望 findings 类型 | "需求没写清楚 X" / "边界 case Y 没考虑" | "方案 Z 有性能瓶颈" / "并发 race W" |
| 是否带 diff | 否 | 否(plan 是文本,不是代码) |
| OCR 触发 | 否 | 否 |

## 下一步

codex 配好 LLM 后,`preReview.findings` 会针对方案里的具体点给评论,例如:

- "FOR UPDATE 行锁在高并发登录时可能成瓶颈,考虑用 Redis 原子计数 + 异步落库"
- "NOW() 时区问题:建议用 UTC 显式存储,应用层转时区"
- "failCount 永不清零策略可能误锁老用户,建议加滑窗(30 天内累计)"

人类看完可以 `decide --verdict comment --comment "接受 1/3,2 用应用层时区,3 不改"` 把决策回给生产 agent。
