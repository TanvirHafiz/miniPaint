import test from 'node:test';
import assert from 'node:assert/strict';
import { pushPrompt, stepIndex, HISTORY_MAX } from '../ai-history.js';

test('pushPrompt puts the newest first and removes duplicates', () => {
	let l = pushPrompt([], 'a red car');
	l = pushPrompt(l, 'a blue boat');
	l = pushPrompt(l, '  a red car  ');
	assert.deepEqual(l, ['a red car', 'a blue boat']);
});

test('pushPrompt ignores empty and one character prompts and caps the list', () => {
	assert.deepEqual(pushPrompt(['x y'], ' '), ['x y']);
	assert.deepEqual(pushPrompt(['x y'], 'a'), ['x y']);
	let l = [];
	for (let i = 0; i < HISTORY_MAX + 5; i++) l = pushPrompt(l, 'prompt ' + i);
	assert.equal(l.length, HISTORY_MAX);
	assert.equal(l[0], 'prompt ' + (HISTORY_MAX + 4));
});

test('stepIndex walks older and newer and returns to the draft', () => {
	assert.equal(stepIndex(-1, -1, 3), 0);
	assert.equal(stepIndex(0, -1, 3), 1);
	assert.equal(stepIndex(2, -1, 3), 2);
	assert.equal(stepIndex(1, 1, 3), 0);
	assert.equal(stepIndex(0, 1, 3), -1);
	assert.equal(stepIndex(-1, -1, 0), -1);
});
