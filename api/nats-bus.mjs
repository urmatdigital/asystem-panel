/**
 * NATS Event Bus — MetaGPT Watch Pattern Implementation
 * Agents subscribe to events, SOP Engine publishes
 * 
 * Events: UserRequirement, PRD, ArchitectureDesign, TaskAssignment,
 *   CodeComplete, TestReport, TestPass, Approval, DeployComplete,
 *   BugReport, SecurityAlert, SprintComplete, APIReady, IncidentAlert
 */
import { connect, StringCodec, JSONCodec } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://100.79.127.66:4222";
const NATS_TOKEN = process.env.NATS_TOKEN || "asystem-nats-2026-secret";

let nc = null;
let js = null;  // JetStream
const sc = StringCodec();
const jc = JSONCodec();

// Watch matrix — who listens to what
const WATCH_MATRIX = {
  atlas:  ["UserRequirement", "PRD", "TestReport", "BugReport", "SprintComplete"],
  forge:  ["ArchitectureDesign", "TaskAssignment", "BugReport", "CodeIncident"],
  dana:   ["UserRequirement", "ArchitectureDesign", "CodeComplete", "BlockedTask"],
  bekzat: ["ArchitectureDesign", "TaskAssignment", "APISpec"],
  ainura: ["UISpec", "APIReady", "TaskAssignment"],
  marat:  ["CodeComplete", "NewFeature", "BugFix"],
  nurlan: ["TestPass", "Approval", "SecurityAlert"],
  iron:   ["SecurityAlert", "DeployComplete", "BugReport"],
  mesa:   ["SprintComplete", "DeployComplete", "DailyTrigger", "IncidentResolved"],
};

// Event handlers registered by subscribers
const handlers = new Map(); // event -> [{ agent, callback }]

/**
 * Connect to NATS
 */
export async function connectNats() {
  try {
    nc = await connect({
      servers: NATS_URL,
      token: NATS_TOKEN,
      name: "asystem-sop-engine",
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    
    // Setup JetStream
    js = nc.jetstream();
    
    // Create stream for SOP events (if not exists)
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.add({
        name: "SOP_EVENTS",
        subjects: ["sop.>"],
        retention: "limits",
        max_msgs: 10000,
        max_age: 7 * 24 * 60 * 60 * 1e9, // 7 days in nanos
        storage: "file",
      });
      console.log("[nats-bus] Created SOP_EVENTS stream");
    } catch (e) {
      if (e.message?.includes("already in use")) {
        console.log("[nats-bus] SOP_EVENTS stream exists");
      } else {
        console.warn("[nats-bus] Stream setup warning:", e.message);
      }
    }
    
    console.log(`[nats-bus] Connected to ${NATS_URL}`);
    return nc;
  } catch (err) {
    console.error(`[nats-bus] Connection failed: ${err.message}`);
    return null;
  }
}

/**
 * Publish event to NATS
 * @param {string} eventType - e.g. "CodeComplete", "BugReport"
 * @param {object} payload - { from, to, action, content, metadata }
 */
export async function publishEvent(eventType, payload) {
  if (!nc) {
    console.warn("[nats-bus] Not connected, skipping publish");
    return false;
  }
  
  const msg = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    type: eventType,
    ...payload,
  };
  
  // Publish to subject pattern: sop.events.<eventType>
  const subject = `sop.events.${eventType}`;
  
  try {
    // Publish to JetStream for durability
    if (js) {
      await js.publish(subject, jc.encode(msg));
    } else {
      // Fallback to core NATS
      nc.publish(subject, jc.encode(msg));
    }
    
    console.log(`[nats-bus] Published ${eventType} from ${payload.from || "system"}`);
    
    // Also notify local handlers
    const localHandlers = handlers.get(eventType) || [];
    for (const h of localHandlers) {
      try { await h.callback(msg); } catch (e) { console.error(`[nats-bus] Handler error:`, e); }
    }
    
    return true;
  } catch (err) {
    console.error(`[nats-bus] Publish error:`, err.message);
    return false;
  }
}

/**
 * Subscribe agent to their watch events
 * @param {string} agent - agent name
 * @param {function} callback - (msg) => {}
 */
export async function subscribeAgent(agent, callback) {
  const events = WATCH_MATRIX[agent];
  if (!events) {
    console.warn(`[nats-bus] No watch events for agent: ${agent}`);
    return [];
  }
  
  const subs = [];
  for (const event of events) {
    const subject = `sop.events.${event}`;
    
    // Register local handler
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push({ agent, callback });
    
    // Subscribe to NATS
    if (nc) {
      const sub = nc.subscribe(subject);
      subs.push(sub);
      
      (async () => {
        for await (const msg of sub) {
          try {
            const data = jc.decode(msg.data);
            await callback(data);
          } catch (e) {
            console.error(`[nats-bus] ${agent} handler error for ${event}:`, e);
          }
        }
      })();
    }
    
    console.log(`[nats-bus] ${agent} watching: ${event}`);
  }
  
  return subs;
}

/**
 * Subscribe to all SOP process events
 * @param {function} callback - (msg) => {}
 */
export async function subscribeAll(callback) {
  if (!nc) return null;
  
  const sub = nc.subscribe("sop.events.>");
  
  (async () => {
    for await (const msg of sub) {
      try {
        const data = jc.decode(msg.data);
        await callback(data);
      } catch (e) {
        console.error("[nats-bus] Global handler error:", e);
      }
    }
  })();
  
  console.log("[nats-bus] Global subscription active");
  return sub;
}

/**
 * Publish SOP step completion event
 */
export async function publishStepComplete(processId, stepIndex, agent, action, output) {
  return publishEvent("StepComplete", {
    from: agent,
    content: output,
    metadata: { processId, stepIndex, action },
  });
}

/**
 * Publish SOP process lifecycle events
 */
export async function publishProcessCreated(process) {
  return publishEvent("ProcessCreated", {
    from: "sop-engine",
    content: `SOP ${process.sopId} started: ${process.trigger}`,
    metadata: { processId: process.id, sopId: process.sopId },
  });
}

export async function publishProcessCompleted(process) {
  return publishEvent("ProcessCompleted", {
    from: "sop-engine",
    content: `SOP ${process.sopId} completed`,
    metadata: { processId: process.id, sopId: process.sopId },
  });
}

/**
 * Get connection status
 */
export function isConnected() {
  return nc && !nc.isClosed();
}

/**
 * Get WATCH_MATRIX
 */
export function getWatchMatrix() {
  return WATCH_MATRIX;
}

/**
 * Disconnect
 */
export async function disconnect() {
  if (nc) {
    await nc.drain();
    console.log("[nats-bus] Disconnected");
  }
}
