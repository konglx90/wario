# Demo: code 类 review (with diff)

场景:Agent 写完代码,push diff 给 wario 做代码评审(正确性 / 安全 / 风格)。producer=claude-code → reviewer=codex(异构)。如果开了 `WARIO_OCR=enabled` 并带 `repoPath`/`gitFrom`/`gitTo`,还会并行跑 Alibaba OCR 做对比。

## 被评审的 diff

故意埋了几个 bug 给 reviewer 抓:

```diff
diff --git a/src/auth/login.ts b/src/auth/login.ts
index 1111111..2222222 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,3 +1,4 @@
 import { db } from '../db';
+import { hashPassword } from '../crypto';
 
 export async function login(email: string, password: string) {
@@ -8,7 +9,16 @@ export async function login(email: string, password: string) {
   const user = await db.query(`SELECT * FROM users WHERE email='${email}'`);
   const ok = await verifyPassword(password, user.passwordHash);
   if (!ok) {
-    return { success: false };
+    const failCount = (user.failCount || 0) + 1;
+    await db.query(`UPDATE users SET failCount=${failCount} WHERE email='${email}'`);
+    if (failCount >= 5) {
+      await db.query(`UPDATE users SET lockedUntil=NOW() + INTERVAL 30 MINUTE WHERE email='${email}'`);
+    }
+    return { success: false, locked: failCount >= 5 };
   }
+  await db.query(`UPDATE users SET failCount=0 WHERE email='${email}'`);
   return { success: true, user };
 }
```

埋的点:
1. **SQL 注入** —— `email` 直接拼进 SQL 字符串
2. **未使用 import** —— `hashPassword` 导入了但没用
3. **无事务** —— failCount+1 和 lockedUntil 更新不在一个事务里,并发下可能错位
4. **`locked` 判断时机** —— 达到 5 次的那次返回 `locked: true`,但锁定是异步生效的,下次登录才会真正被 lockedUntil 拦截
5. **成功路径 failCount 清零在 if 块外** —— 逻辑正确但可读性差,容易被后续改动破坏

## Push 命令

```bash
# 用 jq 安全转义 diff 里的换行/引号
jq -n \
  --arg title "代码:登录失败锁定实现" \
  --arg desc "实现登录失败 5 次锁定 30 分钟。修改 src/auth/login.ts。" \
  --arg diff "$(cat /tmp/demo-login-diff.patch)" \
  '{
    title: $title,
    description: $desc,
    pushedBy: "claude-code",
    sessionId: "sess-demo-code",
    source: "claude-code",
    contentType: "code",
    selfAssessedRisk: "L3",
    tags: ["auth","security"],
    diff: $diff
  }' > /tmp/demo-code.json

curl -sS -X POST http://127.0.0.1:7331/api/projects/default/reviews \
  -H 'content-type: application/json' \
  -d @/tmp/demo-code.json
```

等价 CLI(diff 从 stdin 读):

```bash
cat /tmp/demo-login-diff.patch | wario push \
  --title "代码:登录失败锁定实现" \
  --content-type code --risk L3 --tags auth,security \
  --source claude-code --session-id sess-demo-code \
  --by claude-code \
  --description "实现登录失败 5 次锁定 30 分钟。修改 src/auth/login.ts。"
```

## 路由

- producer = `claude-code` → reviewer = `codex`(异构)
- `contentType=code` → 走代码评审 prompt(强调正确性 / 安全)
- OCR:**本 demo 未开**(`WARIO_OCR=disabled`)。若开,需额外带 `--repo-path`/`--git-from`/`--git-to`,wario 会并行 spawn `ocr review --format json --audience agent`

## 执行结果

**Push 响应(HTTP 201)**:

```json
{
  "id": "rv_5d086345-f1bf-4bd2-bfb2-c9528efb307a",
  "pushedBy": "claude-code",
  "sessionId": "sess-demo-code",
  "context": {
    "title": "代码:登录失败锁定实现",
    "description": "实现登录失败 5 次锁定 30 分钟。修改 src/auth/login.ts。",
    "diff": "diff --git a/src/auth/login.ts b/src/auth/login.ts\n...",
    "tags": ["auth", "security"],
    "source": "claude-code"
  },
  "selfAssessedRisk": "L3",
  "contentType": "code",
  "status": "pending",
  "attemptedReviewer": "codex",
  "preReviewStatus": "running",
  "createdAt": "2026-06-22T07:31:23.552Z"
}
```

注意 `context.diff` 完整保留(用于 reviewer 读上下文),`attemptedReviewer=codex` + `preReviewStatus=running` 立刻可见。

**~30s 后最终状态**:

```json
{
  "id": "rv_5d086345-f1bf-4bd2-bfb2-c9528efb307a",
  "contentType": "code",
  "status": "pending",
  "attemptedReviewer": "codex",
  "preReviewStatus": "failed",
  "preReview": null,
  "ocrReview": null,
  "ocrStatus": null
}
```

`preReviewStatus=failed` —— codex app-server 起来了(JSON-RPC 握手成功),但 LLM 端点(`http://127.0.0.1:8787/responses`)连不上。`ocrStatus=null` —— OCR 未开。

服务端日志:

```
[codex] error notification: stream disconnected before completion: error sending request for url (http://127.0.0.1:8787/responses)
[prereview] codex exited 1 for rv_5d086345-...:
```

## Dashboard 渲染

卡片头部:
```
rv_5d086345…  [L3]  [code]  3 分钟前  · pushed by claude-code · claude-code
代码:登录失败锁定实现
实现登录失败 5 次锁定 30 分钟。修改 src/auth/login.ts。
[reviewer: codex failed]              ← 红色徽章
auth  security
```

preReview 区块(紫色)不渲染(因为没有 preReview)。ocrReview 区块(琥珀)不渲染(没开 OCR)。

## 开启 OCR 对比

如果同一次 push 带 git refs 并开 OCR:

```bash
cat /tmp/demo-login-diff.patch | wario push \
  --title "代码:登录失败锁定实现" --content-type code --risk L3 \
  --tags auth,security --source claude-code --session-id sess-demo-code-2 \
  --repo-path /path/to/repo --git-from main --git-to HEAD

# 服务端:WARIO_OCR=enabled pnpm serve
```

响应会增加:
```json
{
  "ocrStatus": "running"   // 然后变 succeeded / failed
}
```

OCR 跑完后 `ocrReview` 填充 `{byAgent:'ocr', findings[], riskLevel, summary}`,Dashboard 卡片下方多一个琥珀色 "OCR (Alibaba)" 折叠区块,和紫色 "Review Agent"(异构 codex)并排。

## 下一步

codex 配好 LLM 后,`preReview.findings` 预期会抓到上面埋的 1-3 个点(SQL 注入大概率第一个被抓)。OCR 如果也配好,会从另一个视角再评一遍,两边 findings 可以对比 coverage 和 false positive。
