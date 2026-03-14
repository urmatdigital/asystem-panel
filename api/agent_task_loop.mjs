/**
 * Agent Task Loop v2 — MAS-Factory Pattern
 *
 * Switch Node logic (from MAS-Factory paper):
 *   pending → in_progress → [dispatch] →
 *     ✅ done   → save memory
 *     ❌ fail   → RETRY (same agent, enriched prompt)
 *     ❌ fail×2 → ESCALATE to Atlas (senior agent review)
 *     ❌ fail×3 → BLOCKED (human review required)
 *
 * Adapters:
 *   memory  → ReMe (/api/memory/reme)
 *   message → ASYSTEM dispatch (/api/dispatch)
 *   state   → Convex (/api/tasks/:id PATCH)
 *   code    → mac-agent-listen (:7600)
 */

const API_BASE      = 'http://127.0.0.1:5190';
const TASK_INTERVAL = 60_000;
const HEALTH_INTERVAL = 300_000;
const MAX_RETRIES   = 2; // attempt 1 + retry 1 → then escalate

// ── Pipeline Middleware ──────────────────────────────────────────────────────
import { startTrace, closeTrace, checkRateLimit, contextHandoff, securityGate, scoreTask, analyzeError, applyHeal, recordFailureToMemory, getFailureWarnings } from './pipeline.mjs';
import { selectModel, classifyTask, logModelChoice, recordModelOutcome, selectModelAdaptive, getModelStats, getTokenBudget, getThinkingMode } from "./model-router.mjs";
import { runLogician, injectSST, recordLogicianResult } from "./logician.mjs";
import { auditResult, shouldAudit, recordAuditFailure } from "./audit-agent.mjs";
import { recordMetric, shouldKeep, keepChanges } from "./keep-or-discard.mjs";

// ── Loop Guard (OpenFang-inspired: SHA256 circuit breaker) ─────────────────
// Prevents ping-pong loops: Task A→dispatch B→Task B→dispatch A
import { createHash as _createHash } from 'node:crypto';
const _loopWindow = new Map(); // hash → { count, firstSeen }
const LOOP_TTL    = 5 * 60_000;
const LOOP_MAX    = 3; // after 3 identical dispatches in 5min → block

function _loopHash(title, body = '') {
  return _createHash('sha256').update((title + body).slice(0, 1000)).digest('hex').slice(0, 16);
}

function isLoopDetected(title, body) {
  const h = _loopHash(title, body);
  const now = Date.now();
  const entry = _loopWindow.get(h);
  if (!entry || now - entry.firstSeen > LOOP_TTL) return false;
  return entry.count >= LOOP_MAX;
}

function recordDispatch(title, body) {
  const h = _loopHash(title, body);
  const now = Date.now();
  const entry = _loopWindow.get(h);
  if (entry && now - entry.firstSeen <= LOOP_TTL) {
    entry.count++;
  } else {
    _loopWindow.set(h, { count: 1, firstSeen: now });
  }
  // Prune stale entries
  if (_loopWindow.size > 128) {
    for (const [k, v] of _loopWindow) {
      if (now - v.firstSeen > LOOP_TTL) _loopWindow.delete(k);
    }
  }
}

const CRITICAL_SERVICES = [
  { name: 'ASYSTEM Panel', url: 'https://os.te.kg',      expect: 200 },
  { name: 'Cap Recorder',  url: 'https://cap.te.kg',     expect: [200, 302, 307] },
  { name: 'OliveTin Ops',  url: 'https://os.te.kg/ops/', expect: 200 },
];

// ── Retry tracking (in-memory, resets on restart) ──────────────────────────
const retryCount = new Map(); // taskId → count

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const { default: http } = await import('node:http');
  const isExternal = path.startsWith('http');
  const url = isExternal ? new URL(path) : new URL(path, API_BASE);
  const mod = url.protocol === 'https:' ? (await import('node:https')).default : http;

  return new Promise((resolve) => {
    const reqOpts = {
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 5190),
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout || 15000,
    };
    const req = mod.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, data: JSON.parse(data), status: res.statusCode }); }
        catch { resolve({ ok: res.statusCode < 400, data: {}, status: res.statusCode }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const post  = (p, b) => apiFetch(p, { method: 'POST',  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(b)) }, body: JSON.stringify(b) });
