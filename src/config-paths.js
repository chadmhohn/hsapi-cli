// Resolved filesystem locations shared across modules. Env overrides:
// HSAPI_WORKSPACE_ROOT (legacy checkout config root), HSAPI_CATALOG_FILE,
// HSAPI_TIERS_FILE. Portal config selection itself is handled by
// resolvePortalConfigPath so an explicit HSAPI_PORTALS_CONFIG always wins.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = process.env.HSAPI_WORKSPACE_ROOT
  ? path.resolve(process.env.HSAPI_WORKSPACE_ROOT)
  : PACKAGE_ROOT;

function nonEmptyEnvPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function userConfigRoot(env = process.env) {
  const xdgConfigHome = nonEmptyEnvPath(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return path.resolve(xdgConfigHome);
  const explicitHome = nonEmptyEnvPath(env.HOME);
  const home = explicitHome ? path.resolve(explicitHome) : os.homedir();
  return path.join(home, '.config');
}

function defaultUserConfigPath(env = process.env) {
  return path.join(userConfigRoot(env), 'hsapi', 'portals.json');
}

function legacyWorkspaceConfigPath(env = process.env) {
  const workspaceRoot = nonEmptyEnvPath(env.HSAPI_WORKSPACE_ROOT)
    ? path.resolve(env.HSAPI_WORKSPACE_ROOT)
    : PACKAGE_ROOT;
  return path.join(workspaceRoot, 'config', 'hubspot-portals.json');
}

function resolvePortalConfigPath(env = process.env, existsSync = fs.existsSync) {
  const explicit = nonEmptyEnvPath(env.HSAPI_PORTALS_CONFIG);
  if (explicit) return explicit;

  const workspaceOverride = nonEmptyEnvPath(env.HSAPI_WORKSPACE_ROOT);
  const legacyConfig = legacyWorkspaceConfigPath(env);
  if (workspaceOverride && existsSync(legacyConfig)) {
    return legacyConfig;
  }

  const userConfig = defaultUserConfigPath(env);
  if (existsSync(userConfig)) return userConfig;

  // Preserve existing checkout-based installations without copying, moving,
  // or modifying their ignored config. Fresh installs use the external
  // per-user path above.
  if (existsSync(legacyConfig)) return legacyConfig;
  return userConfig;
}

const DEFAULT_CONFIG = defaultUserConfigPath();
const LEGACY_CONFIG = legacyWorkspaceConfigPath();
const CATALOG_FILE = process.env.HSAPI_CATALOG_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-catalog.json');
const TIERS_FILE = process.env.HSAPI_TIERS_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-tiers.json');

module.exports = {
  CATALOG_FILE,
  DEFAULT_CONFIG,
  LEGACY_CONFIG,
  PACKAGE_ROOT,
  TIERS_FILE,
  WORKSPACE_ROOT,
  defaultUserConfigPath,
  legacyWorkspaceConfigPath,
  resolvePortalConfigPath,
  userConfigRoot
};
