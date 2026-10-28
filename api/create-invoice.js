
import {
  createHmac,
  timingSafeEqual,
  randomUUID
} from "node:crypto";

function positiveInteger(name) {
  const raw = process.env[name];
  const value = Number(raw);

  if (
    !raw ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 100000
  ) {
    throw new Error("Invalid configuration: " + name);
  }

  return value;
}

function verifyTelegramInitData(initData, botToken) {
  if (typeof initData !== "string" || !initData || initData.length > 16384) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  // Reject missing, expired, or future-dated Telegram data.
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > now + 60 ||
    now - authDate > 24 * 60 * 60
  ) {
    return null;
  }

  const checkString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest();

  const suppliedHash = Buffer.from(receivedHash, "hex");

  if (
    suppliedHash.length !== calculatedHash.length ||
    !timingSafeEqual(suppliedHash, calculatedHash)
  ) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "null");

    if (
      !user ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    ) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

async function supabaseRequest(path, method, serviceKey, body) {
  const baseUrl = process.env.SUPABASE_URL;

  if (!baseUrl || !serviceKey) {
    throw new Error("Supabase server configuration is missing");
  }

  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/rest/v1/${path}`,
    {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) })
    }
  );

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    console.error(
      "Supabase request failed:",
      response.status,
      JSON.stringify(data)
    );

    throw new Error("Database request failed");
  }

  return data;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  let payload = null;

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!botToken || !serviceKey || !process.env.SUPABASE_URL) {
      return res.status(500).json({
        ok: false,
        error: "Server configuration is incomplete"
      });
    }

    const initData = req.headers["x-telegram-init-data"];
    const user = verifyTelegramInitData(initData, botToken);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Open MovieBox inside Telegram and try again"
      });
    }

    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Invalid JSON"
        });
      }
    }

    const plan = body?.plan;

    if (plan !== "premium" && plan !== "vip") {
      return res.status(400).json({
        ok: false,
        error: "Unknown subscription plan"
      });
    }

    const config = plan === "premium"
      ? {
          stars: positiveInteger("MOVIEBOX_PREMIUM_STARS"),
          days: positiveInteger("MOVIEBOX_PREMIUM_DAYS"),
          title: "MovieBox Premium",
          description: "Premium: 100 searches per day for 30 days."
        }
      : {
          stars: positiveInteger("MOVIEBOX_VIP_STARS"),
          days: positiveInteger("MOVIEBOX_VIP_DAYS"),
          title: "MovieBox VIP",
          description: "VIP: 250 searches per day for 30 days."
        };

    // The server generates the payload and owns the price.
    payload = "moviebox_" + randomUUID();

    const inserted = await supabaseRequest(
      "moviebox_star_orders",
      "POST",
      serviceKey,
      {
        invoice_payload: payload,
        telegram_id: String(user.id),
        plan,
        stars_amount: config.stars,
        currency: "XTR",
        duration_days: config.days,
        status: "pending"
      }
    );

    if (!Array.isArray(inserted) || inserted.length !== 1) {
      throw new Error("Could not create the payment order");
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/createInvoiceLink`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: config.title,
          description: config.description,
          payload,
          currency: "XTR",
          prices: [
            {
              label: `${config.title} (${config.days} days)`,
              amount: config.stars
            }
          ]
        })
      }
    );

    const telegramResult = await telegramResponse.json();

    if (
      !telegramResponse.ok ||
      !telegramResult.ok ||
      typeof telegramResult.result !== "string" ||
      !telegramResult.result.startsWith("https://")
    ) {
      console.error(
        "Telegram invoice creation failed:",
        telegramResult.description || telegramResponse.status
      );

      const query = new URLSearchParams({
        invoice_payload: `eq.${payload}`
      });

      await supabaseRequest(
        `moviebox_star_orders?${query.toString()}`,
        "PATCH",
        serviceKey,
        { status: "cancelled" }
      );

      payload = null;

      return res.status(502).json({
        ok: false,
        error: "Telegram could not create the invoice. Please try again."
      });
    }

    return res.status(200).json({
      ok: true,
      plan,
      currency: "XTR",
      amountStars: config.stars,
      durationDays: config.days,
      invoiceUrl: telegramResult.result
    });
  } catch (error) {
    console.error("MovieBox invoice error:", error.message);

    // Do not expose tokens, signatures, or internal database errors.
    return res.status(500).json({
      ok: false,
      error: "Could not create the invoice. Check the server logs."
    });
  }
}