const patch = (p, b) => apiFetch(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(b)) }, body: JSON.stringify(b) });

// ── Memory adapter ──────────────────────────────────────────────────────────
async function saveMemory(content) {
  await post('/api/memory/reme/add', { content }).catch(() => {});
}

async function enrichWithContext(task) {
  try {
    const q = encodeURIComponent(task.title.split(' ').slice(0, 5).join(' '));
    const { data } = await apiFetch(`/api/memory/reme?q=${q}&top=3`);
    const hits = (data?.results || []).filter(r => r.score > 0.38);
    if (!hits.length) return task;
    const ctx = hits.map(m => `• ${m.content.substring(0, 200)}`).join('\n');
    return { ...task, body: `${task.body || ''}\n\n[Memory Context]:\n${ctx}` };
  } catch { return task; }
}

// ── State adapter ───────────────────────────────────────────────────────────
async function updateState(decision, agent = 'task-loop') {
  await post('/api/state', { agent, decision }).catch(() => {});
}

// ── Symphony Pattern: Auto Test Runner ──────────────────────────────────────
// After coding task: detect project type → run tests → return { passed, output }
async function runTests(repoPath) {
  const { execSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');

  // Detect test runner
  let cmd = null;
  let cwd = repoPath;

  if (existsSync(path.join(repoPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(require('fs').readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
      if (pkg.scripts?.test && !pkg.scripts.test.includes('no test')) {
        const pm = existsSync(path.join(repoPath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
        cmd = `${pm} test -- --passWithNoTests 2>&1`;
      }
    } catch {}
  }

  if (!cmd && existsSync(path.join(repoPath, 'pytest.ini')) || existsSync(path.join(repoPath, 'pyproject.toml'))) {
    cmd = 'python3 -m pytest --tb=short -q 2>&1';
  }

  if (!cmd) return { passed: true, output: 'no test runner detected — skip', skipped: true };

  try {
    console.log(`[Symphony] 🧪 Running tests in ${repoPath}: ${cmd}`);
    const output = execSync(cmd, { cwd, timeout: 120_000, encoding: 'utf8', stdio: 'pipe' });
    console.log(`[Symphony] ✅ Tests passed`);
    return { passed: true, output: output.slice(-2000) };
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '') || e.message;
    console.warn(`[Symphony] ❌ Tests FAILED:\n${output.slice(0, 500)}`);
    return { passed: false, output: output.slice(0, 3000) };
  }
}

// ── Executor — runs the actual task ─────────────────────────────────────────
async function executeTask(task, attempt = 1, prevTestOutput = null, traceMeta = null) {
  const agent = task.assignedTo || task.agent || 'forge';
  const isCode = /build|fix|feature|deploy|code|implement|create.*component|refactor|написать код/i
    .test(task.title + ' ' + (task.body || ''));

  if (isCode && agent === 'forge') {
    // Достать предупреждения о провалах похожих задач
    const failureWarnings = await getFailureWarnings(task);

    // Qdrant semantic context — найти похожие решения из памяти
    let qdrantContext = '';
    try {
      const { execSync: _exec } = await import('node:child_process');
      const OAIKEY = process.env.OPENAI_API_KEY || 
        _exec(`grep OPENAI_API_KEY $HOME/.openclaw/workspace/.env | tail -1 | cut -d= -f2`, {encoding:'utf8'}).trim();
      const query = `${task.title} ${(task.body||'').slice(0,200)}`;
      const raw = _exec(
        `OPENAI_API_KEY=${OAIKEY} python3 $HOME/.openclaw/workspace/scripts/memory_search.py --query ${JSON.stringify(query)} --limit 3 --json 2>/dev/null`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const hits = JSON.parse(raw);
      if (hits.length > 0) {
        qdrantContext = '\n\n🧠 RELEVANT MEMORY (semantic search):\n' +
          hits.map(h => `[${h.payload.type}|score:${h.score.toFixed(2)}] ${h.payload.content.slice(0,300)}`).join('\n---\n');
        console.log(`[TaskLoop] 🧠 Qdrant: ${hits.length} relevant memories injected`);
      }
    } catch(_e) { /* silent - Qdrant not critical */ }

    // Build prompt — include test failure context on retry (Symphony pattern)
    let prompt;
    if (attempt > 1 && prevTestOutput) {
      prompt = injectSST(`RETRY attempt ${attempt}. Tests failed after previous implementation.\n\nTask: ${task.title}\n\n${task.body || ''}\n\n` +
        `⚠️ TEST FAILURES (fix these):\n\`\`\`\n${prevTestOutput.slice(0, 2000)}\n\`\`\`\n\nFix the code so all tests pass.${failureWarnings}`, task);
    } else if (attempt > 1) {
      prompt = injectSST(`RETRY attempt ${attempt}. Previous attempt failed.\n\nTask: ${task.title}\n\n${task.body || ''}\n\nBe extra careful and explicit.${failureWarnings}`, task);
    } else {
      prompt = injectSST(`${task.title}\n\n${task.body || ''}${failureWarnings}${qdrantContext}`, task);
    }

    // Pass callback_url so worker POSTs result back to /complete
    const callbackUrl = `http://127.0.0.1:5190/api/tasks/${task._id}/complete`;

    // Auto model selection
    const budgetResp = await apiFetch("/api/costs/guard").catch(() => ({ data: {} }));
    const budgetStatus = budgetResp.data?.data || budgetResp.data || {};
    const modelChoice = selectModelAdaptive(task, budgetStatus);
    logModelChoice(task, modelChoice);

    // Update traceMeta with modelId for feedback loop
    if (traceMeta) {
      traceMeta.modelId = modelChoice.id;
    }

    // Thinking Mode (GPT-5.4 паттерн)
    const thinkingMode = getThinkingMode(task);

    const resp = await apiFetch('http://127.0.0.1:7600/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'forge-mac-agent-2026-secret' },
      body: JSON.stringify({ prompt, runtime: modelChoice.runtime, model: modelChoice.model, max_tokens: getTokenBudget(task), thinking: thinkingMode.enabled, thinking_budget: thinkingMode.budget, timeout: 300, callback_url: callbackUrl }),
      timeout: 310_000,
    });
    if (!resp.ok) throw new Error(resp.error || `mac-agent HTTP ${resp.status}`);

    // Verify: check job result for git_changed or validation_passed
    const jobResult = resp.data || {};
    if (jobResult.status === 'failed') {
      throw new Error(`mac-agent job failed: ${jobResult.summary || 'no output'}`);
    }
    if (jobResult.git_changed === false && jobResult.validation_passed === true) {
      console.warn(`[SwitchNode] ⚠️ Job done but no git changes: "${task.title}"`);
    }
    if (jobResult.git_commit) {
      console.log(`[SwitchNode] 📦 git commit: ${jobResult.git_commit}`);
    }

    // ── Symphony: Run tests after code generation ──────────────────────────
    const repoPath = task.repo || `${process.env.HOME}/projects/ASYSTEM`;
    const testResult = await runTests(repoPath);

    if (!testResult.skipped) {
      console.log(`[Symphony] Test result: ${testResult.passed ? '✅ PASS' : '❌ FAIL'}`);
    }

    // Log test result to symphony-tests.jsonl for dashboard widget
    const testLog = {
      id: `test-${Date.now()}`,
      taskTitle: task.title,
      passed: testResult.passed,
      skipped: testResult.skipped || false,
      output: testResult.passed ? undefined : testResult.output?.slice(0, 2000),
      agent: agent,
      attempt,
      ts: Date.now(),
    };
    try {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(
        `${process.env.HOME}/projects/ASYSTEM/api/symphony-tests.jsonl`,
        JSON.stringify(testLog) + '\n'
      );
    } catch {}

    if (!testResult.passed) {
      // Tests failed — throw with test output so SwitchNode retries with context
      const err = new Error(`Tests failed after code generation`);
      err.testOutput = testResult.output;
      err.isTestFailure = true;
      throw err;
    }

    return `mac-agent: ${jobResult.status || 'done'} | tests: ${testResult.skipped ? 'skipped' : '✅ pass'} | git: ${jobResult.git_changed ? jobResult.git_commit || 'committed' : 'no changes'}`;
  } else {
    // LXC offline fallback: if agent is LXC and offline, reroute to forge
    const LXC_AGENTS = ['dana','nurlan','ainura','bekzat','marat'];
    const isLxc = LXC_AGENTS.includes(agent);
    const effectiveAgent = isLxc ? 'forge' : agent;

    if (isLxc && agent !== 'forge') {
      console.log(`[SwitchNode] ⚡ LXC agent "${agent}" → routing via forge`);
    }

    // Retry with exponential backoff on overload
    let resp;
    for (let attempt529 = 0; attempt529 < 4; attempt529++) {
      resp = await withSemaphore(() => post('/api/dispatch', {
        agent: effectiveAgent,
        title: isLxc && agent !== 'forge' ? `[${agent.toUpperCase()}] ${task.title}` : task.title,
        body: task.body || task.description || task.title,
        task_id: task._id,
        source: attempt > 1 ? `task-loop-retry-${attempt}` : 'task-loop-auto',
      }));
      // Check for overload signal
      const isOverload = !resp.ok && (
        resp.status === 529 ||
        JSON.stringify(resp).includes('overloaded') ||
        JSON.stringify(resp).includes('temporarily')
      );
      if (!isOverload) break;
      const wait = Math.pow(2, attempt529 + 1) * 1000; // 2s, 4s, 8s, 16s
      console.log(`[TaskLoop] ⚡ Overload 529 — waiting ${wait/1000}s (attempt ${attempt529+1}/4)`);
      await new Promise(r => setTimeout(r, wait));
    }
    if (!resp.ok) throw new Error(resp.error || `dispatch HTTP ${resp.status}`);
    return resp.data?.result || 'Dispatched';
  }
}

// ── Switch Node — MAS-Factory pattern ──────────────────────────────────────
// testOutputMap: tracks last test failure output per task for retry context
const testOutputMap = new Map();

// ── Simple concurrency semaphore ─────────────────────────────────────────
let _activeCalls = 0;
const MAX_CONCURRENT = 2;
async function withSemaphore(fn) {
  while (_activeCalls >= MAX_CONCURRENT) {
    await new Promise(r => setTimeout(r, 2000));
  }
  _activeCalls++;
  try { return await fn(); } finally { _activeCalls--; }
}

async function switchNode(task) {
  const tid = task._id;
  const agent = task.assignedTo || task.agent || 'forge';
  const attempts = (retryCount.get(tid) || 0) + 1;
  retryCount.set(tid, attempts);

  const prevTestOutput = testOutputMap.get(tid) || null;
  console.log(`[SwitchNode] "${task.title}" — attempt ${attempts}/${MAX_RETRIES + 1} → ${agent}${prevTestOutput ? ' [with test context]' : ''}`);

  // ── Logician Gate (ResonantOS: детерминированные правила до LLM) ──────────
  const logicianResult = runLogician(task);
  recordLogicianResult(logicianResult.action);

  if (!logicianResult.passed) {
    if (logicianResult.action === "block") {
      console.log(`[SwitchNode] 🔒 BLOCKED by Logician: ${logicianResult.violations[0]?.message}`);
      await patchTaskConvex(task._id, "blocked");
      retryCount.delete(tid);
      return { outcome: "blocked", result: `Logician: ${logicianResult.violations.map(v => v.message).join("; ")}` };
    }
    if (logicianResult.action === "escalate") {
      console.log(`[SwitchNode] 📢 ESCALATED by Logician`);
      // Dispatch to atlas for review
      await post("/api/dispatch", { to: "atlas", title: `[ESCALATE] ${task.title}`, body: logicianResult.violations[0]?.message, source: "logician" }).catch(() => {});
      await patchTaskConvex(task._id, "escalated");
      retryCount.delete(tid);
      return { outcome: "escalated", result: "Logician escalation" };
    }
    // delegate/split: продолжаем но помечаем для sub-agent
    task = { ...logicianResult.task, _logicianHint: logicianResult.action };
  } else {
    // Задача прошла — применить модифицированную версию (auto-assign и др.)
    task = logicianResult.task;
  }

  // ── Loop Guard check ────────────────────────────────────────────────────
  if (isLoopDetected(task.title, task.body || '')) {
    console.error(`[LoopGuard] 🔄 Circuit breaker triggered: "${task.title}" — too many identical dispatches, blocking`);
    await patchTaskConvex(tid, 'blocked');
    retryCount.delete(tid);
    await saveMemory(`LOOP BLOCKED: "${task.title}" dispatched ${LOOP_MAX}+ times in ${LOOP_TTL/60000}min — circuit breaker`);
    await post('/api/dispatch', {
      to: 'atlas',
      title: `🔄 LOOP DETECTED: ${task.title}`,
      body: `Task has been dispatched ${LOOP_MAX}+ times in ${LOOP_TTL/60000} minutes. Possible agent loop. Auto-blocked. Manual review required.`,
      source: 'loop-guard',
      priority: 'high',
    }).catch(() => {});
    return { outcome: 'blocked' };
  }
  recordDispatch(task.title, task.body || '');

  // ── Pipeline: Security Gate
  if (!securityGate(task)) {
    await patchTaskConvex(task._id, 'blocked');
    return { outcome: 'blocked', result: 'security gate rejection' };
  }

  // ── Pipeline: Rate Limiter
  const agentId = task.agent || 'forge';
  const priority = task.priority?.toUpperCase() || 'MEDIUM';
  if (!checkRateLimit(agentId, priority)) {
    return { outcome: 'retry', result: 'rate limited' };
  }

  // ── Pipeline: Trace Start
  const traceMeta = startTrace(task);

  // ── Pipeline: Context Handoff (async, non-blocking)
  contextHandoff(task, traceMeta).catch(() => {});

  // Enrich task with memory context
  const enriched = await enrichWithContext(task);

  try {
    const result = await executeTask(enriched, attempts, prevTestOutput, traceMeta);

    // Feedback loop: записать результат для адаптивного роутинга
    if (traceMeta) {
      recordModelOutcome(
        traceMeta.modelId || "unknown",
        "done",
        Date.now() - (traceMeta.startedAt || Date.now())
      );
    }

    // Аудит результата (GPT-5.4 паттерн: QA после выполнения)
    if (shouldAudit(task)) {
      const audit = await auditResult(task, result || "").catch(() => null);
      if (audit && !audit.passed && audit.score >= 0) {
        console.log(`[SwitchNode] 🔍 Audit failed (score=${audit.score}) → flagging for review`);
        await recordAuditFailure(task, audit).catch(() => {});
        // Если score < 4 — помечаем как требующий проверки
        if (audit.score < 4) {
          await patchTaskConvex(task._id, "needs_review").catch(() => {});
        }
      }
    }

    // ✅ SUCCESS path
    await patchTaskConvex(tid, 'done');
    retryCount.delete(tid);
    testOutputMap.delete(tid);
    await saveMemory(`Task done: "${task.title}". Agent: ${agent}. Attempts: ${attempts}. Result: ${String(result).slice(0, 250)}`);
    // Записать факт выполнения в Qdrant
    try {
      const { execSync: _execQ } = await import('node:child_process');
      const OAIKEY = process.env.OPENAI_API_KEY ||
        _execQ(`grep OPENAI_API_KEY $HOME/.openclaw/workspace/.env | tail -1 | cut -d= -f2`, {encoding:'utf8'}).trim();
      const content = `Task completed [${agent}]: ${task.title}. ${(task.body||'').slice(0,200)}. Result: ${String(result).slice(0,200)}`;
      _execQ(
        `OPENAI_API_KEY=${OAIKEY} python3 $HOME/.openclaw/workspace/scripts/memory_write.py --content ${JSON.stringify(content)} --type decision --tags "task-done,${agent}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 15000 }
      );
    } catch(_) {}
    console.log(`[SwitchNode] ✅ SUCCESS: "${task.title}" (attempt ${attempts})`);
    await closeTrace(traceMeta, 'done', result);
    return { outcome: 'done' };

  } catch (e) {
    // Feedback loop: записать fail для моделей
    if (traceMeta) {
      recordModelOutcome(
        traceMeta.modelId || "unknown",
        "fail",
        Date.now() - (traceMeta.startedAt || Date.now())
      );
    }

    // Записать провал в shared memory (Карпаты: каждый провал = урок)
    if (attempts === 1 || (attempts === MAX_RETRIES && attempts >= 2)) {
      await recordFailureToMemory(task, e.message || "unknown error", traceMeta || {}).catch(() => {});
    }

    // Self-heal: если fail → проанализировать и применить фикс для retry
    if (attempts <= MAX_RETRIES) {
      const healed = applyHeal(enriched, e.message || String(e));
      if (healed._selfHealApplied) {
        console.log(`[SwitchNode] 🔧 Self-heal applied: ${healed._healFix}`);
      }
    }

    // Store test output for next retry attempt (Symphony pattern)
    if (e.isTestFailure && e.testOutput) {
      testOutputMap.set(tid, e.testOutput);
      console.warn(`[Symphony] 🔄 Test failure context saved for retry`);
    }
    console.warn(`[SwitchNode] ❌ Attempt ${attempts} failed: ${e.message}${e.isTestFailure ? ' [TEST FAILURE]' : ''}`);

    if (attempts <= MAX_RETRIES) {
      // 🔄 RETRY path — requeue with higher priority note
      await patchTaskConvex(tid, 'todo');
      console.log(`[SwitchNode] 🔄 RETRY scheduled (attempt ${attempts + 1})`);
      await closeTrace(traceMeta, 'retry');
      return { outcome: 'retry' };

    } else if (attempts === MAX_RETRIES + 1) {
      // 📤 ESCALATE path — send to Atlas
      await patchTaskConvex(tid, 'blocked');
      retryCount.delete(tid);

      console.warn(`[SwitchNode] 📤 ESCALATING → Урмат: "${task.title}"`);
      const testCtx = testOutputMap.get(tid);
      testOutputMap.delete(tid);
      await post('/api/dispatch', {
        to: 'urmat',
        title: `🔺 НУЖНА ПОМОЩЬ: ${task.title}`,
        body: `Task failed after ${attempts} attempts by ${agent}.\n\nOriginal task:\n${task.body || task.description || ''}\n\nError: ${e.message}` +
          (testCtx ? `\n\n🧪 Last test output:\n\`\`\`\n${testCtx.slice(0, 1500)}\n\`\`\`` : '') +
          `\n\nPlease review and reassign or unblock.`,
        source: 'task-loop-escalation',
        priority: 'high',
      });

      await saveMemory(`ESCALATED → Урмат: "${task.title}". Failed ${attempts}x by ${agent}. Error: ${e.message}`);
      await updateState(`Escalated task "${task.title}" to Atlas after ${attempts} failed attempts`, 'task-loop');

      // Telegram notify
      await post('/api/dispatch', {
        to: 'forge',
        title: `📤 Задача эскалирована → Урмат`,
        body: `"${task.title}" → Atlas (failed ${attempts}x)`,
        source: 'task-loop-notify',
      }).catch(() => {});

      await closeTrace(traceMeta, 'escalated', e.message);
      return { outcome: 'escalated' };

    } else {
      // 🚫 BLOCKED — needs human
      await patchTaskConvex(tid, 'blocked');
      retryCount.delete(tid);
      await saveMemory(`BLOCKED: "${task.title}". Needs human review.`);
      console.error(`[SwitchNode] 🚫 BLOCKED: "${task.title}" — human review needed`);
      await closeTrace(traceMeta, 'blocked', 'human review needed');
      return { outcome: 'blocked' };
    }
  }
}

// ── Task Cycle ──────────────────────────────────────────────────────────────
async function taskCycle() {
  try {
    // NEW: Cost guard with budget enforcement
    const guardResp = await apiFetch('/api/costs/guard');
    if (guardResp.data?.pause_tasks) {
      const status = guardResp.data.data;
      console.error(`[TaskLoop] 🛑 BUDGET EXHAUSTED: $${status.spent}/$${status.budget} — all tasks paused`);
      await post('/api/dispatch', {
        to: 'urmat',
        title: '🛑 Daily budget exhausted',
        body: `Spent: $${status.spent}\nBudget: $${status.budget}\n\nAll task processing paused. Waiting for budget reset or approval.`,
        source: 'cost-guard',
        priority: 'critical',
      }).catch(() => {});
      return; // PAUSE ALL WORK
    }

    if (guardResp.data?.use_cheap_only) {
      const status = guardResp.data.data;
      console.warn(`[TaskLoop] 💛 Budget critical: ${status.percent_used}% used — switching to cheap models`);
      // Note: Agents will automatically use fallback models when primary rate-limits
    }

    // NEW: Use priority queue instead of simple pending
    const priorityResp = await apiFetch('/api/tasks/priority-queue?agent=forge&limit=2');
    if (!priorityResp.data?.queue || priorityResp.data.queue.length === 0) return;

    console.log(`[TaskLoop] ${priorityResp.data.queue.length} prioritized task(s) | spend: $${guardResp.data?.data?.spent || "0"} | budget: ${guardResp.data?.data?.percent_used || 0}%`);
    
    // Fetch full task details from pending endpoint
    const { data: pendingData } = await apiFetch('/api/tasks/pending?limit=10');
    const taskMap = new Map((pendingData.tasks || []).map(t => [t._id, t]));

    for (const queuedTask of priorityResp.data.queue) {
      const task = taskMap.get(queuedTask.id);
      if (!task) continue;

      console.log(`[TaskLoop] Processing: "${queuedTask.title}" (priority=${queuedTask.priority}, score=${queuedTask.score})`);
      if (queuedTask.overdue_minutes > 0) console.log(`  ⚠️  OVERDUE by ${queuedTask.overdue_minutes}min`);
      if (queuedTask.stalled_minutes > 0) console.log(`  🔄 STALLED for ${queuedTask.stalled_minutes}min`);

      await patchTaskConvex(task._id, 'in_progress');
      const { outcome, result } = await switchNode(task);
      if (outcome === 'retry') console.log(`[TaskLoop] ⏳ Will retry in next cycle`);

      // Record tasks_per_dollar metric (Karpathy val_metric)
      if (outcome === 'done') {
        const agent = task.assignedTo || task.agent || 'forge';
        const budgetStatus = guardResp.data?.data || {};
        const spent = parseFloat(budgetStatus.spent || 0);
        const tasksPerDollar = spent > 0 ? 1 / spent : 999;
        recordMetric(agent, 'tasks_per_dollar', tasksPerDollar);

        // Check if this outcome improves the metric (keep or discard)
        const improved = shouldKeep(agent, 'tasks_per_dollar', tasksPerDollar, false); // false = higher is better
        if (improved) {
          const repo = task.repo || `${process.env.HOME}/Projects/ASYSTEM`;
          try { keepChanges(repo, `✅ task: ${task.title}`); } catch {};
        }
      }

      // Git workflow: after successful coding task → commit + push
      if (outcome === 'done' && /build|fix|implement|refactor|написать код/i.test(task.title)) {
        const repo = task.repo || `${process.env.HOME}/Projects/ASYSTEM`;
        const gitResp = await post('/api/git/workflow', {
          repo, task_title: task.title, create_pr: false,
        }).catch(() => null);
        if (gitResp?.data?.changed) {
          console.log(`[TaskLoop] 📦 Git commit: ${gitResp.data.commit}`);
          await saveMemory(`Git commit for task "${task.title}": ${gitResp.data.commit}`);
        }
      }
    }
  } catch (e) {
    console.error('[TaskLoop] Cycle error:', e.message, e.stack?.split('\n').slice(1,3).join(' | '));
  }
}

// ── Health Monitor ──────────────────────────────────────────────────────────
const alerted = new Set();

async function healthCycle() {
  const { default: https } = await import('node:https');
  for (const svc of CRITICAL_SERVICES) {
    try {
      const code = await new Promise(resolve => {
        const req = https.get(svc.url, { timeout: 8000 }, res => resolve(res.statusCode));
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
      });
      const expected = Array.isArray(svc.expect) ? svc.expect : [svc.expect];
      const ok = expected.includes(code);

      if (!ok && !alerted.has(svc.name)) {
        alerted.add(svc.name);
        console.warn(`[Health] ❌ ${svc.name} DOWN (HTTP ${code})`);
        await post('/api/dispatch', {
          agent: 'forge',
          title: `🚨 SERVICE DOWN: ${svc.name}`,
          body: `URL: ${svc.url}\nHTTP: ${code}\nCheck: PM2, Docker, Cloudflare tunnel`,
          source: 'health-monitor',
        }).catch(() => {});
        await updateState(`Service DOWN: ${svc.name} (HTTP ${code})`, 'health-monitor');
      } else if (ok && alerted.has(svc.name)) {
        alerted.delete(svc.name);
        console.log(`[Health] ✅ ${svc.name} recovered`);
        await updateState(`Service RECOVERED: ${svc.name}`, 'health-monitor');
      }
    } catch (e) {
      console.error(`[Health] Check error for ${svc.name}:`, e.message);
    }
  }
}

// ── Blueprint executor — run a pre-built graph from /api/braindump ──────────
// (Future: accept { nodes, edges, type } and execute sequentially/parallel)
// For now: listens on /api/blueprint via HTTP if needed

// ── Start ──────────────────────────────────────────────────────────────────
console.log('[TaskLoop v2] 🚀 MAS-Factory Switch Node pattern active');
console.log(`  Retry policy: ${MAX_RETRIES} retries → escalate to Atlas → blocked`);
console.log(`  Task polling: ${TASK_INTERVAL / 1000}s | Health: ${HEALTH_INTERVAL / 1000}s`);
console.log(`  Adapters: memory(ReMe) + message(dispatch) + state(Convex) + code(mac-agent)`);

taskCycle();
healthCycle();

setInterval(taskCycle, TASK_INTERVAL);
setInterval(healthCycle, HEALTH_INTERVAL);

// ── Patch fix — override to use Convex directly ───────────────────────────
// Previous patch() called server.mjs PATCH which had broken convex.site endpoint
// Now we call Convex cloud directly
async function syncTaskToMC(agent, status, title='') {
  try {
    await fetch('http://127.0.0.1:5190/api/mc/task-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agent.toLowerCase(), status, title }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {}
}

async function patchTaskConvex(taskId, status) {
  const { default: https } = await import('node:https');
  const body = JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status } });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'expert-dachshund-299.convex.cloud',
      path: '/api/mutation', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.status === 'success'); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}
