/**
 * Main scheduled task entry point
 */
function runScheduledTask() {
  Logger.log('Run runScheduledTask()');

  // Set to false for production cron execution
  const DEBUG_MODE = false;

  // Start processing from the first config
  processNextConfig(0, DEBUG_MODE);
}

function processNextConfig(configIndex, debugMode) {
  Logger.log(
    'Run processNextConfig() - Index: ' + configIndex + (debugMode ? ' [DEBUG MODE]' : ''),
  );

  const configs = getEnvJson('SPREADSHEET_CONFIGS');

  // Check if config exists and is valid
  if (!configs || !configs.length) {
    Logger.log('processNextConfig() - No configuration found. Running setupEnv()...');
    setupEnv();
    Logger.log('─────────────────────────────────────────────────────────────');
    Logger.log('⚠️  ACTION REQUIRED: Update Script Properties with your values');
    Logger.log('   1. Go to Project Settings (⚙️) > Script Properties');
    Logger.log('   2. Edit SPREADSHEET_CONFIGS with your spreadsheet_id and api_key');
    Logger.log('   3. Run runScheduledTask() again');
    Logger.log('─────────────────────────────────────────────────────────────');

    return;
  }

  // Check if config has placeholder values
  const firstConfig = configs[0];

  if (
    firstConfig.spreadsheet_id === 'YOUR_SPREADSHEET_ID' ||
    firstConfig.api_key === 'YOUR_API_KEY'
  ) {
    Logger.log('─────────────────────────────────────────────────────────────');
    Logger.log('⚠️  ACTION REQUIRED: Script Properties contain placeholder values');
    Logger.log('   1. Go to Project Settings (⚙️) > Script Properties');
    Logger.log('   2. Edit SPREADSHEET_CONFIGS with your real spreadsheet_id and api_key');
    Logger.log('   3. Run runScheduledTask() again');
    Logger.log('─────────────────────────────────────────────────────────────');

    return;
  }

  // Check if we've processed all configs
  if (configIndex >= configs.length) {
    Logger.log('processNextConfig() - All configs processed (' + configs.length + ' total)');

    return;
  }

  const currentConfig = configs[configIndex];

  Logger.log(
    'processNextConfig() - Processing config ' +
      (configIndex + 1) +
      '/' +
      configs.length +
      ' (sheet: ' +
      (currentConfig.sheet_name || 'default') +
      ')',
  );

  // Process current config
  try {
    updateSpreadsheet(currentConfig);
  } catch (e) {
    Logger.log('processNextConfig() - Error processing config ' + configIndex + ': ' + e.message);
  }

  // Schedule next config if there are more
  if (configIndex + 1 < configs.length) {
    if (debugMode) {
      // Debug mode: process immediately without delay
      Logger.log('processNextConfig() - [DEBUG] Processing next config immediately...');
      processNextConfig(configIndex + 1, debugMode);
    } else {
      // Production mode: schedule async with delay
      const delayMs = 5000; // 5 seconds
      Logger.log('processNextConfig() - Scheduling next config in ' + delayMs / 1000 + ' seconds');
      Async.apply('processNextConfig', [configIndex + 1, false], { after: delayMs });
    }
  } else {
    Logger.log('processNextConfig() - All configs have been processed');
  }
}

function getSpreadsheetHeaders(currentHeaders, newHeaders) {
  const isDynamicHeader = (header) =>
    typeof header === 'string' &&
    (header.startsWith('Custom Field ') || header.startsWith('Question '));
  const baseHeaders = newHeaders.filter((header) => !isDynamicHeader(header));
  const customHeaders = [...currentHeaders, ...newHeaders].filter(isDynamicHeader);

  return [...new Set([...baseHeaders, ...customHeaders])];
}

function buildSpreadsheetFields(headers, schemaFields) {
  const fieldsByLabel = new Map();

  schemaFields.forEach((field) => {
    if (!fieldsByLabel.has(field.label)) {
      fieldsByLabel.set(field.label, field);
    }
  });

  return headers.map((header, index) => {
    const field = fieldsByLabel.get(header);

    return {
      ...field,
      col_number: index + 1,
      name: field ? field.name : '',
      dataType: field ? field.dataType : 'STRING',
      letter: columnToLetter(index + 1),
      spreadsheet_formula: field ? field.spreadsheet_formula || '' : '',
      // Preserve older Sheets headers that used title-cased custom field names.
      custom_field_label: !field && header.startsWith('Custom Field ') ? header : '',
    };
  });
}

/**
 * Align columns without rewriting cell values or formulas.
 * @returns {boolean} Whether the sheet structure changed.
 */
