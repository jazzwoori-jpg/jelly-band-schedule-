/**
 * 젤리합주일정잡기 - Netlify Functions 백엔드
 *
 * 저장소: Netlify Blobs("band-schedule" 스토어, "state" 라는 키 하나)에
 * { members: {id: member}, notifs: {id: notif} } 형태의 JSON 전체를 저장합니다.
 * Google Apps Script 버전의 PropertiesService/Sheets 저장 방식과 동일한 역할을 합니다.
 *
 * 프론트(Index.html)는 /.netlify/functions/api 로 POST { fn, args } 를 보내고,
 * 이 파일은 fn 이름에 맞는 핸들러를 실행해 { ok:true, data } 또는 { ok:false, error } 를 돌려줍니다.
 * 함수 이름은 기존 Code.gs(api_getOrCreateMember 등)와 동일하게 맞춰서,
 * 프론트 쪽 호출 코드는 거의 그대로 재사용할 수 있게 했습니다.
 */
import { getStore } from "@netlify/blobs";

const ADMIN_PIN = process.env.ADMIN_PIN || "1234"; // 관리자 암호 - Netlify 사이트 환경변수 ADMIN_PIN 으로 덮어쓸 수 있습니다.
const STORE_NAME = "band-schedule";
const STATE_KEY = "state";

function emptyState() {
  return { members: {}, notifs: {} };
}

async function loadState(store) {
  const data = await store.get(STATE_KEY, { type: "json" });
  return data || emptyState();
}

async function saveState(store, state) {
  await store.setJSON(STATE_KEY, state);
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  return err;
}

function checkPin(pin) {
  if (String(pin == null ? "" : pin) !== String(ADMIN_PIN)) {
    throw httpError("관리자 암호가 올바르지 않습니다.", 403);
  }
}

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const handlers = {
  /* ================= member APIs (누구나 호출 가능 - 이름만으로 사용) ================= */

  api_getOrCreateMember: async (store, args) => {
    var name = String(args[0] || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!name) throw httpError("이름이 비어 있습니다.");
    if (name.length > 20) throw httpError("이름이 너무 깁니다.");
    const state = await loadState(store);
    for (const id in state.members) {
      if (state.members[id].name === name) return state.members[id];
    }
    const now = Date.now();
    const m = { id: uuid(), name: name, days: {}, completed: false, completedAt: null, createdAt: now, updatedAt: now };
    state.members[m.id] = m;
    await saveState(store, state);
    return m;
  },

  api_saveDay: async (store, args) => {
    var memberId = args[0],
      dateStr = args[1],
      payload = args[2];
    const state = await loadState(store);
    const m = state.members[memberId];
    if (!m) throw httpError("멤버를 찾을 수 없습니다.", 404);
    if (!m.days) m.days = {};
    if (payload === null || payload === undefined) {
      delete m.days[dateStr];
    } else {
      m.days[dateStr] = payload;
    }
    m.updatedAt = Date.now();
    await saveState(store, state);
    return { days: m.days, updatedAt: m.updatedAt };
  },

  api_completeMember: async (store, args) => {
    var memberId = args[0];
    const state = await loadState(store);
    const m = state.members[memberId];
    if (!m) throw httpError("멤버를 찾을 수 없습니다.", 404);
    const already = !!m.completed;
    const now = Date.now();
    m.completed = true;
    m.completedAt = now;
    m.updatedAt = now;
    const nid = uuid();
    state.notifs[nid] = { id: nid, memberId: memberId, name: m.name, type: already ? "update" : "complete", at: now, read: false };
    await saveState(store, state);
    return { completed: true, completedAt: now };
  },

  /* ================= admin APIs (암호 필요) ================= */

  api_getAllMembers: async (store, args) => {
    checkPin(args[0]);
    const state = await loadState(store);
    return Object.keys(state.members).map(function (id) {
      return state.members[id];
    });
  },

  api_getNotifications: async (store, args) => {
    checkPin(args[0]);
    const state = await loadState(store);
    const list = Object.keys(state.notifs).map(function (id) {
      return state.notifs[id];
    });
    list.sort(function (a, b) {
      return b.at - a.at;
    });
    return list.slice(0, 200);
  },

  api_markNotifRead: async (store, args) => {
    checkPin(args[0]);
    var notifId = args[1];
    const state = await loadState(store);
    const n = state.notifs[notifId];
    if (n) {
      n.read = true;
      await saveState(store, state);
    }
    return true;
  },

  api_markAllRead: async (store, args) => {
    checkPin(args[0]);
    const state = await loadState(store);
    var changed = false;
    for (const id in state.notifs) {
      if (!state.notifs[id].read) {
        state.notifs[id].read = true;
        changed = true;
      }
    }
    if (changed) await saveState(store, state);
    return true;
  },

  api_deleteMember: async (store, args) => {
    checkPin(args[0]);
    var memberId = args[1];
    const state = await loadState(store);
    delete state.members[memberId];
    for (const id in state.notifs) {
      if (state.notifs[id].memberId === memberId) delete state.notifs[id];
    }
    await saveState(store, state);
    return true;
  },

  /* ================= 일회성 데이터 이전용 (관리자 암호 필요) =================
   * 기존 Google Apps Script 버전에 저장되어 있던 멤버/알림 데이터를
   * 한 번에 이 저장소로 옮겨 넣을 때만 사용합니다. 이미 존재하는 멤버는
   * 같은 id 로 덮어씁니다(여러 번 실행해도 안전). */
  api_importState: async (store, args) => {
    checkPin(args[0]);
    var incoming = args[1] || {};
    const state = await loadState(store);
    if (incoming.members) {
      for (const id in incoming.members) {
        state.members[id] = incoming.members[id];
      }
    }
    if (incoming.notifs) {
      for (const id in incoming.notifs) {
        state.notifs[id] = incoming.notifs[id];
      }
    }
    await saveState(store, state);
    return { memberCount: Object.keys(state.members).length, notifCount: Object.keys(state.notifs).length };
  },
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* Netlify Functions 2.0 형식 (export default). 주소는 그대로 /.netlify/functions/api 입니다. */
export default async function (req) {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }
  var body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "잘못된 요청입니다." }, 400);
  }
  var fn = body && body.fn;
  var args = (body && body.args) || [];
  var handler = handlers[fn];
  if (!handler) {
    return jsonResponse({ ok: false, error: "알 수 없는 요청입니다: " + fn }, 400);
  }
  try {
    /* consistency: "strong" - 저장 직후 바로 읽어도 최신 값이 보이도록 (기본값은 최대 60초 지연) */
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const result = await handler(store, args);
    return jsonResponse({ ok: true, data: result }, 200);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message || "서버 오류가 발생했습니다." }, e.statusCode || 500);
  }
}
