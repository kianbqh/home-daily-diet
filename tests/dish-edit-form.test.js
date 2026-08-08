const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'pages/dish-edit/dish-edit.wxml'), 'utf8');
const pageScript = fs.readFileSync(path.join(root, 'pages/dish-edit/dish-edit.js'), 'utf8');

test('record form does not ask for legacy dish-level ratings or notes', () => {
  assert.doesNotMatch(template, /ratingOptions/);
  assert.doesNotMatch(template, /value="\{\{note\}\}"/);
  assert.doesNotMatch(pageScript, /rating:\s*this\.data\.rating/);
  assert.doesNotMatch(pageScript, /note:\s*this\.data\.note/);
  assert.match(template, /class="card-surface rating-section"/);
  assert.match(template, /bindtap="chooseReviewStar"/);
  assert.match(template, /bindtap="submitReview"/);
});

test('dish text inputs use visible native controls and tags are chips instead of free-form text', () => {
  assert.match(template, /class="visible-native-input/);
  assert.match(template, /placeholder="例如：番茄炒蛋"/);
  assert.match(template, /class="category-chip/);
  assert.match(template, /class="characteristic-chip/);
  assert.doesNotMatch(template, /tagsDraft/);
  assert.doesNotMatch(template, /input-capture/);
});
