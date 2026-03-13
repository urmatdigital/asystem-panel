/**
 * SOP Engine — BPMN-powered Process Execution for ASYSTEM
 * 
 * Combines:
 * - bpmn-engine: BPMN 2.0 XML parsing and execution
 * - A2A Protocol: agent-to-agent dispatch
 * - Convex: persistence and real-time state
 * 
 * Flow: BPMN diagram → parse → execute steps → dispatch to agents → track progress
 */

import { Engine } from 'bpmn-engine';
import { findBestAgent, AGENT_CAPABILITIES } from './a2a-protocol.mjs';
import { connectNats, publishEvent, publishProcessCreated, publishProcessCompleted, publishStepComplete, isConnected as natsConnected } from './nats-bus.mjs';

const CONVEX_CLOUD = 'https://expert-dachshund-299.convex.cloud';

// Auto-connect to NATS on module load
connectNats().catch(e => console.warn('[sop-engine] NATS connect deferred:', e.message));

// ── Agent dispatch config ──────────────────────────────────────────────
const AGENT_GATEWAYS = {
  forge:  { ip: '100.87.107.50',  port: 18789, token: null }, // local
  atlas:  { ip: '100.68.144.79',  port: 18789, token: 'atlas-proxmox-vm216-77f69ebeec37f60bd7324cf9' },
  iron:   { ip: '100.114.136.87', port: 18789, token: 'iron-vps-c01d6818d635d80523bbb355' },
  mesa:   { ip: '100.100.40.27',  port: 18789, token: null },
  nurlan: { ip: '100.83.188.95',  port: 18789, token: 'nurlan-pve2-2026-b7f23a918c44' },
  bekzat: { ip: '100.66.219.32',  port: 18789, token: 'bekzat-pve2-2026-aceca388538a' },
  ainura: { ip: '100.112.184.63', port: 18789, token: 'ainura-pve2-2026-98b2cf94456f' },
  marat:  { ip: '100.107.171.121',port: 18789, token: 'marat-pve2-2026-70bd808f3957' },
  dana:   { ip: '100.114.5.104',  port: 18789, token: 'dana-pve2-2026-1b9cb2394b15' },
};

// ── SOP Definitions ────────────────────────────────────────────────────
const SOP_DEFINITIONS = {
  'sop-001': {
    id: 'sop-001',
    name: 'Feature Development',
    steps: [
      { id: 'prd',       agent: 'dana',   action: 'WritePRD',           waitFor: null },
      { id: 'design',    agent: 'atlas',  action: 'DesignArchitecture', waitFor: 'prd' },
      { id: 'plan',      agent: 'dana',   action: 'PlanSprint',         waitFor: 'design' },
      { id: 'backend',   agent: 'bekzat', action: 'WriteAPI',           waitFor: 'plan' },
      { id: 'frontend',  agent: 'ainura', action: 'BuildUI',            waitFor: 'backend' },
      { id: 'integrate', agent: 'forge',  action: 'BuildFeature',       waitFor: 'frontend' },
      { id: 'test',      agent: 'marat',  action: 'WriteTest',          waitFor: 'integrate' },
      { id: 'review',    agent: 'atlas',  action: 'ReviewCode',         waitFor: 'test' },
      { id: 'deploy',    agent: 'nurlan', action: 'DeployService',      waitFor: 'review' },
    ],
  },
  'sop-002': {
    id: 'sop-002',
    name: 'Bug Resolution',
    steps: [
      { id: 'triage',   agent: 'atlas',  action: 'TriageBug',         waitFor: null },
      { id: 'security', agent: 'iron',   action: 'SecurityAudit',     waitFor: 'triage' },
      { id: 'fix',      agent: 'forge',  action: 'FixBug',            waitFor: 'triage' },
      { id: 'validate', agent: 'marat',  action: 'ValidateQuality',   waitFor: 'fix' },
      { id: 'deploy',   agent: 'nurlan', action: 'DeployService',     waitFor: 'validate' },
    ],
  },
  'sop-003': {
    id: 'sop-003',
    name: 'Sprint Cycle',
    steps: [
      { id: 'plan',   agent: 'dana',  action: 'PlanSprint',      waitFor: null },
      { id: 'standup', agent: 'mesa', action: 'GenerateReport',  waitFor: 'plan' },
      { id: 'retro',  agent: 'mesa',  action: 'AnalyzeData',     waitFor: 'standup' },
      { id: 'adjust', agent: 'atlas', action: 'DefineStrategy',  waitFor: 'retro' },
    ],
  },
  'sop-004': {
    id: 'sop-004',
    name: 'Incident Response',
    steps: [
      { id: 'triage',     agent: 'iron',   action: 'SecurityAudit',   waitFor: null },
      { id: 'diagnose',   agent: 'nurlan', action: 'DiagnoseAndFix',  waitFor: 'triage' },
      { id: 'hotfix',     agent: 'forge',  action: 'FixBug',          waitFor: 'triage' },
      { id: 'postmortem', agent: 'mesa',   action: 'GenerateReport',  waitFor: 'hotfix' },
    ],
  },
  'sop-005': {
    id: 'sop-005',
    name: 'Deployment Pipeline',
    steps: [
      { id: 'ci',       agent: 'nurlan', action: 'SetupCI',         waitFor: null },
      { id: 'test',     agent: 'marat',  action: 'RunE2E',          waitFor: 'ci' },
      { id: 'deploy',   agent: 'nurlan', action: 'DeployService',   waitFor: 'test' },
      { id: 'scan',     agent: 'iron',   action: 'SecurityAudit',   waitFor: 'deploy' },
      { id: 'monitor',  agent: 'mesa',   action: 'ForecastMetrics', waitFor: 'scan' },
    ],
  },
};

