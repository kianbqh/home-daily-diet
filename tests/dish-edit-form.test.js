const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'pages/dish-edit/dish-edit.wxml'), 'utf8');
const pageScript = fs.readFileSync(path.join(root, 'pages/dish-edit/dish-edit.js'), 'utf8');

test('dish record form does not ask for ratings or notes', () => {
  assert.doesNotMatch(template, /吃起来怎么样/);
  assert.doesNotMatch(template, /placeholder="比如：/);
  assert.doesNotMatch(template, /ratingOptions/);
  assert.doesNotMatch(template, /value="\{\{note\}\}"/);
  assert.doesNotMatch(pageScript, /onNoteInput|chooseRating/);
  assert.doesNotMatch(pageScript, /rating:\s*this\.data\.rating/);
  assert.doesNotMatch(pageScript, /note:\s*this\.data\.note/);
});
