# SOP: Code Review (Critic Agent)
> Owner: Atlas | Updated: 2026-03-06

## Trigger
Code Review запускается автоматически когда:
- Задача перемещается в колонку `done` с типом `code`
- PR создан на GitHub
- Явный запрос через `sd begin review-task-id`

## Checklist
### Security (CISO check)
- [ ] No hardcoded secrets / API keys
- [ ] No SQL injection vectors
- [ ] No XSS vulnerabilities
- [ ] Dependencies up-to-date (no critical CVEs)

### Code Quality
- [ ] TypeScript types correct (no `any`)
- [ ] Error handling present
- [ ] No console.log in production code
- [ ] Functions < 50 lines (single responsibility)
- [ ] Tests cover happy path + edge cases

### Performance
- [ ] No N+1 queries
- [ ] useCallback/useMemo used where needed
- [ ] Large lists virtualized

### ASYSTEM Standards
- [ ] API_BASE used (not hardcoded URLs)
- [ ] Events posted to EventBus after key actions
- [ ] Squad Chat notified on deploy
- [ ] Git commit message follows: `feat/fix/refactor: description`

## Score
- 90-100%: ✅ Approve → merge
- 70-89%: ⚠️ Approve with suggestions
- < 70%: ❌ Request changes

## Output format
```
Code Review: {task title}
Score: {N}/100
Status: ✅ / ⚠️ / ❌
Issues: 
  - [critical] ...
  - [suggestion] ...
Approve: yes/no
```
