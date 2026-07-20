#!/usr/bin/env bash
set -euo pipefail

# Sample neutral credential-source wrapper for hsapi and hsapi-mcp.
#
# The wrapper reads declared credential environment variable names from
# HSAPI_PORTALS_CONFIG, including ServiceKey/private-app tokens and hosted
# OAuth broker admission credentials. It asks a local secret lookup command
# for missing values, exports them for the child process, then execs the
# requested command. Keep the lookup command and real portal config outside
# this package.
#
# Required:
#   HSAPI_PORTALS_CONFIG     Path to a private hsapi portals config.
#   HSAPI_SECRET_LOOKUP_CMD  Executable that accepts one env var name and
#                            writes the matching secret value to stdout.
#
# Optional:
#   HSAPI_NEUTRAL_TOKEN_PROFILES  Comma-separated profile names to load.
#   HSAPI_NEUTRAL_TOKEN_DRY_RUN   Set to 1 to list required env names only.

if [[ -z "${HSAPI_PORTALS_CONFIG:-}" ]]; then
  printf 'HSAPI_PORTALS_CONFIG is required.\n' >&2
  exit 2
fi

if [[ -z "${HSAPI_SECRET_LOOKUP_CMD:-}" ]]; then
  printf 'HSAPI_SECRET_LOOKUP_CMD is required.\n' >&2
  exit 2
fi

profiles_filter="${HSAPI_NEUTRAL_TOKEN_PROFILES:-}"

required_envs=()
while IFS= read -r required_env; do
  required_envs+=("$required_env")
done < <(node - "$HSAPI_PORTALS_CONFIG" "$profiles_filter" <<'NODE'
const fs = require('fs');

const configPath = process.argv[2];
const profileFilter = (process.argv[3] || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

function fail(message) {
  console.error(message);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`Unable to read HSAPI_PORTALS_CONFIG: ${error.message}`);
}

const portals = config && config.portals;
if (!portals || typeof portals !== 'object' || Array.isArray(portals)) {
  fail('HSAPI_PORTALS_CONFIG must define a portals object.');
}

const profileNames = profileFilter.length ? profileFilter : Object.keys(portals);
const credentialEnvNames = [];

function addCredentialEnv(value) {
  if (typeof value === 'string' && value.trim()) {
    credentialEnvNames.push(value.trim());
  }
}

for (const name of profileNames) {
  const portal = portals[name];
  if (!portal || typeof portal !== 'object' || Array.isArray(portal)) {
    fail(`Portal profile "${name}" is not defined in HSAPI_PORTALS_CONFIG.`);
  }

  const auth = portal.auth && typeof portal.auth === 'object'
    ? portal.auth
    : {};
  const portalBearer = auth.portalBearer && typeof auth.portalBearer === 'object'
    ? auth.portalBearer
    : {};
  const oauth = auth.oauth && typeof auth.oauth === 'object'
    ? auth.oauth
    : {};
  const developer = auth.developer && typeof auth.developer === 'object'
    ? auth.developer
    : {};

  addCredentialEnv(portalBearer.tokenEnv);
  addCredentialEnv(portal.tokenEnv);
  addCredentialEnv(oauth.brokerStartKeyEnv);
  addCredentialEnv(oauth.clientIdEnv);
  addCredentialEnv(oauth.clientSecretEnv);
  addCredentialEnv(developer.personalAccessKeyEnv);
  addCredentialEnv(developer.developerApiKeyEnv);
  addCredentialEnv(developer.appIdEnv);
  addCredentialEnv(developer.clientIdEnv);
  addCredentialEnv(developer.clientSecretEnv);
}

for (const credentialEnv of [...new Set(credentialEnvNames)]) {
  console.log(credentialEnv);
}
NODE
)

for credential_env in "${required_envs[@]}"; do
  if [[ ! "$credential_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf 'Refusing invalid credential env var name from HSAPI_PORTALS_CONFIG: %s\n' "$credential_env" >&2
    exit 2
  fi

  if [[ -n "${!credential_env:-}" ]]; then
    continue
  fi

  if [[ "${HSAPI_NEUTRAL_TOKEN_DRY_RUN:-}" == "1" ]]; then
    printf 'would_load_env=%s\n' "$credential_env" >&2
    continue
  fi

  secret_value="$("$HSAPI_SECRET_LOOKUP_CMD" "$credential_env")"
  if [[ -z "$secret_value" ]]; then
    printf 'Secret lookup returned an empty value for %s.\n' "$credential_env" >&2
    exit 2
  fi

  export "$credential_env=$secret_value"
done

if [[ "${HSAPI_NEUTRAL_TOKEN_DRY_RUN:-}" == "1" ]]; then
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  set -- hsapi
fi

exec "$@"
