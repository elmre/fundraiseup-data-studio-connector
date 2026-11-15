const communityConnector = DataStudioApp.createCommunityConnector();
const schemaCache = new Map();
const dynamicFieldIds = new Map();
let apiRateLimitCount = 0;

function getSchema(request = {}) {
  try {
    const credentials = getApiCredentials(request);
    const credentialsFingerprint = cacheFingerprint(JSON.stringify(credentials));

    if (schemaCache.has(credentialsFingerprint)) {
      return { schema: schemaCache.get(credentialsFingerprint) };
    }

    const schemaSample = fetchDataApi(
      { ...request, max_request_count: 5, allow_partial: true },
      true,
      false,
    );

    const schema = [...getSchemaDefinition(), ...rememberDynamicFields(request, schemaSample)];
    schemaCache.set(credentialsFingerprint, schema);

    return { schema: schema };
  } catch (error) {
    throwConnectorError_(error);
  }
}

function getConfig(request) {
  const config = communityConnector.getConfig();

  config
    .newTextInput()
    .setId('api_key')
    .setName('API Key')
    .setHelpText(
      'Enter a Fundraise Up API key with donations read access. This key is saved in this data source and is visible to people who can edit its connection settings.',
    )
    .setPlaceholder('Fundraise Up API key')
    .setAllowOverride(false);

  config
    .newCheckbox()
    .setId('test_data')
    .setName('Test data')
    .setHelpText(
      'Use test donations instead of live donations. Your API key must have read access to the selected mode.',
    )
    .setAllowOverride(false);

  config.newInfo().setId('instructions').setText('Reports use donation creation dates in UTC.');
  config.setDateRangeRequired(true);

  return config.build();
}

function getApiCredentials(request = {}) {
  // Explicit keys are used by the existing scheduled Sheets integration.
  const hasExplicitApiKey = request.api_key !== undefined;
  const configParams = request.configParams || {};
  const apiKey = normalizeApiKey_(hasExplicitApiKey ? request.api_key : configParams.api_key);
  const modeSetting = hasExplicitApiKey
    ? (request.livemode ?? configParams.livemode ?? true)
    : (configParams.test_data ?? false);

  if (![true, false, 'true', 'false'].includes(modeSetting)) {
    throw connectorError(
      'REQUEST',
      hasExplicitApiKey ? 'Invalid live mode value.' : 'Invalid Test data value.',
    );
  }

  const isModeEnabled = modeSetting === true || modeSetting === 'true';

  return { apiKey, livemode: hasExplicitApiKey ? isModeEnabled : !isModeEnabled };
}

function normalizeApiKey_(key) {
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    key.trim().length > 4096 ||
    /[^\x21-\x7e]/.test(key.trim())
  ) {
    throw connectorError(
      'AUTH',
      'Enter a valid Fundraise Up API key in the data source connection settings.',
    );
  }

  return key.trim();
}

function getDateBounds(request) {
  if (!request.dateRange) {
    return {};
  }

  const parseReportDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw connectorError('REQUEST', 'Invalid report date range.');
    }

    const date = new Date(value + 'T00:00:00.000Z');

    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw connectorError('REQUEST', 'Invalid report date range.');
    }

    return date;
  };
  const startDate = parseReportDate(request.dateRange.startDate);
  const endDate = parseReportDate(request.dateRange.endDate);

  if (startDate > endDate) {
    throw connectorError('REQUEST', 'Invalid report date range.');
  }

  endDate.setUTCDate(endDate.getUTCDate() + 1);

  return { createdGte: startDate.toISOString(), createdLt: endDate.toISOString() };
}

function tryGetFromCache(cache, skipCache, freshAfter = 0) {
  if (skipCache) {
    return null;
  }

  const data = getCache(cache, freshAfter);

  return data && data.has_more === false && Array.isArray(data.data) ? data : null;
}