function migrateSchemaIfNeeded(sheet, newHeaders) {
  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const currentHeaders = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
  const finalHeaders = getSpreadsheetHeaders(currentHeaders, newHeaders);

  if (!finalHeaders.length) {
    return false;
  }

  if (
    currentHeaders.length === finalHeaders.length &&
    currentHeaders.every((header, index) => header === finalHeaders[index])
  ) {
    Logger.log('migrateSchemaIfNeeded() - Headers match, no migration needed');

    return false;
  }

  Logger.log('migrateSchemaIfNeeded() - Schema change detected, starting migration...');
  Logger.log(
    'migrateSchemaIfNeeded() - Current columns: ' +
      currentHeaders.length +
      ', New columns: ' +
      finalHeaders.length,
  );

  const addedColumns = finalHeaders.filter((header) => !currentHeaders.includes(header));
  const removedColumns = currentHeaders.filter(
    (header) => header && !finalHeaders.includes(header),
  );

  if (lastRow === 0) {
    const missingColumns = finalHeaders.length - sheet.getMaxColumns();

    if (missingColumns > 0) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumns);
    }
  } else {
    const workingHeaders = currentHeaders.slice();

    finalHeaders.forEach((header, index) => {
      const sourceIndex = workingHeaders.indexOf(header, index);

      if (sourceIndex === index) {
        return;
      }

      if (sourceIndex === -1) {
        if (index < workingHeaders.length) {
          sheet.insertColumnsBefore(index + 1, 1);
        } else if (index >= sheet.getMaxColumns()) {
          sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
        }

        sheet.getRange(1, index + 1, 1, 1).setValues([[header]]);
      } else {
        // Native moves preserve formulas and update references to moved cells.
        sheet.moveColumns(sheet.getRange(1, sourceIndex + 1, 1, 1), index + 1);
        workingHeaders.splice(sourceIndex, 1);
      }

      workingHeaders.splice(index, 0, header);
    });

    if (workingHeaders.length > finalHeaders.length) {
      sheet
        .getRange(1, finalHeaders.length + 1, lastRow, workingHeaders.length - finalHeaders.length)
        .clear();
    }
  }

  sheet
    .getRange(1, 1, 1, finalHeaders.length)
    .setValues([finalHeaders])
    .setFontWeight('bold')
    .setWrap(true);
  sheet.setFrozenRows(1);

  if (addedColumns.length) {
    Logger.log('migrateSchemaIfNeeded() - Added columns: ' + addedColumns.join(', '));
  }

  if (removedColumns.length) {
    Logger.log('migrateSchemaIfNeeded() - Removed columns: ' + removedColumns.join(', '));
  }

  Logger.log('migrateSchemaIfNeeded() - Migration completed. Existing cell contents preserved.');

  return true;
}

