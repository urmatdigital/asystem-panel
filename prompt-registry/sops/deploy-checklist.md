# SOP: Deploy Checklist
> Owner: Forge | Updated: 2026-03-06

## Pre-deploy
- [ ] `pnpm build` — 0 errors
- [ ] API endpoints tested locally
- [ ] `.env` vars committed (encrypted/excluded from git)
- [ ] Veritas task → In Progress

## Deploy
- [ ] `pm2 restart asystem-api`
- [ ] Restart serve: `pkill -f "serve.*8899" && nohup serve -s dist -l 8899 &`
- [ ] CF tunnel still running: `ps aux | grep cloudflared`
- [ ] Verify: `curl -s https://os.asystem.kg/ -o /dev/null -w "%{http_code}"`

## Post-deploy
- [ ] Check `/api/agents` → agents responding
- [ ] Check `/kanban` → Veritas tasks load
- [ ] Post to Squad Chat: `EventBus.deploySuccess('forge', 'panel', 'https://os.asystem.kg')`
- [ ] Veritas task → Done
- [ ] Git commit: `git commit -m "feat/fix: ..."`

## Rollback
```bash
git revert HEAD
pnpm build
pm2 restart asystem-api
```
