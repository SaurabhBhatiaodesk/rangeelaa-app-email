# Thursday Cycle Fixes - Dev Validation and Live Rollout Notes

## Context

Client feedback was based on the live Rangeelaa store, especially order `#11682`.
Fixes were implemented and validated on the dev/test store:

- Store: `test-email-store-ojktyeff.myshopify.com`
- App: Rangeela Shipping Manager

Do not tell the client the live store is fully fixed until the updated app is deployed/released to live and the live smoke test is completed.

## Client Issues Reviewed

1. Stored draft ID did not resolve.
2. Script wrote `rangeela.thursday_draft_id`, while Sidekick reads `sidekick.draft_order_id`.
3. Draft note was missing `Combined orders: #...`.
4. Shipping item count needed to stop relying on retired product tags (`india`, `canada`, `dispatch`) and instead count physical items that require shipping while excluding orders tagged `india-direct`.

## Fixes Implemented

### 1. Draft ID Capture

The script now verifies the draft returned by `draftOrderCreate` before storing its ID.

Expected live behavior:

- The metafield draft ID should open/resolves in Shopify Drafts.
- It should not store a stale/non-existent draft ID.

### 2. Sidekick Metafields

The script writes the draft ID to Sidekick-compatible metafields:

- `sidekick.draft_order_id`
- `sidekick.thursday_draft_id`

The legacy Thursday draft field is still kept for backward compatibility:

- `rangeela.thursday_draft_id`

Expected live behavior:

- Sidekick can read/link the Thursday invoice using `sidekick.draft_order_id`.

### 3. Combined Orders Note

The draft order `Notes` field now receives:

```text
Combined orders: #1234, #1235
```

Expected live behavior:

- Single-order draft: `Combined orders: #1234`
- Combined draft: `Combined orders: #1234, #1235`

### 4. Shipping Count and Dynamic Rate

The Thursday cycle now counts physical items that require shipping and excludes orders tagged `india-direct`.

Shipping amount is no longer hardcoded in code or `.env`. It is resolved dynamically from Shopify Shipping profiles using:

- destination country/province
- physical item count based on items that require shipping
- Shopify delivery profile method conditions

Safety behavior:

- A `$0.00` shipping draft is blocked.
- If Shopify only returns zero-dollar rates, the script throws an error instead of creating a zero-dollar invoice.

## Dev Store Proof Collected

Dev preview showed:

- Orders: `#1030`, `#1028`
- Items: `2`
- Shipping: `22.00 CAD`

This confirms the dynamic shipping resolver is reading Shopify Shipping profile rates instead of using the old hardcoded table.

Earlier dev tests also confirmed:

- Draft invoice created.
- `sidekick.draft_order_id` filled.
- `sidekick.thursday_draft_id` filled.
- Draft Notes show `Combined orders: #...`.
- Combined customer orders are grouped into one draft.

## Live Deployment Requirements

Before client confirmation, do this on live:

1. Deploy/release the updated app to the live Rangeelaa store.
2. Ensure the app has `read_shipping` scope approved on live.
3. Confirm live Shopify Shipping profiles have the expected paid rates.
4. Run one controlled live smoke test.

## Live Smoke Test Checklist

Use a safe test customer/order set.

Verify these proof points:

1. Draft invoice is created.
2. The saved draft ID opens the actual Shopify Draft page.
3. `sidekick.draft_order_id` is filled on the source order.
4. Draft Notes show `Combined orders: #...`.
5. Shipping amount is a paid dynamic Shopify profile rate, not `$0.00`.
6. `india-direct` orders do not appear in the Thursday preview.
7. Normal physical items that require shipping are counted for the shipping rate.

## Suggested Client Reply After Live Deployment

```text
Hi Satya,

Thanks again for the detailed Sidekick testing notes. We reviewed the Thursday cycle against the live feedback and implemented the fixes in the app.

The updates cover:
- verifying and storing the actual created draft order ID
- writing the draft ID to Sidekick's `sidekick.draft_order_id` metafield
- adding `Combined orders: #...` to the draft Notes field
- updating the shipping count logic to use physical items that require shipping and exclude `india-direct` orders
- resolving the shipping amount dynamically from Shopify Shipping profiles

We validated the updated behavior on the dev/test store first. After deploying to live, we will run a controlled smoke test and confirm the live proof points: draft link resolves, Sidekick metafield is filled, combined-order note is present, and shipping is calculated from Shopify profiles.

Thanks!
```
