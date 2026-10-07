# Issue #10 dispatch brief: approved reference maps

Status: implementation inputs frozen by owner approval Q26.62–65 (2026-10-07). This brief defines configuration data for #10; it does not implement the UI, persist runtime settings, or claim external API writes were verified.

## Source of truth

- Exact UOM and catalog price-type pairs: [`t26-field-mapping.md`](t26-field-mapping.md#утверждённые-пары-каталога-q2662–65-2026-10-07).
- Read-only account catalog/typed-reference evidence: [PR #43](https://github.com/Makskaii/bitrix-moysklad-sync/pull/43).
- Product scope and behaviors Q26.49/.53/.54/.58–.61: [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42).
- Both PRs are separate from this dispatch brief; owner-approved pairs here are configuration inputs, not proof of runtime persistence or production round-trip.

## UOM configuration seed

Persist the following nine explicitly approved pairs. The three listed unmatched Bitrix24 measures must be visible as unconfigured; do not infer substitutes, create units, or derive `row.pack` / conversion factors.

| B24 measure ID | B24 code | MS UOM code | MS UOM UUID | State |
| ---: | ---: | ---: | --- | --- |
| 3 | 112 | 112 | `250d5161-f815-4524-85b6-fd6afebc1ad6` | configured seed |
| 5 | 163 | 163 | `8e2eb543-99e9-4077-bc31-93b1359de9c4` | configured seed |
| 7 | 166 | 166 | `2ec1170c-3f69-4409-87bb-c68e0011b275` | configured seed |
| 9 | 796 | 796 | `19f1edc0-fc42-4001-94cb-c9ec9c62ec10` | configured seed |
| 10 | 778 | 778 | `605a1781-b652-11e3-feb0-002590a28eca` | configured seed |
| 12 | 839 | 839 | `f5611dc2-1acd-11e7-7a31-d0fd001085d2` | configured seed |
| 22 | 736 | 736 | `647775b2-3b57-409b-910e-8b17940b279f` | configured seed |
| 1 | 6 | 006 | `dfe54549-ec98-4fd7-ad1b-215162a9199a` | configured seed |
| 18 | 55 | 055 | `7cfd013f-33d0-448a-a4aa-1c8bb2e05417` | configured seed |
| 14 | 1720010507 | — | — | intentionally unmapped |
| 16 | 1720532980 | — | — | intentionally unmapped |
| 20 | 1762891510 | — | — | intentionally unmapped |

The Q26.53 readiness gate applies only when the affected product/document row actually requires an unmapped UOM: hold that affected order, report the missing mapping, and route it for review. Other orders continue. Do not block the catalog UI or all orders globally because an unused measure is unmapped.

## Catalog price-type configuration seed

Persist only these seven explicit pairs. These are catalog-card price types, separate from document-row prices.

| B24 price type ID | B24 code | MS price type UUID | Label | State |
| ---: | --- | --- | --- | --- |
| 2 | `BASE` | `02b04e92-d515-11e2-e753-7054d21a8d1e` | Розница | configured seed |
| 4 | `opt` | `f2ead8ce-de34-11e5-7a69-8f550015ae90` | Опт | configured seed |
| 6 | `vip` | `78a9ffa3-0712-11e6-7a69-8f5500119e54` | VIP | configured seed |
| 8 | `dil` | `1b4623d2-2857-11eb-0a80-044e00021305` | Дилер | configured seed |
| 12 | `ozon` | `5c8a8396-b503-11ee-0a80-0d3e00059f64` | Ozon | configured seed |
| 14 | `mdo` | `61161db9-7f0b-11ee-0a80-0b350015853e` | М. До скидки | configured seed |
| 16 | `rrc` | `138eeb4d-82c0-11ed-0a80-0ffb0028e290` | РРЦ | configured seed |

Do not exchange B24 catalog price types `10 mark`, `18 ali`, `20 MIN`, and `22 ZAKUP` until an explicit future configuration. Preserve their current values. Preserve all MySklad price types not included above: ВБ (`181fccd0-7736-11ed-0a80-080900027768`), ВБ ВентМаркет (`47e91e27-ad13-11f1-0a80-144700177791`), Ozon ВентМаркет (`7c45db73-7b9e-11f1-0a80-182500121f3e`), ЯМ (`e4a858d7-e190-11f0-0a80-1059000f9c17`), and Минимальная цена Ozon (`a88d2683-3e1f-11f1-0a80-185000073e51`). The approved seven pairs are bidirectional; MySklad wins conflicts (Q26.54). An absent optional catalog price does not block exchange (Q26.21).

## Existing service and payment reference fields

The #10 value-mapping UI also needs to handle the existing typed reference pairs below. These are already selected field references; the live ID-only GET check found current list coverage of 46/46 service values and 5/5 payment values by exact UUID `CODE` ↔ MySklad value ID. It is not label equivalence, write permission, or a round-trip result. The detailed sanitized ID crosswalk is in PR #43.

| Meaning | B24 field/type/list | MySklad attribute/type/directory |
| --- | --- | --- |
| Service | `UF_CRM_1766085949`, single `iblock_element`, list ID `42` | `0ad997c8-8e75-11e3-1ec9-002590a28eca`, optional `customentity`, directory `f0177126-8e74-11e3-b761-002590a28eca` |
| Payment method | `UF_CRM_1766072752`, single `iblock_element`, list ID `44` | `f214f966-dc1a-11f0-0a80-0ef700278459`, optional `customentity`, directory `0ecffb86-d8a3-11eb-0a80-0dbc000256e5` |

Service is an optional order reference only (no product row or text copy, Q26.60). Payment method is optional; clear propagates and an unmapped value skips/logs only that field. Do not create payment documents or write `payedSum` (Q26.61).

## #10 implementation boundary

- Present both directories in the mapping section, show mapping state and IDs/labels, and let an admin assign or reassign pairs. Persist the configured map and record changes for diagnosis.
- Seed only the nine UOM and seven catalog price-type pairs above. Keep the three unmapped measures and excluded/unpaired price types explicitly outside the active map while preserving their values.
- Make repeated assignment idempotent and validate each selected ID still exists. Never silently remap an existing pair because a label or order changed.
- Keep service/payment typed value references separate from product UOM and catalog price types. An unmapped optional service/payment value follows Q26.60/.61; the catalog mapping UI remains usable with unmapped references.
- Do not implement product/order synchronization, row matching, `row.pack` conversion, external writes, or production round-trip proof in #10. The row-ID and per-order UOM readiness evidence remains a consuming feature gate for #16, not a prerequisite for building the generic reference-mapping UI.
