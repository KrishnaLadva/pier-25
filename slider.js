export function getVisibleCardsCount(viewportWidth) {
  if (viewportWidth <= 550) return 1;
  if (viewportWidth <= 900) return 2;
  return 3;
}

export function getMaxSlideIndex(totalItems, visibleCount) {
  if (totalItems <= 0 || visibleCount <= 0) return 0;
  return Math.max(0, totalItems - visibleCount);
}

export function clampSlideIndex(index, maxIndex) {
  if (maxIndex <= 0) return 0;
  return Math.min(Math.max(0, index), maxIndex);
}

export function getNextSlideIndex(currentIndex, maxIndex) {
  if (maxIndex <= 0) return 0;
  return currentIndex >= maxIndex ? 0 : currentIndex + 1;
}

export function getPrevSlideIndex(currentIndex, maxIndex) {
  if (maxIndex <= 0) return 0;
  return currentIndex <= 0 ? maxIndex : currentIndex - 1;
}

export function getTrackOffsetPercent(currentIndex, visibleCount) {
  if (visibleCount <= 0) return 0;
  return (currentIndex * 100) / visibleCount;
}
