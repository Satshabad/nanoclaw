---
name: add-fredmeyer
description: Add Fred Meyer / Kroger grocery shopping to NanoClaw. Search products, add to cart via API, and check out via browser automation.
---

# Add Fred Meyer Shopping

This skill adds a Kroger MCP server that lets the container agent search products, add items to your real Kroger/Fred Meyer cart via API, and complete checkout using agent-browser. Fast for search and cart, browser only for checkout (Kroger API limitation).

Tools added:
- `kroger_search_products` — search by keyword, get prices and availability
- `kroger_get_product` — detailed product info by ID
- `kroger_add_to_cart` — add items to your real Kroger cart
- `kroger_search_locations` — find Fred Meyer / Kroger stores by zip
- `kroger_set_store` / `kroger_get_store` — preferred store for pricing
- `kroger_authorize` — one-time OAuth login
- `kroger_auth_status` — check auth state

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/kroger-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

The user needs a free Kroger developer account:

> To use this skill, you need API credentials from Kroger:
>
> 1. Go to https://developer.kroger.com/ and create a free account
> 2. Create a new application (any name, e.g. "NanoClaw Shopping")
> 3. Set the redirect URI to `http://localhost:8888/callback`
> 4. Copy your **Client ID** and **Client Secret**
>
> Do you have these ready?

Wait for the user to confirm they have credentials before proceeding.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If neither `upstream` nor `origin` point to `Satshabad/nanoclaw` or `qwibitai/nanoclaw`, add the appropriate remote:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch origin skill/add-fredmeyer
git merge origin/skill/add-fredmeyer
```

This merges in:
- `container/agent-runner/src/kroger-mcp-stdio.ts` (Kroger MCP server)
- `container/skills/fredmeyer/SKILL.md` (container skill for shopping flow)
- Kroger MCP config in `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- Kroger env var forwarding in `src/container-runner.ts`
- `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` in `src/config.ts` and `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/kroger-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Copy container skill to per-group sessions

```bash
for dir in data/sessions/*/.claude/skills; do
  [ -d "$dir" ] && cp -r container/skills/fredmeyer "$dir/"
done
```

### Validate code changes

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Set Kroger API credentials

Ask the user for their Client ID and Client Secret, then add to `.env`:

```bash
KROGER_CLIENT_ID=<their-client-id>
KROGER_CLIENT_SECRET=<their-client-secret>
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test product search

Tell the user:

> Send a message like: "search for organic milk on Fred Meyer"
>
> The agent should use `kroger_search_locations` to find a nearby store (it will ask your zip code), set it as preferred, then search for products.

### Test add to cart

Tell the user:

> Send: "add 2% milk to my Fred Meyer cart"
>
> The agent will need to authorize your Kroger account first (one-time). It will open a Kroger login page in the browser — log in with your Fred Meyer account. After that, it can add items to your cart.

### Test checkout

Tell the user:

> Send: "check out my Fred Meyer cart"
>
> The agent will open fredmeyer.com in the browser, navigate to your cart, show you the summary, and ask for confirmation before placing the order.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i kroger
```

Look for `[KROGER]` log lines from the MCP server.

## Troubleshooting

### Agent says "KROGER_CLIENT_ID not set"

1. Check `.env` has `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET`
2. Restart the service after adding them

### "No valid user token. Run kroger_authorize first"

The user hasn't authorized their Kroger account yet. The agent should call `kroger_authorize` and walk through the browser login.

### Token refresh fails

The refresh token may have expired (Kroger tokens last ~6 months). Delete `/workspace/group/.kroger-auth.json` in the group directory and re-authorize.

### Products show no prices

Set a preferred store first. Without a store, the API returns products but no pricing or availability.

### Checkout fails (element not found)

Fred Meyer's website DOM may have changed. The container skill uses semantic locators but may need updating. Check the agent-browser snapshot output for what's on the page.

### Agent doesn't use Kroger tools

Try being explicit: "use the kroger_search_products tool to find sourdough bread"
