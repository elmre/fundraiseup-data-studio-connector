function cacheFingerprint(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map((byte) => (byte & 255).toString(16).padStart(2, '0'))
    .join('');
}

function DataCache(cacheService, cacheKey) {
  this.service = cacheService;
  this.cacheKey = 'fru:v2:' + cacheFingerprint(cacheKey);
}

DataCache.REQUEST_CACHING_TIME = 3600;
DataCache.MAX_CACHE_SIZE = 90000;
DataCache.MAX_CHUNKS = 400;

DataCache.prototype.get = function (freshAfter = 0) {
  try {
    const metadata = JSON.parse(this.service.get(this.cacheKey));

    if (
      !metadata ||
      !metadata.generation ||
      !Number.isInteger(metadata.chunks) ||
      metadata.chunks < 1 ||
      metadata.chunks > DataCache.MAX_CHUNKS ||
      metadata.createdAt < freshAfter
    ) {
      return null;
    }

    const encodedChunks = [];

    for (let offset = 0; offset < metadata.chunks; offset += 50) {
      const chunkKeys = Array.from(
        { length: Math.min(50, metadata.chunks - offset) },
        (_, chunkIndex) => this.cacheKey + ':' + metadata.generation + ':' + (offset + chunkIndex),
      );
      const chunkValues = this.service.getAll(chunkKeys);

      for (const key of chunkKeys) {
        if (typeof chunkValues[key] !== 'string') {
          return null;
        }

        encodedChunks.push(chunkValues[key]);
      }
    }

    const encodedSnapshot = encodedChunks.join('');

    if (encodedSnapshot.length !== metadata.length) {
      return null;
    }

    return Utilities.ungzip(
      Utilities.newBlob(Utilities.base64Decode(encodedSnapshot), 'application/x-gzip'),
    ).getDataAsString('UTF-8');
  } catch (error) {
    return null;
  }
};

DataCache.prototype.set = function (value, createdAt = Date.now()) {
  const encodedSnapshot = Utilities.base64Encode(
    Utilities.gzip(Utilities.newBlob(value, 'application/json')).getBytes(),
  );
  const chunkCount = Math.ceil(encodedSnapshot.length / DataCache.MAX_CACHE_SIZE);

  if (chunkCount > DataCache.MAX_CHUNKS) {
    return false;
  }

  const generation = Utilities.getUuid();

  for (let offset = 0; offset < chunkCount; offset += 50) {
    const chunkValues = {};

    for (let chunkIndex = offset; chunkIndex < Math.min(offset + 50, chunkCount); chunkIndex++) {
      chunkValues[this.cacheKey + ':' + generation + ':' + chunkIndex] = encodedSnapshot.slice(
        chunkIndex * DataCache.MAX_CACHE_SIZE,
        (chunkIndex + 1) * DataCache.MAX_CACHE_SIZE,
      );
    }

    this.service.putAll(chunkValues, DataCache.REQUEST_CACHING_TIME);
  }

  // Publish only after every chunk is written. Readers never mix generations.
  this.service.put(
    this.cacheKey,
    JSON.stringify({ generation, chunks: chunkCount, length: encodedSnapshot.length, createdAt }),
    DataCache.REQUEST_CACHING_TIME,
  );

  return true;
};
