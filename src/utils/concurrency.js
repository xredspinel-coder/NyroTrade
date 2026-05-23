'use strict';

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await iterator(items[index], index);
    }
  }

  const workers = Array.from({
    length: Math.max(1, Math.min(limit, items.length))
  }, () => worker());

  await Promise.all(workers);
  return results;
}

module.exports = {
  mapLimit
};
