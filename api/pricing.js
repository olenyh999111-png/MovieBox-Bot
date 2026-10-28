
function readPositiveInteger(name, fallback) {
  const raw = process.env[name] || String(fallback);
  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1 || value > 100000) {
    throw new Error(`Invalid configuration: ${name}`);
  }

  return value;
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const premiumStars = readPositiveInteger(
      "MOVIEBOX_PREMIUM_STARS",
      425
    );

    const vipStars = readPositiveInteger(
      "MOVIEBOX_VIP_STARS",
      1275
    );

    const premiumDays = readPositiveInteger(
      "MOVIEBOX_PREMIUM_DAYS",
      30
    );

    const vipDays = readPositiveInteger(
      "MOVIEBOX_VIP_DAYS",
      30
    );

    return res.status(200).json({
      ok: true,
      currency: "XTR",
      premium: {
        plan: "premium",
        amountStars: premiumStars,
        durationDays: premiumDays,
        dailySearchLimit: 100
      },
      vip: {
        plan: "vip",
        amountStars: vipStars,
        durationDays: vipDays,
        dailySearchLimit: 250
      }
    });
  } catch (error) {
    console.error("MovieBox pricing error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Pricing configuration error"
    });
  }
}
