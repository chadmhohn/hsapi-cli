#!/usr/bin/env bash
set -euo pipefail

# Sample neutral token-source wrapper for hsapi and hsapi-mcp.
#
# The wrapper reads portal-bearer token environment variable names from
# HSAPI_PORTALS_CONFIG, asks a local secret lookup command for any missing
# values, exports those variables for the child process, then execs the
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

mapfile -t required_envs < <(node - "$HSAPI_PORTALS_CONFIG" "$profiles_filter" <<'NODE'
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
const tokenEnvNames = [];

for (const name of profileNames) {
  const portal = portals[name];
  if (!portal || typeof portal !== 'object' || Array.isArray(portal)) {
    fail(`Portal profile "${name}" is not defined in HSAPI_PORTALS_CONFIG.`);
  }

  const tokenEnv = portal.auth
    && portal.auth.portalBearer
    && typeof portal.auth.portalBearer.tokenEnv === 'string'
    && portal.auth.portalBearer.tokenEnv.trim()
      ? portal.auth.portalBearer.tokenEnv.trim()
      : (typeof portal.tokenEnv === 'string' ? portal.tokenEnv.trim() : '');

  if (tokenEnv) tokenEnvNames.push(tokenEnv);
}

for (const tokenEnv of [...new Set(tokenEnvNames)]) {
  console.log(tokenEnv);
}
NODE
)

for token_env in "${required_envs[@]}"; do
  if [[ ! "$token_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf 'Refusing invalid token env var name from HSAPI_PORTALS_CONFIG: %s\n' "$token_env" >&2
    exit 2
  fi

  if [[ -n "${!token_env:-}" ]]; then
    continue
  fi

  if [[ "${HSAPI_NEUTRAL_TOKEN_DRY_RUN:-}" == "1" ]]; then
    printf 'would_load_env=%s\n' "$token_env" >&2
    continue
  fi

  secret_value="$("$HSAPI_SECRET_LOOKUP_CMD" "$token_env")"
  if [[ -z "$secret_value" ]]; then
    printf 'Secret lookup returned an empty value for %s.\n' "$token_env" >&2
    exit 2
  fi

  export "$token_env=$secret_value"
done

if [[ "${HSAPI_NEUTRAL_TOKEN_DRY_RUN:-}" == "1" ]]; then
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  set -- hsapi
fi

exec "$@"