function withLock(callback) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw connectorError('BUSY', 'Another data request is running. Try again shortly.');
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function fetchDataApi(request = {}, skipCache = false, writeCache = true) {
  const startedAt = Date.now();
  const { apiKey, livemode } = getApiCredentials(request);

  if (!apiKey) {
    throw connectorError('AUTH', 'Reconnect the data source and enter a Fundraise Up API key.');
  }

  const dateBounds = getDateBounds(request);
  const useReportProjection = request.report_projection === true;
  const projectionFields = useReportProjection
    ? getSchemaDefinition().map((field) => field.name)
    : null;

  const fetchOptions = {
    ...dateBounds,
    startingAfter: request.starting_after,
    endingBefore: request.ending_before,
    maxRequests: request.max_request_count ?? DEFAULT_MAX_REQUEST_COUNT,
    allowPartial: request.allow_partial === true,
    mapDonation: useReportProjection
      ? (donation) => projectDonation(donation, projectionFields)
      : undefined,
    deadline: startedAt + (request.fetch_time_ms || MAX_FETCH_TIME_MS),
  };

  const cache = new DataCache(
    CacheService.getUserCache(),
    JSON.stringify({
      apiKey,
      livemode,
      ...dateBounds,
      projection: useReportProjection
        ? cacheFingerprint(JSON.stringify(projectionFields))
        : undefined,
      startingAfter: fetchOptions.startingAfter,
      endingBefore: fetchOptions.endingBefore,
    }),
  );

  const freshAfter = Number(request.scriptParams?.lastRefresh) || 0;
  const cachedDonations = tryGetFromCache(cache, skipCache, freshAfter);

  if (cachedDonations) {
    return cachedDonations;
  }

  const failureCacheKey = cache.cacheKey + ':failure';
  const checkCooldown = () => {
    if (!fetchOptions.allowPartial && cache.service.get(failureCacheKey)) {
      throw connectorError(
        'COOLDOWN',
        'Repeated downloads of this range are temporarily paused. Select a shorter range or wait one minute before retrying.',
      );
    }
  };

  checkCooldown();

  return withLock(() => {
    const cachedDonationsAfterLock = tryGetFromCache(cache, skipCache, freshAfter);

    if (cachedDonationsAfterLock) {
      return cachedDonationsAfterLock;
    }

    checkCooldown();

    try {
      const donationsResponse = new ApiClient(apiKey, livemode).fetchAllPages(fetchOptions);

      if (useReportProjection) {
        donationsResponse.projected = true;
      }

      if (
        writeCache &&
        !donationsResponse.has_more &&
        !setCache(donationsResponse, cache, startedAt)
      ) {
        cache.service.put(failureCacheKey, 'cache', FETCH_FAILURE_COOLDOWN_SECONDS);
      }

      return donationsResponse;
    } catch (error) {
      if (
        !fetchOptions.allowPartial &&
        ['LIMIT', 'TIMEOUT', 'API_UNAVAILABLE', 'API_RESPONSE'].includes(error.code)
      ) {
        cache.service.put(failureCacheKey, '1', FETCH_FAILURE_COOLDOWN_SECONDS);
      }

      throw error;
    }
  });
}

function getDynamicFieldId(prefix, sourceName) {
  const cacheKey = prefix + ':' + sourceName;

  if (!dynamicFieldIds.has(cacheKey)) {
    dynamicFieldIds.set(cacheKey, prefix + '_' + cacheFingerprint(sourceName));
  }

  return dynamicFieldIds.get(cacheKey);
}

function buildDynamicFieldsSchema(response) {
  const fields = new Map();

  for (const donation of response.data || []) {
    for (const customField of donation.custom_fields || []) {
      const name = getDynamicFieldId('custom_fields', customField.name);

      if (!fields.has(name)) {
        fields.set(name, {
          name,
          label: 'Custom Field ' + customField.name,
          description: 'Custom field: ' + customField.name,
          group: 'Custom Fields',
          dataType: 'STRING',
          semantics: { conceptType: 'DIMENSION' },
        });
      }
    }

    for (const question of donation.questions || []) {
      for (const property of ['code', 'text', 'checked', 'options']) {
        if (!Object.prototype.hasOwnProperty.call(question, property)) {
          continue;
        }

        const name = getDynamicFieldId('questions_' + property, question.id);

        if (!fields.has(name)) {
          fields.set(name, {
            name,
            label: 'Question ' + question.id + ' (' + property + ')',
            description: 'Question ID: ' + question.id + '. Options are stored as a JSON array.',
            group: 'Questions',
            dataType: property === 'checked' ? 'BOOLEAN' : 'STRING',
            semantics: { conceptType: 'DIMENSION' },
          });
        }
      }
    }
  }

  return [...fields.values()];
}

