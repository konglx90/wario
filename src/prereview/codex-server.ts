/**
 * Codex app-server client.
 *
 * Spawns `codex app-server --listen stdio://` and drives the JSON-RPC 2.0
 * protocol. Adapted from rotom's CodexExecutor, stripped to wario's needs:
 *   - no streaming (fire-and-forget pre-review)
 *   - no human approval routing (auto-accept all exec/file requests)
 *   - no status emit
 *
 * Lifecycle:
 *   1. initialize handshake → initialized notification
 *   2. thread/start (or thread/resume when resumeSessionId given) → threadId
 *   3. turn/start with threadId + prompt
 *   4. wait for turn/completed
 *   5. collect agentMessage text along the way
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CodexServerOptions {
  command: string;
  baseArgs: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  resumeSessionId?: string;
}

export interface CodexServerResult {
  modelText: string;
  sessionId?: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export function runCodexServer(
  prompt: string,
  config: CodexServerOptions
): Promise<CodexServerResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let timedOut = false;

    const args = [...config.baseArgs, 'app-server', '--listen', 'stdio://'];
    const child = spawn(config.command, args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let nextId = 1;
    const pending = new Map<number, PendingRpc>();
    let fullOutput = '';
    let stderr = '';
    let threadId = '';
    let settled = false;
    let failed = false;
    let turnDoneResolve: ((aborted: boolean) => void) | null = null;
    const turnDone = new Promise<boolean>((res) => {
      turnDoneResolve = res;
    });
    let notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    const completedTurnIds = new Set<string>();
    let terminalArrived = false;

    function signalTurnDone(aborted: boolean): void {
      if (turnDoneResolve) {
        const r = turnDoneResolve;
        turnDoneResolve = null;
        r(aborted);
      }
    }

    function send(msg: Record<string, unknown>): void {
      if (!child.stdin || child.stdin.destroyed) return;
      child.stdin.write(JSON.stringify(msg) + '\n');
    }

    function request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej, method });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }

    function notify(method: string, params?: unknown): void {
      send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    }

    function respond(id: unknown, result: unknown): void {
      send({ jsonrpc: '2.0', id, result });
    }

    function respondError(id: unknown, code: number, message: string): void {
      send({ jsonrpc: '2.0', id, error: { code, message } });
    }

    function handleServerRequest(raw: Record<string, unknown>): void {
      const id = raw.id;
      const method = raw.method as string;
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'execCommandApproval':
          respond(id, { decision: 'accept' });
          return;
        case 'item/fileChange/requestApproval':
        case 'applyPatchApproval':
          respond(id, { decision: 'accept' });
          return;
        case 'mcpServer/elicitation/request':
          respond(id, { action: 'accept', content: null, _meta: null });
          return;
        default:
          respondError(id, -32601, `unhandled server request: ${method}`);
      }
    }

    function handleResponse(raw: Record<string, unknown>): void {
      const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (raw.error) {
        const err = raw.error as { code?: number; message?: string };
        p.reject(
          new Error(`${p.method}: ${err.message ?? 'rpc error'} (code=${err.code ?? '?'})`)
        );
        return;
      }
      p.resolve(raw.result);
    }

    function handleNotification(raw: Record<string, unknown>): void {
      const method = raw.method as string;
      const params = (raw.params ?? {}) as Record<string, unknown>;

      if (method === 'codex/event' || method.startsWith('codex/event/')) {
        notificationProtocol = 'legacy';
        const msg = (params.msg ?? params) as Record<string, unknown> | undefined;
        if (msg && typeof msg === 'object' && 'type' in msg) handleLegacyEvent(msg);
        return;
      }
      if (notificationProtocol === 'legacy') return;
      if (
        notificationProtocol === 'unknown' &&
        (method === 'turn/started' ||
          method === 'turn/completed' ||
          method === 'thread/started' ||
          method.startsWith('item/'))
      ) {
        notificationProtocol = 'raw';
      }
      if (notificationProtocol === 'raw') handleRawNotification(method, params);
    }

    function handleLegacyEvent(msg: Record<string, unknown>): void {
      const type = msg.type as string;
      switch (type) {
        case 'agent_message': {
          const text = msg.message as string | undefined;
          if (text) fullOutput += text;
          return;
        }
        case 'task_complete':
          signalTurnDone(false);
          return;
        case 'turn_aborted':
          signalTurnDone(true);
          return;
      }
    }

    function handleRawNotification(method: string, params: Record<string, unknown>): void {
      const eventThreadId = params.threadId as string | undefined;
      if (eventThreadId && threadId && eventThreadId !== threadId) return;

      switch (method) {
        case 'turn/started':
          return;
        case 'turn/completed': {
          const turn = (params.turn ?? {}) as Record<string, unknown>;
          const turnId = (turn.id as string | undefined) ?? '';
          const status = (turn.status as string | undefined) ?? '';
          if (status === 'failed') {
            failed = true;
          }
          if (turnId) {
            if (completedTurnIds.has(turnId)) return;
            completedTurnIds.add(turnId);
          }
          signalTurnDone(status === 'cancelled' || status === 'canceled' || status === 'aborted');
          return;
        }
        case 'error': {
          const willRetry = params.willRetry === true;
          const errMsg =
            ((params.error as Record<string, unknown> | undefined)?.message as string | undefined) ||
            (params.message as string | undefined) ||
            '';
          if (errMsg && !willRetry) {
            console.warn(`[codex] error notification: ${errMsg}`);
            failed = true;
          }
          return;
        }
        case 'thread/status/changed': {
          const statusType =
            ((params.status as Record<string, unknown> | undefined)?.type as string | undefined) ?? '';
          if (statusType === 'idle') signalTurnDone(false);
          return;
        }
        default:
          if (method.startsWith('item/')) handleItemNotification(method, params);
      }
    }

    function handleItemNotification(method: string, params: Record<string, unknown>): void {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item) return;
      const itemType = item.type as string | undefined;

      if (method === 'item/agentMessage/delta') {
        const delta = (params.delta as string | undefined) ?? '';
        if (delta) fullOutput += delta;
        return;
      }

      if (method === 'item/completed' && itemType === 'agentMessage') {
        const text = (item.text as string | undefined) ?? '';
        if (text && !fullOutput.endsWith(text)) {
          fullOutput += text;
        }
        const phase = item.phase as string | undefined;
        if (phase && phase.toLowerCase() === 'final_answer') {
          terminalArrived = true;
          signalTurnDone(false);
        }
        return;
      }
    }

    function handleLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return;
      }
      const hasId = 'id' in raw && raw.id !== null && raw.id !== undefined;
      const hasMethod = typeof raw.method === 'string';
      const hasResult = 'result' in raw;
      const hasError = 'error' in raw;
      if (hasId && (hasResult || hasError)) {
        handleResponse(raw);
        return;
      }
      if (hasId && hasMethod) {
        handleServerRequest(raw);
        return;
      }
      if (hasMethod) handleNotification(raw);
    }

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', handleLine);

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      signalTurnDone(true);
    }, config.timeoutMs);

    function finish(exitCode: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [, p] of pending) p.reject(new Error('codex process exited'));
      pending.clear();
      const reportedSessionId = threadId || config.resumeSessionId || undefined;
      const finalCode = failed && exitCode === 0 ? 1 : exitCode;
      resolve({
        modelText: fullOutput,
        sessionId: reportedSessionId,
        stderr,
        exitCode: finalCode ?? -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    }

    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      console.error(`[codex] Spawn error: ${err.message}`);
      finish(1);
    });

    void (async () => {
      try {
        await request('initialize', {
          clientInfo: {
            name: 'wario',
            title: 'Wario',
            version: '0.1.0',
          },
          capabilities: { experimentalApi: true },
        });
        notify('initialized');

        threadId = await startOrResumeThread(
          request,
          config.resumeSessionId ?? '',
          config.cwd ?? process.cwd()
        );

        await request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
        });

        const aborted = await turnDone;
        if (aborted) failed = true;
      } catch (err) {
        failed = true;
        const msg = (err as Error).message;
        console.error(`[codex] lifecycle error: ${msg}`);
      } finally {
        try {
          child.stdin?.end();
        } catch {
          /* noop */
        }
      }
    })();
  });
}

