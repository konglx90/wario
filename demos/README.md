# Wario Demos

三个 contentType 的 push 示例 + 真实执行结果。

| 文件 | contentType | 评审重点 | 是否带 diff | OCR 触发 |
|------|-------------|----------|-------------|----------|
| [requirement.md](./requirement.md) | `requirement` | 完整性 / 歧义 / 边界 | 否 | 否 |
| [plan.md](./plan.md) | `plan` | 可行性 / 副作用 / 遗漏 | 否 | 否 |
| [code-diff.md](./code-diff.md) | `code` | 正确性 / 安全 / 风格 | 是 | 是(需 `WARIO_OCR=enabled` + git refs) |

## 跑这些 demo

```bash
# 1. 起服务
cd /Users/kong/ai-work/wario
pnpm run build
WARIO_HOME=/tmp/wario-demo-home WARIO_DB=/tmp/wario-demo.db \
WARIO_PORT=7331 WARIO_PREREVIEW_TIMEOUT=90 \
  pnpm serve

# 2. init project
curl -sS -X POST http://127.0.0.1:7331/api/projects \
  -H 'content-type: application/json' -d '{"slug":"default","name":"default"}'

# 3. 按各 demo .md 里的 push 命令推
# 4. 打开 http://127.0.0.1:7331/ 看 Dashboard
```

## 本次执行结果说明

三个 demo 的 `preReviewStatus` 都是 `failed` —— **不是 wario 的 bug**,是 demo 环境里 codex CLI 配置的 LLM 端点(`http://127.0.0.1:8787/responses`,cc-switch 代理)没起。`codex exec` 连不上模型,退出码 1。

修复:

```bash
# 检查 codex 配置
cat ~/.codex/config.toml | grep -i url
# 启动 cc-switch 代理,或改 endpoint 指向能用的 LLM
# 验证
codex exec --json --skip-git-repo-check "ping"
```

codex 跑通后,`preReviewStatus` 会变 `succeeded`,`preReview` 填上 `{riskLevel, summary, findings[], byAgent, reviewSessionId}`。

## reviewer 可见性

本次改动新增了 `attemptedReviewer` + `preReviewStatus` 持久化(`prereview_status` 列,migration #6)。Dashboard 卡片头部现在会显示:

- `reviewer: codex running`(蓝色)—— push 后立刻可见,哪怕 preReview 还没回来
- `reviewer: codex succeeded`(绿色)—— preReview 写入后
- `reviewer: codex failed`(红色)—— codex 退出码非 0 / 输出不可解析 / 异常
- `reviewer: codex timeout`(琥珀)—— 超过 `WARIO_PREREVIEW_TIMEOUT`

OCR 同理有 `ocrStatus` 字段和对应的 `reviewer: ocr *` 徽章。

这样人在 Dashboard 上**一眼能看出是谁在评、评得怎么样了**,不用去翻服务端日志。
