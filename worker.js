/**
 * ProxyGem + Platega payment backend
 *
 * Deploy this as a Cloudflare Worker.
 * Required secrets/vars:
 *   PLATEGA_MERCHANT_ID
 *   PLATEGA_SECRET
 *   PREMIUM_CODES_URL (defaults to the user's raw GitHub file)
 *   PUBLIC_SITE_URL (defaults to https://proxygem.github.io/site)
 *
 * Required binding:
 *   PAYMENT_KV — Cloudflare KV namespace
 *
 * IMPORTANT:
 * Never put PLATEGA_SECRET in index.html or any browser-side JS.
 */

const METHODS = Object.freeze({
  sbp: 2,       // SBP / QR
  card: 11,     // Card acquiring
  crypto: 13,   // Cryptocurrency
});

const PLANS = Object.freeze({
  1: { amount: 259, duration: "1_month" },
  3: { amount: 659, duration: "3_months" },
  6: { amount: 1190, duration: "6_months" },
});

const DEFAULT_CODES_URL =
  "https://raw.githubusercontent.com/slava20222014-create/Servers_ProxyGemSite/main/premium_codes.json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "https://proxygem.github.io",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function digits20() {
  let s = "";
  while (s.length < 20) s += Math.floor(Math.random() * 10);
  return s.slice(0, 20);
}

