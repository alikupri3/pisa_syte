import { getStore } from "@netlify/blobs";

const COOLDOWN = 300;
const START_BALANCE = 100;

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

function publicState(state, meId) {
  const players = Object.entries(state.players || {}).map(([id, p]) => ({
    id,
    ...normalizePlayer(p)
  }));
  players.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  const me = meId && state.players[meId] ? { id: meId, ...normalizePlayer(state.players[meId]) } : null;
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

  const mode = String(body.mode || "action");
  const actor = body.actor || {};
  const actorId = String(actor.id || "");
  if (!actorId) {
    return json(400, { error: "Открой игру через Telegram." });
  }

  if (mode === "action") {
    const action = String(body.action || "");
    const targetId = String(body.target || "");
    const now = Math.floor(Date.now() / 1000);
    if (!["buy", "improve", "collect"].includes(action)) {
      return json(400, { error: "Неизвестное действие." });
    }
    if (!state.players[actorId]) {
      state.players[actorId] = normalizePlayer({
        name: actor.name,
        balance: START_BALANCE
      });
    }
    const me = state.players[actorId];
    me.name = cleanName(actor.name || me.name);

    if (action === "collect") {
      const readyAt = me.lastCollect + COOLDOWN;
      if (now < readyAt) {
        return json(400, { error: "Доход будет готов через " + (readyAt - now) + " сек." });
      }
      const total = Object.entries(state.players)
        .filter(([id, p]) => id !== actorId && p.owner === actorId)
        .reduce((sum, [, p]) => sum + Math.max(0, Number(p.income) || 0), 0);
      if (!total) {
        return json(400, { error: "У тебя пока нет рабов." });
      }
      me.lastCollect = now;
      me.balance += total;
      state.results[actorId] = {
        text: "Собрано " + total + " монет.",
        at: now
      };
    } else {
      if (!targetId || targetId === actorId) {
        return json(400, { error: "Нельзя выбрать этого игрока." });
      }
      const target = state.players[targetId];
      if (!target) {
        return json(400, { error: "Игрок не найден." });
      }
      if (target.owner && target.owner !== actorId && !state.players[target.owner]) {
        target.owner = null;
      }
      const cost = Math.max(1, Number(target.price) || 150);
      if (me.balance < cost) {
        return json(400, { error: "Не хватает монет: нужно " + cost + "." });
      }
      me.balance -= cost;
      if (target.owner && target.owner !== actorId && state.players[target.owner]) {
        state.players[target.owner].balance += Math.floor(cost / 2);
      }
      const oldOwner = target.owner;
      target.owner = actorId;
      target.price = Math.max(cost + 1, Math.round(cost * 1.5));
      target.income = Math.max(
        (Number(target.income) || 15) + 1,
        Math.round((Number(target.income) || 15) * 1.4)
      );
      state.results[actorId] = {
        text: oldOwner && oldOwner !== actorId
          ? target.name + " выкуплен у другого игрока."
          : target.name + " теперь твой.",
        at: now
      };
    }
    state.updatedAt = now;
    await store.setJSON("state", state);
    return json(200, { ok: true, state: publicState(state, actorId) });
  }

  if (mode === "sync") {
    if (body.state?.players) {
      for (const [id, p] of Object.entries(body.state.players)) {
        state.players[id] = normalizePlayer(p);
      }
    }
    state.updatedAt = Math.floor(Date.now() / 1000);
    await store.setJSON("state", state);
    return json(200, publicState(state, actorId));
  }

  return json(400, { error: "Неизвестный режим." });
};
