class ApiClient {
  constructor(apiKey, livemode = true) {
    if (!apiKey) {
      throw connectorError('AUTH', 'Reconnect the data source and enter a Fundraise Up API key.');
    }

    this.livemode = livemode;
    this.headers = { Authorization: 'Bearer ' + apiKey };
  }

  buildUrl(options = {}) {
    if (options.startingAfter && options.endingBefore) {
      throw connectorError('REQUEST', 'Only one pagination cursor can be used.');
    }

    const queryParameters = {
      limit: options.limit || API_LIMIT_PER_REQUEST,
      livemode: this.livemode,
    };

    if (options.startingAfter) {
      queryParameters.starting_after = options.startingAfter;
    }

    if (options.endingBefore) {
      queryParameters.ending_before = options.endingBefore;
    }

    if (options.createdGte) {
      queryParameters['created[gte]'] = options.createdGte;
    }

    if (options.createdLt) {
      queryParameters['created[lt]'] = options.createdLt;
    }

    const queryString = Object.keys(queryParameters)
      .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(queryParameters[key]))
      .join('&');

    return `${API_DONATIONS_ENDPOINT}?${queryString}`;
  }

  fetchAllPages(options = {}) {
    const maxPageRequests = options.maxRequests ?? DEFAULT_MAX_REQUEST_COUNT;
    const maxRows = options.maxRows ?? MAX_DONATIONS_PER_REQUEST;

    if (
      !Number.isInteger(maxPageRequests) ||
      maxPageRequests < 1 ||
      maxPageRequests > DEFAULT_MAX_REQUEST_COUNT ||
      !Number.isInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > MAX_DONATIONS_PER_REQUEST
    ) {
      throw connectorError('REQUEST', 'Invalid page or row limit.');
    }

    const deadlineMs = options.deadline || Date.now() + MAX_FETCH_TIME_MS;
    const canFetchInParallel =
      options.parallel !== false &&
      (!options.allowPartial || options.parallel === true) &&
      !options.startingAfter &&
      !options.endingBefore &&
      options.createdGte &&
      options.createdLt;
    const pendingRanges = [{ ...options, lastCreatedAtMs: Date.parse(options.createdLt) }];
    const donationsResponse = { data: [], has_more: true };
    const seenDonationIds = new Set();
    let fetchedPageCount = 0;
    let rangeCount = 1;
    let requestConcurrency = canFetchInParallel ? MAX_API_CONCURRENCY : 1;

    while (pendingRanges.length) {
      if (
        fetchedPageCount >= maxPageRequests ||
        Date.now() + HTTP_TIMEOUT_SECONDS * 1000 >= deadlineMs ||
        (options.allowPartial && donationsResponse.data.length >= maxRows)
      ) {
        if (options.allowPartial) {
          break;
        }

        throw connectorError(
          'LIMIT',
          'The selected date range is too large to load completely. Select a shorter range.',
        );
      }

      // Split only unvisited time spans. Equal timestamps stay in one cursor chain.
      while (
        fetchedPageCount >= 3 &&
        pendingRanges.length < requestConcurrency &&
        rangeCount < MAX_DATE_PARTITIONS
      ) {
        const longestRemainingRange = pendingRanges
          .map((pageRequest) => ({
            pageRequest,
            remainingDurationMs: pageRequest.lastCreatedAtMs - Date.parse(pageRequest.createdGte),
          }))
          .sort(
            (leftRange, rightRange) =>
              rightRange.remainingDurationMs - leftRange.remainingDurationMs,
          )[0];
        const canSplitRange =
          longestRemainingRange && longestRemainingRange.remainingDurationMs > 1;

        if (!canSplitRange) {
          break;
        }

        const pageRequest = longestRemainingRange.pageRequest;
        const splitDate = new Date(
          Math.floor((Date.parse(pageRequest.createdGte) + pageRequest.lastCreatedAtMs) / 2),
        ).toISOString();

        pendingRanges.push({
          createdGte: pageRequest.createdGte,
          createdLt: splitDate,
          lastCreatedAtMs: Date.parse(splitDate),
        });
        pageRequest.createdGte = splitDate;
        rangeCount++;
      }

      const remainingRowCount = maxRows - donationsResponse.data.length;
      const remainingPageRequests = maxPageRequests - fetchedPageCount;
      const pagesWithinRowLimit =
        remainingRowCount > 0
          ? Math.ceil(remainingRowCount / API_LIMIT_PER_REQUEST)
          : requestConcurrency;
      const batchSize = Math.min(requestConcurrency, remainingPageRequests, pagesWithinRowLimit);
      const requestBatch = pendingRanges.slice(0, batchSize);
      const pageSizes = requestBatch.map((_, requestIndex) => {
        if (remainingRowCount > 0) {
          return Math.min(
            API_LIMIT_PER_REQUEST,
            remainingRowCount - requestIndex * API_LIMIT_PER_REQUEST,
          );
        }

        return 1;
      });
      let pageResponses;
      const rateLimitCountBeforeBatch = apiRateLimitCount;

      try {
        pageResponses = requestURLs(
          requestBatch.map((pageRequest, requestIndex) => ({
            url: this.buildUrl({
              ...pageRequest,
              limit: pageSizes[requestIndex],
            }),
            headers: this.headers,
          })),
          deadlineMs,
        );
      } catch (error) {
        if (
          options.allowPartial &&
          donationsResponse.data.length &&
          ['TIMEOUT', 'API_UNAVAILABLE'].includes(error.code)
        ) {
          break;
        }

        throw error;
      }

      if (apiRateLimitCount > rateLimitCountBeforeBatch) {
        requestConcurrency = 1;
      }

      for (let index = 0; index < requestBatch.length; index++) {
        const pageRequest = requestBatch[index];
        const pageResponse = pageResponses[index];

        if (
          !pageResponse ||
          !Array.isArray(pageResponse.data) ||
          typeof pageResponse.has_more !== 'boolean' ||
          pageResponse.data.length > pageSizes[index] ||
          (pageResponse.has_more && !pageResponse.data.length)
        ) {
          throw connectorError(
            'API_RESPONSE',
            'Fundraise Up returned an invalid pagination response. Try again later.',
          );
        }

        for (const donation of pageResponse.data) {
          if (!donation || typeof donation.id !== 'string' || seenDonationIds.has(donation.id)) {
            throw connectorError(
              'API_RESPONSE',
              'Fundraise Up returned duplicate or invalid donation IDs. Try again later.',
            );
          }

          if (canFetchInParallel) {
            const createdAtMs = Date.parse(donation.created_at);

            if (
              !Number.isFinite(createdAtMs) ||
              createdAtMs < Date.parse(pageRequest.createdGte) ||
              createdAtMs >= Date.parse(pageRequest.createdLt) ||
              createdAtMs > pageRequest.lastCreatedAtMs
            ) {
              throw connectorError(
                'API_RESPONSE',
                'Fundraise Up returned an invalid creation-date order or range. Try again later.',
              );
            }

            pageRequest.lastCreatedAtMs = createdAtMs;
          }

          if (donationsResponse.data.length >= maxRows) {
            throw connectorError(
              'LIMIT',
              'The selected date range is too large to load completely. Select a shorter range.',
            );
          }

          seenDonationIds.add(donation.id);
          donationsResponse.data.push(
            options.mapDonation ? options.mapDonation(donation) : donation,
          );
        }

        fetchedPageCount++;

        if (!pageResponse.has_more) {
          pendingRanges.splice(pendingRanges.indexOf(pageRequest), 1);
        } else if (options.endingBefore) {
          pageRequest.endingBefore = pageResponse.data[0].id;
        } else {
          pageRequest.startingAfter = pageResponse.data[pageResponse.data.length - 1].id;
        }
      }
    }

    donationsResponse.has_more = pendingRanges.length > 0;

    if (rangeCount > 1) {
      donationsResponse.data.sort((leftDonation, rightDonation) => {
        const dateDifference =
          Date.parse(rightDonation.created_at) - Date.parse(leftDonation.created_at);

        if (dateDifference) {
          return dateDifference;
        }

        if (leftDonation.id < rightDonation.id) {
          return 1;
        }

        if (leftDonation.id > rightDonation.id) {
          return -1;
        }

        return 0;
      });
    }

    console.log(
      'API pages: ' +
        fetchedPageCount +
        ', donations: ' +
        donationsResponse.data.length +
        ', complete: ' +
        !donationsResponse.has_more,
    );

    return donationsResponse;
  }
}

function connectorError(code, message) {
  const error = new Error(message);

  error.code = code;

  return error;
}
