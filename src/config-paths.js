// Resolved filesystem locations shared across modules. Env overrides:
// HSAPI_WORKSPACE_ROOT (config home), HSAPI_CATALOG_FILE, HSAPI_TIERS_FILE.
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = process.env.HSAPI_WORKSPACE_ROOT
  ? path.resolve(process.env.HSAPI_WORKSPACE_ROOT)
  : PACKAGE_ROOT;
const DEFAULT_CONFIG = path.join(WORKSPACE_ROOT, 'config', 'hubspot-portals.json');
const CATALOG_FILE = process.env.HSAPI_CATALOG_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-catalog.json');
const TIERS_FILE = process.env.HSAPI_TIERS_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-tiers.json');

module.exports = {
  CATALOG_FILE,
  DEFAULT_CONFIG,
  PACKAGE_ROOT,
  TIERS_FILE,
  WORKSPACE_ROOT
};
