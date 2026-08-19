const { createRecordingController } = require('../../services/recording-controller');

const LOCAL_STORAGE_KEY = 'recipe-recording-workspaces-v1';
const RECORDING_PURPOSE_CONSENT_KEY = 'recipe-recording-purpose-consent-v1';
const LOCAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_LABELS = Object.freeze({
  pending: '等待上传',
  transcribing: '转写中',
  ready: '可校对',
  failed: '转写失败',
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function workspaceKey(familyId, dishId, recordId) {
  const parts = [familyId, dishId, recordId].map((value) => String(value || '').trim());
  return parts.every(Boolean) ? parts.join('|') : '';
}

function eventKey(event) {
  return String(event && event.currentTarget && event.currentTarget.dataset
    ? event.currentTarget.dataset.key || ''
    : '');
}

function inputValue(event) {
  return String(event && event.detail ? event.detail.value || '' : '');
}

function recordingIdOf(recording) {
  return String(recording && (recording._id || recording.id) || '');
}

function formatClock(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function showToast(title) {
  if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
    wx.showToast({ title, icon: 'none' });
  }
}

function callNative(target, methodName, options) {
  return new Promise((resolve, reject) => {
    if (!target || typeof target[methodName] !== 'function') {
      reject(new Error(`${methodName} unavailable`));
      return;
    }
    let settled = false;
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || {});
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error || new Error(`${methodName} failed`));
    };
    try {
      const result = target[methodName]({ ...options, success: succeed, fail });
      if (result && typeof result.then === 'function') result.then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function createFileSystemAdapter(fileSystem) {
  return {
    saveFile(options) { return callNative(fileSystem, 'saveFile', options); },
    getFileInfo(options) { return callNative(fileSystem, 'getFileInfo', options); },
    removeSavedFile(options) { return callNative(fileSystem, 'removeSavedFile', options); },
  };
}

function createStorageAdapter(api, clock) {
  function write(entries) {
    try {
      api.setStorageSync(LOCAL_STORAGE_KEY, clone(entries));
    } catch (error) {
      // A session-only clip can still be uploaded when durable metadata is unavailable.
    }
  }

  function read() {
    let raw = [];
    try {
      raw = api.getStorageSync(LOCAL_STORAGE_KEY);
    } catch (error) {
      raw = [];
    }
    const entries = Array.isArray(raw) ? raw : [];
    const cutoff = clock.now() - LOCAL_RETENTION_MS;
    const retained = entries.filter((entry) => {
      const createdAt = Number(entry && entry.createdAt);
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    });
    if (retained.length !== entries.length) write(retained);
    return clone(retained);
  }

  return { read, write };
}

function visibleStatus(clip) {
  const status = String(clip && clip.status || '');
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'transcribing' || status === 'uploading') return 'transcribing';
  return 'pending';
}

function isOrganizableClip(clip) {
  return String(clip && clip.status || '') === 'ready'
    && Boolean(String(clip && clip.editedTranscript || '').trim())
    && Boolean(String(clip && clip.recordingId || ''));
}

function incompleteLabel(clip, index) {
  const sequence = Number(clip && clip.sequence);
  const label = `第 ${Number.isFinite(sequence) && sequence > 0 ? sequence : index + 1} 段`;
  if (visibleStatus(clip) === 'ready' && !String(clip && clip.editedTranscript || '').trim()) {
    return `${label}（请补充文字）`;
  }
  return `${label}（${STATUS_LABELS[visibleStatus(clip)]}）`;
}

function decorateClip(value) {
  const clip = { ...value };
  const displayStatus = visibleStatus(clip);
  const localPath = String(clip.localPath || clip.savedFilePath || clip.tempFilePath || '');
  const audioUrl = String(clip.audioUrl || '');
  return {
    ...clip,
    key: String(clip.key || clip.recordingId || (clip.localId ? `local:${clip.localId}` : '')),
    displayStatus,
    statusLabel: STATUS_LABELS[displayStatus],
    durationLabel: formatClock(clip.durationMs),
    localPath,
    audioUrl,
    canPlay: Boolean(localPath || audioUrl),
    canEditTranscript: displayStatus === 'ready' || displayStatus === 'failed',
    canRetryTranscript: displayStatus === 'failed' && Boolean(clip.recordingId && clip.fileId),
  };
}

function compareClips(left, right) {
  const leftSequence = Number(left.sequence);
  const rightSequence = Number(right.sequence);
  const normalizedLeft = Number.isFinite(leftSequence) ? leftSequence : Number.MAX_SAFE_INTEGER;
  const normalizedRight = Number.isFinite(rightSequence) ? rightSequence : Number.MAX_SAFE_INTEGER;
  if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
  return (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
}

function localClipView(localClip) {
  return decorateClip({
    key: `local:${localClip.localId}`,
    localId: localClip.localId,
    workspaceKey: localClip.workspaceKey,
    recordingId: '',
    sourceType: 'audio',
    sequence: null,
    status: 'reserved',
    durationMs: localClip.durationMs,
    byteLength: localClip.byteLength,
    createdAt: localClip.createdAt,
    localPath: localClip.savedFilePath || localClip.tempFilePath || '',
    fileId: '',
    editedTranscript: '',
    transcriptRevision: 0,
    uploadFailed: false,
  });
}

function remoteClipView(recording, audioUrls, previous) {
  const recordingId = recordingIdOf(recording);
  const fileId = recording.fileId || (previous && previous.fileId) || '';
  return decorateClip({
    ...(previous || {}),
    ...recording,
    key: previous && previous.key ? previous.key : recordingId,
    recordingId,
    sourceType: recording.sourceType || 'audio',
    fileId,
    localPath: fileId ? '' : String(previous && previous.localPath || ''),
    editedTranscript: String(recording.editedTranscript || ''),
    transcriptRevision: Number(recording.transcriptRevision) || 0,
    audioUrl: String(audioUrls && audioUrls[recordingId] || (previous && previous.audioUrl) || ''),
    uploadFailed: false,
  });
}

Component({
  properties: {
    familyId: { type: String, value: '' },
    dishId: { type: String, value: '' },
    recordId: { type: String, value: '' },
    disabled: { type: Boolean, value: false },
  },

  data: {
    clips: [],
    recording: false,
    recordingStatus: 'idle',
    elapsedLabel: '00:00',
    remainingLabel: '03:00',
    manualTextDraft: '',
    workspaceError: '',
    microphoneDenied: false,
    asrUnavailable: false,
    draftId: '',
    playingClipKey: '',
    hasContent: false,
    readyToOrganize: false,
    pendingCount: 0,
    pendingLabels: [],
    draftStatus: '',
    organizeRequestPending: false,
    organizeMessage: '',
  },

  observers: {
    'familyId, dishId, recordId': function observeWorkspace() {
      if (!this.componentAttached) return;
      const nextKey = this.getWorkspaceKey();
      if (nextKey !== this.activeWorkspaceKey) {
        this.destroyAudioContext();
        this.organizeRequestGeneration = (this.organizeRequestGeneration || 0) + 1;
        this.activeWorkspaceKey = nextKey;
        if (this.localReservations) this.localReservations.clear();
        this.setData({
          clips: [], draftId: '', draftStatus: '', manualTextDraft: '', workspaceError: '',
          asrUnavailable: false, organizeRequestPending: false, organizeMessage: '', pendingLabels: [],
        });
      }
      this.loadLocalClips();
      if (nextKey) this.loadWorkspace({ refresh: true }).catch(() => {});
    },
  },

  lifetimes: {
    attached() {
      this.componentAttached = true;
      this.localReservations = new Map();
      this.uploadingLocalIds = new Set();
      this.workspaceLoadGeneration = 0;
      this.organizeRequestGeneration = 0;
      this.activeWorkspaceKey = this.getWorkspaceKey();
      this.createController();
      this.loadLocalClips();
    },

    detached() {
      this.componentAttached = false;
      this.workspaceLoadGeneration = (this.workspaceLoadGeneration || 0) + 1;
      this.organizeRequestGeneration = (this.organizeRequestGeneration || 0) + 1;
      this.destroyAudioContext();
      if (typeof this.unsubscribeController === 'function') this.unsubscribeController();
      this.unsubscribeController = null;
      if (this.recordingController) this.recordingController.destroy();
      this.recordingController = null;
    },
  },

  pageLifetimes: {
    show() {
      return this.loadWorkspace({ refresh: true });
    },
    hide() {
      this.destroyAudioContext();
    },
  },

  methods: {
    getWorkspaceKey() {
      return workspaceKey(this.data.familyId, this.data.dishId, this.data.recordId);
    },

    getRecipeAssistant() {
      const app = typeof getApp === 'function' ? getApp() : null;
      return app && app.globalData ? app.globalData.recipeAssistant || null : null;
    },

    createController() {
      if (typeof wx === 'undefined'
        || typeof wx.getRecorderManager !== 'function'
        || typeof wx.getFileSystemManager !== 'function'
        || typeof wx.getStorageSync !== 'function'
        || typeof wx.setStorageSync !== 'function') {
        this.setData({ workspaceError: '当前设备暂不支持录音，可继续添加文字说明' });
        return;
      }
      try {
        const clock = { now: () => Date.now() };
        const storage = createStorageAdapter(wx, clock);
        this.recordingStorage = storage;
        this.recordingController = createRecordingController({
          recorderManager: wx.getRecorderManager(),
          fileSystem: createFileSystemAdapter(wx.getFileSystemManager()),
          storage,
          clock,
          timerApi: {
            setInterval: (callback, delay) => setInterval(callback, delay),
            clearInterval: (timerId) => clearInterval(timerId),
          },
        });
        this.unsubscribeController = this.recordingController.on('state', (state) => {
          this.handleRecordingState(state);
        });
      } catch (error) {
        this.recordingController = null;
        this.setData({ workspaceError: '录音暂时不可用，可继续添加文字说明' });
      }
    },

    findWorkspace(scope) {
      if (!this.recordingController || typeof this.recordingController.findWorkspace !== 'function') return null;
      return this.recordingController.findWorkspace(scope || {});
    },

    loadLocalClips() {
      const key = this.getWorkspaceKey();
      if (!key || !this.recordingController) return;
      const recovered = this.recordingController.listRecoverable(key).map(localClipView);
      const current = Array.isArray(this.data.clips) ? this.data.clips : [];
      const remote = current.filter((clip) => clip.recordingId);
      const remoteLocalIds = new Set(remote.map((clip) => clip.localId).filter(Boolean));
      const locals = recovered.filter((clip) => !remoteLocalIds.has(clip.localId));
      this.setClips([...remote, ...locals]);
    },

    confirmRecordingPurpose() {
      if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
        try {
          if (wx.getStorageSync(RECORDING_PURPOSE_CONSENT_KEY) === true) return Promise.resolve(true);
        } catch (error) {
          // The confirmation can still proceed when storage is temporarily unavailable.
        }
      }
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return Promise.resolve(true);
      if (this.recordingPurposePromise) return this.recordingPurposePromise;
      const purposePromise = new Promise((resolve) => {
        try {
          wx.showModal({
            title: '开始记录做菜过程',
            content: '录音会上传到家庭私有云空间，并由腾讯云语音识别处理，用于整理家庭菜谱。',
            confirmText: '继续录音',
            cancelText: '暂不录音',
            success: (result) => {
              const confirmed = Boolean(result && result.confirm);
              if (confirmed && typeof wx.setStorageSync === 'function') {
                try {
                  wx.setStorageSync(RECORDING_PURPOSE_CONSENT_KEY, true);
                } catch (error) {
                  // Recording may continue for this session if consent storage is unavailable.
                }
              }
              resolve(confirmed);
            },
            fail: () => resolve(false),
          });
        } catch (error) {
          resolve(false);
        }
      });
      this.recordingPurposePromise = purposePromise.then((confirmed) => {
        this.recordingPurposePromise = null;
        return confirmed;
      });
      return this.recordingPurposePromise;
    },

    async ensureMicrophonePermission() {
      if (typeof wx === 'undefined' || typeof wx.getSetting !== 'function') return true;
      try {
        const settings = await callNative(wx, 'getSetting', {});
        const authSetting = settings && settings.authSetting ? settings.authSetting : {};
        if (authSetting['scope.record'] === true) {
          this.setData({ microphoneDenied: false });
          return true;
        }
        if (authSetting['scope.record'] === false) {
          this.setData({
            microphoneDenied: true,
            workspaceError: '请在小程序设置中允许使用麦克风',
          });
          return false;
        }
        await callNative(wx, 'authorize', { scope: 'scope.record' });
        this.setData({ microphoneDenied: false, workspaceError: '' });
        return true;
      } catch (error) {
        this.setData({
          microphoneDenied: true,
          workspaceError: '请在小程序设置中允许使用麦克风',
        });
        return false;
      }
    },

    async openMicrophoneSettings() {
      if (typeof wx === 'undefined' || typeof wx.openSetting !== 'function') return false;
      try {
        const result = await callNative(wx, 'openSetting', {});
        const authorized = Boolean(result && result.authSetting && result.authSetting['scope.record']);
        this.setData({
          microphoneDenied: !authorized,
          workspaceError: authorized ? '' : '仍未允许使用麦克风，可继续添加文字说明',
        });
        return authorized;
      } catch (error) {
        return false;
      }
    },

    async startRecording() {
      if (this.data.disabled || this.data.recording) return false;
      const key = this.getWorkspaceKey();
      if (!key) {
        showToast('制作记录还没有准备好');
        return false;
      }
      if (!this.recordingController) {
        showToast('录音暂时不可用，可添加文字说明');
        return false;
      }
      const shouldAskPurpose = typeof wx !== 'undefined' && typeof wx.showModal === 'function';
      let consented = false;
      if (shouldAskPurpose && typeof wx.getStorageSync === 'function') {
        try {
          consented = wx.getStorageSync(RECORDING_PURPOSE_CONSENT_KEY) === true;
        } catch (error) {
          consented = false;
        }
      }
      const confirmed = !shouldAskPurpose || consented
        ? true
        : await this.confirmRecordingPurpose();
      const currentKey = this.getWorkspaceKey();
      if (!confirmed || this.data.disabled || this.data.recording || !this.recordingController || !currentKey) return false;
      if (!await this.ensureMicrophonePermission()) return false;
      if (this.data.disabled || this.data.recording || !this.recordingController || currentKey !== this.getWorkspaceKey()) return false;
      this.recordingController.start(currentKey);
      return true;
    },

    stopRecording() {
      if (this.data.disabled || !this.recordingController) return;
      this.recordingController.stop();
    },

    handleRecordingState(state) {
      const status = String(state && state.status || 'idle');
      const errorMessages = {
        MICROPHONE_DENIED: '请授权麦克风后重试，也可以添加文字说明',
        MICROPHONE_BUSY: '麦克风正被通话或其他应用占用，请稍后重试',
        RECORDING_START_FAILED: '录音没有成功启动，请稍后重试',
        RECORDING_LIMIT_EXCEEDED: '每次最多 10 段、累计 15 分钟',
        LOCAL_FILE_UNAVAILABLE: '本地录音文件不可用，请重新录制',
        RECORDING_INTERRUPTED: '录音被中断，请重新录制',
      };
      const activeStatuses = ['starting', 'recording', 'interrupted'];
      const errorCode = String(state && state.errorCode || '');
      this.setData({
        recording: activeStatuses.includes(status),
        recordingStatus: status,
        elapsedLabel: formatClock(state && state.elapsedMs),
        remainingLabel: formatClock(state && state.remainingMs == null ? 180000 : state.remainingMs),
        microphoneDenied: errorCode === 'MICROPHONE_DENIED',
        workspaceError: errorCode
          ? errorMessages[errorCode] || '录音暂时不可用'
          : status === 'interrupted' ? '录音因系统占用暂停，结束后会自动继续' : '',
      });
      if (!state || !state.localClip || state.localClip.workspaceKey !== this.getWorkspaceKey()) return;
      const clip = localClipView(state.localClip);
      this.setClips([...(this.data.clips || []).filter((item) => item.localId !== clip.localId), clip]);
      this.uploadLocalClip(clip.localId).catch(() => {});
    },

    setClips(clips) {
      const next = clips.map(decorateClip).sort(compareClips);
      this.setData({ clips: next });
      this.emitWorkspaceChange(next);
    },

    updateClip(key, patch) {
      const clips = (this.data.clips || []).map((clip) => (
        clip.key === key ? decorateClip({ ...clip, ...patch }) : clip
      ));
      this.setClips(clips);
      return clips.find((clip) => clip.key === key) || null;
    },

    upsertRemoteRecording(recording, audioUrls) {
      const recordingId = recordingIdOf(recording);
      if (!recordingId) return;
      const clips = [...(this.data.clips || [])];
      const index = clips.findIndex((clip) => clip.recordingId === recordingId);
      const previous = index >= 0 ? clips[index] : null;
      const next = remoteClipView(recording, audioUrls || {}, previous);
      if (index >= 0) clips[index] = next;
      else clips.push(next);
      this.setClips(clips);
    },

    async uploadLocalClip(localId) {
      if (!localId || this.data.disabled) return false;
      this.uploadingLocalIds = this.uploadingLocalIds || new Set();
      if (this.uploadingLocalIds.has(localId)) return false;
      const clip = (this.data.clips || []).find((item) => item.localId === localId);
      if (!clip || !clip.localPath) return false;
      const assistant = this.getRecipeAssistant();
      if (!assistant) {
        this.updateClip(clip.key, { status: 'reserved', uploadFailed: true });
        showToast('录音上传需要启用 CloudBase');
        return false;
      }

      this.uploadingLocalIds.add(localId);
      let fileId = String(clip.fileId || '');
      try {
        let reservation = this.localReservations && this.localReservations.get(localId);
        if (!reservation) {
          reservation = await assistant.reserveRecording({
            familyId: this.data.familyId,
            dishId: this.data.dishId,
            recordId: this.data.recordId,
            format: 'mp3',
          });
          reservation = { ...reservation, familyId: this.data.familyId };
          if (this.localReservations) this.localReservations.set(localId, reservation);
        }
        this.updateClip(clip.key, {
          recordingId: reservation.recordingId,
          status: 'reserved',
          uploadFailed: false,
        });
        fileId = await assistant.uploadRecording(reservation, clip.localPath);
        this.updateClip(clip.key, { fileId, status: 'uploading', uploadFailed: false });
        const submitted = await assistant.submitRecording({
          familyId: this.data.familyId,
          dishId: this.data.dishId,
          recordingId: reservation.recordingId,
          fileId,
        });
        if (this.recordingController) await this.recordingController.markUploaded(localId);
        const current = (this.data.clips || []).find((item) => item.localId === localId);
        const recording = submitted && submitted.recording;
        if (recording) {
          const clips = [...(this.data.clips || [])];
          const index = clips.findIndex((item) => item.localId === localId);
          if (index >= 0) clips[index] = remoteClipView(recording, {}, current);
          this.setClips(clips);
        }
        return true;
      } catch (error) {
        const current = (this.data.clips || []).find((item) => item.localId === localId);
        if (current) {
          this.updateClip(current.key, fileId
            ? { fileId, status: 'failed', uploadFailed: false, errorCode: error && error.code || '' }
            : { status: 'reserved', uploadFailed: true, errorCode: error && error.code || '' });
        }
        showToast(fileId ? '转写提交失败，可重试或添加文字' : '上传失败，录音已保存在本机');
        return false;
      } finally {
        this.uploadingLocalIds.delete(localId);
      }
    },

    async loadWorkspace(options = {}) {
      const assistant = this.getRecipeAssistant();
      const key = this.getWorkspaceKey();
      if (!assistant || !key || typeof assistant.getRecordWorkspace !== 'function') return false;
      const payload = {
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        recordId: this.data.recordId,
      };
      const generation = (this.workspaceLoadGeneration || 0) + 1;
      this.workspaceLoadGeneration = generation;
      try {
        const workspace = await assistant.getRecordWorkspace(payload);
        if (generation !== this.workspaceLoadGeneration) return false;
        this.applyWorkspace(workspace || {});
        if (options.refresh !== false && typeof assistant.refreshWorkspace === 'function') {
          try {
            const refreshed = await assistant.refreshWorkspace(payload);
            if (generation !== this.workspaceLoadGeneration) return false;
            this.applyRefreshedRecordings(refreshed && refreshed.recordings);
            this.setData({ asrUnavailable: false });
          } catch (error) {
            if (generation !== this.workspaceLoadGeneration) return false;
            const unavailable = error && error.code === 'ASR_UNAVAILABLE';
            this.setData({
              asrUnavailable: unavailable,
              workspaceError: unavailable ? '语音识别暂时不可用，可继续添加文字说明' : '转写状态暂时无法刷新',
            });
          }
        }
        return true;
      } catch (error) {
        if (generation === this.workspaceLoadGeneration) {
          this.setData({ workspaceError: '制作过程暂时无法读取，本地录音仍会保留' });
        }
        return false;
      }
    },

    applyWorkspace(workspace) {
      const recordings = Array.isArray(workspace.recordings) ? workspace.recordings : [];
      const audioUrls = workspace.audioUrls || {};
      const current = this.data.clips || [];
      const remoteIds = new Set(recordings.map(recordingIdOf));
      const remote = recordings.map((recording) => {
        const previous = current.find((clip) => clip.recordingId === recordingIdOf(recording));
        return remoteClipView(recording, audioUrls, previous);
      });
      const localOnly = current.filter((clip) => clip.localId && !remoteIds.has(clip.recordingId));
      const draft = workspace.draft || null;
      this.applyDraftState(draft);
      this.setData({ workspaceError: '' });
      this.setClips([...remote, ...localOnly]);
    },

    applyDraftState(draft) {
      const status = String(draft && draft.status || '');
      const messages = {
        organizing: '正在整理，可以离开页面',
        ready: '菜谱草稿已整理，等待确认',
        failed: '整理失败，可重试或继续手动编辑',
        confirmed: '本次做法已经保存',
      };
      this.setData({
        draftId: String(draft && (draft._id || draft.id) || this.data.draftId || ''),
        draftStatus: status,
        organizeMessage: messages[status] || '',
        organizeRequestPending: false,
      });
    },

    applyRefreshedRecordings(recordings) {
      if (!Array.isArray(recordings) || !recordings.length) {
        this.emitWorkspaceChange(this.data.clips || []);
        return;
      }
      const byId = new Map(recordings.map((recording) => [recordingIdOf(recording), recording]));
      const clips = (this.data.clips || []).map((clip) => {
        const recording = byId.get(clip.recordingId);
        return recording ? remoteClipView(recording, {}, clip) : clip;
      });
      recordings.forEach((recording) => {
        const id = recordingIdOf(recording);
        if (!clips.some((clip) => clip.recordingId === id)) clips.push(remoteClipView(recording, {}, null));
      });
      this.setClips(clips);
    },

    emitWorkspaceChange(clips) {
      const list = Array.isArray(clips) ? clips : [];
      const manualDraft = String(this.data.manualTextDraft || '').trim();
      const hasContent = list.length > 0 || Boolean(manualDraft);
      const incomplete = list
        .map((clip, index) => ({ clip, index }))
        .filter(({ clip }) => visibleStatus(clip) !== 'ready'
          || !String(clip.editedTranscript || '').trim());
      const pendingCount = incomplete.length;
      const pendingLabels = incomplete.map(({ clip, index }) => incompleteLabel(clip, index));
      const usable = list.filter(isOrganizableClip);
      const hasBlockingStatus = list.some((clip) => String(clip && clip.status || '') !== 'ready');
      const readyToOrganize = usable.length > 0 && !hasBlockingStatus;
      const detail = { hasContent, readyToOrganize, pendingCount };
      this.setData({ ...detail, pendingLabels });
      this.triggerEvent('workspacechange', detail);
    },

    async organizeDraft() {
      if (this.data.disabled || this.data.organizeRequestPending
        || this.data.draftStatus === 'organizing' || !this.data.readyToOrganize) return false;
      const assistant = this.getRecipeAssistant();
      const draftId = String(this.data.draftId || '');
      if (!assistant || typeof assistant.organizeDraft !== 'function') {
        showToast('智能整理需要启用 CloudBase');
        return false;
      }
      if (!draftId) {
        showToast('请先保存本次记录，再整理菜谱');
        return false;
      }
      const sourceRecordingIds = (this.data.clips || [])
        .filter(isOrganizableClip)
        .map((clip) => String(clip.recordingId || ''))
        .filter(Boolean);
      if (!sourceRecordingIds.length) return false;
      const requestWorkspaceKey = this.getWorkspaceKey();
      const requestGeneration = (this.organizeRequestGeneration || 0) + 1;
      this.organizeRequestGeneration = requestGeneration;
      const requestPayload = {
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        draftId,
        sourceRecordingIds,
      };
      const requestIsCurrent = () => (
        requestGeneration === this.organizeRequestGeneration
        && requestWorkspaceKey === this.getWorkspaceKey()
      );

      this.setData({
        organizeRequestPending: true,
        draftStatus: 'organizing',
        organizeMessage: '正在整理，可以离开页面',
      });
      this.emitWorkspaceChange(this.data.clips || []);
      this.triggerEvent('opendraft', { draftId });
      try {
        const result = await assistant.organizeDraft(requestPayload);
        if (!requestIsCurrent()) return false;
        if (result && result.draft) this.applyDraftState(result.draft);
        else this.setData({ organizeRequestPending: false });
        this.emitWorkspaceChange(this.data.clips || []);
        return true;
      } catch (error) {
        if (!requestIsCurrent()) return false;
        this.setData({ organizeRequestPending: false });
        const loaded = await this.loadWorkspace({ refresh: false });
        if (!requestIsCurrent()) return false;
        if (!loaded) {
          this.setData({
            draftStatus: 'organizing',
            organizeMessage: '正在整理，可以离开页面',
          });
        }
        this.emitWorkspaceChange(this.data.clips || []);
        return false;
      }
    },

    onTranscriptInput(event) {
      if (this.data.disabled) return;
      const key = eventKey(event);
      this.updateClip(key, { editedTranscript: inputValue(event) });
    },

    async saveTranscript(event) {
      if (this.data.disabled) return false;
      const key = eventKey(event);
      const clip = (this.data.clips || []).find((item) => item.key === key);
      const text = String(clip && clip.editedTranscript || '').trim();
      const assistant = this.getRecipeAssistant();
      if (!clip || !clip.recordingId || !text || !assistant) {
        showToast(!text ? '请先填写文字' : '文字保存需要启用 CloudBase');
        return false;
      }
      try {
        const result = await assistant.updateTranscript({
          familyId: this.data.familyId,
          dishId: this.data.dishId,
          recordingId: clip.recordingId,
          transcriptRevision: Number(clip.transcriptRevision) || 0,
          text,
        });
        if (result && result.recording) this.upsertRemoteRecording(result.recording, {});
        return true;
      } catch (error) {
        showToast(error && error.code === 'TRANSCRIPT_CONFLICT' ? '文字已被家人更新，请刷新' : '文字暂时无法保存');
        return false;
      }
    },

    onManualTextInput(event) {
      if (this.data.disabled) return;
      this.setData({ manualTextDraft: inputValue(event) });
      this.emitWorkspaceChange(this.data.clips || []);
    },

    async addManualText() {
      if (this.data.disabled) return false;
      const text = String(this.data.manualTextDraft || '').trim();
      if (!text) {
        showToast('请先填写文字说明');
        return false;
      }
      const assistant = this.getRecipeAssistant();
      if (!assistant) {
        showToast('文字共享需要启用 CloudBase');
        return false;
      }
      try {
        const result = await assistant.addManualText({
          familyId: this.data.familyId,
          dishId: this.data.dishId,
          recordId: this.data.recordId,
          text,
        });
        this.setData({ manualTextDraft: '' });
        if (result && result.recording) this.upsertRemoteRecording(result.recording, {});
        else this.emitWorkspaceChange(this.data.clips || []);
        return true;
      } catch (error) {
        showToast('文字说明暂时无法保存');
        return false;
      }
    },

    async retryClip(event) {
      if (this.data.disabled) return false;
      const clip = (this.data.clips || []).find((item) => item.key === eventKey(event));
      if (!clip) return false;
      if (clip.localId && !clip.fileId) return this.uploadLocalClip(clip.localId);
      if (!clip.recordingId || !clip.fileId) return false;
      const assistant = this.getRecipeAssistant();
      if (!assistant) return false;
      try {
        const result = await assistant.submitRecording({
          familyId: this.data.familyId,
          dishId: this.data.dishId,
          recordingId: clip.recordingId,
          fileId: clip.fileId,
        });
        if (clip.localId && this.recordingController) {
          await this.recordingController.markUploaded(clip.localId);
        }
        if (result && result.recording) this.upsertRemoteRecording(result.recording, {});
        return true;
      } catch (error) {
        this.updateClip(clip.key, { status: 'failed', uploadFailed: false });
        showToast('重新转写失败，可保留文字后继续');
        return false;
      }
    },

    async deleteClip(event) {
      if (this.data.disabled) return false;
      const clip = (this.data.clips || []).find((item) => item.key === eventKey(event));
      if (!clip) return false;
      const assistant = this.getRecipeAssistant();
      try {
        if (clip.recordingId) {
          if (!assistant) throw new Error('recipe assistant unavailable');
          await assistant.deleteRecording({
            familyId: this.data.familyId,
            dishId: this.data.dishId,
            recordingId: clip.recordingId,
          });
        }
        if (clip.localId && this.recordingController) await this.recordingController.remove(clip.localId);
        this.setClips((this.data.clips || []).filter((item) => item.key !== clip.key));
        return true;
      } catch (error) {
        showToast('这段内容暂时无法删除');
        return false;
      }
    },

    playClip(event) {
      if (this.data.disabled || typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') return;
      const clip = (this.data.clips || []).find((item) => item.key === eventKey(event));
      if (!clip) return;
      const source = String(clip.localPath || clip.audioUrl || '');
      if (!source) {
        if (clip.recordingId) this.loadWorkspace({ refresh: false }).catch(() => {});
        showToast('播放地址已过期，正在刷新');
        return;
      }
      this.destroyAudioContext();
      const context = wx.createInnerAudioContext();
      this.audioContext = context;
      this.setData({ playingClipKey: clip.key });
      if (typeof context.onEnded === 'function') {
        context.onEnded(() => {
          if (this.audioContext === context) this.destroyAudioContext();
        });
      }
      if (typeof context.onError === 'function') {
        context.onError(() => {
          const shouldRefresh = this.audioContext === context && Boolean(clip.recordingId && clip.audioUrl);
          if (this.audioContext === context) this.destroyAudioContext();
          if (shouldRefresh) this.loadWorkspace({ refresh: false }).catch(() => {});
        });
      }
      context.src = source;
      if (typeof context.play === 'function') context.play();
    },

    destroyAudioContext() {
      const context = this.audioContext;
      this.audioContext = null;
      if (context && typeof context.destroy === 'function') {
        try {
          context.destroy();
        } catch (error) {
          // Audio cleanup is best effort.
        }
      }
      if (this.data.playingClipKey) this.setData({ playingClipKey: '' });
    },

    hasPendingLocalClips() {
      if (this.data.recording || (this.uploadingLocalIds && this.uploadingLocalIds.size)) return true;
      const key = this.getWorkspaceKey();
      return Boolean(this.recordingController && key
        && this.recordingController.listRecoverable(key).length);
    },

    hasUncommittedInput() {
      return Boolean(String(this.data.manualTextDraft || '').trim());
    },

    canFinalizeWorkspace() {
      return !this.hasPendingLocalClips() && !this.hasUncommittedInput();
    },

    async finalizeAfterAttach() {
      if (!this.canFinalizeWorkspace()) return false;
      await this.clearLocalClips();
      return true;
    },

    async clearLocalClips() {
      const key = this.getWorkspaceKey();
      if (this.recordingController) this.recordingController.cancel();
      const entries = this.recordingStorage && key
        ? this.recordingStorage.read().filter((entry) => entry.workspaceKey === key)
        : [];
      if (this.recordingController) {
        for (const entry of entries) await this.recordingController.remove(entry.localId);
      }
      if (this.localReservations) this.localReservations.clear();
      this.destroyAudioContext();
      this.setData({
        clips: [], manualTextDraft: '', draftId: '', draftStatus: '', workspaceError: '',
        organizeRequestPending: false, organizeMessage: '', pendingLabels: [],
        recording: false, recordingStatus: 'idle', microphoneDenied: false,
        elapsedLabel: '00:00', remainingLabel: '03:00',
      });
      this.emitWorkspaceChange([]);
    },

    openDraft() {
      const draftId = String(this.data.draftId || '');
      if (draftId) this.triggerEvent('opendraft', { draftId });
    },
  },
});