function rememberDynamicFields(request, response) {
  const discoveredFields = buildDynamicFieldsSchema(response);
  const credentials = JSON.stringify(getApiCredentials(request));
  const cache = new DataCache(CacheService.getUserCache(), 'dynamic-schema:v1:' + credentials);
  let fields = discoveredFields;

  // Metadata is best-effort; missing cache entries must not discard downloaded donations.
  try {
    fields = withLock(() => {
      const cachedSchema = cache.get();
      const cachedFields = JSON.parse(cachedSchema) || [];
      const fieldsByName = new Map(cachedFields.map((field) => [field.name, field]));

      for (const field of discoveredFields) {
        fieldsByName.set(field.name, field);
      }

      const mergedFields = [...fieldsByName.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      );

      const mergedSchema = JSON.stringify(mergedFields);

      if (mergedSchema !== cachedSchema) {
        cache.set(mergedSchema);
      }

      return mergedFields;
    });
  } catch (error) {
    console.log('Dynamic field metadata could not be cached.');
  }

  schemaCache.set(cacheFingerprint(credentials), [...getSchemaDefinition(), ...fields]);

  return fields;
}

function getDonationFrequency(donation) {
  if (Number(donation.installment) === 1) {
    return 'First installment';
  }

  if (donation.recurring_plan_id || Number(donation.installment) > 1) {
    return 'Recurring';
  }

  return 'One-time';
}

function buildRows(request, data, outputType = '') {
  Logger.log('Run buildRows()');

  const rows = [];
  let rowNumber = request.last_row + 1 || 2;

  for (const donation of data.data) {
    const values = data.projected ? { ...donation } : flattenObject(donation);

    values.frequency = getDonationFrequency(values);
    values.custom_fields = donation.custom_fields || [];
    values.questions = donation.questions || [];

    for (const customField of values.custom_fields) {
      values[getDynamicFieldId('custom_fields', customField.name)] = customField.value;
    }

    for (const question of values.questions) {
      for (const property of ['code', 'text', 'checked', 'options']) {
        values[getDynamicFieldId('questions_' + property, question.id)] = question[property];
      }
    }

    const row = request.fields.map((field) => {
      if (outputType === 'spreadsheet' && field.spreadsheet_formula) {
        return parseFormula(field, request, rowNumber);
      }

      if (field.custom_field_label) {
        const matches = values.custom_fields.filter(
          (customField) =>
            'Custom Field ' + convertToTitleCase(customField.name) === field.custom_field_label,
        );

        return matches.length === 1 ? validateValue(field, matches[0].value, outputType) : '';
      }

      return validateValue(field, values[field.name], outputType);
    });

    rows.push(outputType === 'spreadsheet' ? row : { values: row });
    rowNumber++;
  }

  console.log('Total donations:', rows.length);

  return rows;
}

function getData(request) {
  try {
    if (!request.dateRange) {
      throw connectorError('REQUEST', 'Select a report date range.');
    }

    const donationsResponse = fetchDataApi({
      ...request,
      allow_partial: false,
      report_projection: true,
    });

    if (donationsResponse.has_more) {
      throw connectorError('LIMIT', 'The selected date range could not be loaded completely.');
    }

    const schema = [...getSchemaDefinition(), ...rememberDynamicFields(request, donationsResponse)];
    const fieldsByName = new Map(schema.map((field) => [field.name, field]));

    const fields = request.fields.map((field) => {
      const fieldDefinition = fieldsByName.get(field.name);

      if (fieldDefinition) {
        return fieldDefinition;
      }
      // Dynamic fields may be absent from every donation in the selected range.
      if (/^(custom_fields|questions_(code|text|checked|options))_[a-f0-9]{64}$/.test(field.name)) {
        return {
          name: field.name,
          label: field.name,
          dataType: field.name.startsWith('questions_checked_') ? 'BOOLEAN' : 'STRING',
          semantics: { conceptType: 'DIMENSION' },
        };
      }

      throw connectorError('SCHEMA', 'Refresh the data source fields before using this report.');
    });

    return {
      schema: fields,
      rows: buildRows({ ...request, fields }, donationsResponse),
      filtersApplied: false,
    };
  } catch (error) {
    throwConnectorError_(error);
  }
}

function throwConnectorError_(error) {
  communityConnector
    .newUserError()
    .setText(error.code ? error.message : 'The data could not be loaded. Try a shorter date range.')
    .setDebugText(error.code || 'CONNECTOR_ERROR')
    .throwException();
}

function getAuthType() {
  return { type: 'NONE' };
}

function isAdminUser() {
  return false;
}

function flattenObject(source, flattenedValues, prefix) {
  flattenedValues = flattenedValues || {};
  prefix = prefix || '';

  Object.keys(source).forEach(function (key) {
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      flattenObject(source[key], flattenedValues, prefix + key + '_');
    } else {
      return (flattenedValues[prefix + key] = source[key]);
    }
  });

  return flattenedValues;
}

