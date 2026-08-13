const MAX_DURATION_MS = 180000;
const MAX_WORKSPACE_DURATION_MS = 900000;
const MAX_WORKSPACE_CLIPS = 10;
const RECORDING_OPTIONS = {
  duration: MAX_DURATION_MS,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: 'mp3',
};

function createRecordingController({ recorderManager, fileSystem, storage, clock, timerApi }) {
  if (!recorderManager || !fileSystem || !storage || !clock || !timerApi) {
    throw new Error('recording controller dependencies are required');
  }
  if (typeof storage.read !== 'function' || typeof storage.write !== 'function') {
    throw new Error('recording storage must provide read() and write(entries)');
  }

  // storage is controller-owned metadata storage. It contains only clip index entries,
  // never audio bytes, transcript text, family display data, or credentials.
  let entries = readEntries(storage);
  let destroyed = false;
  let timerId = null;
  let active = null;
  const listeners = new Set();
  let state = idleState();
  const recorderHandlers = {};
  const reservedLocalIds = new Set(entries.map((entry) => entry.localId));
  const pendingCaptures = [];
  const entryMutationQueues = new Map();

  const currentTime = () => clock.now();

  bindRecorderHandlers();

  function on(eventName, listener) {
    if (eventName !== 'state' || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function start(workspaceKey) {
    if (destroyed || active) return;
    const durationLimit = remainingWorkspaceDuration(workspaceKey);
    if (durationLimit <= 0 || workspaceClipCount(workspaceKey) >= MAX_WORKSPACE_CLIPS) {
      emit(errorState('RECORDING_LIMIT_EXCEEDED'));
      return;
    }
    const startedAt = currentTime();
    const token = {};
    active = {
      token, workspaceKey, startedAt, durationLimit, stopping: false, discarded: false,
    };
    emit(recordingState(0, durationLimit));
    timerId = timerApi.setInterval(() => {
      if (!isActive(token)) return;
      const elapsedMs = Math.min(durationLimit, currentTime() - startedAt);
      emit(recordingState(elapsedMs, durationLimit));
      if (elapsedMs >= durationLimit) stop();
    }, 1000);
    recorderManager.start({ ...RECORDING_OPTIONS, duration: durationLimit });
  }

  function stop() {
    if (destroyed || !active || active.stopping) return;
    active.stopping = true;
    clearTimer();
    recorderManager.stop();
  }

  function cancel() {
    if (destroyed) return;
    const recording = active;
    if (!recording) {
      if (pendingCaptures.length) pendingCaptures.at(-1).discarded = true;
      clearTimer();
      emit(idleState());
      return;
    }
    recording.discarded = true;
    recording.stopping = true;
    clearTimer();
    emit(idleState());
    try {
      recorderManager.stop();
    } catch (error) {
      if (active === recording) active = null;
      emit(errorState('RECORDING_INTERRUPTED'));
    }
  }

  function listRecoverable(workspaceKey) {
    return clone(entries.filter((entry) => (
      entry.workspaceKey === workspaceKey
      && entry.uploadStatus !== 'uploaded'
      && (entry.savedFilePath || entry.tempFilePath)
    )));
  }

  function findWorkspace({ familyId, dishId }) {
    const prefix = `${familyId}|${dishId}|`;
    const entry = entries
      .filter((item) => item.workspaceKey.startsWith(prefix))
      .sort(compareWorkspaceEntries)[0];
    if (!entry) return null;
    const recordId = entry.workspaceKey.slice(prefix.length);
    return recordId ? { recordId, workspaceKey: entry.workspaceKey } : null;
  }

  function markUploaded(localId) {
    return queueEntryMutation(localId, () => markUploadedNow(localId));
  }

  async function markUploadedNow(localId) {
    const index = findEntryIndex(localId);
    if (index < 0) return;
    const entry = entries[index];
    entries[index] = { ...entry, uploadStatus: 'uploaded' };
    writeEntries();
    if (entry.savedFilePath) {
      try {
        await fileSystem.removeSavedFile({ filePath: entry.savedFilePath });
        const currentIndex = findEntryIndex(localId);
        if (currentIndex < 0) return;
        entries[currentIndex] = { ...entries[currentIndex], savedFilePath: null };
        writeEntries();
      } catch (error) {
        emit(errorState('LOCAL_FILE_UNAVAILABLE'));
      }
    }
  }

  function remove(localId) {
    return queueEntryMutation(localId, () => removeNow(localId));
  }

  async function removeNow(localId) {
    const index = findEntryIndex(localId);
    if (index < 0) return;
    const entry = entries[index];
    if (entry.savedFilePath) {
      try {
        await fileSystem.removeSavedFile({ filePath: entry.savedFilePath });
      } catch (error) {
        emit(errorState('LOCAL_FILE_UNAVAILABLE'));
        return;
      }
    }
    const currentIndex = findEntryIndex(localId);
    if (currentIndex < 0) return;
    entries.splice(currentIndex, 1);
    writeEntries();
  }

  function destroy() {
    if (destroyed) return;
    const recording = active;
    if (recording) recording.discarded = true;
    destroyed = true;
    clearTimer();
    active = null;
    try {
      if (recording && typeof recorderManager.stop === 'function') recorderManager.stop();
    } catch (error) {
      // Shutdown is best effort; listener/timer cleanup must still complete.
    }
    unbindRecorderHandlers();
    listeners.clear();
  }

  function bindRecorderHandlers() {
    if (typeof recorderManager.onStop === 'function') {
      recorderHandlers.stop = (result) => handleFinished(result, false);
      recorderManager.onStop(recorderHandlers.stop);
    }
    if (typeof recorderManager.onError === 'function') {
      recorderHandlers.error = (error) => {
        if (destroyed || !active) return;
        const session = active;
        active = null;
        clearTimer();
        if (session.discarded) return;
        emit(errorState(isMicrophoneDenied(error) ? 'MICROPHONE_DENIED' : 'RECORDING_INTERRUPTED'));
      };
      recorderManager.onError(recorderHandlers.error);
    }
    if (typeof recorderManager.onInterruptionBegin === 'function') {
      recorderHandlers.interruption = (result) => handleFinished(result, true);
      recorderManager.onInterruptionBegin(recorderHandlers.interruption);
    }
  }

  function unbindRecorderHandlers() {
    const mappings = [
      ['offStop', 'stop'],
      ['offError', 'error'],
      ['offInterruptionBegin', 'interruption'],
    ];
    mappings.forEach(([offMethod, handlerName]) => {
      if (recorderHandlers[handlerName] && typeof recorderManager[offMethod] === 'function') {
        recorderManager[offMethod](recorderHandlers[handlerName]);
      }
    });
  }

  async function handleFinished(result, interrupted) {
    if (destroyed || !active) return;
    const session = active;
    clearTimer();
    if (session.discarded) {
      if (!interrupted) active = null;
      return;
    }
    if (!result || !result.tempFilePath) {
      if (interrupted) {
        emit(errorState('RECORDING_INTERRUPTED'));
        return;
      }
      active = null;
      emit(errorState('LOCAL_FILE_UNAVAILABLE'));
      return;
    }
    active = null;
    const reportedDuration = Number(result.duration);
    const elapsedMs = Math.min(session.durationLimit, Math.max(0, currentTime() - session.startedAt));
    const durationMs = Number.isFinite(reportedDuration) && reportedDuration > 0
      ? reportedDuration
      : elapsedMs;
    if (durationMs <= 0) {
      emit(errorState('LOCAL_FILE_UNAVAILABLE'));
      return;
    }
    if (durationMs > session.durationLimit || durationMs > remainingWorkspaceDuration(session.workspaceKey)) {
      emit(errorState('RECORDING_LIMIT_EXCEEDED'));
      return;
    }
    const capture = { discarded: false, localId: nextLocalId(), workspaceKey: session.workspaceKey, durationMs };
    pendingCaptures.push(capture);
    let clip;
    try {
      clip = await persistClip(
        session.workspaceKey, result.tempFilePath, durationMs, result.fileSize, capture
      );
    } finally {
      pendingCaptures.splice(pendingCaptures.indexOf(capture), 1);
    }
    if (destroyed) return;
    if (clip) {
      emit({ status: 'idle', elapsedMs: 0, remainingMs: MAX_DURATION_MS, localClip: clone(clip), errorCode: null });
    }
  }

  async function persistClip(workspaceKey, tempFilePath, durationMs, fallbackByteLength, capture) {
    const base = {
      localId: capture.localId,
      workspaceKey,
      durationMs,
      format: 'mp3',
      byteLength: Number.isFinite(fallbackByteLength) ? fallbackByteLength : 0,
      createdAt: currentTime(),
      uploadStatus: 'pending',
    };
    try {
      const saved = await fileSystem.saveFile({ tempFilePath });
      const savedFilePath = saved && saved.savedFilePath;
      if (isInvalidCapture(capture)) {
        await removeOrphan(savedFilePath);
        return null;
      }
      if (!savedFilePath) throw new Error('saved file path unavailable');
      let byteLength = base.byteLength;
      try {
        const info = await fileSystem.getFileInfo({ filePath: savedFilePath });
        if (isInvalidCapture(capture)) {
          await removeOrphan(savedFilePath);
          return null;
        }
        if (info && Number.isFinite(info.size)) byteLength = info.size;
      } catch (error) {
        // A saved file remains recoverable even if its size cannot be read.
      }
      const clip = { ...base, savedFilePath, byteLength };
      if (isInvalidCapture(capture)) {
        await removeOrphan(savedFilePath);
        return null;
      }
      entries.push(clip);
      writeEntries();
      return clip;
    } catch (error) {
      if (isInvalidCapture(capture)) return null;
      const clip = { ...base, savedFilePath: null, tempFilePath, sessionOnly: true };
      entries.push(clip);
      writeEntries();
      return clip;
    }
  }

  function workspaceClipCount(workspaceKey) {
    return entries.filter((entry) => entry.workspaceKey === workspaceKey).length
      + pendingCaptures.filter((capture) => !capture.discarded && capture.workspaceKey === workspaceKey).length;
  }
  function remainingWorkspaceDuration(workspaceKey) {
    const usedMs = entries
      .filter((entry) => entry.workspaceKey === workspaceKey)
      .reduce((total, entry) => total + (entry.durationMs || 0), 0)
      + pendingCaptures
        .filter((capture) => !capture.discarded && capture.workspaceKey === workspaceKey)
        .reduce((total, capture) => total + capture.durationMs, 0);
    return Math.min(MAX_DURATION_MS, Math.max(0, MAX_WORKSPACE_DURATION_MS - usedMs));
  }
  function nextLocalId() {
    const timestamp = currentTime();
    let sequence = 1;
    while (reservedLocalIds.has(`${timestamp}-${sequence}`)) sequence += 1;
    const localId = `${timestamp}-${sequence}`;
    reservedLocalIds.add(localId);
    return localId;
  }

  function findEntryIndex(localId) {
    return entries.findIndex((entry) => entry.localId === localId);
  }

  function queueEntryMutation(localId, mutation) {
    const previous = entryMutationQueues.get(localId) || Promise.resolve();
    const current = previous.catch(() => {}).then(mutation);
    entryMutationQueues.set(localId, current);
    return current.finally(() => {
      if (entryMutationQueues.get(localId) === current) entryMutationQueues.delete(localId);
    });
  }

  function isInvalidCapture(capture) { return destroyed || capture.discarded; }
  async function removeOrphan(savedFilePath) {
    if (!savedFilePath) return;
    try {
      await fileSystem.removeSavedFile({ filePath: savedFilePath });
    } catch (error) {
      // Best-effort orphan cleanup cannot re-enable a destroyed or discarded capture.
    }
  }

  function isActive(token) { return !destroyed && active && active.token === token; }
  function clearTimer() {
    if (timerId !== null) timerApi.clearInterval(timerId);
    timerId = null;
  }
  function emit(nextState) {
    if (destroyed) return;
    state = nextState;
    listeners.forEach((listener) => listener(clone(state)));
  }
  function writeEntries() { storage.write(clone(entries)); }

  return { on, start, stop, cancel, listRecoverable, findWorkspace, markUploaded, remove, destroy };
}

function readEntries(storage) {
  const rawEntries = storage.read();
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.filter((entry) => !entry.sessionOnly).map(normalizeEntry).filter(Boolean);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry.localId !== 'string' || typeof entry.workspaceKey !== 'string') return null;
  const normalized = {
    localId: entry.localId,
    workspaceKey: entry.workspaceKey,
    savedFilePath: typeof entry.savedFilePath === 'string' ? entry.savedFilePath : null,
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs) : 0,
    format: 'mp3',
    byteLength: Number.isFinite(entry.byteLength) ? entry.byteLength : 0,
    createdAt: entry.createdAt,
    uploadStatus: entry.uploadStatus === 'uploaded' ? 'uploaded' : 'pending',
  };
  return normalized;
}

function compareWorkspaceEntries(left, right) {
  const leftCreatedAt = Number(left.createdAt);
  const rightCreatedAt = Number(right.createdAt);
  const leftTime = Number.isFinite(leftCreatedAt) ? leftCreatedAt : Number.NEGATIVE_INFINITY;
  const rightTime = Number.isFinite(rightCreatedAt) ? rightCreatedAt : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  const localIdOrder = left.localId.localeCompare(right.localId);
  return localIdOrder || left.workspaceKey.localeCompare(right.workspaceKey);
}

function idleState() {
  return { status: 'idle', elapsedMs: 0, remainingMs: MAX_DURATION_MS, localClip: null, errorCode: null };
}

function errorState(errorCode) {
  return { status: 'error', elapsedMs: 0, remainingMs: MAX_DURATION_MS, localClip: null, errorCode };
}

function recordingState(elapsedMs, durationLimit) {
  return { status: 'recording', elapsedMs, remainingMs: durationLimit - elapsedMs, localClip: null, errorCode: null };
}

function isMicrophoneDenied(error) {
  return /auth|permission|deny/i.test(String(error && (error.errMsg || error.message || error.code || '')));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = { createRecordingController };
