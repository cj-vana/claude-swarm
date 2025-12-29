# Claude Swarm TODO.md
Local improvements and cleanup tasks

## 🐛 Critical Issues

### Resource Management
- [ ] WorkerManager: Clean up `monitorInterval` on server shutdown
- [ ] Dashboard: More aggressive SSE client cleanup on disconnects

### Security
- [ ] `sanitizeOutput()`: Escape regex special chars in home dir replacement
- [ ] Dashboard: Add rate limiting to API endpoints

## 🧪 Testing Gaps
```
Missing test coverage:
❌ WorkerManager (tmux integration, completion monitoring)
❌ Security utilities (path traversal, command validation)
❌ Complexity detector
❌ Plan evaluator
❌ Dashboard server (API endpoints, SSE)
❌ StateManager (atomic writes, corruption recovery)
```

## 🔧 Error Handling
```
Inconsistent patterns:
- Some functions throw raw errors
- Others return typed results
- Standardize to Result<T, Error> or consistent patterns
```

## 🚀 Enhancements
```
Nice-to-haves:
[ ] Graceful shutdown handler (SIGTERM/SIGINT)
[ ] Integration tests with MCP inspector
[ ] E2E tests for full worker lifecycle
[ ] Health check endpoints for workers
[ ] Graceful tmux fallback (no tmux mode)
[ ] Worker timeout configuration
[ ] Memory usage monitoring
```

## 📋 PR Status Check
```
Verify all 6 PRs are merge-ready:
✅ PR1: Test Coverage Foundation (MERGED)
❌ PR2: Feature Validation Framework (OPEN)
❌ PR3: Git Verification (OPEN) ✓ Syntax fixed
❌ PR4: Structured Prompt Templates (OPEN)
❌ PR5: Enhanced State Schemas (OPEN)
❌ PR6: Confidence Tests (OPEN)
```

## Next Actions
1. Run `npm install` (tsc missing)
2. Add missing tests
3. Fix resource leaks
4. Standardize error handling
5. Push remaining PRs to merge