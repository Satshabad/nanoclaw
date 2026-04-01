---
name: fredmeyer
description: Shop on Fred Meyer / Kroger. Use kroger_* MCP tools for product search and cart, agent-browser for checkout. Activate when user wants to buy groceries, shop at Fred Meyer or Kroger, or manage their grocery cart.
allowed-tools: Bash(agent-browser:*), mcp__kroger__*
---

# Fred Meyer Shopping

You can search products, add items to the user's real Kroger/Fred Meyer cart via API, and complete checkout using agent-browser.

## First-Time Setup

Before shopping, the user needs:
1. A preferred store set — use `mcp__kroger__kroger_search_locations` with their zip code, then `mcp__kroger__kroger_set_store`
2. Kroger account authorization — use `mcp__kroger__kroger_authorize`, then complete the login in agent-browser

Check status with `mcp__kroger__kroger_auth_status`.

## Shopping Flow

### 1. Search Products (API — fast)

```
mcp__kroger__kroger_search_products(term: "organic whole milk", limit: 5)
```

Pick the best match based on the user's request. If ambiguous, show options and ask.

### 2. Add to Cart (API — fast)

```
mcp__kroger__kroger_add_to_cart(items: [{upc: "0001111042545", quantity: 1}])
```

You can add multiple items at once. Always confirm what you're adding:
> "Adding: Kroger Organic Whole Milk (1 gal) x1 — $5.99"

### 3. Checkout (Browser)

Checkout MUST be done via agent-browser since the Kroger API doesn't support it.

#### Load saved browser state (if exists)

```bash
agent-browser state load /workspace/group/.fredmeyer-browser-state.json
```

If the file doesn't exist, skip this step — you'll log in fresh.

#### Navigate to cart

```bash
agent-browser open https://www.fredmeyer.com/cart
```

#### Handle login if needed

If redirected to a login page:
1. `agent-browser snapshot -i` to find the email/password fields
2. Ask the user for their Fred Meyer credentials via `mcp__nanoclaw__send_message`
3. Fill in credentials and submit
4. `agent-browser wait --url "**/cart"` or similar
5. Save state: `agent-browser state save /workspace/group/.fredmeyer-browser-state.json`

#### Review cart

1. `agent-browser snapshot -i` to see cart contents
2. Send a summary to the user via `mcp__nanoclaw__send_message`:
   > "Your Fred Meyer cart has:
   > - Organic Whole Milk x1 — $5.99
   > - Sourdough Bread x1 — $4.49
   > Total: ~$10.48
   >
   > Ready to check out? (pickup or delivery?)"
3. **WAIT for user confirmation before proceeding.** Never place an order without explicit approval.

#### Complete checkout

After the user confirms:

1. Click the checkout button
2. Select fulfillment method (pickup at preferred store, or delivery)
3. Choose a time slot — pick the earliest available unless the user specifies
4. Payment — use the saved payment method on the account. **Never enter credit card numbers or payment data.**
5. Review order, then click "Place Order"
6. Screenshot the confirmation: `agent-browser screenshot /workspace/group/last-order-confirmation.png`
7. Send confirmation to user via `mcp__nanoclaw__send_message`:
   > "Order placed! Pickup at [store] on [date/time]. Order #[number]. Screenshot saved."

#### Save browser state after checkout

```bash
agent-browser state save /workspace/group/.fredmeyer-browser-state.json
```

## Important Rules

- **Always confirm before placing an order.** Send the cart summary and wait for "yes" / "go ahead" / explicit approval.
- **Never handle raw payment data.** Only use payment methods already saved on the Kroger account.
- **If login is needed**, ask the user for credentials via send_message — don't guess or reuse old credentials.
- **If checkout fails** (DOM changed, element not found), snapshot the page, tell the user what happened, and offer to retry or let them finish manually at fredmeyer.com/cart.
- **Re-authenticate gracefully.** If you detect a login redirect during checkout, re-login and save state.

## Kroger API Limitations

- The API can ADD items to cart but CANNOT view the cart, remove items, or checkout
- Cart viewing and checkout must go through agent-browser on fredmeyer.com
- Product search without a preferred store may not show prices or availability
- API rate limits: 1,600–10,000 calls/day per endpoint (more than enough for personal use)
