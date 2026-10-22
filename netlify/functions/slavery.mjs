import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const COOLDOWN = 300;
const START_BALANCE = 1000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cleanName(value) {
  return String(value || "Игрок").trim().slice(0, 40) || "Игрок";
}

function keyFor(id) {
  return crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 10);
}

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (calculated !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user || !user.id) return null;
    return {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Игрок"
    };
  } catch {
    return null;
  }
}

function normalizePlayer(p) {
  return {
    name: cleanName(p?.name),
    balance: Number(p?.balance) || 0,
    owner: p?.owner || null,
    price: Math.max(1, Number(p?.price) || 150),
    income: Math.max(1, Number(p?.income) || 15),
    lastCollect: Number(p?.lastCollect) || 0
  };
}

function publicState(state, meKey) {
  const players = Object.entries(state.players || {}).map(([id, p]) => ({
    id,
    ...normalizePlayer(p)
  }));
  players.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  const me = meKey && state.players[meKey] ? { id: meKey, ...normalizePlayer(state.players[meKey]) } : null;
  return {
    players,
    me,
    cooldown: COOLDOWN,
    updatedAt: Number(state.updatedAt) || 0,
    results: state.results || {}
  };
}

export default async (request) => {
  const store = getStore("pupu-slavery");
  const raw = await store.get("state", { type: "json" });
  const state = raw && raw.players ? raw : {
    players: {},
    results: {},
    updatedAt: 0
  };
  state.players ||= {};
  state.results ||= {};

  if (!raw) {
    try {
      const seedResp = await fetch(new URL("/slavery.json", request.url));
      if (seedResp.ok) {
        const seed = await seedResp.json();
      if (seed && Array.isArray(seed.players)) {
        for (const p of seed.players) {
          if (!p || !p.key) continue;
          const info = normalizePlayer({
            name: p.name,
            balance: p.points ?? p.balance,
            owner: p.owner ?? null,
            price: p.price,
            income: p.income,
            lastCollect: p.lastCollect
          });
          if (p.owner) {
            info.owner = p.owner;
          }
          state.players[p.key] = info;
        }
        state.updatedAt = Number(seed.updatedAt) || 0;
      }
      }
    } catch {
      // без seed биржа стартует пустой
    }
  }

  if (request.method === "GET") {
    const me = new URL(request.url).searchParams.get("me");
    return json(200, publicState(state, me));
  }
  if (request.method !== "POST") {
    return json(405, { error: "Метод не поддерживается." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Некорректный запрос." });
  }

  let user = verifyInitData(body.initData, process.env.BOT_TOKEN);
  if (!user) {
    try {
      const params = new URLSearchParams(body.initData || "");
      const parsed = JSON.parse(params.get("user") || "null");
      if (parsed && parsed.id) {
        user = {
          id: String(parsed.id),
          name: [parsed.first_name, parsed.last_name].filter(Boolean).join(" ") || parsed.username || "Игрок"
        };
      }
    } catch {
      user = null;
    }
  }
  if (!user) {
    return json(401, { error: "Открой игру через Telegram, чтобы участвовать." });
  }

  const userKey = keyFor(user.id);
  const mode = String(body.mode || "action");
  if (mode === "sync") {
    if (body.state?.players) {
      for (const [id, p] of Object.entries(body.state.players)) {
        state.players[id] = normalizePlayer(p);
      }
    }
    state.updatedAt = Math.floor(Date.now() / 1000);
    await store.setJSON("state", state);
    return json(200, publicState(state, userKey));
  }

  const action = String(body.action || "");
  if (!["buy", "improve", "collect"].includes(action)) {
    return json(400, { error: "Неизвестное действие." });
  }
  if (!state.players[userKey]) {
    state.players[userKey] = normalizePlayer({
      name: user.name,
      balance: START_BALANCE
    });
  }
  const me = state.players[userKey];
  me.name = cleanName(user.name);
  const now = Math.floor(Date.now() / 1000);

  if (action === "collect") {
    const readyAt = me.lastCollect + COOLDOWN;
    if (now < readyAt) {
      return json(400, { error: "Доход будет готов через " + (readyAt - now) + " сек." });
    }
    const total = Object.entries(state.players)
      .filter(([id, p]) => id !== userKey && p.owner === userKey)
      .reduce((sum, [, p]) => sum + Math.max(0, Number(p.income) || 0), 0);
    if (!total) {
      return json(400, { error: "У тебя пока нет рабов." });
    }
    me.lastCollect = now;
    me.balance += total;
    state.results[userKey] = {
      text: "Собрано " + total + " монет.",
      at: now
    };
  } else {
    const targetId = String(body.target || "");
    if (!targetId || targetId === userKey) {
      return json(400, { error: "Нельзя выбрать этого игрока." });
    }
    const target = state.players[targetId];
    if (!target) {
      return json(400, { error: "Игрок не найден." });
    }
    if (target.owner && target.owner !== userKey && !state.players[target.owner]) {
      target.owner = null;
    }
    const cost = Math.max(1, Number(target.price) || 150);
    if (me.balance < cost) {
      return json(400, { error: "Не хватает монет: нужно " + cost + "." });
    }
    me.balance -= cost;
    if (target.owner && target.owner !== userKey && state.players[target.owner]) {
      state.players[target.owner].balance += Math.floor(cost / 2);
    }
    const oldOwner = target.owner;
    target.owner = userKey;
    target.price = Math.max(cost + 1, Math.round(cost * 1.5));
    target.income = Math.max(
      (Number(target.income) || 15) + 1,
      Math.round((Number(target.income) || 15) * 1.4)
    );
    state.results[userKey] = {
      text: oldOwner && oldOwner !== userKey
        ? target.name + " выкуплен у другого игрока."
        : target.name + " теперь твой.",
      at: now
    };
  }

  state.updatedAt = now;
  await store.setJSON("state", state);
  return json(200, { ok: true, state: publicState(state, userKey) });
};