function updateSpreadsheet(config, request) {
  Logger.log('Run updateSpreadsheet()');

  const spreadsheetId = config?.spreadsheet_id;
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const apiKey = config?.api_key || '';
  const livemode = config?.livemode !== undefined ? config.livemode : true; // Default to true (live mode)

  // select the sheet we want to update, or create it if it doesn't exist yet
  let sheet;
  const sheetName = config?.sheet_name || DEFAULT_SHEET_NAME;

  if (spreadsheet.getSheetByName(sheetName) === null) {
    sheet = spreadsheet.insertSheet(sheetName);
  } else {
    sheet = spreadsheet.getSheetByName(sheetName);
  }

  Logger.log('updateSpreadsheet() - Sheet name "' + sheetName + '"');

  request = request || {};

  // In case we need to use another API key
  if (apiKey) {
    request['api_key'] = apiKey;
  }

  // Set livemode parameter (required for API keys created after 30th January 2026)
  request['livemode'] = livemode;

  const lastColumn = sheet.getLastColumn();
  const currentHeaders = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
  const donationIdIndex = currentHeaders.indexOf('Donation ID') + 1;
  const lastRow = sheet.getLastRow();
  const isInitialFill = lastRow < 2; // No data rows yet

  if (!isInitialFill && donationIdIndex === 0) {
    throw connectorError('SCHEMA', 'The spreadsheet must contain a Donation ID column.');
  }

  if (isInitialFill) {
    console.log('updateSpreadsheet() - Initial fill mode: fetching all historical donations');
  }

  request.last_row = lastRow;

  // Determine fetch direction based on mode
  if (lastRow > 1) {
    const donationIdColumn = sheet.getRange(2, donationIdIndex, lastRow - 1, 1).getValues();

    // Find first (oldest) and last (newest) donation IDs
    let oldestDonationId = null;
    let newestDonationId = null;

    for (let i = 0; i < donationIdColumn.length; i++) {
      if (donationIdColumn[i][0]) {
        oldestDonationId = donationIdColumn[i][0];
        break;
      }
    }

    for (let i = donationIdColumn.length - 1; i >= 0; i--) {
      if (donationIdColumn[i][0]) {
        newestDonationId = donationIdColumn[i][0];
        break;
      }
    }

    console.log('updateSpreadsheet() - Oldest Donation ID: ' + oldestDonationId);
    console.log('updateSpreadsheet() - Newest Donation ID: ' + newestDonationId);

    // Check if we're in "continue historical fill" mode (passed from previous run)
    if (request.continue_historical && oldestDonationId) {
      // Continue fetching older donations
      console.log(
        'updateSpreadsheet() - Continuing historical fill, fetching donations before: ' +
          oldestDonationId,
      );
      request['starting_after'] = oldestDonationId;
      request['fetch_direction'] = 'older';
    } else if (newestDonationId) {
      // Normal mode: fetch new donations
      console.log(
        'updateSpreadsheet() - Normal update mode, fetching donations after: ' + newestDonationId,
      );
      request['ending_before'] = newestDonationId;
      request['fetch_direction'] = 'newer';
    }
  }

  // Limit requests per run to avoid timeout (uses global constant from _Constants.gs)
  request.max_request_count = request.max_request_count || MAX_REQUESTS_PER_RUN;

  request.allow_partial = true;
  request.fetch_time_ms = SPREADSHEET_FETCH_TIME_MS;

  const donationsResponse = fetchDataApi(request, true, false);
  const schemaFields = [
    ...getSchemaDefinition(),
    ...rememberDynamicFields(request, donationsResponse),
  ];
  const headers = getSpreadsheetHeaders(
    currentHeaders,
    schemaFields.map((field) => field.label),
  );

  migrateSchemaIfNeeded(sheet, headers);
  sheet.setFrozenRows(1);
  request.fields = buildSpreadsheetFields(headers, schemaFields);
  request.last_row = sheet.getLastRow();

  if (donationsResponse.data === undefined || donationsResponse.data.length === 0) {
    console.log('updateSpreadsheet() - No new data received');

    // If we were doing initial fill and there's more to fetch, schedule continuation
    if (request.continue_historical && donationsResponse.has_more) {
      console.log('updateSpreadsheet() - Historical fill incomplete, scheduling continuation...');

      const nextRequest = {
        continue_historical: true,
        max_request_count: MAX_REQUESTS_PER_RUN,
      };

      Async.apply('updateSpreadsheet', [config, nextRequest], {
        after: SPREADSHEET_CONTINUE_DELAY_MS,
      });
    }

    return false;
  }

  console.log(
    'updateSpreadsheet() - Received ' +
      donationsResponse.data.length +
      ' donations, has_more: ' +
      donationsResponse.has_more,
  );

  // API returns records from newest to oldest
  // For chronological order in spreadsheet (oldest at top, newest at bottom):
  // - When fetching newer donations (ending_before): reverse and append at end
  // - When fetching older donations (starting_after): reverse and prepend at beginning

  let rows;
  let insertRow;

  // Always reverse to get chronological order (oldest first)
  donationsResponse['data'] = donationsResponse.data.slice().reverse();

  if (request.fetch_direction === 'older') {
    // Fetching older donations - insert at beginning (row 2, after header)
    rows = buildRows(request, donationsResponse, 'spreadsheet');
    insertRow = 2;

    // Insert empty rows at the top (after header) to make space
    if (rows.length > 0) {
      sheet.insertRowsAfter(1, rows.length);
    }

    console.log('updateSpreadsheet() - Inserting ' + rows.length + ' older donations at row 2');
  } else {
    // Fetching newer donations or initial fill - append at end
    rows = buildRows(request, donationsResponse, 'spreadsheet');
    insertRow = sheet.getLastRow() + 1;

    console.log(
      'updateSpreadsheet() - Appending ' + rows.length + ' newer donations at row ' + insertRow,
    );
  }

  // Write data
  if (rows.length) {
    // Update last_row for row formulas if inserting at top
    if (request.fetch_direction === 'older') {
      // Recalculate row numbers in request.fields for formulas
      for (let i = 0; i < request.fields.length; i++) {
        request.fields[i].col_number = i + 1;
      }

      request.last_row = 1; // Will insert starting at row 2
      rows = buildRows(request, donationsResponse, 'spreadsheet');
    }

    sheet.getRange(insertRow, 1, rows.length, rows[0].length).setValues(rows);
    console.log('updateSpreadsheet() - Added ' + rows.length + ' rows at position ' + insertRow);
  }

  // Schedule continuation if there's more data
  if (donationsResponse.has_more) {
    console.log('updateSpreadsheet() - More data available, scheduling continuation...');
    // After initial fill or while continuing historical fill, keep fetching older records
    const shouldContinueHistorical =
      request.fetch_direction === 'older' || isInitialFill || request.continue_historical;
    const nextRequest = {
      continue_historical: shouldContinueHistorical,
      max_request_count: MAX_REQUESTS_PER_RUN,
    };

    Async.apply('updateSpreadsheet', [config, nextRequest], {
      after: SPREADSHEET_CONTINUE_DELAY_MS,
    });
  } else {
    // If we just finished initial/historical fill, now fetch new donations
    if (request.fetch_direction === 'older' || request.continue_historical) {
      console.log(
        'updateSpreadsheet() - Historical fill complete! Now checking for new donations...',
      );
      Async.apply('updateSpreadsheet', [config, {}], { after: SPREADSHEET_CONTINUE_DELAY_MS });
    } else {
      console.log('updateSpreadsheet() - Spreadsheet update complete.');
    }
  }

  return true;
}

function columnToLetter(column) {
  let columnRemainder,
    columnLetters = '';

  while (column > 0) {
    columnRemainder = (column - 1) % 26;
    columnLetters = String.fromCharCode(columnRemainder + 65) + columnLetters;
    column = (column - columnRemainder - 1) / 26;
  }

  return columnLetters;
}
