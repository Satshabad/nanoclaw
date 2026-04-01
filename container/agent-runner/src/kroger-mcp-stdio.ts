/**
 * Kroger MCP Server for NanoClaw
 * Provides product search, cart management, and store location tools
 * via the Kroger Public API. Used by the fredmeyer container skill.
 *
 * Auth: Client credentials for public endpoints, OAuth2 authorization
 * code grant for cart operations. Tokens persisted to workspace.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

const KROGER_BASE_URL = 'https://api.kroger.com/v1';
const AUTH_FILE = '/workspace/group/.kroger-auth.json';
const CONFIG_FILE = '/workspace/group/.kroger-config.json';
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const CLIENT_ID = process.env.KROGER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KROGER_CLIENT_SECRET || '';

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
}

interface AuthState {
  client_token?: TokenData;
  user_token?: TokenData;
}

interface KrogerConfig {
  preferred_location_id?: string;
  preferred_location_name?: string;
  zip_code?: string;
}

function log(message: string): void {
  console.error(`[KROGER] ${message}`);
}

// --- Token Management ---

function loadAuth(): AuthState {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    }
  } catch (err) {
    log(`Failed to load auth: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {};
}

function saveAuth(state: AuthState): void {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  const tmp = `${AUTH_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, AUTH_FILE);
}

function loadConfig(): KrogerConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function saveConfig(config: KrogerConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

function isTokenValid(token?: TokenData): boolean {
  if (!token) return false;
  return Date.now() < token.expires_at - 60_000; // 1 min buffer
}

async function getClientToken(): Promise<string> {
  const auth = loadAuth();
  if (isTokenValid(auth.client_token)) {
    return auth.client_token!.access_token;
  }

  log('Requesting new client credentials token');
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`${KROGER_BASE_URL}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: 'grant_type=client_credentials&scope=product.compact',
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Client token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  auth.client_token = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope || 'product.compact',
  };
  saveAuth(auth);
  return auth.client_token.access_token;
}

async function getUserToken(): Promise<string> {
  const auth = loadAuth();

  if (isTokenValid(auth.user_token)) {
    return auth.user_token!.access_token;
  }

  // Try refresh
  if (auth.user_token?.refresh_token) {
    log('Refreshing user token');
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const resp = await fetch(`${KROGER_BASE_URL}/connect/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.user_token.refresh_token)}`,
    });

    if (resp.ok) {
      const data = await resp.json();
      auth.user_token = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || auth.user_token.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        scope: data.scope || auth.user_token.scope,
      };
      saveAuth(auth);
      return auth.user_token.access_token;
    }
    log(`Refresh failed (${resp.status}), user must re-authorize`);
  }

  throw new Error('No valid user token. Run kroger_authorize first to authenticate with your Kroger account.');
}

async function krogerFetch(
  endpoint: string,
  options: { method?: string; body?: string; requireUser?: boolean } = {},
): Promise<unknown> {
  const token = options.requireUser
    ? await getUserToken()
    : await getClientToken();

  const resp = await fetch(`${KROGER_BASE_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: options.body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kroger API error (${resp.status} ${endpoint}): ${text}`);
  }

  // Some endpoints (like PUT cart) return 204 with no body
  const contentType = resp.headers.get('content-type');
  if (resp.status === 204 || !contentType?.includes('application/json')) {
    return { success: true };
  }

  return resp.json();
}

// --- MCP Server ---

const server = new McpServer({
  name: 'kroger',
  version: '1.0.0',
});

server.tool(
  'kroger_search_products',
  `Search for products on Kroger/Fred Meyer. Returns product name, UPC, price, size, and availability. Set a preferred store first for accurate pricing/availability.`,
  {
    term: z.string().describe('Search term (e.g., "organic milk", "sourdough bread")'),
    limit: z.number().min(1).max(50).default(10).describe('Max results (default 10)'),
  },
  async (args) => {
    const config = loadConfig();
    const locationId = config.preferred_location_id;

    let endpoint = `/products?filter.term=${encodeURIComponent(args.term)}&filter.limit=${args.limit}`;
    if (locationId) {
      endpoint += `&filter.locationId=${locationId}`;
    }

    const data = await krogerFetch(endpoint) as { data?: unknown[] };
    const products = (data.data || []).map((p: any) => {
      const item = p.items?.[0];
      const price = item?.price;
      return {
        productId: p.productId,
        upc: p.upc,
        description: p.description,
        brand: p.brand,
        size: item?.size,
        price: price?.regular,
        promoPrice: price?.promo,
        inStock: item?.fulfillment?.inStore || item?.fulfillment?.curbside,
        aisle: item?.aisle?.description,
        image: p.images?.find((i: any) => i.perspective === 'front')?.sizes?.find((s: any) => s.size === 'medium')?.url,
      };
    });

    const text = products.length === 0
      ? `No products found for "${args.term}"${locationId ? '' : '. Try setting a preferred store first with kroger_set_store.'}`
      : products.map((p: any, i: number) =>
          `${i + 1}. ${p.description} (${p.brand})\n   UPC: ${p.upc} | Size: ${p.size || 'N/A'} | Price: $${p.price ?? 'N/A'}${p.promoPrice ? ` (sale: $${p.promoPrice})` : ''}\n   In stock: ${p.inStock ? 'Yes' : 'No/Unknown'}${p.aisle ? ` | Aisle: ${p.aisle}` : ''}`
        ).join('\n\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'kroger_get_product',
  'Get detailed info for a specific product by ID.',
  {
    productId: z.string().describe('The Kroger product ID'),
  },
  async (args) => {
    const config = loadConfig();
    let endpoint = `/products/${args.productId}`;
    if (config.preferred_location_id) {
      endpoint += `?filter.locationId=${config.preferred_location_id}`;
    }

    const data = await krogerFetch(endpoint) as { data?: any };
    const p = data.data;
    if (!p) {
      return { content: [{ type: 'text' as const, text: 'Product not found.' }] };
    }

    const item = p.items?.[0];
    const text = [
      `Product: ${p.description} (${p.brand})`,
      `UPC: ${p.upc}`,
      `Size: ${item?.size || 'N/A'}`,
      `Price: $${item?.price?.regular ?? 'N/A'}${item?.price?.promo ? ` (sale: $${item.price.promo})` : ''}`,
      `In-store: ${item?.fulfillment?.inStore ? 'Yes' : 'No'}`,
      `Curbside: ${item?.fulfillment?.curbside ? 'Yes' : 'No'}`,
      `Delivery: ${item?.fulfillment?.delivery ? 'Yes' : 'No'}`,
      item?.aisle?.description ? `Aisle: ${item.aisle.description}` : null,
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'kroger_add_to_cart',
  `Add items to your Kroger/Fred Meyer cart. Requires user authorization (run kroger_authorize first if not done). Items are added to your REAL Kroger cart — you can then check out via the Fred Meyer website.`,
  {
    items: z.array(z.object({
      upc: z.string().describe('Product UPC code (from search results)'),
      quantity: z.number().min(1).default(1).describe('Quantity to add'),
    })).min(1).describe('Items to add to cart'),
  },
  async (args) => {
    const body = JSON.stringify({
      items: args.items.map(item => ({
        upc: item.upc,
        quantity: item.quantity,
      })),
    });

    await krogerFetch('/cart/add', {
      method: 'PUT',
      body,
      requireUser: true,
    });

    const summary = args.items.map(i => `  ${i.upc} x${i.quantity}`).join('\n');
    return {
      content: [{ type: 'text' as const, text: `Added to cart:\n${summary}\n\nItems are now in your Kroger cart. Use agent-browser to navigate to fredmeyer.com/cart to review and check out.` }],
    };
  },
);

server.tool(
  'kroger_search_locations',
  'Find Kroger/Fred Meyer stores near a zip code.',
  {
    zipCode: z.string().describe('ZIP code to search near'),
    limit: z.number().min(1).max(25).default(5).describe('Max results'),
    chain: z.string().default('FRED MEYER').describe('Chain name filter (default: FRED MEYER). Use "KROGER" for Kroger stores.'),
  },
  async (args) => {
    let endpoint = `/locations?filter.zipCode.near=${args.zipCode}&filter.limit=${args.limit}`;
    if (args.chain) {
      endpoint += `&filter.chain=${encodeURIComponent(args.chain)}`;
    }

    const data = await krogerFetch(endpoint) as { data?: any[] };
    const locations = (data.data || []).map((loc: any) => ({
      locationId: loc.locationId,
      name: loc.name,
      chain: loc.chain,
      address: `${loc.address?.addressLine1}, ${loc.address?.city}, ${loc.address?.state} ${loc.address?.zipCode}`,
      phone: loc.phone,
    }));

    if (locations.length === 0) {
      return { content: [{ type: 'text' as const, text: `No ${args.chain || ''} stores found near ${args.zipCode}.` }] };
    }

    const text = locations.map((l: any, i: number) =>
      `${i + 1}. ${l.name} (${l.chain})\n   ID: ${l.locationId}\n   ${l.address}${l.phone ? `\n   Phone: ${l.phone}` : ''}`
    ).join('\n\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'kroger_set_store',
  'Set your preferred Kroger/Fred Meyer store. This store is used for product pricing, availability, and curbside pickup.',
  {
    locationId: z.string().describe('Store location ID (from kroger_search_locations)'),
    name: z.string().optional().describe('Store name for display'),
  },
  async (args) => {
    const config = loadConfig();
    config.preferred_location_id = args.locationId;
    if (args.name) config.preferred_location_name = args.name;
    saveConfig(config);

    return {
      content: [{ type: 'text' as const, text: `Preferred store set to ${args.name || args.locationId}. Product searches will now show pricing and availability for this store.` }],
    };
  },
);

server.tool(
  'kroger_get_store',
  'Get the currently set preferred store.',
  {},
  async () => {
    const config = loadConfig();
    if (!config.preferred_location_id) {
      return { content: [{ type: 'text' as const, text: 'No preferred store set. Use kroger_search_locations and kroger_set_store to set one.' }] };
    }
    return {
      content: [{ type: 'text' as const, text: `Preferred store: ${config.preferred_location_name || config.preferred_location_id} (ID: ${config.preferred_location_id})` }],
    };
  },
);

server.tool(
  'kroger_authorize',
  `Start the OAuth authorization flow to connect your Kroger account. This opens a Kroger login page in agent-browser. You only need to do this once — tokens are saved and refreshed automatically.

IMPORTANT: After calling this tool, you MUST use agent-browser to complete the login:
1. This tool returns an auth URL
2. Open that URL with: agent-browser open <url>
3. Fill in the user's Kroger email and password
4. After login, the callback is captured automatically
5. Call kroger_auth_status to verify`,
  {},
  async () => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return {
        content: [{ type: 'text' as const, text: 'KROGER_CLIENT_ID and KROGER_CLIENT_SECRET environment variables are not set. Add them to your .env file.' }],
        isError: true,
      };
    }

    const state = crypto.randomBytes(16).toString('hex');
    const scope = 'cart.basic:write profile.compact';

    // Start temporary callback server
    const authPromise = new Promise<string>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');

          if (returnedState !== state) {
            res.writeHead(400);
            res.end('State mismatch');
            srv.close();
            reject(new Error('OAuth state mismatch'));
            return;
          }

          if (!code) {
            res.writeHead(400);
            res.end('No authorization code');
            srv.close();
            reject(new Error('No authorization code in callback'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorization successful!</h2><p>You can close this tab.</p></body></html>');
          srv.close();
          resolve(code);
        }
      });

      srv.listen(REDIRECT_PORT, () => {
        log(`OAuth callback server listening on port ${REDIRECT_PORT}`);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        srv.close();
        reject(new Error('OAuth flow timed out (5 minutes)'));
      }, 300_000);
    });

    const authUrl = `${KROGER_BASE_URL}/connect/oauth2/authorize?scope=${encodeURIComponent(scope)}&response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

    // Exchange code for tokens in the background
    authPromise.then(async (code) => {
      log('Received authorization code, exchanging for tokens');
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const resp = await fetch(`${KROGER_BASE_URL}/connect/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      });

      if (!resp.ok) {
        const text = await resp.text();
        log(`Token exchange failed: ${text}`);
        return;
      }

      const data = await resp.json();
      const auth = loadAuth();
      auth.user_token = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        scope: data.scope || scope,
      };
      saveAuth(auth);
      log('User tokens saved successfully');
    }).catch((err) => {
      log(`OAuth flow error: ${err.message}`);
    });

    return {
      content: [{ type: 'text' as const, text: `Open this URL in agent-browser to authorize:\n\n${authUrl}\n\nThe user needs to log in with their Kroger/Fred Meyer account. After successful login, tokens are saved automatically.` }],
    };
  },
);

server.tool(
  'kroger_auth_status',
  'Check whether Kroger API authentication is working.',
  {},
  async () => {
    const auth = loadAuth();
    const config = loadConfig();

    const lines: string[] = [];
    lines.push(`Client ID configured: ${CLIENT_ID ? 'Yes' : 'No'}`);
    lines.push(`Client token: ${isTokenValid(auth.client_token) ? 'Valid' : 'Expired/Missing'}`);
    lines.push(`User token: ${isTokenValid(auth.user_token) ? 'Valid' : 'Expired/Missing'}`);
    lines.push(`Refresh token: ${auth.user_token?.refresh_token ? 'Present' : 'None'}`);
    lines.push(`Preferred store: ${config.preferred_location_id || 'Not set'}`);

    if (isTokenValid(auth.user_token)) {
      lines.push('\nUser is authorized. Cart operations will work.');
    } else if (auth.user_token?.refresh_token) {
      lines.push('\nUser token expired but refresh token present. Will auto-refresh on next API call.');
    } else {
      lines.push('\nUser not authorized. Run kroger_authorize to connect a Kroger account (required for cart operations).');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
