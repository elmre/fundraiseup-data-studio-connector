const API_BASE_URL = 'https://api.fundraiseup.com/v1';
const API_DONATIONS_ENDPOINT = API_BASE_URL + '/donations';
const API_LIMIT_PER_REQUEST = 100;

// One script lock bounds the combined concurrency of all report downloads.
const MAX_API_CONCURRENCY = 3;
const MAX_DATE_PARTITIONS = 128;
const DEFAULT_MAX_REQUEST_COUNT = 1200;
const MAX_DONATIONS_PER_REQUEST = 100000;
const MAX_REQUESTS_PER_RUN = 500;

// Apps Script allows 6 minutes, including locks, caching and row conversion.
const MAX_FETCH_TIME_MS = 240000;
const SPREADSHEET_FETCH_TIME_MS = 180000;
const HTTP_TIMEOUT_SECONDS = 30;
const LOCK_TIMEOUT_MS = 30000;
const FETCH_FAILURE_COOLDOWN_SECONDS = 60;

const SPREADSHEET_CONTINUE_DELAY_MS = 120000;
const DEFAULT_SHEET_NAME = 'Fundraise Up';
