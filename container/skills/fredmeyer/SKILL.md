---
name: fredmeyer
description: Shop on Fred Meyer / Kroger. Use kroger_* MCP tools for product search, cart, and checkout. Activate when user wants to buy groceries, shop at Fred Meyer or Kroger, or manage their grocery cart.
allowed-tools: Bash(agent-browser:*), mcp__kroger__*
---

# Fred Meyer Shopping

You can search products, add items to the user's real Kroger/Fred Meyer cart via API, review the cart, and complete checkout using Stagehand-powered browser automation.

## First-Time Setup

Before shopping, the user needs:
1. A preferred store set — use `mcp__kroger__kroger_search_locations` with their zip code, then `mcp__kroger__kroger_set_store`
2. Kroger account authorization — use `mcp__kroger__kroger_authorize`, then complete the login in agent-browser
3. Browser sign-in — after OAuth, use agent-browser to sign in at fredmeyer.com so cookies are saved for cart/checkout

Check status with `mcp__kroger__kroger_auth_status`.

## Shopping Flow

### 1. Search Products (API — instant)

```
mcp__kroger__kroger_search_products(term: "organic whole milk", limit: 5)
```

Pick the best match based on the user's request. If ambiguous, show options and ask.

### 2. Add to Cart (API — instant)

```
mcp__kroger__kroger_add_to_cart(items: [{upc: "0001111042545", quantity: 1}])
```

You can add multiple items at once. Always confirm what you're adding:
> "Adding: Kroger Organic Whole Milk (1 gal) x1 — $5.99"

### 3. Review Cart & Checkout

#### View cart

```
mcp__kroger__kroger_view_cart()
```

This uses Stagehand (AI browser automation) to navigate fredmeyer.com/cart and extract item details. Returns structured data: item names, quantities, prices, subtotal, estimated total.

Send a summary to the user via `mcp__nanoclaw__send_message`:
> "Your Fred Meyer cart has:
> - Organic Whole Milk x1 — $5.99
> - Sourdough Bread x1 — $4.49
> Estimated Total: $10.48
>
> Ready to check out? (pickup or delivery?)"

**WAIT for user confirmation before proceeding.** Never place an order without explicit approval.

#### Checkout

After the user confirms:

```
mcp__kroger__kroger_checkout(fulfillment: "pickup")
```

This automates the full checkout: clicks checkout, selects fulfillment, picks earliest time slot, uses saved payment method, places order, and screenshots the confirmation.

Send confirmation to user via `mcp__nanoclaw__send_message`:
> "Order placed! Order #[number], pickup on [date/time]. Total: [amount]. Screenshot saved."

### If kroger_view_cart or kroger_checkout fails

**`login_required` error:**
1. Use agent-browser to sign in at fredmeyer.com
2. Load state: `agent-browser state load /workspace/group/.fredmeyer-browser-state.json`
3. Open: `agent-browser open https://www.fredmeyer.com`
4. Complete sign-in flow
5. Save state: `agent-browser state save /workspace/group/.fredmeyer-browser-state.json`
6. Retry the failed kroger_view_cart or kroger_checkout call

**`unknown` error — fall back to agent-browser:**
1. `agent-browser state load /workspace/group/.fredmeyer-browser-state.json`
2. `agent-browser open https://www.fredmeyer.com/cart`
3. Use `agent-browser snapshot -i` to see the page
4. Complete checkout manually using snapshot + click
5. Screenshot: `agent-browser screenshot /workspace/group/last-order-confirmation.png`
6. Save state: `agent-browser state save /workspace/group/.fredmeyer-browser-state.json`

## Important Rules

- **Always confirm before placing an order.** Send the cart summary and wait for "yes" / "go ahead" / explicit approval.
- **Never handle raw payment data.** Only use payment methods already saved on the Kroger account.
- **If login is needed**, ask the user for credentials via send_message — don't guess or reuse old credentials.
- **If checkout fails**, tell the user what happened and offer to retry or let them finish manually at fredmeyer.com/cart.
- **Re-authenticate gracefully.** If you get a `login_required` error, help the user sign in via agent-browser, then retry.

## Kroger API Limitations

- The API can ADD items to cart but CANNOT view the cart, remove items, or checkout
- Cart viewing and checkout use Stagehand browser automation on fredmeyer.com
- Product search without a preferred store may not show prices or availability
- API rate limits: 1,600–10,000 calls/day per endpoint (more than enough for personal use)

## Performance Notes

- First use of kroger_view_cart or kroger_checkout is slower (~15-60 seconds) as Stagehand uses AI to learn the page structure
- Subsequent runs are fast (<5 seconds) because Stagehand caches the learned selectors
- If Fred Meyer changes their website, Stagehand self-heals by re-learning the new layout automatically
