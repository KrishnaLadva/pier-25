import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSlideIndex,
  getMaxSlideIndex,
  getNextSlideIndex,
  getPrevSlideIndex,
  getTrackOffsetPercent,
  getVisibleCardsCount,
} from './slider.js';

test('getVisibleCardsCount maps viewport widths to responsive slide counts', () => {
  assert.equal(getVisibleCardsCount(1440), 3);
  assert.equal(getVisibleCardsCount(901), 3);
  assert.equal(getVisibleCardsCount(768), 2);
  assert.equal(getVisibleCardsCount(550), 1);
  assert.equal(getVisibleCardsCount(390), 1);
});

test('getMaxSlideIndex computes valid upper bound', () => {
  assert.equal(getMaxSlideIndex(9, 3), 6);
  assert.equal(getMaxSlideIndex(9, 1), 8);
  assert.equal(getMaxSlideIndex(2, 3), 0);
  assert.equal(getMaxSlideIndex(0, 3), 0);
});

test('getNextSlideIndex and getPrevSlideIndex wrap smoothly at boundaries', () => {
  assert.equal(getNextSlideIndex(0, 6), 1);
  assert.equal(getNextSlideIndex(6, 6), 0);
  assert.equal(getPrevSlideIndex(0, 6), 6);
  assert.equal(getPrevSlideIndex(3, 6), 2);
});

test('clampSlideIndex and getTrackOffsetPercent compute expected layout offsets', () => {
  assert.equal(clampSlideIndex(8, 6), 6);
  assert.equal(clampSlideIndex(-2, 6), 0);
  assert.equal(getTrackOffsetPercent(0, 3), 0);
  assert.equal(Math.round(getTrackOffsetPercent(3, 3)), 100);
  assert.equal(getTrackOffsetPercent(2, 2), 100);
});
