# Task 4 Report: recipe-assistant authorization and repository skeleton

## Status

Implemented the Task 4 server-side authorization boundary, repository skeleton, read-only recipe actions, constrained error/log handling, and in-memory authorization tests. Task 5 draft/version write semantics were not implemented.

## TDD Evidence

### RED

Command:

```text
node --test --test-isolation=none tests/recipe-assistant-handler.test.js
```

Observed before production implementation:

```text
Error: Cannot find module '../cloudfunctions/recipe-assistant'
tests 1
pass 0
fail 1
```

The failure was the expected missing Task 4 module, not a test setup or syntax failure.

### GREEN

Command:

```text
node --test --test-isolation=none tests/recipe-assistant-handler.test.js
```

Final focused result after implementation and self-review cleanup:

```text
tests 14
pass 14
fail 0
```

Coverage includes trusted OPENID authorization, revoked/non-member denial, purged and deleted dish behavior, family/dish/record ownership, absent recipes, version ordering and limit, response sanitization, `_id` stripping, transactions, and constrained logs.

### Full suite

Command run once on the final production code:

```text
npm test
```

Result:

```text
tests 228
pass 228
fail 0
duration_ms 1168.6925
```

The suite also printed the pre-existing exercised diagnostic `[CloudBase] load CLOUD_CALL_FAILED`; it did not represent a test failure.

## Changed Files

- `cloudfunctions/recipe-assistant/index.js` — trusted identity boundary, authorization guards, read-only actions, safe responses, and constrained logging.
- `cloudfunctions/recipe-assistant/repository.js` — family/dish/record-scoped repository skeleton and transaction delegation.
- `cloudfunctions/recipe-assistant/logic.js` — stable errors, public-message mapping, `_id` stripping, and recursive response sanitization.
- `cloudfunctions/recipe-assistant/package.json` — independently deployable cloud-function package using `wx-server-sdk`.
- `tests/recipe-assistant-handler.test.js` — CloudBase-style in-memory database and Task 4 security/read tests.
- `.superpowers/sdd/2026-08-13-voice-recipe-assistant/task-4-report.md` — this report.

The existing Task 2 `cloudfunctions/recipe-assistant/recipe-schema.js` remains in the independently deployable package and was not duplicated or modified.

## Self-review

- Authentication in `main` uses only `cloud.getWXContext().OPENID`; caller-supplied `event.openid`, `event.memberId`, and context OPENID do not authorize the request.
- Every recognized or pending recipe action reaches active family-membership and family-owned dish checks before dispatch.
- Purged tombstones return `DISH_PURGED` for read and pending mutation action names.
- Deleted dishes permit only recipe/version reads and bound `getRecordWorkspace`; mutation action names return `DISH_DELETED`.
- Repository reads constrain family, dish, and record ownership; `getVersion` checks both family and dish.
- `getRecipe` returns a null pair when the pointer or owned version is absent; versions are descending and capped at 100.
- Repository `set` and `add` paths strip `_id` before calling CloudBase.
- Successful data is recursively sanitized for OPENID and temporary URL fields; query predicates prevent other-family documents from entering results.
- Error responses contain only `code` and `message`; emitted error log objects contain only `stage`, `action`, `code`, `requestId`, and `durationMs`.
- No recording, ASR, organizing, draft mutation, confirmation, or immutable-version write behavior from Task 5 was added.
- No scratch files were created.

## Concerns

None. Git staging initially required permission to update the linked worktree metadata; approval was granted and staging succeeded.

## Fix round 1

Addressed all three Important security findings without implementing Task 5 behavior:

- Empty or whitespace-only trusted `OPENID` now fails closed with `{ code: 'AUTH_REQUIRED', message: '无法确认登录身份' }` before querying membership. A malformed active member whose stored `openid` is empty cannot authorize.
- The complete record-scoped action contract is defined. Actions whose planned request contract directly carries `recordId` validate family/dish/record ownership before dispatch or `ACTION_INVALID`; indirect `recordingId`/`draftId` ownership remains part of those later action implementations.
- Recursive success sanitization denies every case-insensitive key containing `openid` and every URL-suffixed field, including `audioUrl`, `downloadUrl`, and `tempFileURL`, while preserving durable `fileId` fields and ordinary recipe content.

### RED

Command:

```text
node --test --test-isolation=none tests/recipe-assistant-handler.test.js
```

Observed before the fix:

```text
tests 17
pass 13
fail 4
```

The four expected failures demonstrated: blank trusted identity authorized the malformed empty-OPENID member; record action contract exports were absent; a cross-dish pending `reserveRecording` reached `ACTION_INVALID` instead of `RECORD_NOT_FOUND`; and nested creator/audio/download fields escaped sanitization.

### GREEN

Command:

```text
node --test --test-isolation=none tests/recipe-assistant-handler.test.js
```

Result:

```text
tests 17
pass 17
fail 0
duration_ms 24.7299
```

### Full suite

Command:

```text
npm test
```

Result:

```text
tests 231
pass 231
fail 0
duration_ms 1171.266
```

The suite printed the existing exercised diagnostic `[CloudBase] load CLOUD_CALL_FAILED`; it was not a test failure.
