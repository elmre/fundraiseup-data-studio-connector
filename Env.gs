/**
 * Environment Configuration using Properties Service
 * @see https://developers.google.com/apps-script/guides/properties
 *
 * Script Properties hold the private install's scheduled Sheets configuration.
 *
 * Setup:
 * 1. Run setupEnv() once to initialize default config structure
 * 2. In Apps Script Editor: Project Settings > Script Properties > Edit
 * 3. Or use setEnv('KEY', 'value') programmatically
 */

/**
 * Get environment variable from Script Properties
 * @param {string} key - Variable name
 * @returns {string|null} Variable value or null
 */
function getEnv(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Set environment variable in Script Properties
 * @param {string} key - Variable name
 * @param {string} value - Variable value
 */
function setEnv(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  Logger.log('setEnv() - Set: ' + key);
}

/**
 * Get environment variable as parsed JSON
 * @param {string} key - Variable name
 * @returns {*} Parsed JSON value or null
 */
function getEnvJson(key) {
  const value = getEnv(key);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    Logger.log('getEnvJson() - Invalid JSON in ' + key);

    return null;
  }
}

/**
 * Initialize environment with example configuration
 * Run this once, then update values in Project Settings > Script Properties
 */
function setupEnv() {
  const scriptProperties = PropertiesService.getScriptProperties();

  // Only set if not already configured
  if (!scriptProperties.getProperty('SPREADSHEET_CONFIGS')) {
    scriptProperties.setProperty(
      'SPREADSHEET_CONFIGS',
      JSON.stringify([
        {
          spreadsheet_id: 'YOUR_SPREADSHEET_ID',
          sheet_name: 'Live',
          api_key: 'YOUR_API_KEY',
          livemode: true, // Required for API keys created after 30th January 2026. Set to false for test mode.
        },
      ]),
    );
    Logger.log(
      'setupEnv() - Default config created. Update values in Project Settings > Script Properties',
    );
  }

  showEnv();
}

/**
 * Show configured property names without disclosing their values.
 */
function showEnv() {
  const scriptProperties = PropertiesService.getScriptProperties().getProperties();

  Logger.log('Current Script Properties:');
  Object.keys(scriptProperties).forEach(function (key) {
    Logger.log('  ' + key + ' = [redacted]');
  });
}
