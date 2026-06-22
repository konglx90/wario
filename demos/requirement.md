# Demo: requirement 类 review

场景:Agent 拿到一个需求文档,在动手实现前 push 给 wario 做需求评审(完整性 / 歧义 / 边界)。

## Push 命令

```bash
curl -sS -X POST http://127.0.0.1:7331/api/projects/default/reviews \
  -H 'content-type: application/json' \
  -d '{
    "title": "需求:登录失败锁定",
    "description": "用户连续登录失败 5 次后,锁定该账号 30 分钟。锁定期间拒绝所有登录尝试(即使密码正确)。锁定结束后 failCount 清零。需要考虑:1) 并发登录失败的竞态;2) 计数持久化(服务重启不丢);3) 管理员能否手动解锁;4) 锁定状态对用户的提示文案。",
    "pushedBy": "claude-code",
    "sessionId": "sess-demo-req",
    "source": "claude-code",
    "contentType": "requirement",
    "selfAssessedRisk": "L2",
    "tags": ["auth", "security"]
  }'
```

等价的 CLI:

```bash
wario push --title "需求:登录失败锁定" \
  --content-type requirement --risk L2 --tags auth,security \
  --source claude-code --session-id sess-demo-req \
  --by claude-code \
  --description "用户连续登录失败 5 次后,锁定该账号 30 分钟……"
```

## 路由

- producer = `claude-code` → reviewer = `codex`(异构)
- `contentType=requirement` → 走需求评审 prompt(强调完整性 / 歧义 / 边界)
- OCR 不触发(只 `contentType=code` 才跑)

## 执行结果

**Push 响应(HTTP 201,immediately)**:

```json
{
  "id": "rv_88ac7aef-34d4-4e00-887f-f1c37dda4f8f",
  "pushedBy": "claude-code",
  "sessionId": "sess-demo-req",
  "context": {
    "title": "需求:登录失败锁定",
    "description": "用户连续登录失败 5 次后,锁定该账号 30 分钟……",
    "tags": ["auth", "security"],
    "source": "claude-code"
  },
  "selfAssessedRisk": "L2",
  "contentType": "requirement",
  "status": "pending",
  "attemptedReviewer": "codex",
  "preReviewStatus": "running",
  "createdAt": "2026-06-22T07:30:47.467Z"
}
```

`attemptedReviewer=codex` + `preReviewStatus=running` 立刻可见,Dashboard 卡片上会显示 `reviewer: codex running` 徽章 —— 即便 codex 还没跑完,人也能看到是谁在评。

**~30s 后最终状态**:

```json
{
  "id": "rv_88ac7aef-34d4-4e00-887f-f1c37dda4f8f",
  "contentType": "requirement",
  "status": "pending",
  "attemptedReviewer": "codex",
  "preReviewStatus": "failed",
  "preReview": null
}
```

`preReviewStatus=failed` —— codex 跑挂了。本次 demo 环境里 codex 配置的 LLM 端点(`http://127.0.0.1:8787/responses`,cc-switch 代理)没起,`codex app-server` 走 JSON-RPC 起来了但 LLM 调用连不上。Dashboard 徽章变红:`reviewer: codex failed`。

服务端日志:

```
[codex] error notification: stream disconnected before completion: error sending request for url (http://127.0.0.1:8787/responses)
[prereview] codex exited 1 for rv_88ac7aef-...:
```

## 失败排查

`preReviewStatus=failed` 时看服务端日志(`~/.wario/logs/` 或 stdout):

- `[codex] error notification: stream disconnected ... error sending request for url (...)` → LLM 端点连不上。检查 `~/.codex/config.toml` 里的 `url`,以及 cc-switch 代理是否在跑
- `codex timed out after Nms` → 调大 `WARIO_PREREVIEW_TIMEOUT`(秒,默认 120)
- `output not parseable` → codex 跑通了但没按约定 JSON schema 输出,prompt 模板可能被改坏
- `Spawn error: ...` → `codex` 不在 PATH,装 codex CLI 或设 `WARIO_CODEX_CMD`

## 下一步

codex 配好 LLM 后重新 push,`preReviewStatus` 会变 `succeeded`,`preReview` 字段填上 `{riskLevel, summary, findings[], byAgent, reviewSessionId}`,Dashboard 紫色 "Review Agent" 区块展开显示 findings。

人类有疑问可以 `wario review resume <id> --question "..."`,wario 会 spawn `codex exec resume <reviewSessionId>` 在原上下文继续,findings 回写 `preReview.resumeRounds[]`。
