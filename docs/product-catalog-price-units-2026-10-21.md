# Catalog prices: native amount units

The live synthetic PRODUCT01 exposed a unit error: MySklad `salePrices.value=23700`
became Bitrix24 `catalog.price=23700 RUB` instead of `237 RUB`.

The official Remap product contract defines sale prices in kopecks:
https://github.com/moysklad/api-remap-1.2-doc/blob/master/md/dictionaries/_product.md#цены-продажи

`ProductCardHttpApi.readMoysklad` now decodes native minor units to major units,
including dry-write readback. Both provider snapshots and their checkpoints use
major units. Initial card creation and later price updates copy that amount;
they do not choose a new price or recalculate discounts/VAT. The otherwise
disabled reverse-price branch serializes major units back to native minor units.

Postchecks cover product/service CREATE 23700→237, UPDATE 1000→1825→0,
unchanged unrelated price types, exact existing price IDs and no document writes.
The second UPDATE also verifies that the source price survives the first durable
checkpoint (previously `readField` omitted prices, causing the next update to hold).

No migration or bulk baseline reset is required. Product cards remain one-way
MySklad→Bitrix24; existing source prices stay authoritative. Earlier held events
and the failed live synthetic card are retained, not replayed or manually repaired.