async function startOrResumeThread(
  request: (method: string, params?: unknown) => Promise<unknown>,
  resumeSessionId: string,
  cwd: string
): Promise<string> {
  if (resumeSessionId) {
    try {
      const res = (await request('thread/resume', {
        threadId: resumeSessionId,
        cwd,
        model: null,
        developerInstructions: null,
      })) as Record<string, unknown> | undefined;
      const id = extractThreadId(res);
      if (id) return id;
      console.warn(
        `[codex] thread/resume returned no thread id; falling back to thread/start (prior=${resumeSessionId})`
      );
    } catch (err) {
      console.warn(
        `[codex] thread/resume failed; falling back to thread/start: ${(err as Error).message}`
      );
    }
  }

  const res = (await request('thread/start', {
    model: null,
    modelProvider: null,
    profile: null,
    cwd,
    approvalPolicy: null,
    sandbox: 'danger-full-access',
    config: null,
    baseInstructions: null,
    developerInstructions: null,
    compactPrompt: null,
    includeApplyPatchTool: null,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  })) as Record<string, unknown> | undefined;

  const id = extractThreadId(res);
  if (!id) throw new Error('codex thread/start returned no thread id');
  return id;
}

function extractThreadId(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const thread = r.thread as Record<string, unknown> | undefined;
  if (thread && typeof thread.id === 'string') return thread.id;
  return '';
}
