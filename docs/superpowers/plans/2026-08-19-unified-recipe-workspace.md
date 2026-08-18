# Unified Recipe Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete phase-two voice-to-recipe flow visible and usable from dish detail while keeping manual recipe entry available and compact.

**Architecture:** Keep the existing distinction between record-bound voice workspaces and record-free manual main-recipe drafts. Unify their entry points in the dish detail UI, move the existing recording component to the top of the record flow, add an explicit first-use privacy explanation, and compact the existing draft editor without changing recipe storage schemas.

**Tech Stack:** WeChat Mini Program JavaScript/WXML/WXSS, CloudBase, Node.js `node:test`.

## Global Constraints

- Voice recognition supports Mandarin through `16k_zh` only; no dialect selector is added.
- Voice and AI output remain drafts until a family member explicitly confirms them.
- Manual recipe entry remains fully usable when ASR or AI is unavailable.
- Existing recipe, recording, version, optimistic-lock, quota, and deletion schemas remain unchanged.
- Original audio remains private and is uploaded only after the user sees the recording-purpose explanation.
- No chat, public community, automatic publishing, or automatic model fallback is added.

---

### Task 1: Expose a unified voice-first recipe entry

**Files:**
- Modify: `tests/recipe-pages.test.js`
- Modify: `pages/dish-edit/dish-edit.js`
- Modify: `pages/dish-edit/dish-edit.wxml`
- Modify: `pages/dish-edit/dish-edit.wxss`

**Interfaces:**
- Produces: `startVoiceRecipeEntry()` opens a provisional record workspace and scrolls to `#recordingWorkspaceAnchor`.
- Produces: `openManualFamilyRecipe()` keeps the existing `createManualDraft({ sourceType: 'manual' })` path.
- Produces: `toggleRecordExtras()` controls optional photo/date/meal fields through `recordExtrasExpanded`.

- [ ] **Step 1: Write the failing entry tests**

Add tests that instantiate the dish page and assert that `startVoiceRecipeEntry()` sets `recordFormVisible` to `true`, creates a stable `recordIdDraft`, keeps `recordExtrasExpanded` false, and calls:

```js
wx.pageScrollTo({ selector: '#recordingWorkspaceAnchor', duration: 240 });
```

Also assert that the template contains the labels “语音记录做法” and “直接手动填写”, and that the recording component appears before the optional record-fields card.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-isolation=none --test-name-pattern="voice-first recipe entry" tests/recipe-pages.test.js
```

Expected: FAIL because `startVoiceRecipeEntry`, `recordExtrasExpanded`, and the new template labels do not exist.

- [ ] **Step 3: Implement the minimal entry behavior**

Add page state and methods equivalent to:

```js
recordExtrasExpanded: false,

startVoiceRecipeEntry() {
  this.startRecordEntry();
  this.setData({ recordExtrasExpanded: false });
  setTimeout(() => wx.pageScrollTo({
    selector: '#recordingWorkspaceAnchor',
    duration: 240,
  }), 0);
},

toggleRecordExtras() {
  this.setData({ recordExtrasExpanded: !this.data.recordExtrasExpanded });
},
```

Split the empty-family-recipe actions into a primary voice button and a secondary manual button. Move `recipe-recording-workspace` above optional record fields, add `id="recordingWorkspaceAnchor"`, and collapse existing-dish metadata behind “补充这次信息”. Preserve all existing save values and reset the new state in `resetRecordEntry()`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
node --test --test-isolation=none --test-name-pattern="voice-first recipe entry|manual recipe entry" tests/recipe-pages.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add tests/recipe-pages.test.js pages/dish-edit/dish-edit.js pages/dish-edit/dish-edit.wxml pages/dish-edit/dish-edit.wxss
git commit -m "feat: expose voice-first recipe entry"
```

### Task 2: Add first-use recording disclosure and strengthen the recorder UI

**Files:**
- Modify: `tests/recipe-pages.test.js`
- Modify: `components/recipe-recording-workspace/recipe-recording-workspace.js`
- Modify: `components/recipe-recording-workspace/recipe-recording-workspace.wxml`
- Modify: `components/recipe-recording-workspace/recipe-recording-workspace.wxss`

**Interfaces:**
- Produces: `RECORDING_PURPOSE_CONSENT_KEY = 'recipe-recording-purpose-consent-v1'`.
- Produces: `confirmRecordingPurpose() -> Promise<boolean>`.
- `startRecording()` starts the recorder only after the purpose modal is confirmed once.

- [ ] **Step 1: Write the failing consent test**

Use a key-aware storage stub and `wx.showModal` stub. Assert that the first `startRecording()` shows copy mentioning “家庭私有云空间” and “腾讯云语音识别”, does not start before confirmation, stores consent after confirmation, and the second call starts without showing the modal again. Add a cancel case proving the recorder does not start.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-isolation=none --test-name-pattern="recording purpose" tests/recipe-pages.test.js
```

Expected: FAIL because recording currently starts immediately.

- [ ] **Step 3: Implement consent-before-recording**

Implement:

```js
async confirmRecordingPurpose() {
  if (wx.getStorageSync(RECORDING_PURPOSE_CONSENT_KEY) === true) return true;
  if (typeof wx.showModal !== 'function') return true;
  const result = await callNative(wx, 'showModal', {
    title: '开始记录做菜过程',
    content: '录音会上传到家庭私有云空间，并由腾讯云语音识别转成文字，用来整理家庭菜谱。',
    confirmText: '继续录音',
    cancelText: '暂不录音',
  });
  if (!result.confirm) return false;
  wx.setStorageSync(RECORDING_PURPOSE_CONSENT_KEY, true);
  return true;
}
```

Convert `startRecording()` to async and call the controller only after consent. Keep existing microphone-denied and unsupported-device fallbacks.

- [ ] **Step 4: Rework the recorder presentation**

Change the heading to “说说这次怎么做”, shorten its copy, and give the start/stop button an icon, primary label, and helper label. Keep elapsed and remaining time visible. Do not alter clip actions or upload/transcription behavior.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test --test-isolation=none --test-name-pattern="recording purpose|recording workspace" tests/recipe-pages.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add tests/recipe-pages.test.js components/recipe-recording-workspace
git commit -m "feat: clarify and polish voice recording"
```

