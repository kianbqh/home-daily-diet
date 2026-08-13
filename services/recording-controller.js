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
  let localIdSequence = 0;
  const listeners = new Set();
  let state = idleState();

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
    active = { token, workspaceKey, startedAt, durationLimit, stopping: false };
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
    if (destroyed || !active) return;
    active = null;
    clearTimer();
    if (typeof recorderManager.cancel === 'function') recorderManager.cancel();
    emit(idleState());
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
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))[0];
    if (!entry) return null;
    const recordId = entry.workspaceKey.slice(prefix.length);
    return recordId ? { recordId, workspaceKey: entry.workspaceKey } : null;
  }

  async function markUploaded(localId) {
    const index = entries.findIndex((entry) => entry.localId === localId);
    if (index < 0) return;
    const entry = entries[index];
    entries[index] = { ...entry, uploadStatus: 'uploaded' };
    writeEntries();
    if (entry.savedFilePath) {
      try {
        await fileSystem.removeSavedFile({ filePath: entry.savedFilePath });
      } catch (error) {
        emit(errorState('LOCAL_FILE_UNAVAILABLE'));
      }
    }
  }

  async function remove(localId) {
    const index = entries.findIndex((entry) => entry.localId === localId);
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
    entries.splice(index, 1);
    writeEntries();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimer();
    active = null;
    listeners.clear();
  }

  function bindRecorderHandlers() {
    if (typeof recorderManager.onStop === 'function') {
      recorderManager.onStop((result) => handleFinished(result, false));
    }
    if (typeof recorderManager.onError === 'function') {
      recorderManager.onError((error) => {
        if (destroyed || !active) return;
        active = null;
        clearTimer();
        emit(errorState(isMicrophoneDenied(error) ? 'MICROPHONE_DENIED' : 'RECORDING_INTERRUPTED'));
      });
    }
    if (typeof recorderManager.onInterruptionBegin === 'function') {
      recorderManager.onInterruptionBegin((result) => handleFinished(result, true));
    }
  }

  async function handleFinished(result, interrupted) {
    if (destroyed || !active) return;
    const session = active;
    clearTimer();
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
    const durationMs = Number.isFinite(result.duration)
      ? result.duration
      : Math.min(session.durationLimit, Math.max(0, currentTime() - session.startedAt));
    if (durationMs > session.durationLimit || durationMs > remainingWorkspaceDuration(session.workspaceKey)) {
      emit(errorState('RECORDING_LIMIT_EXCEEDED'));
      return;
    }
    const clip = await persistClip(session.workspaceKey, result.tempFilePath, durationMs, result.fileSize);
    if (destroyed) return;
    if (clip) {
      emit({ status: 'idle', elapsedMs: 0, remainingMs: MAX_DURATION_MS, localClip: clone(clip), errorCode: null });
    }
  }

  async function persistClip(workspaceKey, tempFilePath, durationMs, fallbackByteLength) {
    const base = {
      localId: `${currentTime()}-${++localIdSequence}`,
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
      if (!savedFilePath) throw new Error('saved file path unavailable');
      let byteLength = base.byteLength;
      try {
        const info = await fileSystem.getFileInfo({ filePath: savedFilePath });
        if (info && Number.isFinite(info.size)) byteLength = info.size;
      } catch (error) {
        // A saved file remains recoverable even if its size cannot be read.
      }
      const clip = { ...base, savedFilePath, byteLength };
      entries.push(clip);
      writeEntries();
      return clip;
    } catch (error) {
      const clip = { ...base, savedFilePath: null, tempFilePath, sessionOnly: true };
      entries.push(clip);
      writeEntries();
      return clip;
    }
  }

  function workspaceClipCount(workspaceKey) {
    return entries.filter((entry) => entry.workspaceKey === workspaceKey).length;
  }
  function remainingWorkspaceDuration(workspaceKey) {
    const usedMs = entries
      .filter((entry) => entry.workspaceKey === workspaceKey)
      .reduce((total, entry) => total + (entry.durationMs || 0), 0);
    return Math.min(MAX_DURATION_MS, Math.max(0, MAX_WORKSPACE_DURATION_MS - usedMs));
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
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
    format: 'mp3',
    byteLength: Number.isFinite(entry.byteLength) ? entry.byteLength : 0,
    createdAt: entry.createdAt,
    uploadStatus: entry.uploadStatus === 'uploaded' ? 'uploaded' : 'pending',
  };
  return normalized;
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
