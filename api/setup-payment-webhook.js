
import { timingSafeEqual } from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const expectedSecret = process.env.WEBHOOK_SETUP_SECRET;
  const receivedHeader = req.headers["x-setup-secret"];
  const receivedSecret = Array.isArray(receivedHeader)
    ? receivedHeader[0]
    : receivedHeader;

  if (!expectedSecret || !receivedSecret) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const expected = Buffer.from(expectedSecret, "utf8");
  const received = Buffer.from(receivedSecret, "utf8");

  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !webhookSecret) {
    return res.status(500).json({
      ok: false,
      error: "Telegram webhook configuration is missing"
    });
  }

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    return res.status(500).json({
      ok: false,
      error: "Invalid Telegram webhook secret format"
    });
  }

  const webhookUrl =
    "https://moviebox-bot.vercel.app/api/telegram";

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: webhookSecret,
          allowed_updates: [
            "message",
            "pre_checkout_query"
          ],
          drop_pending_updates: false
        })
      }
    );

    const result = await telegramResponse.json().catch(() => null);

    if (!telegramResponse.ok || !result?.ok) {
      console.error(
        "Telegram setWebhook failed:",
        telegramResponse.status,
        result?.description || "Unknown Telegram error"
      );

      return res.status(502).json({
        ok: false,
        error:
          result?.description ||
          "Telegram could not configure the webhook"
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Telegram webhook configured",
      webhookUrl,
      allowed_updates: [
        "message",
        "pre_checkout_query"
      ]
    });
  } catch (error) {
    console.error(
      "Webhook setup failed:",
      error.message
    );

    return res.status(500).json({
      ok: false,
      error: "Could not configure Telegram webhook"
    });
  }
}
