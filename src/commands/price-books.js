// HubSpot Price Books 2026-09-beta read operations.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  pathPart,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  appendMappedSearchQuery,
} = require('../command-inputs');
const {
  endpointDefinitionById,
} = require('../catalog');
const {
  collectPages,
  hubspotFetch,
} = require('../request');

const PRICE_BOOKS_BASE = '/commerce/price-books/2026-09-beta/price-books';

function priceBookIdFrom(rest, flags, action) {
  const priceBookId = rest[0] || flags['price-book-id'];
  if (!priceBookId) fail(`price-books ${action} requires <priceBookId> or --price-book-id.`);
  return priceBookId;
}

function priceBookListQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    limit: 'limit',
    after: 'after',
    archived: 'archived'
  });
}

function archivedQueryFlags(flags) {
  return appendMappedSearchQuery(flags, { archived: 'archived' });
}

async function runPriceBooks(portal, action, rest, flags) {
  if (action === 'list') {
    const queryFlags = priceBookListQueryFlags(flags);
    const endpoint = endpointDefinitionById('price_books.list');
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', PRICE_BOOKS_BASE, queryFlags, undefined, endpoint)
      : await hubspotFetch(portal, 'GET', PRICE_BOOKS_BASE, queryFlags, undefined, endpoint);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const priceBookId = priceBookIdFrom(rest, flags, action);
    printJson(await hubspotFetch(
      portal,
      'GET',
      `${PRICE_BOOKS_BASE}/${pathPart(priceBookId)}`,
      archivedQueryFlags(flags),
      undefined,
      endpointDefinitionById('price_books.get')
    ));
    return;
  }

  if (action === 'validate') {
    const priceBookId = priceBookIdFrom(rest, flags, action);
    printJson(await hubspotFetch(
      portal,
      'POST',
      `${PRICE_BOOKS_BASE}/${pathPart(priceBookId)}/validate`,
      flags,
      undefined,
      endpointDefinitionById('price_books.validate')
    ));
    return;
  }

  if (action === 'items-list') {
    const priceBookId = priceBookIdFrom(rest, flags, action);
    const target = `${PRICE_BOOKS_BASE}/${pathPart(priceBookId)}/items`;
    const queryFlags = priceBookListQueryFlags(flags);
    const endpoint = endpointDefinitionById('price_books.items_list');
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', target, queryFlags, undefined, endpoint)
      : await hubspotFetch(portal, 'GET', target, queryFlags, undefined, endpoint);
    printJson(result);
    return;
  }

  if (action === 'item-get') {
    const priceBookId = priceBookIdFrom(rest, flags, action);
    const priceBookItemId = rest[1] || flags['price-book-item-id'];
    if (!priceBookItemId) {
      fail('price-books item-get requires <priceBookId> <priceBookItemId> or --price-book-item-id.');
    }
    printJson(await hubspotFetch(
      portal,
      'GET',
      `${PRICE_BOOKS_BASE}/${pathPart(priceBookId)}/items/${pathPart(priceBookItemId)}`,
      archivedQueryFlags(flags),
      undefined,
      endpointDefinitionById('price_books.item_get')
    ));
    return;
  }

  fail(`Unknown price-books action: ${action}`);
}

module.exports = {
  PRICE_BOOKS_BASE,
  runPriceBooks,
};
