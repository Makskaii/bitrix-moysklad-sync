# T26 live technical gate — 2026-10-06

This supplement records a bounded, read-only live check for the field-mapping gate. It does not replace the product decisions recorded in the accepted Q26.58–61 review, and it does not claim a complete approved runtime map.

## Scope and method

The probe in [`../scripts/t26-readonly-gate.ps1`](../scripts/t26-readonly-gate.ps1) reads the authorized local `.env` values in memory and permits only explicitly allowlisted Bitrix24 and MySklad GET requests. Its output contains reference IDs, types, counts, and selected catalogue labels; it excludes tokens, webhook paths, customer/order/product records, and personal field values. All calls in this check used GET. No POST, PUT, PATCH, or DELETE was sent; no production write/roundtrip was attempted.

This is a point-in-time observation of the accessible account schema and reference directories. It does not establish account-specific write permissions, successful update semantics, or live event delivery. Official API documentation is used below only to distinguish documented writable shapes from runtime proof.

## Live schema and reference evidence

### Units of measure

Bitrix24 returned 12 measures. IDs and API codes were:

| B24 ID | Code | MySklad exact-code candidate UUID |
| ---: | ---: | --- |
| 1 | 6 | — |
| 3 | 112 | `250d5161-f815-4524-85b6-fd6afebc1ad6` |
| 5 | 163 | `8e2eb543-99e9-4077-bc31-93b1359de9c4` |
| 7 | 166 | `2ec1170c-3f69-4409-87bb-c68e0011b275` |
| 9 | 796 | `19f1edc0-fc42-4001-94cb-c9ec9c62ec10` |
| 10 | 778 | `605a1781-b652-11e3-feb0-002590a28eca` |
| 12 | 839 | `f5611dc2-1acd-11e7-7a31-d0fd001085d2` |
| 14 | 1720010507 | — |
| 16 | 1720532980 | — |
| 18 | 55 | — |
| 20 | 1762891510 | — |
| 22 | 736 | `647775b2-3b57-409b-910e-8b17940b279f` |

MySklad returned 66 UOM references. Seven B24 rows have a unique exact-code candidate among them; these are candidates, not approved mappings. Five B24 codes had no exact match. Similar labels or zero-padded codes (for example `6`/`006`, `55`/`055`) are not sufficient evidence to map. The owner-approved Q26.53 workflow permits admin UI automatic matching plus manual persisted assignment, but it does not authorize guessing, creating missing units, or inventing pack factors. Product `uom` and document-row `pack` are separate concepts; row-level UOM mapping remains unverified.

