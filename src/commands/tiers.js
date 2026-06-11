// hsapi tiers: product-tier reporting against the bundled matrix.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  hubspotFetch,
} = require('../request');
const {
  extractFeaturesByTier,
  globalApiSurfaceSummary,
  loadTiersData,
  normalizeTierName,
  tier403Note,
} = require('../tiers');

async function runTiers(portal, action, flags) {
  const tiersData = loadTiersData();

  if (action === 'products') {
    const products = (tiersData.products || []).map((product) => ({
      hub: product.hub || null,
      tiers: product.tiers || [],
      featureCount: Array.isArray(product.features) ? product.features.length : 0
    }));
    printJson({
      ok: true,
      sourceUrl: tiersData.sourceUrl || null,
      generatedAt: tiersData.generatedAt || null,
      note: tiersData.note || null,
      products
    });
    return;
  }

  if (action === 'apis') {
    const requestedTier = normalizeTierName(flags.tier || portal.knownPlanLabel || 'starter');
    if (!requestedTier) fail('tiers apis requires a valid --tier free|starter|pro|enterprise or a portal known plan.');
    const hubFilter = flags.hub ? String(flags.hub).trim().toLowerCase() : null;
    const includeGlobal = boolFlag(flags, 'include-global') || hubFilter === 'free';
    const products = extractFeaturesByTier(tiersData, requestedTier, hubFilter, { includeGlobal });
    printJson({
      ok: true,
      sourceUrl: tiersData.sourceUrl || null,
      generatedAt: tiersData.generatedAt || null,
      requestedTier,
      hubFilter,
      globalApiSurface: hubFilter ? undefined : globalApiSurfaceSummary(tiersData),
      products
    });
    return;
  }

  if (action === 'portal') {
    const account = await hubspotFetch(portal, 'GET', '/account-info/2026-03/details', flags);
    const inferredTier = normalizeTierName(portal.knownPlanLabel);
    const productTierApis = inferredTier ? extractFeaturesByTier(tiersData, inferredTier, null, { includeGlobal: false }) : [];
    printJson({
      ok: true,
      portal: {
        name: portal.name,
        label: portal.label,
        portalId: portal.portalId,
        accountType: account.data && account.data.accountType ? account.data.accountType : null,
        knownPlanLabel: portal.knownPlanLabel,
        knownPlanSource: portal.knownPlanSource
      },
      note: tier403Note(),
      inferredTier,
      globalApiSurface: globalApiSurfaceSummary(tiersData),
      productTierApis,
      account: account.data
    });
    return;
  }

  fail(`Unknown tiers action: ${action}`);
}

module.exports = {
  runTiers,
};
