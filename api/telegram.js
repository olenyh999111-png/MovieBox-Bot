
import { randomBytes, createHash } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!token || !secret || !adminId || !supabaseUrl || !supabaseKey) {
    console.error("Missing required environment variable");
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const message = req.body?.message;
  const chatId = message?.chat?.id;

  if (!chatId || !message.from?.id) {
    return res.status(200).json({ ok: true });
  }

  const senderId = String(message.from.id);
  const text = (message.text || "").trim();
  const isAdmin = senderId === String(adminId);

  async function telegram(method, body) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      console.error(`Telegram ${method} failed:`, response.status);
      throw new Error(`Telegram ${method} request failed`);
    }

    return result;
  }

  async function db(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("apikey", supabaseKey);
    headers.set("Content-Type", "application/json");

    if (supabaseKey.startsWith("sb_secret_")) {
      headers.delete("Authorization");
    } else {
      headers.set("Authorization", `Bearer ${supabaseKey}`);
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 1000);
      console.error(
        "Supabase request failed:",
        response.status,
        details
      );
      throw new Error(`Supabase request failed (${response.status})`);
    }

    if (response.status === 204) return null;

    const result = await response.text();
    return result ? JSON.parse(result) : null;
  }

  async function reply(value) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: value
    });
  }

  async function getUser(telegramId = senderId) {
    const rows = await db(
      `moviebox_users?telegram_id=eq.${encodeURIComponent(telegramId)}&select=*`
    );

    if (rows.length) return rows[0];

    const created = await db("moviebox_users", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        telegram_id: telegramId,
        free_searches_used: 0,
        daily_searches_used: 0
      })
    });

    if (!created?.length) {
      throw new Error("User creation returned no row");
    }

    return created[0];
  }

  async function grant(telegramId, tier, days) {
    if (!["premium", "vip"].includes(tier)) {
      throw new Error("Invalid subscription tier");
    }

    if (![7, 14, 30, 365].includes(days)) {
      throw new Error("Invalid subscription duration");
    }

    const user = await getUser(telegramId);
    const column = tier === "premium" ? "premium_until" : "vip_until";
    const existing = user[column] ? new Date(user[column]) : new Date();
    const now = new Date();
    const start = existing > now ? existing : now;

    start.setUTCDate(start.getUTCDate() + days);

    await db(
      `moviebox_users?telegram_id=eq.${encodeURIComponent(telegramId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          [column]: start.toISOString()
        })
      }
    );

    return start;
  }

  try {
    if (!text) return res.status(200).json({ ok: true });

    if (text === "/link") {
      await getUser();

      // Generate a cryptographically random one-time linking code.
      const code = randomBytes(24).toString("base64url");
      const codeHash = createHash("sha256")
        .update(code)
        .digest("hex");

      // Invalidate previous unused codes for this Telegram account.
      await db(
        `moviebox_link_codes?telegram_id=eq.${encodeURIComponent(senderId)}&used_at=is.null`,
        { method: "DELETE" }
      );

      const expiresAt = new Date(
        Date.now() + 10 * 60 * 1000
      ).toISOString();

      await db("moviebox_link_codes", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          telegram_id: senderId,
          code_hash: codeHash,
          expires_at: expiresAt
        })
      });

      await reply(
        "🔐 Код привязки MovieBox:\n\n" +
        code +
        "\n\nКод действует 10 минут и может быть использован один раз. " +
        "Не пересылай его другим людям.\n\n" +
        "Подтверждение привязки на сайте будет доступно после подключения следующего этапа."
      );
    } else if (text === "/start") {
      await getUser();

      await reply(
        "Добро пожаловать в MovieBox! 🎬\n\n" +
        "Команды:\n" +
        "/status — статус Premium/VIP\n" +
        "/link — получить код привязки сайта\n" +
        "/redeem CODE — активировать промокод\n" +
        "/help — помощь\n" +
        "/id — ваш Telegram ID"
      );
    } else if (text === "/help") {
      await reply(
        "MovieBox — помощь 🎬\n\n" +
        "/start — главное меню\n" +
        "/status — статус подписки\n" +
        "/link — код привязки сайта\n" +
        "/redeem CODE — активировать промокод\n" +
        "/id — узнать свой ID"
      );
    } else if (text === "/id") {
      await reply(`Ваш Telegram ID: ${senderId}`);
    } else if (text === "/status") {
      const user = await getUser();
      const now = new Date();

      const premium =
        user.premium_until && new Date(user.premium_until) > now;
      const vip =
        user.vip_until && new Date(user.vip_until) > now;

      await reply(
        "Ваш статус MovieBox 🎬\n\n" +
        `Premium: ${
          premium
            ? "активен до " +
              new Date(user.premium_until).toLocaleDateString("ru-RU")
            : "не активен"
        }\n` +
        `VIP: ${
          vip
            ? "активен до " +
              new Date(user.vip_until).toLocaleDateString("ru-RU")
            : "не активен"
        }`
      );
    } else if (text.startsWith("/grant ")) {
      if (!isAdmin) {
        await reply("Эта команда доступна только администратору.");
      } else {
        const parts = text.split(/\s+/);
        const targetId = parts[1];
        const tier = (parts[2] || "").toLowerCase();
        const days = Number(parts[3]);

        if (
          !targetId ||
          !["premium", "vip"].includes(tier) ||
          ![7, 14, 30, 365].includes(days)
        ) {
          await reply(
            "Формат:\n/grant TELEGRAM_ID premium 7\n" +
            "Доступные сроки: 7, 14, 30, 365 дней."
          );
        } else {
          await grant(targetId, tier, days);
          await reply(
            `✅ ${tier.toUpperCase()} выдан на ${days} дней пользователю ${targetId}.`
          );
        }
      }
    } else if (text.startsWith("/promo ")) {
      if (!isAdmin) {
        await reply("Эта команда доступна только администратору.");
      } else {
        const parts = text.split(/\s+/);
        const code = (parts[1] || "").toUpperCase();
        const tier = (parts[2] || "").toLowerCase();
        const days = Number(parts[3]);
        const maxActivations = Number(parts[4]);

        if (
          !/^[A-Z0-9_-]{3,40}$/.test(code) ||
          !["premium", "vip"].includes(tier) ||
          ![7, 14, 30, 365].includes(days) ||
          !Number.isInteger(maxActivations) ||
          maxActivations < 1
        ) {
          await reply("Формат: /promo MOVIE2026 premium 7 10");
        } else {
          await db("moviebox_promo_codes", {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              code,
              tier,
              duration_days: days,
              max_activations: maxActivations,
              activations: 0,
              active: true
            })
          });

          await reply(`Промокод ${code} создан.`);
        }
      }
    } else if (text.startsWith("/redeem ")) {
      const code = (text.split(/\s+/)[1] || "").toUpperCase();

      if (!code) {
        await reply("Использование: /redeem CODE");
      } else {
        const codes = await db(
          `moviebox_promo_codes?code=eq.${encodeURIComponent(code)}&active=eq.true&select=*`
        );
        const promo = codes[0];

        if (!promo || promo.activations >= promo.max_activations) {
          await reply(
            "Промокод не найден, отключён или лимит активаций исчерпан."
          );
        } else {
          const previous = await db(
            `moviebox_promo_redemptions?code=eq.${encodeURIComponent(code)}&telegram_id=eq.${encodeURIComponent(senderId)}&select=id`
          );

          if (previous.length) {
            await reply("Ты уже активировал этот промокод.");
          } else {
            await grant(
              senderId,
              promo.tier,
              Number(promo.duration_days)
            );

            await db("moviebox_promo_redemptions", {
              method: "POST",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                code,
                telegram_id: senderId
              })
            });

            await db(
              `moviebox_promo_codes?code=eq.${encodeURIComponent(code)}`,
              {
                method: "PATCH",
                headers: { Prefer: "return=minimal" },
                body: JSON.stringify({
                  activations: promo.activations + 1
                })
              }
            );

            await reply(
              `Промокод активирован! 🎉\n` +
              `Подписка ${promo.tier} выдана на ${promo.duration_days} дней.`
            );
          }
        }
      }
    } else if (text === "/admin") {
      await reply(
        isAdmin
          ? "Команды администратора:\n" +
            "/grant TELEGRAM_ID premium 30\n" +
            "/promo CODE premium 7 10"
          : "Эта команда доступна только администратору."
      );
    } else {
      await reply("Напиши /start, чтобы открыть меню MovieBox.");
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("MovieBox bot error:", error.message);

    try {
      await reply(
        "Не удалось выполнить команду. Проверь настройки базы данных или попробуй позже."
      );
    } catch {
      console.error("Telegram error while sending failure reply");
    }

    return res.status(200).json({ ok: true });
  }
}
