/**
 * living-context.mjs — Auto-updated ORGONASYSTEM/CONTEXT.md
 *
 * NotebookLM pattern: "Living Context Document" that agents keep
 * up-to-date after every completed task. Acts as shared project memory.
 *
 * Updated after: Blueprint CI pass + task complete (done)
 * Location: ~/projects/ORGONASYSTEM/CONTEXT.md
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const CONTEXT_PATH= path.join(HOME, 'projects/ORGONASYSTEM/CONTEXT.md');
const AUDIT_LOG   = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');
const MAX_LOG     = 30; // keep last 30 completed tasks in context

function ensureContextFile() {
  if (!fs.existsSync(CONTEXT_PATH)) {
    const initial = `# ORGONASYSTEM — Living Context Document
> Auto-maintained by AI agents (bekzat/ainura). Last updated: ${new Date().toISOString()}
> Do NOT manually edit the "## Recent Agent Activity" section — it's auto-generated.

## Stack
- **Backend:** FastAPI 0.115+ · asyncpg · Neon (PostgreSQL) · JWT auth
- **Frontend:** Next.js 16 · TypeScript · Aceternity UI · Tailwind
- **Infra:** Docker · GitHub Actions CI · Tailscale network

## Project Status
> Updated by agents. Check git log for latest.

## Known Issues / Blockers
> None recorded yet.

## Architecture Decisions
> Agents append here when making significant decisions.

## Recent Agent Activity
<!-- AUTO-GENERATED: do not edit below this line -->
`;
    fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
    fs.writeFileSync(CONTEXT_PATH, initial);
  }
}

// ── Append a task completion entry ────────────────────────────────────────────
export async function appendTaskToContext({ taskId, title, agent, result, ciPassed, score, branch }) {
  try {
    ensureContextFile();
    const raw = fs.readFileSync(CONTEXT_PATH, 'utf8');
    const marker = '<!-- AUTO-GENERATED: do not edit below this line -->';
    const markerIdx = raw.indexOf(marker);
    const header = markerIdx >= 0 ? raw.slice(0, markerIdx + marker.length) : raw;

    // Parse existing entries
    const existingSection = markerIdx >= 0 ? raw.slice(markerIdx + marker.length) : '';
    const entries = existingSection.trim().split(/\n---\n/).filter(Boolean);

    // Build new entry
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const ciIcon = ciPassed ? '✅' : '⚠️';
    const scoreStr = score != null ? ` | score ${score}/10` : '';
    const branchStr = branch ? ` | branch \`${branch}\`` : '';
    const newEntry = [
      `\n### ${ts} — [${agent}] ${(title || taskId).slice(0, 80)}`,
      `**Task:** \`${taskId}\`  **CI:** ${ciIcon}${scoreStr}${branchStr}`,
      `**Summary:** ${(result || 'completed').slice(0, 300)}`,
    ].join('\n');

    // Keep last MAX_LOG entries
    const updatedEntries = [newEntry, ...entries].slice(0, MAX_LOG);

    // Rewrite file
    const updatedHeader = header.replace(
      /> Auto-maintained by AI agents.*\n/,
      `> Auto-maintained by AI agents (bekzat/ainura). Last updated: ${new Date().toISOString()}\n`
    );
    const newContent = updatedHeader + '\n' + updatedEntries.join('\n---\n') + '\n';
    fs.writeFileSync(CONTEXT_PATH, newContent);

    console.log(`[LivingContext] 📝 Updated CONTEXT.md: ${agent} → ${(title||taskId).slice(0,50)}`);
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'context.updated', agent, taskId }) + '\n');
    return { ok: true };
  } catch (e) {
    console.warn('[LivingContext] Update failed (non-fatal):', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Append an architecture decision ──────────────────────────────────────────
export function appendDecision({ agent, decision, rationale }) {
  try {
    ensureContextFile();
    const raw = fs.readFileSync(CONTEXT_PATH, 'utf8');
    const ts = new Date().toISOString().slice(0, 10);
    const entry = `\n- **${ts} [${agent}]:** ${decision}${rationale ? ` — _${rationale}_` : ''}`;
    const updated = raw.replace(
      '## Architecture Decisions\n> Agents append here when making significant decisions.',
      `## Architecture Decisions\n> Agents append here when making significant decisions.${entry}`
    );
    if (updated !== raw) fs.writeFileSync(CONTEXT_PATH, updated);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Read current context (for agent injection) ────────────────────────────────
export function readContext(maxChars = 3000) {
  try {
    const raw = fs.readFileSync(CONTEXT_PATH, 'utf8');
    return raw.slice(0, maxChars);
  } catch { return null; }
}
