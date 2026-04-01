/**
 * Kroger Browser Automation via Stagehand
 *
 * Uses Stagehand (Browserbase's AI browser framework) for cart viewing
 * and checkout on fredmeyer.com. Stagehand provides:
 * - Natural language browser actions (act/extract)
 * - Auto-caching: first run uses AI, subsequent runs replay cached selectors
 * - Self-healing: if Kroger changes their UI, Stagehand re-invokes AI
 *
 * Cookie persistence: Stagehand v3 userDataDir is broken (#1250), so we
 * manually save/restore cookies via the V3Context cookie API.
 *
 * LLM calls route through the credential proxy automatically since
 * Stagehand uses @anthropic-ai/sdk which reads ANTHROPIC_BASE_URL
 * and ANTHROPIC_API_KEY from the environment.
 */

import { Stagehand, type Cookie, type CookieParam } from '@browserbasehq/stagehand';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// --- Paths ---

const COOKIES_PATH = '/workspace/group/.fredmeyer-cookies.json';
const CACHE_DIR = '/workspace/group/.stagehand-cache';
const SCREENSHOT_DIR = '/workspace/group';
const CHROMIUM_PATH =
  process.env.AGENT_BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium';

// --- Types ---

export interface ViewCartResult {
  success: boolean;
  errorType?: string;
  message?: string;
  items?: Array<{ name: string; quantity: number; price: string }>;
  subtotal?: string;
  estimatedTotal?: string;
}

export interface CheckoutResult {
  success: boolean;
  errorType?: string;
  message?: string;
  orderNumber?: string;
  pickupTime?: string;
  total?: string;
  screenshotPath?: string;
}

// --- Cookie Persistence ---

async function loadCookies(stagehand: Stagehand): Promise<void> {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies: CookieParam[] = JSON.parse(
        fs.readFileSync(COOKIES_PATH, 'utf-8'),
      );
      if (cookies.length > 0) {
        await stagehand.context.addCookies(cookies);
        log(`Loaded ${cookies.length} saved cookies`);
      }
    }
  } catch (err) {
    log(
      `Failed to load cookies: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function saveCookies(stagehand: Stagehand): Promise<void> {
  try {
    const cookies = await stagehand.context.cookies();
    fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    log(`Saved ${cookies.length} cookies`);
  } catch (err) {
    log(
      `Failed to save cookies: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Logging ---

function log(message: string): void {
  console.error(`[KROGER-BROWSER] ${message}`);
}

// --- Stagehand Lifecycle ---

async function createStagehand(): Promise<Stagehand> {
  // Ensure cache directory exists
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: {
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
    model: 'anthropic/claude-haiku-4-5',
    selfHeal: true,
    cacheDir: CACHE_DIR,
    verbose: 0,
  });

  await stagehand.init();
  log('Stagehand initialized');

  // Restore saved cookies before navigating
  await loadCookies(stagehand);

  return stagehand;
}

/**
 * Get the active page from Stagehand, throwing if unavailable.
 */
function getPage(stagehand: Stagehand) {
  const page = stagehand.context.activePage();
  if (!page) throw new Error('No active page in Stagehand context');
  return page;
}

// --- Retry Helper ---

async function retryAct(
  stagehand: Stagehand,
  instruction: string,
  maxAttempts = 2,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await stagehand.act(instruction);
      return;
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      log(
        `act() failed (attempt ${attempt + 1}/${maxAttempts}): ${err instanceof Error ? err.message : String(err)}. Retrying...`,
      );
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// --- Cart Viewing ---

const CartSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().describe('Full product name'),
      quantity: z.number().describe('Item quantity'),
      price: z
        .string()
        .describe('Item price as shown (e.g., "$5.99")'),
    }),
  ),
  subtotal: z.string().describe('Cart subtotal'),
  estimatedTotal: z
    .string()
    .describe('Estimated total including tax/fees'),
});