function projectDonation(donation, fieldNames) {
  const flattenedDonation = flattenObject(donation);
  const row = {};

  for (const name of fieldNames) {
    const value = Object.prototype.hasOwnProperty.call(donation, name)
      ? donation[name]
      : flattenedDonation[name];

    if (value !== undefined && value !== null) {
      row[name] = value;
    }
  }

  row.custom_fields = donation.custom_fields || [];
  row.questions = donation.questions || [];

  return row;
}

function packReportSnapshot(data) {
  if (!data.projected) {
    return data;
  }

  const presentFieldNames = new Set();

  for (const row of data.data) {
    for (const name of Object.keys(row)) {
      presentFieldNames.add(name);
    }
  }

  const columns = getSchemaDefinition()
    .map((field) => field.name)
    .filter((name) => presentFieldNames.has(name));

  return {
    format: 'report-columns-v1',
    columns,
    has_more: data.has_more,
    rows: data.data.map((row) => columns.map((name) => row[name] ?? null)),
  };
}

function getCache(cache, freshAfter = 0) {
  try {
    const snapshot = JSON.parse(cache.get(freshAfter));

    if (snapshot?.format !== 'report-columns-v1') {
      return snapshot;
    }

    if (!Array.isArray(snapshot.columns) || !Array.isArray(snapshot.rows)) {
      return null;
    }

    return {
      projected: true,
      has_more: snapshot.has_more,
      data: snapshot.rows.map((rowValues) => {
        if (!Array.isArray(rowValues) || rowValues.length !== snapshot.columns.length) {
          throw new Error('Invalid cached row.');
        }

        const row = {};

        snapshot.columns.forEach((name, index) => {
          row[name] = rowValues[index];
        });

        return row;
      }),
    };
  } catch (error) {
    return null;
  }
}

function setCache(data, cache, createdAt) {
  try {
    const wasCached = cache.set(JSON.stringify(packReportSnapshot(data)), createdAt);

    if (!wasCached) {
      console.log('Snapshot exceeds cache capacity.');
    }

    return wasCached;
  } catch (error) {
    console.log('Snapshot could not be cached.');

    return false;
  }
}

function convertToTitleCase(text) {
  if (!text) {
    return '';
  }

  const exceptions = ['of', 'the', 'and'];

  return text
    .replace(/[^a-zA-Z0-9-. ]/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((word, wordIndex) => {
      return exceptions.includes(word) && wordIndex !== 0
        ? word
        : word.charAt(0).toUpperCase().concat(word.substr(1));
    })
    .join(' ');
}

function formatReportDate(date, format = 'YYYYMMDDhhmmss') {
  const padTwoDigits = (value) => value.toString().padStart(2, '0');

  const dateParts = {
    YYYY: date.getUTCFullYear(),
    MM: padTwoDigits(date.getUTCMonth() + 1),
    DD: padTwoDigits(date.getUTCDate()),
    hh: padTwoDigits(date.getUTCHours()),
    mm: padTwoDigits(date.getUTCMinutes()),
    ss: padTwoDigits(date.getUTCSeconds()),
  };

  return Object.entries(dateParts).reduce(
    (formattedDate, datePart) => formattedDate.replace(...datePart),
    format,
  );
}

/**
 * Validates the row values. Only numbers, boolean, date and strings are allowed
 */
function validateValue(field, value, outputType) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  if (field.semantics?.semanticType === 'YEAR_MONTH_DAY_SECOND') {
    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) {
      return '';
    }

    return outputType === 'spreadsheet' ? date.toISOString() : formatReportDate(date);
  }

  if (field.dataType === 'NUMBER') {
    const number = Number(value);

    return Number.isFinite(number) ? number : '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  if (field.dataType === 'STRING') {
    const text = String(value);

    // Sheets interprets leading '=' as a formula, including supporter-provided answers.
    return outputType === 'spreadsheet' && text.startsWith('=') ? "'" + text : text;
  }

  return value;
}

