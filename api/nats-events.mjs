/**
 * NATS Event Publisher — forge publishes system events to JetStream
 * Subscribers: other agents via their watch loops
 */

let nc = null;
let js = null;
const NATS_URL = process.env.NATS_URL || 'nats://100.79.127.66:4222';
const NATS_TOKEN = process.env.NATS_TOKEN || 'asystem-nats-2026-secret';

export async function getNATSClient() {
  if (nc && !nc.isDraining()) return { nc, js };
  try {
    const { connect, StringCodec, JSONCodec } = await import('nats');
    nc = await connect({ servers: NATS_URL, token: NATS_TOKEN, timeout: 5000 });
    js = nc.jetstream();
    console.log('[NATS] Connected to', NATS_URL);
    return { nc, js };
  } catch (e) {
    console.warn('[NATS] Connection failed:', e.message);
    return { nc: null, js: null };
  }
}

export async function publishEvent(subject, data) {
  try {
    const { js } = await getNATSClient();
    if (!js) return false;
    const { JSONCodec } = await import('nats');
    const jc = JSONCodec();
    await js.publish(subject, jc.encode({ ...data, ts: Date.now(), from: 'forge' }));
    return true;
  } catch (e) {
    console.warn('[NATS] Publish failed:', subject, e.message);
    return false;
  }
}

// Event helpers
export const events = {
  taskCreated: (task) => publishEvent('sop.task.created', task),
  taskUpdated: (task) => publishEvent('sop.task.updated', task),
  taskCompleted: (task) => publishEvent('sop.task.completed', task),
  agentDispatched: (data) => publishEvent('sop.agent.dispatched', data),
  agentResponse: (data) => publishEvent('sop.agent.response', data),
  sopStarted: (proc) => publishEvent('sop.process.started', proc),
  sopStepDone: (data) => publishEvent('sop.step.completed', data),
  alertFired: (alert) => publishEvent('sop.alert.fired', alert),
  heartbeat: (status) => publishEvent('sop.heartbeat.forge', status),
};