// ── BPMN XML Generator ─────────────────────────────────────────────────
/**
 * Generate BPMN 2.0 XML from an SOP definition
 */
export function sopToBpmn(sopDef) {
  const { id, name, steps } = sopDef;
  
  // Generate flow nodes
  const tasks = steps.map((step, i) => {
    const x = 300 + i * 200;
    return {
      id: `Task_${step.id}`,
      name: `${step.agent}: ${step.action}`,
      agent: step.agent,
      action: step.action,
      x, y: 240,
    };
  });

  // XML generation
  const taskElements = tasks.map(t => 
    `    <bpmn:serviceTask id="${t.id}" name="${t.name}">
      <bpmn:extensionElements>
        <asystem:agent>${t.agent}</asystem:agent>
        <asystem:action>${t.action}</asystem:action>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`
  ).join('\n');

  // Sequence flows
  const flows = [];
  flows.push(`    <bpmn:sequenceFlow id="Flow_start" sourceRef="StartEvent_1" targetRef="${tasks[0].id}" />`);
  for (let i = 0; i < tasks.length - 1; i++) {
    flows.push(`    <bpmn:sequenceFlow id="Flow_${i}" sourceRef="${tasks[i].id}" targetRef="${tasks[i+1].id}" />`);
  }
  flows.push(`    <bpmn:sequenceFlow id="Flow_end" sourceRef="${tasks[tasks.length-1].id}" targetRef="EndEvent_1" />`);

  // Shape positions
  const shapes = [
    `      <bpmndi:BPMNShape id="Shape_Start" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="247" width="36" height="36" />
      </bpmndi:BPMNShape>`,
    ...tasks.map(t => 
      `      <bpmndi:BPMNShape id="Shape_${t.id}" bpmnElement="${t.id}">
        <dc:Bounds x="${t.x}" y="220" width="160" height="80" />
      </bpmndi:BPMNShape>`
    ),
    `      <bpmndi:BPMNShape id="Shape_End" bpmnElement="EndEvent_1">
        <dc:Bounds x="${300 + tasks.length * 200}" y="247" width="36" height="36" />
      </bpmndi:BPMNShape>`,
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:asystem="http://asystem.kg/bpmn"
  id="Definitions_${id}" targetNamespace="http://asystem.kg/bpmn">
  <bpmn:process id="Process_${id}" name="${name}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start" />
${taskElements}
    <bpmn:endEvent id="EndEvent_1" name="End" />
${flows.join('\n')}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_${id}">
${shapes.join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

// ── Process Store (in-memory + Convex sync) ────────────────────────────
const activeProcesses = new Map();

/**
 * Create a new process instance from SOP
 */
export function createProcess(sopId, trigger, triggeredBy = 'manual') {
  const sopDef = SOP_DEFINITIONS[sopId];
  if (!sopDef) throw new Error(`Unknown SOP: ${sopId}`);

  const processId = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  
  const process = {
    id: processId,
    sopId,
    name: sopDef.name,
    trigger,
    triggeredBy,
    status: 'active',
    currentStepIndex: 0,
    steps: sopDef.steps.map(s => ({
      ...s,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      output: null,
      error: null,
    })),
    startedAt: Date.now(),
    completedAt: null,
    events: [],
  };

  // Mark first step as running
  process.steps[0].status = 'running';
  process.steps[0].startedAt = Date.now();

  activeProcesses.set(processId, process);

  // Log event
  process.events.push({
    timestamp: Date.now(),
    type: 'process_started',
    message: `SOP ${sopId} triggered: ${trigger}`,
  });

  // Sync to Convex
  syncProcessToConvex(process).catch(err => console.error('Convex sync error:', err));

  // Publish to NATS
  publishProcessCreated(process).catch(() => {});

  return process;
}

/**
 * Advance process to next step
 */
export function advanceProcess(processId, output = null) {
  const process = activeProcesses.get(processId);
  if (!process || process.status !== 'active') return null;

  const currentStep = process.steps[process.currentStepIndex];
  currentStep.status = 'done';
  currentStep.completedAt = Date.now();
  currentStep.output = output;

  process.events.push({
    timestamp: Date.now(),
    type: 'step_completed',
    step: currentStep.id,
    agent: currentStep.agent,
    action: currentStep.action,
    message: `${currentStep.agent} completed ${currentStep.action}`,
  });

  // Move to next step
  const nextIndex = process.currentStepIndex + 1;
  if (nextIndex < process.steps.length) {
    process.currentStepIndex = nextIndex;
    process.steps[nextIndex].status = 'running';
    process.steps[nextIndex].startedAt = Date.now();

    process.events.push({
      timestamp: Date.now(),
      type: 'step_started',
      step: process.steps[nextIndex].id,
      agent: process.steps[nextIndex].agent,
      action: process.steps[nextIndex].action,
    });
  } else {
    process.status = 'completed';
    process.completedAt = Date.now();
    process.events.push({
      timestamp: Date.now(),
      type: 'process_completed',
      message: `SOP ${process.sopId} completed in ${Math.round((Date.now() - process.startedAt) / 1000)}s`,
    });
    // NATS: process completed
    publishProcessCompleted(process).catch(() => {});
  }

  // NATS: step completed event
  publishStepComplete(processId, process.currentStepIndex, currentStep.agent, currentStep.action, output).catch(() => {});

  // Publish domain event for Watch pattern
  const ACTION_TO_EVENT = {
    WritePRD: 'PRD', DesignArchitecture: 'ArchitectureDesign', PlanSprint: 'TaskAssignment',
    WriteAPI: 'APIReady', BuildUI: 'CodeComplete', BuildFeature: 'CodeComplete',
    WriteTest: 'TestReport', RunE2E: 'TestReport', ValidateQuality: 'TestPass',
    ReviewCode: 'Approval', DeployService: 'DeployComplete', SecurityAudit: 'SecurityReport',
    FixBug: 'BugFix', DiagnoseAndFix: 'BugFix', GenerateReport: 'DataReport',
  };
  const domainEvent = ACTION_TO_EVENT[currentStep.action];
  if (domainEvent) {
    publishEvent(domainEvent, {
      from: currentStep.agent,
      content: output || `${currentStep.action} completed`,
      metadata: { processId, stepIndex: process.currentStepIndex, sopId: process.sopId },
    }).catch(() => {});
  }

  syncProcessToConvex(process).catch(err => console.error('Convex sync error:', err));
  return process;
}

/**
 * Fail a process step
 */
export function failProcess(processId, error) {
  const process = activeProcesses.get(processId);
  if (!process || process.status !== 'active') return null;

  const currentStep = process.steps[process.currentStepIndex];
  currentStep.status = 'failed';
  currentStep.error = error;

  process.status = 'failed';
  process.events.push({
    timestamp: Date.now(),
    type: 'step_failed',
    step: currentStep.id,
    agent: currentStep.agent,
    error,
  });

  syncProcessToConvex(process).catch(err => console.error('Convex sync error:', err));
  return process;
}

/**
 * Get all active processes
 */
export function getActiveProcesses() {
  return Array.from(activeProcesses.values());
}

/**
 * Get process by ID
 */
export function getProcess(processId) {
  return activeProcesses.get(processId);
}

/**
 * Get SOP definitions
 */
export function getSopDefinitions() {
  return Object.values(SOP_DEFINITIONS);
}

/**
 * Get SOP as BPMN XML
 */
export function getSopBpmn(sopId) {
  const def = SOP_DEFINITIONS[sopId];
  if (!def) return null;
  return sopToBpmn(def);
}

// ── Dispatch to Agent ──────────────────────────────────────────────────
/**
 * Send a task to an agent via OpenClaw gateway
 */
export async function dispatchToAgent(agent, action, context) {
  const gw = AGENT_GATEWAYS[agent];
  if (!gw) {
    console.warn(`No gateway config for agent: ${agent}`);
    return { success: false, error: 'No gateway config' };
  }

  const message = `[SOP Task] Action: ${action}\nContext: ${JSON.stringify(context)}`;

  try {
    // For local (forge) — use direct task file
    if (agent === 'forge') {
      const fs = await import('fs');
      const taskFile = `/Users/urmatmyrzabekov/.openclaw/workspace/tasks/inbox/sop-${Date.now()}.json`;
      fs.writeFileSync(taskFile, JSON.stringify({
        from: 'sop-engine',
        type: 'task',
        title: `[SOP] ${action}`,
        body: message,
        task_id: `sop_${Date.now()}`,
        timestamp: new Date().toISOString(),
      }));
      return { success: true, method: 'task-file' };
    }

    // For remote agents — use gateway wake event
    const url = `http://${gw.ip}:${gw.port}/api/wake`;
    const headers = { 'Content-Type': 'application/json' };
    if (gw.token) headers['Authorization'] = `Bearer ${gw.token}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: message, mode: 'now' }),
      signal: AbortSignal.timeout(10000),
    });

    return { success: resp.ok, method: 'gateway-wake', status: resp.status };
  } catch (err) {
    console.error(`Dispatch to ${agent} failed:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Execute Process (auto-dispatch) ────────────────────────────────────
/**
 * Execute current step by dispatching to assigned agent
 */
export async function executeCurrentStep(processId) {
  const process = activeProcesses.get(processId);
  if (!process || process.status !== 'active') return null;

  const step = process.steps[process.currentStepIndex];
  if (step.status !== 'running') return null;

  const result = await dispatchToAgent(step.agent, step.action, {
    processId,
    sopId: process.sopId,
    trigger: process.trigger,
    stepId: step.id,
    stepIndex: process.currentStepIndex,
    totalSteps: process.steps.length,
  });

  process.events.push({
    timestamp: Date.now(),
    type: 'dispatch_sent',
    step: step.id,
    agent: step.agent,
    result,
  });

  return { process, dispatchResult: result };
}

// ── BPMN Engine Integration ────────────────────────────────────────────
/**
 * Execute a BPMN XML process using bpmn-engine
 */
export async function executeBpmn(bpmnXml, variables = {}) {
  return new Promise((resolve, reject) => {
    const engine = new Engine({
      name: 'asystem-process',
      source: bpmnXml,
    });

    const results = [];

    engine.execute({
      variables,
      services: {
        // Service task handler — dispatches to agents
        async executeTask(scope, callback) {
          const { id, name } = scope.content;
          results.push({ taskId: id, taskName: name, timestamp: Date.now() });
          
          // Parse agent:action from task name
          const match = name?.match(/^(\w+):\s*(.+)$/);
          if (match) {
            const [, agent, action] = match;
            try {
              await dispatchToAgent(agent, action.trim(), { bpmnTaskId: id });
            } catch {}
          }
          
          callback(null, { completed: true });
        },
      },
    }, (err, execution) => {
      if (err) return reject(err);
      
      execution.on('end', () => {
        resolve({ status: 'completed', tasks: results });
      });

      execution.on('error', (error) => {
        reject(error);
      });
    });
  });
}

// ── Convex Sync ────────────────────────────────────────────────────────
async function syncProcessToConvex(process) {
  try {
    await fetch(`${CONVEX_CLOUD}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'tasks:upsert',
        args: {
          externalId: `sop-${process.id}`,
          title: `[SOP] ${process.name}: ${process.trigger}`,
          description: JSON.stringify({
            sopId: process.sopId,
            status: process.status,
            currentStep: process.currentStepIndex,
            steps: process.steps.map(s => ({ id: s.id, agent: s.agent, action: s.action, status: s.status })),
          }),
          agent: process.steps[process.currentStepIndex]?.agent || 'forge',
          status: process.status === 'active' ? 'in-progress' : process.status === 'completed' ? 'done' : 'blocked',
          type: 'sop',
          priority: 'high',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Silent fail for Convex sync — not critical
  }
}

// ── Export all ──────────────────────────────────────────────────────────
export { SOP_DEFINITIONS, AGENT_GATEWAYS };
