# Historical documentation reconciliation for PRs #44 and #62

Captured 2026-10-20 from read-only audit refs `origin/pr-audit-44` at `60a764a24a0ecdc1545bee24998aa0c735893312` and `origin/pr-audit-62` at `7057327f0ab4b778392158481b447c288692032f`. This is a historical evidence archive, not current implementation guidance. Current requirements and later explicit owner decisions take precedence.

## PR #44: unique approved reference-map evidence

PR #44's `research/issue-10-mapping-ui-brief.md` records owner-approved configuration inputs under Q26.62–65 and the 2026-10-08 direction clarification. Preserve these inputs in `research/t26-field-mapping.md`; they do not prove runtime persistence or external writes.

Approved UOM seed (B24 measure ID/code → MySklad code/UUID):

| B24 ID | B24 code | MS code | MS UUID |
| ---: | ---: | ---: | --- |
| 3 | 112 | 112 | `250d5161-f815-4524-85b6-fd6afebc1ad6` |
| 5 | 163 | 163 | `8e2eb543-99e9-4077-bc31-93b1359de9c4` |
| 7 | 166 | 166 | `2ec1170c-3f69-4409-87bb-c68e0011b275` |
| 9 | 796 | 796 | `19f1edc0-fc42-4001-94cb-c9ec9c62ec10` |
| 10 | 778 | 778 | `605a1781-b652-11e3-feb0-002590a28eca` |
| 12 | 839 | 839 | `f5611dc2-1acd-11e7-7a31-d0fd001085d2` |
| 22 | 736 | 736 | `647775b2-3b57-409b-910e-8b17940b279f` |
| 1 | 6 | 006 | `dfe54549-ec98-4fd7-ad1b-215162a9199a` |
| 18 | 55 | 055 | `7cfd013f-33d0-448a-a4aa-1c8bb2e05417` |

Intentionally unmapped B24 measure IDs/codes: 14/1720010507, 16/1720532980, 20/1762891510. Do not infer substitutes or pack conversions. The readiness gate applies only to an order row that needs an unmapped measure.

Approved catalog price-type seed (B24 ID/code → MS UUID):

| B24 ID | B24 code | MS UUID | Label |
| ---: | --- | --- | --- |
| 2 | `BASE` | `02b04e92-d515-11e2-e753-7054d21a8d1e` | Розница |
| 4 | `opt` | `f2ead8ce-de34-11e5-7a69-8f550015ae90` | Опт |
| 6 | `vip` | `78a9ffa3-0712-11e6-7a69-8f5500119e54` | VIP |
| 8 | `dil` | `1b4623d2-2857-11eb-0a80-044e00021305` | Дилер |
| 12 | `ozon` | `5c8a8396-b503-11ee-0a80-0d3e00059f64` | Ozon |
| 14 | `mdo` | `61161db9-7f0b-11ee-0a80-0b350015853e` | М. До скидки |
| 16 | `rrc` | `138eeb4d-82c0-11ed-0a80-0ffb0028e290` | РРЦ |

Excluded B24 catalog price types are IDs 10 (`mark`), 18 (`ali`), 20 (`MIN`) and 22 (`ZAKUP`); preserve their values. The owner clarified catalog-card prices are MySklad → Bitrix24 only. Document-row prices are separate. These distinctions remain relevant, but this seed is not proof the runtime is configured.

PR #44 also holds a dispatch brief for service/payment typed-reference mappings and reported limited ID-only list coverage (46/46 service and 5/5 payment values), explicitly not label equivalence, writability, or round-trip proof. Preserve as historical evidence; current implementation status is not inferred from it.

The same source commit includes an Oct 8 MS → B24 catalog-correction pass in `research/t26-field-mapping.md`, absent from the Oct 6 baseline in the integration branch. Its approved decisions were folded into the current research map; the dated source file and its remaining TBD must remain distinguishable from current runtime evidence.

## PR #62: unique historical context and planning archive

PR #62 adds a domain context glossary, the 2026-10-09 backlog snapshots (parent specification #1, superseded open issue drafts, and feature ticket drafts), plus the 2026-10-12 open-decision register with D-01–D-14. These are planning/history records, not a second active specification. Their dated source copies are represented here because several choices were later superseded or narrowed in `requirements.md` and the #79 implementation brief.

Decision reconciliation:

| Historical content | Current treatment |
| --- | --- |
| Glossary: confirmed document pair, primary client map, runtime client search, unmatched client and historical document | Terminology useful as context; do not restore the full old `CONTEXT.md` as authoritative without checking current requirements. |
| D-01–D-14 and October 9 issue-body snapshots | Preserve as historical records. Later issue scope/requirements override conflicts. |
| General bidirectional product/card-price concepts in early issue drafts | Superseded for #79 catalog correction: B24 product updates restore configured writable fields from paired MS and never authorize a B24 → MS catalog write. Catalog price direction is MS → B24. |
| Broad initial historical deal/order matching in earlier planning | Narrowed by current requirements: exact approved UUID rule only; historical docs remain excluded from exchange. |
| Invoice exchange as a first-launch requirement in old planning | Superseded by Q26.45 and current brief: invoice31 work is later and not a first-launch readiness blocker. |
| Old source-era product/client matching heuristics, including usage ranking | Replaced by current explicit #79 decisions: saved pairs/aliases first; exact title and comparable configured price for unpaired catalog; earliest reliable MS creation date, deterministic native-ID tie-break, with reason. Runtime client email is unique normalized exact email under the current scope; no bulk UUID-map email matching. |
| Runtime event/settings transition and nightly recovery details | Use current #79 requirements and latest issue-79 runtime/recovery docs; old D entries are not additional requirements where they differ. |

PR #62 remains useful as provenance for original parent/backlog/decision context, but current owner decisions and the current #79 brief are the source of truth. Do not restore or publish archived old drafts as active issue specifications.
