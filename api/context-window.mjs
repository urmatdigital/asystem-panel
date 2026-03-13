/**
 * context-window.mjs — Adaptive Context Window Manager
 *
 * Video: "Structured Data and AI in 2026" (T1YToIpdyCY)
 * + Claude context compression best practices (Anthropic 2026)
 *
 * Pattern: Keep context within token budget by:
 *   1. Sliding window — always include last N chars of recent context
 *   2. Importance scoring — score each block by keyword/recency/type
 *   3. Compression — LRU eviction + summarize oldest blocks
 *   4. Priority pinning — ALWAYS include: goal, error, system, critical blocks
 *
 * Context budget per dispatch (chars, not tokens — approximate 4 chars/token):
 *   Total budget: 32000 chars (~8K tokens)
 *   Reserved for task: 12000 (title + desc + result space)
 *   Available for injected context: 20000 chars
 *   Priority pin budget: 8000 chars
 *   Sliding window budget: 8000 chars
 *   Flexible fill: 4000 chars
 *
 * Block types and priority:
 *   GOAL (pinned), SYSTEM (pinned), ERROR (pinned),
 *   SKILL (high), FEDERATED (medium), MEMORY (medium),
 *   PERSONA (low), NAMESPACE (low)
 *
 * API:
 *   POST /api/context-window/build  { blocks: [{type, content, ts?}] } → { fitted, dropped, totalChars }
 *   GET  /api/context-window/stats  → budget usage stats
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const STATS_LOG = path.join(HOME, '.openclaw/workspace/context-window-stats.jsonl');

// ── Budget config ─────────────────────────────────────────────────────────────
const BUDGET = {
  total:    20000,  // chars for injected context
  pinned:   8000,   // reserved for pinned blocks (GOAL/SYSTEM/ERROR)
  sliding:  8000,   // sliding window (recent blocks)
  flexible: 4000,   // best-effort fill
};

// ── Block priority weights ────────────────────────────────────────────────────
const PRIORITY = {
  GOAL:       100,  // always include
  SYSTEM:     90,
  ERROR:      85,
  SKILL:      70,
  FEDERATED:  60,
  MEMORY:     50,
  EMPO2:      45,
  PERSONA:    30,
  NAMESPACE:  25,
  KG:         20,
  OTHER:      10,
};

// ── Score a block ─────────────────────────────────────────────────────────────
function scoreBlock(block) {
  const typePriority = PRIORITY[block.type?.toUpperCase()] || PRIORITY.OTHER;
  const recency = block.ts ? Math.exp(-(Date.now() - block.ts) / (30 * 60_000)) : 0.5; // 30min half-life
  const lengthPenalty = Math.max(0.3, 1 - block.content.length / 10000); // penalize huge blocks
  return typePriority * recency * lengthPenalty;
}

// ── Truncate block to fit max chars ──────────────────────────────────────────
function truncate(content, maxChars) {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars - 4) + '...';
}

// ── Build fitted context from blocks ─────────────────────────────────────────
export function buildContext(blocks = []) {
  if (!blocks || blocks.length === 0) return { fitted: [], dropped: [], totalChars: 0, budgetPct: 0 };

  const pinned  = [];
  const scored  = [];
  let pinnedChars = 0;
  let flexChars   = 0;

  // Separate pinned blocks
  for (const block of blocks) {
    const type = (block.type || 'OTHER').toUpperCase();
    if (['GOAL', 'SYSTEM', 'ERROR'].includes(type)) {
      if (pinnedChars + block.content.length <= BUDGET.pinned) {
        pinned.push({ ...block, _reason: 'pinned' });
        pinnedChars += block.content.length;
      }
    } else {
      scored.push({ ...block, _score: scoreBlock(block) });
    }
  }

  // Sort non-pinned by score
  scored.sort((a, b) => b._score - a._score);

  const fitted  = [...pinned];
  const dropped = [];
  const remaining = BUDGET.total - pinnedChars;

  for (const block of scored) {
    const maxLen = Math.min(block.content.length, remaining - flexChars);
    if (maxLen <= 50) { dropped.push({ type: block.type, reason: 'budget_exceeded', chars: block.content.length }); continue; }

    const content = truncate(block.content, maxLen);
    fitted.push({ ...block, content, _truncated: content.length < block.content.length });
    flexChars += content.length;
    if (flexChars >= remaining) break;
  }

  const totalChars = pinnedChars + flexChars;
  const budgetPct  = Math.round((totalChars / BUDGET.total) * 100);

  // Log stats
  try {
    fs.appendFileSync(STATS_LOG, JSON.stringify({ ts: Date.now(), totalChars, budgetPct, fitted: fitted.length, dropped: dropped.length, pinnedChars }) + '\n');
  } catch {}

  if (dropped.length > 0) console.log(`[CtxWindow] 📐 Budget: ${totalChars}/${BUDGET.total} chars (${budgetPct}%) — dropped ${dropped.length} blocks`);

  return { fitted, dropped, totalChars, budgetPct };
}

export function getBudgetConfig() { return BUDGET; }

// ── Estimate tokens from chars ────────────────────────────────────────────────
export function estimateTokens(chars) { return Math.ceil(chars / 4); }
