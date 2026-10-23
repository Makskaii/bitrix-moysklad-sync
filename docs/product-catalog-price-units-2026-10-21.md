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

## Live verification — 21 October, 18:42 Moscow time

Actual primary `ae67e377091a784da2a4894f14f551f3a96c1182`, configv4, modeON.
One owned MS product `e51edf01-cd62-11f1-0a80-05e600852a66` created B24card682956
through its genuine CREATE notification. Native `created` is absent; the verified
audit CREATE moment passed the launch boundary. Native B24 readback confirmed
property108 equals the MS ID, catalog14/measure9 and exactly237 RUB.

Normal source UPDATE changed its own name/description and retail price to23875
minor units. Native B24 readback confirmed the SAME card/pair and238.75 RUB.
Another source description update retained that price and card. All three genuine
events succeeded (attempts4/1/1; initial rate-limit retries preserved).
The failed earlier PRODUCT01 case remains evidence, not bulk repaired.