function requestURLs(requests, deadlineMs) {
  if (!requests.length || requests.length > MAX_API_CONCURRENCY) {
    throw connectorError('REQUEST', 'Invalid request batch size.');
  }

  const responseBodies = new Array(requests.length);
  let pendingRequests = requests.map((request, index) => ({
    request,
    index,
    attempts: 0,
    readyAt: 0,
  }));

  while (pendingRequests.length) {
    const retryWaitMs = Math.max(
      0,
      Math.min(...pendingRequests.map((pendingRequest) => pendingRequest.readyAt)) - Date.now(),
    );

    if (Date.now() + retryWaitMs + HTTP_TIMEOUT_SECONDS * 1000 >= deadlineMs) {
      throw connectorError('TIMEOUT', 'The request took too long. Select a shorter date range.');
    }

    if (retryWaitMs) {
      Utilities.sleep(retryWaitMs);
    }

    const readyRequests = pendingRequests.filter(
      (pendingRequest) => pendingRequest.readyAt <= Date.now(),
    );
    const fetchRequests = readyRequests.map((pendingRequest) => {
      pendingRequest.attempts++;

      return {
        ...pendingRequest.request,
        muteHttpExceptions: true,
        followRedirects: false,
        timeoutSeconds: HTTP_TIMEOUT_SECONDS,
      };
    });
    let responses;

    try {
      if (fetchRequests.length === 1) {
        const { url, ...fetchOptions } = fetchRequests[0];

        responses = [UrlFetchApp.fetch(url, fetchOptions)];
      } else {
        responses = UrlFetchApp.fetchAll(fetchRequests);
      }
    } catch (error) {
      // A transport exception can contain credentials; never log its text.
    }

    for (let index = 0; index < readyRequests.length; index++) {
      const pendingRequest = readyRequests[index];
      const response = responses?.[index];
      const statusCode = response ? response.getResponseCode() : 0;

      if (statusCode === 429) {
        apiRateLimitCount++;
      }

      if (statusCode === 200) {
        try {
          responseBodies[pendingRequest.index] = JSON.parse(response.getContentText());
        } catch (error) {
          throw connectorError(
            'API_RESPONSE',
            'Fundraise Up returned an invalid response. Try again later.',
          );
        }

        pendingRequests = pendingRequests.filter((otherRequest) => otherRequest !== pendingRequest);
        continue;
      }

      if (statusCode === 401 || statusCode === 403) {
        const error = connectorError(
          'AUTH',
          'The API key is invalid or lacks permission to read donations. Reconnect the data source.',
        );

        error.httpStatus = statusCode;
        throw error;
      }

      if (statusCode && statusCode !== 429 && statusCode < 500) {
        throw connectorError(
          'API_REQUEST',
          'Fundraise Up rejected the request (HTTP ' + statusCode + ').',
        );
      }

      if (pendingRequest.attempts >= 4) {
        throw connectorError(
          'API_UNAVAILABLE',
          'Fundraise Up is temporarily unavailable or busy. Try again later.',
        );
      }

      let retryDelayMs =
        1000 * Math.pow(2, pendingRequest.attempts - 1) + Math.floor(Math.random() * 250);
      const responseHeaders = response ? response.getAllHeaders() : {};
      const retryAfterHeader = Object.keys(responseHeaders).find(
        (name) => name.toLowerCase() === 'retry-after',
      );

      if (retryAfterHeader) {
        const retryAfterValue = String(responseHeaders[retryAfterHeader]);
        const retryAfterMs = /^\d+(\.\d+)?$/.test(retryAfterValue)
          ? Number(retryAfterValue) * 1000
          : Date.parse(retryAfterValue) - Date.now();

        if (Number.isFinite(retryAfterMs)) {
          retryDelayMs = Math.max(retryDelayMs, retryAfterMs);
        }
      }

      if (Date.now() + retryDelayMs + HTTP_TIMEOUT_SECONDS * 1000 >= deadlineMs) {
        throw connectorError(
          'API_UNAVAILABLE',
          'Fundraise Up is temporarily unavailable or busy. Try again later.',
        );
      }

      pendingRequest.readyAt = Date.now() + retryDelayMs;
    }
  }

  return responseBodies;
}

function parseFormula(field, request, rowNumber) {
  if (
    !field.hasOwnProperty('spreadsheet_formula') ||
    !field['spreadsheet_formula'] ||
    !request.hasOwnProperty('fields') ||
    !request['fields'].length
  ) {
    return '';
  }

  let formula = field.spreadsheet_formula;
  const referencedFieldNames = [];

  // Regular expression to match ${variable_name}
  const fieldReferencePattern = /\$\{([^}]+)}/g;
  let fieldReferenceMatch;

  while ((fieldReferenceMatch = fieldReferencePattern.exec(formula)) !== null) {
    referencedFieldNames.push(fieldReferenceMatch[1]);
  }

  for (let fieldIndex = 0; fieldIndex < referencedFieldNames.length; fieldIndex++) {
    let referencedField = request.fields.find(
      (schemaField) => schemaField.name === referencedFieldNames[fieldIndex],
    );

    if (referencedField.hasOwnProperty('letter') && referencedField['letter']) {
      let cellReference = referencedField['letter'] + rowNumber;

      formula = formula.replace(`\${${referencedFieldNames[fieldIndex]}}`, cellReference);
    }
  }

  return formula;
}
