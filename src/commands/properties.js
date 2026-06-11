// hsapi properties / property-groups / property-validations.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  optionalNumber,
  parseBody,
  pathPart,
  requireFlag,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  bodyFromFlags,
  propertyDefinitionBodyFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');
const {
  resolvedCrmPathObjectType,
} = require('../crm-object-types');

async function runProperties(portal, action, rest, flags) {
  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('Missing object type.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);
  const base = `/crm/properties/2026-03/${pathPart(objectType)}`;

  if (action === 'list' || action === 'names') {
    const result = await hubspotFetch(portal, 'GET', base, flags);
    if (action === 'names' || boolFlag(flags, 'names-only')) {
      const names = result.data && Array.isArray(result.data.results)
        ? result.data.results.map((property) => property.name).sort()
        : [];
      printJson({ ok: true, portal: portal.name, objectType, count: names.length, names });
    } else {
      printJson(result);
    }
    return;
  }

  if (action === 'get') {
    const propertyName = rest[1];
    if (!propertyName) fail('properties get requires property name.');
    const result = await hubspotFetch(portal, 'GET', `${base}/${pathPart(propertyName)}`, flags);
    printJson(result);
    return;
  }

  if (action === 'create') {
    const body = propertyDefinitionBodyFromFlags(flags, { requireCreateFields: true });
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const propertyName = rest[1];
    if (!propertyName) fail('properties update requires <objectType> <propertyName>.');
    const body = propertyDefinitionBodyFromFlags(flags);
    if (!Object.keys(body).length) fail('properties update requires --body or at least one property definition flag.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(propertyName)}`, flags, body));
    return;
  }

  if (action === 'archive' || action === 'delete') {
    const propertyName = rest[1];
    if (!propertyName) fail(`properties ${action} requires <objectType> <propertyName>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(propertyName)}`, flags));
    return;
  }

  fail(`Unknown properties action: ${action}`);
}

async function runPropertyGroups(portal, action, rest, flags) {
  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('property-groups requires <objectType>.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);
  const base = `/crm/properties/2026-03/${pathPart(objectType)}/groups`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'create') {
    const body = {
      name: requireFlag(flags, 'name'),
      label: requireFlag(flags, 'label')
    };
    const displayOrder = optionalNumber(flags['display-order']);
    if (displayOrder !== undefined) body.displayOrder = displayOrder;
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const groupName = rest[1];
    if (!groupName) fail('property-groups update requires <objectType> <groupName>.');
    const body = bodyFromFlags(flags, ['label']);
    if (!Object.keys(body).length) fail('property-groups update needs at least one field.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(groupName)}`, flags, body));
    return;
  }

  if (action === 'archive' || action === 'delete') {
    const groupName = rest[1];
    if (!groupName) fail(`property-groups ${action} requires <objectType> <groupName>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(groupName)}`, flags));
    return;
  }

  fail(`Unknown property-groups action: ${action}`);
}

async function runPropertyValidations(portal, action, rest, flags) {
  const [objectTypeInput, propertyName, ruleType] = rest;
  if (!objectTypeInput) fail('property-validations requires <objectType>.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', `/crm/property-validations/2026-03/${pathPart(objectType)}`, flags));
    return;
  }

  if (action === 'set') {
    if (!propertyName || !ruleType) {
      fail('property-validations set requires <objectType> <propertyName> <ruleType>.');
    }
    const ruleArguments = parseBody(requireFlag(flags, 'arguments'));
    const body = {
      ruleArguments,
      shouldApplyNormalization: boolFlag(flags, 'normalize') || undefined
    };
    printJson(await guardedFetch(
      portal,
      'PUT',
      `/crm/property-validations/2026-03/${pathPart(objectType)}/${pathPart(propertyName)}/rule-type/${pathPart(ruleType)}`,
      flags,
      body
    ));
    return;
  }

  fail(`Unknown property-validations action: ${action}`);
}

module.exports = {
  runProperties,
  runPropertyGroups,
  runPropertyValidations,
};