export async function viewCart(): Promise<ViewCartResult> {
  let stagehand: Stagehand | null = null;

  try {
    stagehand = await createStagehand();
    const page = getPage(stagehand);

    log('Navigating to Fred Meyer cart');
    await page.goto('https://www.fredmeyer.com/cart', {
      waitUntil: 'networkidle',
      timeoutMs: 30000,
    });

    // Detect login redirect
    const url = page.url();
    if (url.includes('/signin') || url.includes('/login')) {
      log('Login redirect detected');
      return {
        success: false,
        errorType: 'login_required',
        message:
          'Not logged in to Fred Meyer. Use agent-browser to sign in first, then retry.',
      };
    }

    log('Extracting cart contents');
    const cart = await stagehand.extract(
      'Extract all items in the shopping cart. For each item, get the full product name, quantity (as a number), and price (including the dollar sign). Also get the subtotal and estimated total. If the cart is empty, return an empty items array.',
      CartSchema,
    );

    // Save cookies after successful operation
    await saveCookies(stagehand);

    log(`Cart extracted: ${cart.items.length} items`);
    return {
      success: true,
      items: cart.items,
      subtotal: cart.subtotal,
      estimatedTotal: cart.estimatedTotal,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`viewCart failed: ${message}`);
    return {
      success: false,
      errorType: 'unknown',
      message: `Failed to view cart: ${message}`,
    };
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

// --- Checkout ---

const ConfirmationSchema = z.object({
  orderNumber: z
    .string()
    .describe('Order confirmation number'),
  pickupTime: z
    .string()
    .optional()
    .describe('Scheduled pickup or delivery time'),
  total: z.string().describe('Order total'),
});

export async function checkout(opts: {
  fulfillment: 'pickup' | 'delivery';
}): Promise<CheckoutResult> {
  let stagehand: Stagehand | null = null;
  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    'last-order-confirmation.png',
  );
  const errorScreenshotPath = path.join(
    SCREENSHOT_DIR,
    'checkout-error.png',
  );

  try {
    stagehand = await createStagehand();
    const page = getPage(stagehand);

    log('Navigating to Fred Meyer cart for checkout');
    await page.goto('https://www.fredmeyer.com/cart', {
      waitUntil: 'networkidle',
      timeoutMs: 30000,
    });

    // Detect login redirect
    const url = page.url();
    if (url.includes('/signin') || url.includes('/login')) {
      log('Login redirect detected during checkout');
      return {
        success: false,
        errorType: 'login_required',
        message:
          'Not logged in to Fred Meyer. Use agent-browser to sign in first, then retry.',
      };
    }

    // Step through checkout — each act() is cached after first success
    log('Starting checkout flow');

    await retryAct(stagehand, 'Click the checkout button');
    log('Clicked checkout');

    await retryAct(
      stagehand,
      `Select ${opts.fulfillment} as the fulfillment method`,
    );
    log(`Selected ${opts.fulfillment}`);

    await retryAct(
      stagehand,
      'Select the earliest available time slot',
    );
    log('Selected time slot');

    await retryAct(
      stagehand,
      'Continue with the saved payment method',
    );
    log('Confirmed payment');

    await retryAct(stagehand, 'Review and place the order');
    log('Order placed');

    // Wait for confirmation page to render
    await page.waitForTimeout(5000);

    // Screenshot the confirmation
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
    log(`Confirmation screenshot saved to ${screenshotPath}`);

    // Extract order details from confirmation page
    const confirmation = await stagehand.extract(
      'Extract the order confirmation details: order number, scheduled pickup or delivery time, and order total. If any field is not visible, use "N/A".',
      ConfirmationSchema,
    );

    // Save cookies after successful checkout
    await saveCookies(stagehand);

    log(
      `Checkout complete: order ${confirmation.orderNumber}, total ${confirmation.total}`,
    );
    return {
      success: true,
      orderNumber: confirmation.orderNumber,
      pickupTime: confirmation.pickupTime,
      total: confirmation.total,
      screenshotPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Checkout failed: ${message}`);

    // Try to capture error screenshot
    if (stagehand) {
      try {
        const page = stagehand.context.activePage();
        if (page) {
          await page.screenshot({
            path: errorScreenshotPath,
            fullPage: true,
          });
          log(`Error screenshot saved to ${errorScreenshotPath}`);
        }
      } catch {
        // ignore screenshot failure
      }
    }

    return {
      success: false,
      errorType: 'unknown',
      message: `Checkout failed: ${message}. An error screenshot was saved. You can fall back to agent-browser to complete checkout manually.`,
      screenshotPath: errorScreenshotPath,
    };
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
