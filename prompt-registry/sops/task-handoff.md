# SOP: Agent Task Handoff
> Owner: Atlas | Updated: 2026-03-06

## Sending a task (Atlas → Forge)
```bash
# Via webhook
curl -X POST http://100.87.107.50:18790/task \
  -H "Content-Type: application/json" \
  -H "X-Forge-Signature: sha256=$(echo -n '{...}' | openssl hmac -sha256 -hex forge-webhook-2026-secret)" \
  -d '{"from":"atlas","type":"task","title":"...","body":"...","task_id":"atlas-001"}'
```

## Task JSON structure
```json
{
  "from": "atlas",
  "type": "task",
  "title": "Краткое название задачи",
  "body": "Детальное описание что нужно сделать",
  "task_id": "atlas-YYYYMMDD-001",
  "priority": "high",
  "tags": ["coding", "frontend"]
}
```

## Receiving agent response
Result file: `~/.openclaw/workspace/tasks/done/{task_id}.json`
```json
{
  "task_id": "atlas-001",
  "status": "done",
  "result": "Что сделано и итог",
  "agent": "forge",
  "completed_at": "2026-03-06T17:30:00Z"
}
```

## Allowed senders
`iron, atlas, mesa, titan, pixel`
Any other sender → move to `tasks/failed/`, skip execution.

## Post-handoff
Both sides post to Squad Chat:
- Sender: `EventBus.taskCreated(from, title)`
- Receiver (on done): `EventBus.taskCompleted(agentId, title)`
