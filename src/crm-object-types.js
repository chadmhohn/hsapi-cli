// CRM object-type knowledge: the standard-object catalog, alias resolution,
// and the custom-schema fallback lookup the commands share.
const {
  hubspotFetchAllowError,
} = require('./request');
const {
  accessNoteForError,
} = require('./tiers');

const CRM_OBJECT_TYPE_CATALOG = [
  {
    family: 'core',
    objectType: 'contacts',
    objectTypeId: '0-1',
    label: 'Contacts',
    aliases: ['contact'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide'
  },
  {
    family: 'core',
    objectType: 'companies',
    objectTypeId: '0-2',
    label: 'Companies',
    aliases: ['company'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide'
  },
  {
    family: 'core',
    objectType: 'deals',
    objectTypeId: '0-3',
    label: 'Deals',
    aliases: ['deal'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/guide'
  },
  {
    family: 'core',
    objectType: 'tickets',
    objectTypeId: '0-5',
    label: 'Tickets',
    aliases: ['ticket'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tickets/guide'
  },
  {
    family: 'commerce',
    objectType: 'products',
    objectTypeId: '0-7',
    label: 'Products',
    aliases: ['product'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/products/guide',
    notes: 'Common product library object. Frequently associated to line items.'
  },
  {
    family: 'commerce',
    objectType: 'line_items',
    objectTypeId: '0-8',
    label: 'Line items',
    aliases: ['line_item', 'line item', 'line items'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/line-items/guide',
    notes: 'Line items usually need name, quantity, and price, then associations to deals, quotes, invoices, or subscriptions.'
  },
  {
    family: 'commerce',
    objectType: 'quotes',
    objectTypeId: '0-14',
    label: 'Quotes',
    aliases: ['quote'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/quotes/guide',
    notes: 'Quote records usually sit in a commerce workflow with deals and line items.'
  },
  {
    family: 'commerce',
    objectType: 'invoices',
    objectTypeId: '0-53',
    label: 'Invoices',
    aliases: ['invoice'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/invoices/guide',
    notes: 'Invoice records depend on commerce/payment setup and should be tested in disposable portals first.'
  },
  {
    family: 'commerce',
    objectType: 'commerce_payments',
    objectTypeId: '0-101',
    label: 'Commerce payments',
    aliases: ['commerce_payment', 'payment', 'payments'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-payments/guide',
    notes: 'Payment records are tied to HubSpot payments or Stripe payment processing setup.'
  },
  {
    family: 'commerce',
    objectType: 'subscriptions',
    objectTypeId: '0-69',
    label: 'Commerce subscriptions',
    aliases: ['subscription', 'commerce_subscription', 'commerce subscriptions'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-subscriptions/guide',
    notes: 'Commerce subscriptions use the subscriptions object type, distinct from marketing communication preferences.'
  },
  {
    family: 'commerce',
    objectType: 'orders',
    objectTypeId: '0-123',
    label: 'Orders',
    aliases: ['order'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/orders/guide'
  },
  {
    family: 'commerce',
    objectType: 'carts',
    objectTypeId: '0-142',
    label: 'Carts',
    aliases: ['cart'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/carts/guide'
  },
  {
    family: 'commerce',
    objectType: 'fees',
    objectTypeId: '0-85',
    label: 'Fees',
    aliases: ['fee'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/fees/guide'
  },
  {
    family: 'commerce',
    objectType: 'discounts',
    objectTypeId: '0-84',
    label: 'Discounts',
    aliases: ['discount'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/discounts/guide'
  },
  {
    family: 'commerce',
    objectType: 'taxes',
    objectTypeId: '0-86',
    label: 'Taxes',
    aliases: ['tax'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/taxes/guide'
  },
  {
    family: 'commerce',
    objectType: 'listings',
    objectTypeId: '0-420',
    label: 'Listings',
    aliases: ['listing'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/listings/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'commerce',
    objectType: 'services',
    objectTypeId: '0-162',
    label: 'Services',
    aliases: ['service'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/services/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'activity',
    objectType: 'calls',
    objectTypeId: '0-48',
    label: 'Calls',
    aliases: ['call'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/calls/guide'
  },
  {
    family: 'activity',
    objectType: 'meetings',
    objectTypeId: '0-47',
    label: 'Meetings',
    aliases: ['meeting'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/meetings/guide'
  },
  {
    family: 'activity',
    objectType: 'notes',
    objectTypeId: '0-46',
    label: 'Notes',
    aliases: ['note'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/notes/guide'
  },
  {
    family: 'activity',
    objectType: 'emails',
    objectTypeId: '0-49',
    label: 'Emails',
    aliases: ['email'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/emails/guide'
  },
  {
    family: 'activity',
    objectType: 'tasks',
    objectTypeId: '0-27',
    label: 'Tasks',
    aliases: ['task'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tasks/guide'
  },
  {
    family: 'activity',
    objectType: 'communications',
    objectTypeId: '0-18',
    label: 'Communications',
    aliases: ['communication'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/communications/guide'
  },
  {
    family: 'activity',
    objectType: 'postal_mail',
    objectTypeId: '0-116',
    label: 'Postal mail',
    aliases: ['postal mail', 'postal_mail'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/postal-mail/guide'
  },
  {
    family: 'activity',
    objectType: 'projects',
    objectTypeId: '0-970',
    label: 'Projects',
    aliases: ['project'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/projects/guide'
  },
  {
    family: 'optional',
    objectType: 'appointments',
    objectTypeId: '0-421',
    label: 'Appointments',
    aliases: ['appointment'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/appointments/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'optional',
    objectType: 'courses',
    objectTypeId: '0-410',
    label: 'Courses',
    aliases: ['course'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/courses/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'optional',
    objectType: 'leads',
    objectTypeId: '0-136',
    label: 'Leads',
    aliases: ['lead'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/leads/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'optional',
    objectType: 'feedback_submissions',
    objectTypeId: '0-19',
    label: 'Feedback submissions',
    aliases: ['feedback_submission', 'feedback submission', 'feedback submissions'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/feedback-submissions/guide'
  },
  {
    family: 'optional',
    objectType: 'goals',
    objectTypeId: '0-74',
    label: 'Goals',
    aliases: ['goal'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/goals/guide'
  },
  {
    family: 'optional',
    objectType: 'users',
    objectTypeId: '0-115',
    label: 'Users',
    aliases: ['user', 'owner', 'owners'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/users/guide'
  }
];

const CRM_OBJECT_TYPE_RESOLUTION_CACHE = new Map();

function normalizeCrmObjectLookupValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^hubspot[\s_-]+/, '')
    .replace(/['"`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function crmObjectLookupKeys(value) {
  const normalized = normalizeCrmObjectLookupValue(value);
  if (!normalized) return [];
  const keys = new Set([normalized]);
  for (const suffix of ['_object', '_objects', '_record', '_records']) {
    if (normalized.endsWith(suffix)) keys.add(normalized.slice(0, -suffix.length));
  }
  for (const key of [...keys]) {
    if (key.endsWith('ies')) keys.add(`${key.slice(0, -3)}y`);
    if (key.endsWith('s')) keys.add(key.slice(0, -1));
  }
  return [...keys].filter(Boolean);
}

function crmObjectCatalogEntryForOutput(entry) {
  const output = {
    family: entry.family,
    objectType: entry.objectType,
    objectTypeId: entry.objectTypeId,
    label: entry.label,
    docsUrl: entry.docsUrl
  };
  if (entry.aliases && entry.aliases.length) output.aliases = [...entry.aliases];
  if (entry.notes) output.notes = entry.notes;
  return output;
}

function standardCrmObjectTypeIndex() {
  const index = new Map();
  for (const entry of CRM_OBJECT_TYPE_CATALOG) {
    const valuesToIndex = [
      entry.objectType,
      entry.objectTypeId,
      entry.label,
      ...(entry.aliases || [])
    ];
    for (const value of valuesToIndex) {
      for (const key of crmObjectLookupKeys(value)) {
        if (!index.has(key)) index.set(key, entry);
      }
    }
  }
  return index;
}

const STANDARD_CRM_OBJECT_TYPE_INDEX = standardCrmObjectTypeIndex();

function resolveStandardCrmObjectType(input) {
  const trimmedInput = String(input || '').trim();
  for (const key of crmObjectLookupKeys(input)) {
    const entry = STANDARD_CRM_OBJECT_TYPE_INDEX.get(key);
    if (entry) {
      const suppliedObjectTypeId = trimmedInput === entry.objectTypeId;
      return {
        resolved: true,
        source: 'standard-catalog',
        input,
        objectType: entry.objectType,
        objectTypeId: entry.objectTypeId,
        pathObjectType: suppliedObjectTypeId ? entry.objectTypeId : entry.objectType,
        standard: true,
        catalogEntry: crmObjectCatalogEntryForOutput(entry)
      };
    }
  }
  return null;
}

function looksLikeCustomObjectTypeId(input) {
  return /^2-\d+$/i.test(String(input || '').trim());
}

function looksLikeFullyQualifiedCustomObjectName(input) {
  return /^p\d+_[a-z0-9_]+$/i.test(String(input || '').trim());
}

function unresolvedCrmObjectType(input) {
  const pathObjectType = String(input || '').trim();
  return {
    resolved: false,
    source: looksLikeCustomObjectTypeId(pathObjectType) ? 'custom-object-type-id'
      : (looksLikeFullyQualifiedCustomObjectName(pathObjectType) ? 'custom-fully-qualified-name' : 'unresolved'),
    input,
    objectType: pathObjectType,
    objectTypeId: looksLikeCustomObjectTypeId(pathObjectType) ? pathObjectType : null,
    pathObjectType,
    standard: false
  };
}

function resolveCrmObjectType(input) {
  const cacheKey = String(input || '').trim();
  if (CRM_OBJECT_TYPE_RESOLUTION_CACHE.has(cacheKey)) {
    return { ...CRM_OBJECT_TYPE_RESOLUTION_CACHE.get(cacheKey) };
  }
  const resolved = resolveStandardCrmObjectType(cacheKey) || unresolvedCrmObjectType(cacheKey);
  CRM_OBJECT_TYPE_RESOLUTION_CACHE.set(cacheKey, resolved);
  return { ...resolved };
}

function resolvedCrmPathObjectType(input) {
  return resolveCrmObjectType(input).pathObjectType;
}

function resolvedCrmObjectTypeIdOrInput(input) {
  const resolution = resolveCrmObjectType(input);
  return resolution.objectTypeId || resolution.pathObjectType;
}

function schemaLookupValues(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const labels = schema.labels && typeof schema.labels === 'object' ? schema.labels : {};
  return [
    schema.objectTypeId,
    schema.fullyQualifiedName,
    schema.name,
    labels.singular,
    labels.plural
  ].filter(Boolean);
}

function customSchemaMatchesInput(schema, input) {
  const wanted = new Set(crmObjectLookupKeys(input));
  return schemaLookupValues(schema).some((value) => (
    crmObjectLookupKeys(value).some((key) => wanted.has(key))
  ));
}

async function resolveCrmObjectTypeWithCustomFallback(portal, input, flags) {
  const standard = resolveCrmObjectType(input);
  if (standard.resolved || standard.source !== 'unresolved') return standard;

  const lookup = await hubspotFetchAllowError(portal, 'GET', '/crm-object-schemas/2026-03/schemas', flags);
  if (!lookup.ok) {
    return {
      ...standard,
      customLookup: {
        attempted: true,
        available: false,
        status: lookup.status,
        statusText: lookup.statusText,
        note: accessNoteForError(lookup.url, lookup.status) || null
      }
    };
  }

  const schemas = lookup.data && Array.isArray(lookup.data.results) ? lookup.data.results : [];
  const match = schemas.find((schema) => customSchemaMatchesInput(schema, input));
  if (!match) {
    return {
      ...standard,
      customLookup: {
        attempted: true,
        available: true,
        matched: false,
        schemaCount: schemas.length
      }
    };
  }

  const objectTypeId = match.objectTypeId || match.fullyQualifiedName || standard.pathObjectType;
  return {
    resolved: true,
    source: 'custom-schema',
    input,
    objectType: objectTypeId,
    objectTypeId: match.objectTypeId || null,
    pathObjectType: objectTypeId,
    standard: false,
    customSchema: {
      objectTypeId: match.objectTypeId || null,
      fullyQualifiedName: match.fullyQualifiedName || null,
      name: match.name || null,
      labels: match.labels || null
    },
    customLookup: {
      attempted: true,
      available: true,
      matched: true,
      schemaCount: schemas.length
    }
  };
}

module.exports = {
  CRM_OBJECT_TYPE_CATALOG,
  CRM_OBJECT_TYPE_RESOLUTION_CACHE,
  STANDARD_CRM_OBJECT_TYPE_INDEX,
  crmObjectCatalogEntryForOutput,
  crmObjectLookupKeys,
  customSchemaMatchesInput,
  looksLikeCustomObjectTypeId,
  looksLikeFullyQualifiedCustomObjectName,
  normalizeCrmObjectLookupValue,
  resolveCrmObjectType,
  resolveCrmObjectTypeWithCustomFallback,
  resolveStandardCrmObjectType,
  resolvedCrmObjectTypeIdOrInput,
  resolvedCrmPathObjectType,
  schemaLookupValues,
  standardCrmObjectTypeIndex,
  unresolvedCrmObjectType,
};