### Task 3: Compact the recipe draft and provide a voice escape hatch

**Files:**
- Modify: `tests/recipe-pages.test.js`
- Modify: `pages/recipe-draft/recipe-draft.js`
- Modify: `pages/recipe-draft/recipe-draft.wxml`
- Modify: `pages/recipe-draft/recipe-draft.wxss`
- Modify: `components/recipe-editor/recipe-editor.wxml`
- Modify: `components/recipe-editor/recipe-editor.wxss`

**Interfaces:**
- Produces: `manualDraft` page state derived from `!draft.recordId && draft.sourceType === 'manual'`.
- Produces: `switchToVoiceRecording()` opens the previous dish page's `startVoiceRecipeEntry()` and navigates back, with `redirectTo(...&openVoice=1)` fallback.
- Consumes: `dish-edit.onLoad({ openVoice: '1' })` from Task 1.

- [ ] **Step 1: Write failing draft-layout tests**

Assert that the draft template no longer contains the in-page `RECIPE DRAFT` eyebrow or duplicate `<view class="page-title">整理家庭菜谱</view>`. Assert that it contains “改用语音记录”, binds `switchToVoiceRecording`, and that each editor section exposes an `is-empty` class plus compact `+ 添加` action.

Add a behavior test where a previous dish page receives `startVoiceRecipeEntry()`, then `wx.navigateBack()` is called. Add a fallback test that redirects to:

```text
/pages/dish-edit/dish-edit?dishId=dish-1&openVoice=1
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-isolation=none --test-name-pattern="compact recipe draft|switches a manual draft" tests/recipe-pages.test.js
```

Expected: FAIL because the old hero and expanded empty sections remain.

- [ ] **Step 3: Implement the compact draft shell**

Derive `manualDraft` whenever a draft loads. Replace the duplicated hero with a compact context row and status pill. Render a voice action card only for a manual editable draft. Keep source recordings, AI states, uncertainties, conflicts, confirmation modes, autosave, and validation behavior unchanged.

- [ ] **Step 4: Implement voice navigation**

Use `getCurrentPages()` when the previous page is the current dish detail. Otherwise redirect using `dishId` and `openVoice=1`. Update dish-detail `onLoad()` to call `startVoiceRecipeEntry()` after its initial state is set when that option is present.

- [ ] **Step 5: Compact empty editor sections**

For every section, add a conditional `is-empty` class and use compact actions such as “+ 食材”, “+ 步骤”, and “+ 技巧”. Set explicit button width, margin, height, and centered content. Empty sections must not reserve textarea-like space; populated sections retain all current fields and delete actions.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test --test-isolation=none --test-name-pattern="compact recipe draft|switches a manual draft|manual recipe pages" tests/recipe-pages.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```powershell
git add tests/recipe-pages.test.js pages/recipe-draft components/recipe-editor pages/dish-edit/dish-edit.js
git commit -m "feat: unify recipe draft workspace"
```

### Task 4: Verify phase-two coverage and prepare device acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/qa/phase-two-dual-account-checklist.md`
- Modify: `scripts/smoke-check.js` only if the new visible entry is not already covered.

**Interfaces:**
- Produces: truthful phase-two status that distinguishes automated completion from real-device acceptance.
- Produces: device checklist rows for visible voice entry, first-use disclosure, iOS recording, transcription, AI organization, and cross-member confirmation.

- [ ] **Step 1: Run the focused phase-two suites**

```powershell
node --test --test-isolation=none tests/recipe-pages.test.js tests/recipe-asr.test.js tests/recipe-tokenhub.test.js tests/recipe-assistant-handler.test.js tests/recipe-lifecycle.test.js tests/recipe-usage.test.js
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run full repository verification**

```powershell
npm test
node scripts/smoke-check.js
Get-ChildItem services,utils,components,pages,cloudfunctions -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect the page in WeChat DevTools**

Verify the dish detail and draft page at a narrow iPhone viewport. Capture evidence that the voice entry is visible, the recorder appears before optional metadata, the draft title is not duplicated, buttons stay within the viewport, and empty sections are compact.

- [ ] **Step 4: Update truthful status and checklist**

Mark only automation and simulator checks actually performed. Leave microphone, real ASR, real TokenHub, and dual-account rows pending unless fresh device evidence exists. Never describe pending rows as complete.

- [ ] **Step 5: Request code review and resolve findings**

Review the final diff against `docs/superpowers/specs/2026-08-19-unified-recipe-workspace-design.md`. Fix every Critical and Important finding, then rerun Task 4 Steps 1–3.

- [ ] **Step 6: Commit the verified delivery**

```powershell
git add README.md docs/qa/phase-two-dual-account-checklist.md scripts/smoke-check.js
git commit -m "test: verify unified phase two recipe flow"
```
