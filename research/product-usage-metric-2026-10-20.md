# Product candidate usage metric investigation (2026-10-20)

## Decision

The owner has explicitly removed usage frequency from product-candidate selection. For new, unpaired exact name/price candidates, the canonical original is the candidate with the earliest reliable creation date. Equal or unavailable candidate creation dates use deterministic native ID and log the reason. Existing saved pairs and aliases retain precedence and are never redefined by candidate ranking. This is the final selection rule; no usage metric is pending implementation.

## Evidence

- This investigation was initiated under an earlier brief that proposed customer-document frequency. The owner superseded that proposal with the explicit date-only rule above; this note is retained as rationale for not substituting a different metric.
- The catalog candidate producer in `apps/api/src/products/product-card-event.processor.ts` passes `usage: null` for both the incoming Bitrix24 product and each MoySklad candidate. The policy in `product-catalog-match-policy.ts` accepts usage evidence, but the producer supplies none.
- A bounded authenticated read of `GET https://api.moysklad.ru/api/remap/1.2/entity/product?limit=1` succeeded against the configured MoySklad account. The probe used `Accept: application/json;charset=utf-8`, `Accept-Encoding: gzip`, HTTPS, and did not emit business records or identifiers.
- The official [Remap turnover report reference](https://dev.moysklad.ru/doc/api/remap/1.2/#/reports/report-turnover) documents `GET /report/turnover/byoperations`, filter `product=<full product entity href>`, and operation types `supply`, `purchasereturn`, `demand`, `salesreturn`, `loss`, `enter`, `move`, `processing`, `retaildemand`, `retailsalesreturn`, and `productionstagecompletion`. `customerorder` is not among the documented types. The response rows contain an `operation` document reference and a `quantity`; that quantity is not document frequency.
- The same official reference says the report without `momentFrom`/`momentTo` covers only the last month. A bounded read using the documented `product=<href>` filter returned a valid response with `meta.size=0` for one sample product in that default month. A second bounded read using `momentFrom=2000-01-01` and a fixed `momentTo` was accepted and returned metadata only (`size=412`, `limit=1`); no row values or product identifier were emitted. `momentFrom=1970-01-01` was rejected with error 1034 (`date below lower bound`). This validates product filtering and date-window behavior, but the turnover endpoint still does not count customer-order appearances.
- A bounded service probe using the documented `product` filter with an `entity/service/<id>` href returned HTTP 400 / error 2024: href has the wrong entity type `service`; `product` is required. The service ID was held in memory and not emitted. Thus this turnover report cannot supply service usage.
- The official [customer order reference](https://dev.moysklad.ru/doc/api/remap/1.2/#/documents/customerOrder) documents `GET /entity/customerorder/{id}/positions` as listing all positions for one order, with only `id`, `limit`, and `offset` parameters. Its customerorder field table lists `positions` as a `MetaArray` but leaves that field's filterability column blank; the reference provides no cross-order item-position filter. A complete customer-order item-frequency index therefore needs reading customer orders and their positions, not one supported filtered product counter. No speculative `positions.assortment` filter was sent.
- The attempted unsupported `filter=assortment=<id>` query returned HTTP 412 / error 1034 (`unknown filter field 'assortment'`). This was an invalid filter expression; the supported field is `product` as shown above. The probe's product identifier stayed in memory. Error 1034 links to the official [Remap API error reference](https://dev.moysklad.ru/doc/api/remap/1.2/#/errors#error_1034).
- Repository searches found no complete product usage aggregate/cache. `HistoricalInventoryEntry` stores selected deal/order scalar fields and IDs, not order positions. `DealOrderPositionPair` and operation tables cover only rows handled by this synchronization workflow, not all historical customer orders. Those records cannot support full-history ranking.

## Why turnover cannot rank candidates for this rule

The report provides an API-side aggregate/detail path for turnover operations, but turnover is not frequency of use in documents and could choose a different canonical candidate. The documented report also lacks customer-order operations and does not cover services. The customer-order positions API has no product filter, so full order frequency would require a resumable historical index or background inventory of order IDs and their positions; existing inventory is incomplete. These limits motivated removal of usage from the decision rather than a metric substitution or incomplete local count.

## Concrete options

No metric implementation options remain open for this matching rule. Reconsidering usage frequency would require a separate explicit product decision and a comparable source for products and services; turnover or partial cache counts must not silently replace the date-only rule.

The bounded provider probes described above were read-only. No external writes were performed.
