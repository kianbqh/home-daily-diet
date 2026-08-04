const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../services/domain');
const { buildFamilyViewModel } = require('../utils/view-model');

function loadFamilyPage() {
  const modulePath = require.resolve('../pages/family/family.js');
  const originalPage = global.Page;
  let definition = null;
  global.Page = (config) => {
    definition = config;
  };
  delete require.cache[modulePath];
  require(modulePath);
  global.Page = originalPage;
  return definition;
}

function createPageInstance(definition, data = {}) {
  return {
    ...definition,
    data: { ...definition.data, ...data },
    setData(next) {
      this.data = { ...this.data, ...next };
    },
  };
}

test('family view model never exposes the internal family id', () => {
  const state = createInitialState({ familyId: 'family-very-long-internal-id' });
  const model = buildFamilyViewModel(state, {
    id: state.family.id,
    name: 'Our family',
    memberCount: 1,
    members: state.members,
    inviteCode: 'A7K9Q2',
    inviteExpiresAt: '2026-09-03T10:00:00.000Z',
    inviteStatus: 'active',
    syncStatus: 'ready',
    syncMessage: '',
  });

  assert.equal(Object.prototype.hasOwnProperty.call(model.family, 'id'), false);
  assert.equal(model.family.inviteCode, 'A7K9Q2');
  assert.equal(model.family.inviteCode.length, 6);
});

test('family page joins through the invite boundary', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let joined = null;
  const state = createInitialState({ familyId: 'family-local', memberId: 'member-local', memberName: 'Me' });
  const store = {
    getState() {
      return state;
    },
    joinFamilyByInvite(code, member) {
      joined = { code, member };
      return Promise.resolve(state);
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showToast() {},
    showModal() {},
  };
  const page = createPageInstance(loadFamilyPage());

  page.tryJoin('A7K9Q2');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(joined, {
    code: 'A7K9Q2',
    member: { id: 'member-local', displayName: 'Me' },
  });
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('copyInvite copies only the short invite code', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let copied = null;
  global.getApp = () => ({ globalData: { store: null } });
  global.wx = {
    setClipboardData(options) {
      copied = options.data;
      options.success();
    },
    showToast() {},
  };
  const page = createPageInstance(loadFamilyPage(), {
    family: { inviteCode: 'A7K9Q2' },
  });

  page.copyInvite();

  assert.equal(copied, 'A7K9Q2');
  assert.equal(copied.length, 6);
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('family template does not render a raw family id field', () => {
  const template = fs.readFileSync('pages/family/family.wxml', 'utf8');

  assert.equal(template.includes('{{family.id}}'), false);
  assert.equal(template.includes('familyId='), false);
  assert.match(template, /class="input-visible"/);
  assert.match(template, /class="input-capture"/);
});