function digits10() {
  let s = "";
  while (s.length < 10) s += Math.floor(Math.random() * 10);
  return s.slice(0, 10);
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "https://proxygem.github.io",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

async function plategaFetch(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-MerchantId", env.PLATEGA_MERCHANT_ID);
  headers.set("X-Secret", env.PLATEGA_SECRET);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  return fetch(`https://app.platega.io${path}`, {
    ...init,
    headers,
  });
}

async function loadCodes(env) {
  const response = await fetch(env.PREMIUM_CODES_URL || DEFAULT_CODES_URL, {
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`GitHub codes HTTP ${response.status}`);
  return response.json();
}

function codeDurationForMonths(months) {
  // The supplied premium_codes.json currently contains 1_month, 3_months and forever.
  // There is no 6_months duration in that source, so 6 months intentionally falls back
  // to the first available "forever" code rather than inventing a non-existent code.
  if (months === 1) return ["1_month"];
  if (months === 3) return ["3_months"];
  if (months === 6) return ["6_months", "forever"];
  return [];
}

async function allocateCode(env, months, publicId) {
  const data = await loadCodes(env);
  const allowed = new Set(codeDurationForMonths(months));
  let candidates = (data.codes || []).filter(
    (c) => allowed.has(c.duration) && c.used !== true
  );

  if (!candidates.length) {
    throw new Error(`Нет свободного Premium-ключа для тарифа ${months} мес.`);
  }

  // Prefer an unclaimed code. KV protects against normal repeated polling.
  for (const candidate of candidates) {
    const claimKey = `code-claim:${candidate.id}`;
    const claimed = await env.PAYMENT_KV.get(claimKey);
    if (claimed) continue;

    await env.PAYMENT_KV.put(
      claimKey,
      JSON.stringify({ publicId, claimedAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );

    return candidate.id;
  }

  throw new Error("Свободные ключи временно закончились.");
}

async function getOrder(env, publicId) {
  return env.PAYMENT_KV.get(`order:${publicId}`, "json");
}

async function saveOrder(env, publicId, order) {
  await env.PAYMENT_KV.put(`order:${publicId}`, JSON.stringify(order), {
    expirationTtl: 60 * 60 * 24 * 3,
  });
}

async function createPayment(request, env) {
  const body = await request.json().catch(() => ({}));
  const months = Number(body.months);
  const methodId = String(body.method || "");
  const plan = PLANS[months];
  const method = METHODS[methodId];

  if (!plan || !method) return json({ error: "Некорректный тариф или способ оплаты." }, 400);

  const publicId = digits20();
  const orderNumber = String(body.orderNumber || digits10()).replace(/\D/g, "").slice(0, 10) || digits10();

  const site = (env.PUBLIC_SITE_URL || "https://proxygem.github.io/site").replace(/\/$/, "");
  const returnUrl = `${site}/?payment=${publicId}`;

  const payload = {
    paymentMethod: method,
    paymentDetails: {
      amount: plan.amount,
      currency: "RUB",
    },
    description: `Номер заказа: ${orderNumber}`,
    return: returnUrl,
    failedUrl: returnUrl,
    payload: JSON.stringify({
      publicId,
      orderNumber,
      months,
      product: "ProxyGem Premium",
    }),
  };

  const response = await plategaFetch(env, "/transaction/process", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.redirect) {
    return json({
      error: result.message || result.error || "Platega не смог создать счёт.",
      details: result,
    }, response.status || 502);
  }

  await saveOrder(env, publicId, {
    publicId,
    orderNumber,
    months,
    amount: plan.amount,
    method: methodId,
    transactionId: result.transactionId,
    status: result.status || "PENDING",
    code: null,
    createdAt: new Date().toISOString(),
  });

  return json({
    url: result.redirect,
    publicId,
    orderNumber,
    transactionId: result.transactionId,
  });
}

async function syncPaymentStatus(env, publicId) {
  const order = await getOrder(env, publicId);
  if (!order) return json({ error: "Заказ не найден." }, 404);

  if (order.status === "CONFIRMED" && order.code) {
    return json({ status: "CONFIRMED", code: order.code, orderNumber: order.orderNumber });
  }

  const response = await plategaFetch(env, `/transaction/${encodeURIComponent(order.transactionId)}`);
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    return json({ status: order.status || "PENDING" });
  }

  const status = result.status || order.status || "PENDING";

  if (status === "CONFIRMED") {
    if (!order.code) {
      try {
        order.code = await allocateCode(env, order.months, publicId);
      } catch (e) {
        // Payment is confirmed, but code allocation failed. Do not lie to the customer.
        order.status = "CONFIRMED";
        order.codeError = e.message;
        await saveOrder(env, publicId, order);
        return json({ status: "CONFIRMED", codePending: true });
      }
    }
    order.status = "CONFIRMED";
    order.confirmedAt = order.confirmedAt || new Date().toISOString();
    await saveOrder(env, publicId, order);
    return json({ status: "CONFIRMED", code: order.code, orderNumber: order.orderNumber });
  }

  order.status = status;
  await saveOrder(env, publicId, order);

  return json({ status, orderNumber: order.orderNumber });
}

async function handleWebhook(request, env) {
  const merchant = request.headers.get("X-MerchantId");
  const secret = request.headers.get("X-Secret");
  if (merchant !== env.PLATEGA_MERCHANT_ID || secret !== env.PLATEGA_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const transactionId = body.id || body.Id;
  const status = body.status || body.Status;
  if (!transactionId) return json({ ok: true });

  // Find the order by scanning a small index created below.
  const publicId = await env.PAYMENT_KV.get(`tx:${transactionId}`);
  if (!publicId) return json({ ok: true });

  const order = await getOrder(env, publicId);
  if (!order) return json({ ok: true });

  order.status = status || order.status;
  if (status === "CONFIRMED" && !order.code) {
    try {
      order.code = await allocateCode(env, order.months, publicId);
      order.confirmedAt = new Date().toISOString();
    } catch (e) {
      order.codeError = e.message;
    }
  }
  await saveOrder(env, publicId, order);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);

    try {
      if (url.pathname === "/create-payment" && request.method === "POST") {
        const response = await createPayment(request, env);
        // Index transaction ID for webhook lookups.
        const body = await response.clone().json().catch(() => null);
        if (body?.transactionId && body?.publicId) {
          await env.PAYMENT_KV.put(`tx:${body.transactionId}`, body.publicId, {
            expirationTtl: 60 * 60 * 24 * 3,
          });
        }
        return response;
      }

      if (url.pathname.startsWith("/payment-status/") && request.method === "GET") {
        const publicId = url.pathname.split("/").pop();
        if (!/^\d{20}$/.test(publicId)) return json({ error: "Invalid payment id" }, 400);
        return syncPaymentStatus(env, publicId);
      }

      if (url.pathname === "/webhook/platega" && request.method === "POST") {
        return handleWebhook(request, env);
      }

      return json({ service: "ProxyGem Payment API", ok: true });
    } catch (error) {
      return json({ error: error?.message || "Server error" }, 500);
    }
  },
};