The documented B24 product update schema has a writable `measure` reference field, and B24 exposes measure list/get/add/update/delete methods ([product update](https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-update.html), [measure methods](https://apidocs.bitrix24.com/api-reference/catalog/measure/index.html)). MySklad's official Product/Uom models document the product UOM reference ([Product](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/Product.md), [Uom](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/Uom.md)). This documents the shape, not successful writes in this account.

### Price types

Bitrix24 returned 11 price-type IDs: `2`, `4`, `6`, `8`, `10`, `12`, `14`, `16`, `18`, `20`, `22` (names: `BASE`, `opt`, `vip`, `dil`, `mark`, `ozon`, `mdo`, `rrc`, `ali`, `MIN`, `ZAKUP`; `BASE` was not flagged base, while `ozon` was). MySklad returned 12 configured price-type references:

| MySklad UUID | Name |
| --- | --- |
| `02b04e92-d515-11e2-e753-7054d21a8d1e` | Retail / Розница |
| `f2ead8ce-de34-11e5-7a69-8f550015ae90` | Opt / Опт |
| `78a9ffa3-0712-11e6-7a69-8f5500119e54` | VIP |
| `1b4623d2-2857-11eb-0a80-044e00021305` | Дилер |
| `181fccd0-7736-11ed-0a80-080900027768` | ВБ |
| `47e91e27-ad13-11f1-0a80-144700177791` | ВБ ВентМаркет |
| `5c8a8396-b503-11ee-0a80-0d3e00059f64` | Ozon |
| `7c45db73-7b9e-11f1-0a80-182500121f3e` | Ozon ВентМаркет |
| `e4a858d7-e190-11f0-0a80-1059000f9c17` | ЯМ |
| `61161db9-7f0b-11ee-0a80-0b350015853e` | М. До скидки |
| `138eeb4d-82c0-11ed-0a80-0ffb0028e290` | РРЦ |
| `a88d2683-3e1f-11f1-0a80-185000073e51` | Минимальная цена Ozon |

The two lists establish actual catalogue IDs, not configured B24↔MySklad correspondence. No current mapping table was exposed by these APIs; the previously used HTMLStudio URL was unavailable (parked page), so no configured pairs are verified here. Do not infer pairs by name, ordering, or position. Currency is carried by price records; the price-type list does not establish each record's currency.

Official docs describe B24 price-type and price APIs ([price types](https://apidocs.bitrix24.com/api-reference/catalog/price-type/index.html), [prices](https://apidocs.bitrix24.com/api-reference/catalog/price/index.html)). MySklad documents the product sale-price collection and the configured price-type directory ([Product](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/Product.md), [PriceType API](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/PriceTypesApi.md), [PriceType](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/PriceType.md), [SalePrice](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/SalePrice.md)). Documentation supports a writable shape; it does not prove which paired IDs the former integration used or account permissions.

### Service and payment-method dictionaries

The two configured B24 deal fields were live-schema type `iblock_element`, single-valued, not mandatory, with information-block IDs `42` and `44`. The current MySklad customer-order attributes were both type `customentity`, optional (`required=false`):

| Meaning | B24 field | B24 list | MySklad attribute | MySklad directory | Current value coverage |
| --- | --- | ---: | --- | --- | ---: |
| Service | `UF_CRM_1766085949` | 42 | `0ad997c8-8e75-11e3-1ec9-002590a28eca` | `f0177126-8e74-11e3-b761-002590a28eca` | 46/46 UUID `CODE`s matched current value IDs |
| Payment method | `UF_CRM_1766072752` | 44 | `f214f966-dc1a-11f0-0a80-0ef700278459` | `0ecffb86-d8a3-11eb-0a80-0dbc000256e5` | 5/5 UUID `CODE`s matched current value IDs |

The live check compared the full current B24 ID/CODE list to current MySklad value IDs in memory. Every UUID-valued B24 `CODE` was an exact MySklad ID and the counts were equal. A sanitized pair inventory is recorded below. This establishes present identifier coverage, not active/non-archived status, label equivalence, field write permission, or a real order update.

| B24 service ID | MySklad service value ID | B24 service ID | MySklad service value ID |
| ---: | --- | ---: | --- |
| 87402 | `0739768a-9611-11eb-0a80-02fe0030d850` | 87404 | `138ba20f-9611-11eb-0a80-09f30031a1bd` |
| 87406 | `13c6b76f-dc8b-11ef-0a80-14a2002bad01` | 87408 | `1c015bd9-8e75-11e3-7988-002590a28eca` |
| 87410 | `1f3aee5b-7a16-11ed-0a80-0e4b003bd0de` | 87412 | `211d13d3-f3f3-11ed-0a80-0d7700134652` |
| 87414 | `212c3425-8e77-11e3-f329-002590a28eca` | 87416 | `2429260a-8e75-11e3-ae91-002590a28eca` |
| 87418 | `25e77ed7-c084-11ec-0a80-0e8a001a9d4f` | 87420 | `29251eea-b0b8-11ec-0a80-070300023cdb` |
| 87422 | `29572e0e-8e75-11e3-151d-002590a28eca` | 87424 | `2a83109a-8e77-11e3-4a28-002590a28eca` |
| 87426 | `35041f84-8e77-11e3-0b6c-002590a28eca` | 87428 | `3984efe8-86ab-11ed-0a80-0cd100882708` |
| 87430 | `3fb3b201-d1eb-11ec-0a80-08ba0005c288` | 87432 | `418e7b55-9611-11eb-0a80-02fe0030e557` |
| 87434 | `527065e5-31a4-11ec-0a80-0519000835b2` | 87436 | `5aa2457d-8e76-11e3-5e81-002590a28eca` |
| 87438 | `5e46388c-30ce-11ec-0a80-07f20005a3f4` | 87440 | `5e74d305-7244-11ee-0a80-0dd10017b294` |
| 87442 | `7bc6a0d6-1419-11ef-0a80-01bb00142540` | 87444 | `8b5a2455-4b17-11ed-0a80-01a5000b0b4c` |
| 87446 | `8db8e733-56b3-11ee-0a80-0751000d5c16` | 87448 | `92165f84-ebd3-11e3-e38a-002590a28eca` |
| 87450 | `95c5d680-31a8-11ec-0a80-07f800089ee0` | 87452 | `9ba4d740-30d5-11ec-0a80-050d0005f97f` |
| 87454 | `9ef09c73-cb92-11e3-b94f-002590a28eca` | 87456 | `a676dd33-332c-11ed-0a80-0ce600045d6c` |
| 87458 | `b2ee2780-9610-11eb-0a80-047b003038f0` | 87460 | `b3092814-3b19-11ec-0a80-07760020ae86` |
| 87462 | `b6b1c19f-2d1c-11ec-0a80-039500004784` | 87464 | `c176e845-317a-11ec-0a80-0d3a000523db` |
| 87466 | `cbf43d9e-9ceb-11ef-0a80-0374001dfff3` | 87468 | `cf0ab1df-22bd-11ed-0a80-014200037ec1` |
| 87470 | `d8496915-d111-11ec-0a80-00f400b0d1a6` | 87472 | `e7e7300a-8e76-11e3-d8ac-002590a28eca` |
| 87474 | `ea915cb0-9610-11eb-0a80-06f300319518` | 87476 | `ef5999e6-7925-11ec-0a80-0855000767c9` |
| 87478 | `f11836ec-9610-11eb-0a80-06f300319643` | 87480 | `f698273f-8e76-11e3-88a5-002590a28eca` |
| 146582 | `4fe3995a-2830-11f1-0a80-0549003d153a` | 146584 | `7df37bb6-252b-11f1-0a80-1070003a882d` |
| 146592 | `2cdeb7b6-3991-11f1-0a80-1312001a35af` | 146594 | `c450c8d9-3990-11f1-0a80-1312001a267e` |
| 564816 | `c6bbab1a-3ef6-11f1-0a80-13210013b832` | 564818 | `b4f6ffd8-97f5-11f1-0a80-01f9001bbad4` |

| B24 payment ID | MySklad payment value ID |
| ---: | --- |
| 87494 | `b28a8751-d985-11eb-0a80-0dc40004c745` |
| 87506 | `522ea159-dc5f-11f0-0a80-190b0001bdcb` |
| 87508 | `b2ff1d3a-d985-11eb-0a80-096a0004d08c` |
| 87510 | `b2d5de19-d985-11eb-0a80-05bb0004d798` |
| 87512 | `b2b17176-d985-11eb-0a80-096a0004d07f` |

MySklad's API describes custom-entity references in metadata and supports entity updates through its JSON API ([JSON API 1.2](https://dev.moysklad.ru/doc/api/remap/1.2/)). The schema and current dictionary contents make a typed reference implementation plausible, but no production write was authorized or tested. Treat writability here as documented API shape only, not a successful update.

## Gate outcome

This evidence supports a scoped static schema/identifier map for the two named dictionaries and the currently observed UOM and price-type catalogs. It does **not** satisfy a claim that every field in #26 has a verified mapping or is successfully writable. In particular:

- UOM: 7 exact-code candidates; 5 unmatched; owner confirmation/manual mapping is still required, and document-row `pack` mapping is open.
- Prices: catalogue IDs are known but actual configured B24↔MySklad price-type pairs are not evidenced; require a readable current settings source or owner-confirmed ID pairs.
- Writes: documentation supports reference-field update shapes, but account permissions and production roundtrip remain unverified and intentionally untested.
- Dictionary values: ID coverage is complete for the current 46/46 and 5/5 lists; archival/active state, semantic labels, and write success are not established.

Therefore do not mark #26 fully complete or close it based on this check alone. A truthful completion claim is limited to the live schema/catalogue inventory and current ID coverage above. Preserve accepted Q26.58–61 as product decisions, not evidence of implementation or runtime success. No downstream #10/#15/#16 work is part of this artifact.
