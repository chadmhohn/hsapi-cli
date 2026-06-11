// HubSpot product-tier knowledge: the bundled tier matrix plus the access
// notes request errors attach when a 403 smells like a tier/feature gate.
const { TIERS_FILE } = require('./config-paths');
const { readJsonFile } = require('./flags');

function loadTiersData() {
  return readJsonFile(TIERS_FILE);
}

function normalizeTierName(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (['free', 'starter', 'pro', 'enterprise'].includes(value)) return value;
  if (value === 'basic') return 'starter';
  return value;
}

function tierRank(tier) {
  const normalized = normalizeTierName(tier);
  const order = { free: 0, starter: 1, pro: 2, enterprise: 3 };
  return normalized in order ? order[normalized] : -1;
}

function featureAvailableAtTier(featureTier, requestedTier) {
  const featureRank = tierRank(featureTier);
  const requestedRank = tierRank(requestedTier);
  if (featureRank < 0 || requestedRank < 0) return false;
  return featureRank <= requestedRank;
}

function extractFeaturesByTier(tiersData, requestedTier, hubFilter = null, options = {}) {
  const includeGlobal = options.includeGlobal === true;
  const matched = [];
  for (const product of tiersData.products || []) {
    const hubId = product.hub && product.hub.id ? product.hub.id : null;
    if (hubFilter && hubId !== hubFilter) continue;
    if (!hubFilter && hubId === 'free' && !includeGlobal) continue;
    const features = (product.features || [])
      .filter((feature) => featureAvailableAtTier(feature.minTier, requestedTier))
      .map((feature) => ({
        name: feature.name,
        minTier: feature.minTier,
        docsUrl: feature.docsUrl || null,
        disclaimer: feature.disclaimer || null
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    matched.push({
      hub: product.hub || null,
      tiers: product.tiers || [],
      featureCount: features.length,
      features
    });
  }
  return matched;
}

function globalApiSurfaceSummary(tiersData) {
  const freeProduct = (tiersData.products || []).find((product) => product.hub && product.hub.id === 'free');
  const features = freeProduct && Array.isArray(freeProduct.features) ? freeProduct.features : [];
  return {
    hub: freeProduct ? freeProduct.hub : { id: 'free', name: 'Free' },
    featureCount: features.length,
    note: 'This is HubSpot\'s broad free/global API surface. It is not enough to prove a portal has access to subscription-gated capabilities such as custom object schemas, calculated-property limits, or association-label limits. Use product-tier rows and live API checks for entitlement decisions.'
  };
}

function tier403Note() {
  return 'A 403 on custom-object/schema endpoints can mean either the app token is missing the needed API scope, or the portal subscription does not include custom objects/schemas. Check both the token scopes and the HubSpot tier matrix before assuming the API is broken.';
}

function gatedAccessNote(feature, tierText) {
  return `A 403 on ${feature} can mean either the app token is missing the needed API scope, or the portal subscription does not include that feature${tierText ? ` (${tierText})` : ''}. Check both the token scopes and the HubSpot tier matrix before assuming the API is broken.`;
}

function accessNoteForError(urlString, status) {
  if (status !== 403) return null;
  let pathname = '';
  try {
    pathname = new URL(urlString).pathname;
  } catch (_error) {
    return null;
  }
  if (pathname.includes('/crm-object-schemas/') || pathname.includes('/crm/v3/limits/custom-object-types')) {
    return tier403Note();
  }
  if (pathname.includes('/crm/v3/limits/calculated-properties')) {
    return gatedAccessNote('calculated property limits', 'Professional or Enterprise');
  }
  if (pathname.includes('/crm/v3/limits/associations/labels')) {
    return gatedAccessNote('association label limits', 'Professional or Enterprise');
  }
  if (pathname.includes('/communication-preferences/2026-03/statuses/batch')) {
    return gatedAccessNote('batch subscription status endpoints', 'Marketing Hub Enterprise plus batch subscription scopes');
  }
  if (pathname.includes('/crm/v3/objects/custom-objects') || pathname.includes('/crm/objects/custom-objects')) {
    return tier403Note();
  }
  return null;
}

module.exports = {
  accessNoteForError,
  extractFeaturesByTier,
  featureAvailableAtTier,
  gatedAccessNote,
  globalApiSurfaceSummary,
  loadTiersData,
  normalizeTierName,
  tier403Note,
  tierRank
};
