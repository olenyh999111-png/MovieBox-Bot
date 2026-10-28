
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (
    !token ||
    !secret ||
    !adminId ||
    !supabaseUrl ||
    !supabaseKey
  ) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (
    req.headers["x-telegram-bot-api-secret-token"] !== secret
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const update = req.body || {};

  // Handle payment confirmation updates separately in a later step.
  const message = update.message;
  const chatId = message?.chat?.id;

  if (!chatId) {
    return res.status(200).json({ ok: true });
  }

  const senderId = String(message.from?.id || "");
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

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(`Telegram ${method} request failed`);
    }

    return result;
  }

  async function db(path, options = {}) {
    const response = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`,
      {
        ...options,
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      }
    );

    if (!response.ok) {
      console.error("Supabase request failed:", response.status);
      throw new Error("Database request failed");
    }

    if (response.status === 204) return null;
    return response.json();
  }

  async function reply(value) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: value
    });
  }

  async function getUser() {
    const rows = await db(
      `moviebox_users?telegram_id=eq.${encodeURIComponent(senderId)}&select=*`
    );

    if (rows.length) return rows[0];

    const created = await db("moviebox_users", {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        telegram_id: senderId,
        free_searches_used: 0
      })
    });

    return created[0];
  }

  async function grant(telegramId, tier, days) {
    if (!["premium", "vip"].includes(tier)) {
      throw new Error("Tier must be premium or vip");
    }

    if (![7, 14, 30, 365].includes(days)) {
      throw new Error("Days must be 7, 14, 30, or 365");
    }

    const rows = await db(
      `moviebox_users?telegram_id=eq.${encodeURIComponent(telegramId)}&select=*`
    );

    const user = rows[0] || {
      telegram_id: telegramId,
      free_searches_used: 0
    };

    const column = tier === "premium" ? "premium_until" : "vip_until";
    const currentEnd = user[column] ? new Date(user[column]) : new Date();
    const now = new Date();

    const start = currentEnd > now ? currentEnd : now;
    start.setUTCDate(start.getUTCDate() + days);

    const payload = {
      telegram_id: telegramId,
      free_searches_used: user.free_searches_used ?? 0,
      [column]: start.toISOString()
    };

    await db("moviebox_users?on_conflict=telegram_id", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(payload)
    });

    return start;
  }

  try {
    if (!text) {
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/start")) {
      await getUser();

      await reply(
        "Добро пожаловать в MovieBox! 🎬\n\n" +
        "Поиск фильмов доступен в Mini App.\n\n" +
        "Команды:\n" +
        "/status — статус подписки\n" +
        "/redeem CODE — активировать промокод\n" +
        "/help — помощь\n" +
        "/id — ваш Telegram ID"
      );
    } else if (text === "/help") {
      await reply(
        "MovieBox — помощь 🎬\n\n" +
        "/start — главное меню\n" +
        "/status — статус Premium/VIP\n" +
        "/redeem CODE — активировать промокод\n" +
        "/id — узнать свой Telegram ID"
      );
    } else if (text === "/id") {
      await reply(`Ваш Telegram ID: ${senderId}`);
    } else if (text === "/status") {
      const user = await getUser();
      const now = new Date();

      const premiumActive =
        user.premium_until && new Date(user.premium_until) > now;
      const vipActive =
        user.vip_until && new Date(user.vip_until) > now;

      await reply(
        "Ваш статус MovieBox 🎬\n\n" +
        `Premium: ${premiumActive ? `активен до ${new Date(user.premium_until).toLocaleDateString("ru-RU")}` : "не активен"}\n` +
        `VIP: ${vipActive ? `активен до ${new Date(user.vip_until).toLocaleDateString("ru-RU")}` : "не активен"}`
      );
    } else if (text.startsWith("/grant ")) {
      if (!isAdmin) {
        await reply("Эта команда доступна только администратору.");
      } else {
        const parts = text.split(/\s+/);
        const targetId = parts[1];
        const tier = (parts[2] || "").toLowerCase();
        const days = Number(parts[3]);

        if (!targetId || !tier || !Number.isInteger(days)) {
          await reply(
            "Формат:\n/grant TELEGRAM_ID premium 30\n" +
            "Доступные сроки: 7, 14, 30, 365 дней."
          );
        } else {
          await grant(targetId, tier, days);
          await reply(`Подписка ${tier} выдана пользователю ${targetId} на ${days} дней.`);
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
          await reply(
            "Формат:\n/promo MOVIE2026 premium 7 10\n\n" +
            "Параметры: код, premium/vip, срок 7/14/30/365, лимит активаций."
          );
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
      const code = text.split(/\s+/)[1]?.toUpperCase();

      if (!code) {
        await reply("Использование: /redeem CODE");
      } else {
        const codes = await db(
          `moviebox_promo_codes?code=eq.${encodeURIComponent(code)}&active=eq.true&select=*`
        );

        const promo = codes[0];

        if (
          !promo ||
          promo.activations >= promo.max_activations
        ) {
          await reply("Промокод не найден, отключён или лимит активаций исчерпан.");
        } else {
          const redemptions = await db(
            `moviebox_promo_redemptions?code=eq.${encodeURIComponent(code)}&telegram_id=eq.${encodeURIComponent(senderId)}&select=id`
          );

          if (redemptions.length) {
            await reply("Ты уже активировал этот промокод.");
          } else {
            await grant(senderId, promo.tier, promo.duration_days);

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
    await reply("Не удалось выполнить команду. Попробуй позже.");
    return res.status(200).json({ ok: true });
  }
}
