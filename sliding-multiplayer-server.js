/**
 * Sliding Maze V29 - Supabase persistent account + ranking + multiplayer
 *
 * Score:
 * clears * 50 + maxStreak * 100 - skips * 10 - lifeLosses * 10
 *
 * Required Render Environment Variables:
 *   SUPABASE_URL=https://xxxxxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   ALLOWED_ORIGIN=https://joumi0822.github.io
 *   COOKIE_SECURE=true
 *
 * Optional:
 *   PORT=3000
 *   SESSION_DAYS=30
 *   COOKIE_SECRET=long-random-secret
 *   APP_TIME_ZONE=Asia/Seoul
 */

"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 30));
const COOKIE_SECURE =
  String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";

const ALLOWED_ORIGIN =
  String(process.env.ALLOWED_ORIGIN || "").trim().replace(/\/+$/, "");

const SUPABASE_URL =
  String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");

const SUPABASE_SERVICE_ROLE_KEY =
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const COOKIE_SECRET =
  String(
    process.env.COOKIE_SECRET ||
      crypto.randomBytes(32).toString("hex")
  );

const APP_TIME_ZONE =
  String(process.env.APP_TIME_ZONE || "Asia/Seoul");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

/* =========================================================
   기본 미들웨어 / CORS
========================================================= */

app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");

  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,OPTIONS"
    );
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* =========================================================
   Supabase REST
   - pg 패키지가 필요하지 않도록 REST API를 사용합니다.
   - service_role key는 서버 환경변수에서만 읽습니다.
========================================================= */

const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;

async function supabaseRequest(
  table,
  {
    method = "GET",
    query = "",
    body = undefined,
    headers = {}
  } = {}
) {
  const response = await fetch(
    `${SUPABASE_REST}/${table}${query ? `?${query}` : ""}`,
    {
      method,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...headers
      },
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body)
    }
  );

  const text = await response.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object"
        ? data.message || data.error || data.hint
        : String(data || response.statusText);

    const error = new Error(
      `Supabase ${response.status}: ${message}`
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

async function findAccount(id) {
  const rows = await supabaseRequest("accounts", {
    query:
      `select=id,nickname,nickname_key,password_hash,created_at` +
      `&id=eq.${encodeURIComponent(id)}` +
      `&limit=1`
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function findNickname(nicknameKey) {
  const rows = await supabaseRequest("accounts", {
    query:
      `select=id` +
      `&nickname_key=eq.${encodeURIComponent(nicknameKey)}` +
      `&limit=1`
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function insertAccount(account) {
  const rows = await supabaseRequest("accounts", {
    method: "POST",
    query: "select=id,nickname,created_at",
    headers: {
      Prefer: "return=representation"
    },
    body: account
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

/* =========================================================
   입력 검증 / 비밀번호
========================================================= */

function normalizeId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeNickname(value) {
  return String(value || "").trim().toLowerCase();
}

function validId(value) {
  return /^[A-Za-z0-9_]{3,24}$/.test(value);
}

function validNickname(value) {
  return (
    value.length >= 2 &&
    value.length <= 16 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString("hex")
) {
  return {
    salt,
    hash: crypto
      .scryptSync(String(password), salt, 64)
      .toString("hex")
  };
}

function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.salt || !stored.hash) return false;

    const a = Buffer.from(
      hashPassword(password, stored.salt).hash,
      "hex"
    );

    const b = Buffer.from(stored.hash, "hex");

    return (
      a.length === b.length &&
      crypto.timingSafeEqual(a, b)
    );
  } catch (_) {
    return false;
  }
}

/* =========================================================
   Stateless signed session cookie
   - Render 재시작 후에도 세션이 유지됩니다.
========================================================= */

function signSession(payload) {
  const encoded = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", COOKIE_SECRET)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

function verifySession(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) return null;

    const [encoded, signature] = parts;

    const expected = crypto
      .createHmac("sha256", COOKIE_SECRET)
      .update(encoded)
      .digest("base64url");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );

    if (
      !payload ||
      !payload.accountId ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return payload;
  } catch (_) {
    return null;
  }
}

function parseCookies(header) {
  const result = {};

  String(header || "")
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index < 0) return;

      const key = part.slice(0, index).trim();
      let value = part.slice(index + 1).trim();

      try {
        value = decodeURIComponent(value);
      } catch (_) {}

      result[key] = value;
    });

  return result;
}

function createSessionToken(accountId) {
  return signSession({
    accountId,
    expiresAt:
      Date.now() + SESSION_DAYS * 86400000
  });
}

function setSessionCookie(res, token) {
  const parts = [
    `sliding_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_DAYS * 86400}`
  ];

  /*
   * GitHub Pages -> Render는 cross-site 요청입니다.
   * Secure + SameSite=None이 필요합니다.
   */
  if (COOKIE_SECURE) {
    parts.push("Secure", "SameSite=None");
  } else {
    parts.push("SameSite=Lax");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    "sliding_session=",
    "HttpOnly",
    "Path=/",
    "Max-Age=0"
  ];

  if (COOKIE_SECURE) {
    parts.push("Secure", "SameSite=None");
  } else {
    parts.push("SameSite=Lax");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

async function getSessionAccount(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifySession(cookies.sliding_session);

  if (!payload) return null;

  return findAccount(payload.accountId);
}

async function requireAuth(req, res, next) {
  try {
    const account = await getSessionAccount(req);

    if (!account) {
      return res
        .status(401)
        .json({ error: "로그인이 필요합니다." });
    }

    req.account = account;
    next();
  } catch (error) {
    console.error("auth error:", error);
    res
      .status(500)
      .json({ error: "인증 처리 중 오류가 발생했습니다." });
  }
}

/* =========================================================
   날짜 / 주간 랭킹
   - 기본 Asia/Seoul
   - 월요일 시작
========================================================= */

function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(date);

  const out = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      out[part.type] = part.value;
    }
  }

  return out;
}

function startOfWeekDateKey(date = new Date()) {
  const p = zonedParts(date);

  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);

  const current = new Date(
    Date.UTC(year, month - 1, day)
  );

  const weekdays = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  const weekday = weekdays[p.weekday] ?? 1;
  const diff = weekday === 0 ? -6 : 1 - weekday;

  current.setUTCDate(
    current.getUTCDate() + diff
  );

  return current
    .toISOString()
    .slice(0, 10);
}

function weekKey(date = new Date()) {
  return startOfWeekDateKey(date);
}

/* =========================================================
   점수
========================================================= */

function calculateScore(
  clears,
  maxStreak,
  skips,
  lifeLosses
) {
  const c = Math.max(
    0,
    Math.min(100000, Math.floor(Number(clears) || 0))
  );

  const s = Math.max(
    0,
    Math.min(c, Math.floor(Number(maxStreak) || 0))
  );

  const k = Math.max(
    0,
    Math.min(100000, Math.floor(Number(skips) || 0))
  );

  const l = Math.max(
    0,
    Math.min(100000, Math.floor(Number(lifeLosses) || 0))
  );

  return Math.max(
    0,
    c * 50 +
      s * 100 -
      k * 10 -
      l * 10
  );
}

/* =========================================================
   회원가입 / 로그인
========================================================= */

app.post("/api/register", async (req, res) => {
  try {
    const id = normalizeId(req.body.id);
    const nickname = String(
      req.body.nickname || ""
    ).trim();

    const nicknameKey = normalizeNickname(nickname);
    const password = String(
      req.body.password || ""
    );

    if (!validId(id)) {
      return res.status(400).json({
        error:
          "아이디는 영문/숫자/_ 3~24자로 입력해주세요."
      });
    }

    if (
      password.length < 8 ||
      password.length > 72
    ) {
      return res.status(400).json({
        error:
          "비밀번호는 8~72자로 입력해주세요."
      });
    }

    if (!validNickname(nickname)) {
      return res.status(400).json({
        error:
          "닉네임은 2~16자로 입력해주세요."
      });
    }

    if (await findAccount(id)) {
      return res.status(409).json({
        error: "이미 사용 중인 아이디입니다."
      });
    }

    if (await findNickname(nicknameKey)) {
      return res.status(409).json({
        error: "이미 사용 중인 닉네임입니다."
      });
    }

    const passwordData =
      hashPassword(password);

    const created = await insertAccount({
      id,
      nickname,
      nickname_key: nicknameKey,
      password_hash: JSON.stringify(passwordData)
    });

    if (!created) {
      throw new Error(
        "회원 계정 생성 결과를 확인할 수 없습니다."
      );
    }

    /*
     * 기존 V28 UX와 동일하게 회원가입 직후에는
     * 로그인 화면으로 돌아가도록 합니다.
     */
    clearSessionCookie(res);

    res.json({
      user: {
        id,
        nickname
      }
    });
  } catch (error) {
    console.error("register error:", error);

    if (error.status === 409) {
      return res.status(409).json({
        error: "이미 사용 중인 아이디 또는 닉네임입니다."
      });
    }

    res.status(500).json({
      error:
        "회원가입 처리 중 오류가 발생했습니다."
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const id = normalizeId(req.body.id);
    const password = String(
      req.body.password || ""
    );

    const account = await findAccount(id);

    if (!account) {
      return res.status(401).json({
        error:
          "아이디 또는 비밀번호가 올바르지 않습니다."
      });
    }

    let storedPassword;

    try {
      storedPassword =
        typeof account.password_hash === "string"
          ? JSON.parse(account.password_hash)
          : account.password_hash;
    } catch (_) {
      storedPassword = null;
    }

    if (
      !verifyPassword(
        password,
        storedPassword
      )
    ) {
      return res.status(401).json({
        error:
          "아이디 또는 비밀번호가 올바르지 않습니다."
      });
    }

    const token =
      createSessionToken(account.id);

    setSessionCookie(res, token);

    res.json({
      user: {
        id: account.id,
        nickname: account.nickname
      }
    });
  } catch (error) {
    console.error("login error:", error);

    res.status(500).json({
      error:
        "로그인 처리 중 오류가 발생했습니다."
    });
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    id: req.account.id,
    nickname: req.account.nickname
  });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* =========================================================
   랭킹 저장
========================================================= */

async function findDailyScore(accountId, date) {
  const rows = await supabaseRequest(
    "game_scores",
    {
      query:
        `select=*` +
        `&account_id=eq.${encodeURIComponent(accountId)}` +
        `&created_at=gte.${encodeURIComponent(
          `${date}T00:00:00`
        )}` +
        `&created_at=lt.${encodeURIComponent(
          `${date}T23:59:59.999999`
        )}` +
        `&order=score.desc` +
        `&limit=1`
    }
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

function scoreIsBetter(candidate, old) {
  if (!old) return true;

  if (candidate.score !== old.score) {
    return candidate.score > old.score;
  }

  if (candidate.maxStreak !== old.max_streak) {
    return candidate.maxStreak > old.max_streak;
  }

  if (candidate.clears !== old.clears) {
    return candidate.clears > old.clears;
  }

  if (candidate.lifeLosses !== old.life_losses) {
    return candidate.lifeLosses < old.life_losses;
  }

  return candidate.skips < old.skips;
}

app.post(
  "/api/ranking/score",
  requireAuth,
  async (req, res) => {
    try {
      const values = [
        Number(req.body.clears),
        Number(req.body.maxStreak),
        Number(req.body.skips),
        Number(req.body.lifeLosses)
      ];

      if (!values.every(Number.isFinite)) {
        return res.status(400).json({
          error: "잘못된 게임 기록입니다."
        });
      }

      const [
        clears,
        maxStreak,
        skips,
        lifeLosses
      ] = values;

      const c = Math.max(
        0,
        Math.min(100000, Math.floor(clears))
      );

      const s = Math.max(
        0,
        Math.min(c, Math.floor(maxStreak))
      );

      const k = Math.max(
        0,
        Math.min(100000, Math.floor(skips))
      );

      const l = Math.max(
        0,
        Math.min(100000, Math.floor(lifeLosses))
      );

      const score = calculateScore(
        c,
        s,
        k,
        l
      );

      const today = dateKey();

      const candidate = {
        account_id: req.account.id,
        clears: c,
        max_streak: s,
        skips: k,
        life_losses: l,
        score
      };

      const old =
        await findDailyScore(
          req.account.id,
          today
        );

      if (!scoreIsBetter(candidate, old)) {
        return res.json({
          saved: false,
          score: old ? old.score : score,
          record: old || candidate
        });
      }

      if (old) {
        const updated =
          await supabaseRequest(
            "game_scores",
            {
              method: "PATCH",
              query:
                `id=eq.${encodeURIComponent(old.id)}`,
              headers: {
                Prefer: "return=representation"
              },
              body: {
                ...candidate,
                updated_at:
                  new Date().toISOString()
              }
            }
          );

        return res.json({
          saved: true,
          score,
          record:
            Array.isArray(updated)
              ? updated[0] || candidate
              : candidate
        });
      }

      const inserted =
        await supabaseRequest(
          "game_scores",
          {
            method: "POST",
            query: "select=*",
            headers: {
              Prefer: "return=representation"
            },
            body: candidate
          }
        );

      res.json({
        saved: true,
        score,
        record:
          Array.isArray(inserted)
            ? inserted[0] || candidate
            : candidate
      });
    } catch (error) {
      console.error(
        "ranking score error:",
        error
      );

      res.status(500).json({
        error:
          "점수 저장 중 오류가 발생했습니다."
      });
    }
  }
);

/* =========================================================
   랭킹 조회
========================================================= */

function sortRankingRows(rows) {
  return rows.sort((a, b) => {
    return (
      Number(b.score || 0) -
        Number(a.score || 0) ||
      Number(b.max_streak || 0) -
        Number(a.max_streak || 0) ||
      Number(b.clears || 0) -
        Number(a.clears || 0) ||
      Number(a.life_losses || 0) -
        Number(b.life_losses || 0) ||
      Number(a.skips || 0) -
        Number(b.skips || 0) ||
      String(a.nickname || "").localeCompare(
        String(b.nickname || "")
      )
    );
  });
}

function formatRankingRows(
  rows,
  accountId
) {
  return rows
    .slice(0, 100)
    .map((row, index) => ({
      rank: index + 1,
      nickname: row.nickname,
      score: Number(row.score || 0),
      clears: Number(row.clears || 0),
      maxStreak: Number(row.max_streak || 0),
      skips: Number(row.skips || 0),
      lifeLosses: Number(
        row.life_losses || 0
      ),
      me: row.account_id === accountId
    }));
}

async function getAllScores() {
  return supabaseRequest(
    "game_scores",
    {
      query:
        "select=id,account_id,clears,max_streak,skips,life_losses,score,created_at,updated_at&limit=10000"
    }
  );
}

async function attachNicknames(rows) {
  const ids = [
    ...new Set(
      rows
        .map((r) => r.account_id)
        .filter(Boolean)
    )
  ];

  if (!ids.length) return [];

  const accounts =
    await supabaseRequest(
      "accounts",
      {
        query:
          `select=id,nickname` +
          `&id=in.(${ids
            .map((id) => encodeURIComponent(id))
            .join(",")})` +
          `&limit=1000`
      }
    );

  const map = new Map(
    (Array.isArray(accounts)
      ? accounts
      : []
    ).map((a) => [
      a.id,
      a.nickname
    ])
  );

  return rows.map((row) => ({
    ...row,
    nickname:
      map.get(row.account_id) ||
      row.account_id
  }));
}

app.get(
  "/api/ranking/today",
  requireAuth,
  async (req, res) => {
    try {
      const today = dateKey();

      let rows = await getAllScores();

      rows = rows.filter(
        (row) =>
          String(row.created_at || "")
            .slice(0, 10) === today
      );

      rows = await attachNicknames(rows);
      rows = sortRankingRows(rows);

      const rankIndex =
        rows.findIndex(
          (row) =>
            row.account_id ===
            req.account.id
        );

      res.json({
        date: today,
        ranking: formatRankingRows(
          rows,
          req.account.id
        ),
        rows: formatRankingRows(
          rows,
          req.account.id
        ),
        mine:
          rankIndex >= 0
            ? {
                rank: rankIndex + 1,
                ...rows[rankIndex]
              }
            : null
      });
    } catch (error) {
      console.error(
        "today ranking error:",
        error
      );

      res.status(500).json({
        error:
          "오늘 랭킹을 불러오지 못했습니다."
      });
    }
  }
);

app.get(
  "/api/ranking/weekly",
  requireAuth,
  async (req, res) => {
    try {
      const weekStart =
        weekKey();

      const allRows =
        await getAllScores();

      const weekRows =
        allRows.filter(
          (row) =>
            String(row.created_at || "")
              .slice(0, 10) >= weekStart
        );

      const namedRows =
        await attachNicknames(
          weekRows
        );

      /*
       * 이번 주에는 한 계정당 가장 높은 일일 기록
       * 하나만 사용합니다. 같은 사람이 월~일 여러 번
       * 중복해서 표시되지 않습니다.
       */
      const bestByAccount = new Map();

      for (const row of namedRows) {
        const old =
          bestByAccount.get(
            row.account_id
          );

        if (
          !old ||
          scoreIsBetter(
            {
              score: Number(row.score || 0),
              maxStreak: Number(
                row.max_streak || 0
              ),
              clears: Number(
                row.clears || 0
              ),
              lifeLosses: Number(
                row.life_losses || 0
              ),
              skips: Number(
                row.skips || 0
              )
            },
            old
          )
        ) {
          bestByAccount.set(
            row.account_id,
            row
          );
        }
      }

      const rows =
        sortRankingRows(
          [...bestByAccount.values()]
        );

      const rankIndex =
        rows.findIndex(
          (row) =>
            row.account_id ===
            req.account.id
        );

      res.json({
        week: weekStart,
        ranking: formatRankingRows(
          rows,
          req.account.id
        ),
        rows: formatRankingRows(
          rows,
          req.account.id
        ),
        mine:
          rankIndex >= 0
            ? {
                rank: rankIndex + 1,
                ...rows[rankIndex]
              }
            : null
      });
    } catch (error) {
      console.error(
        "weekly ranking error:",
        error
      );

      res.status(500).json({
        error:
          "주간 랭킹을 불러오지 못했습니다."
      });
    }
  }
);

app.get(
  "/api/ranking/me",
  requireAuth,
  async (req, res) => {
    try {
      const today = dateKey();
      const allRows =
        await getAllScores();

      const rows =
        await attachNicknames(
          allRows.filter(
            (row) =>
              String(row.created_at || "")
                .slice(0, 10) === today
          )
        );

      sortRankingRows(rows);

      const mine =
        rows.find(
          (row) =>
            row.account_id ===
            req.account.id
        ) || null;

      res.json({
        record: mine,
        rank: mine
          ? rows.indexOf(mine) + 1
          : null
      });
    } catch (error) {
      console.error(
        "my ranking error:",
        error
      );

      res.status(500).json({
        error:
          "내 랭킹을 불러오지 못했습니다."
      });
    }
  }
);

app.get(
  "/api/ranking/weekly/me",
  requireAuth,
  async (req, res) => {
    try {
      const weekStart =
        weekKey();

      const allRows =
        await getAllScores();

      const rows =
        await attachNicknames(
          allRows.filter(
            (row) =>
              String(row.created_at || "")
                .slice(0, 10) >= weekStart
          )
        );

      const bestByAccount = new Map();

      for (const row of rows) {
        const old =
          bestByAccount.get(
            row.account_id
          );

        if (
          !old ||
          scoreIsBetter(
            {
              score: Number(row.score || 0),
              maxStreak: Number(
                row.max_streak || 0
              ),
              clears: Number(
                row.clears || 0
              ),
              lifeLosses: Number(
                row.life_losses || 0
              ),
              skips: Number(
                row.skips || 0
              )
            },
            old
          )
        ) {
          bestByAccount.set(
            row.account_id,
            row
          );
        }
      }

      const ranked =
        sortRankingRows(
          [...bestByAccount.values()]
        );

      const mine =
        ranked.find(
          (row) =>
            row.account_id ===
            req.account.id
        ) || null;

      res.json({
        record: mine,
        rank: mine
          ? ranked.indexOf(mine) + 1
          : null
      });
    } catch (error) {
      console.error(
        "my weekly ranking error:",
        error
      );

      res.status(500).json({
        error:
          "내 주간 랭킹을 불러오지 못했습니다."
      });
    }
  }
);

/* =========================================================
   Health
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "V29",
    database: "supabase",
    dailyRanking: true,
    weeklyRanking: true,
    persistentAccounts: true,
    persistentRanking: true,
    multiplayer: true,
    scoreFormula:
      "clears * 50 + maxStreak * 100 - skips * 10 - lifeLosses * 10"
  });
});

/* =========================================================
   WebSocket 멀티플레이 서버
   기존 V28 클라이언트 프로토콜과 호환
========================================================= */

const wss = new WebSocketServer({
  server,
  path: "/"
});

const rooms = new Map();
const matchmakingQueue = [];

function safeSend(ws, data) {
  if (
    ws &&
    ws.readyState === 1
  ) {
    try {
      ws.send(
        JSON.stringify(data)
      );
    } catch (_) {}
  }
}

function removeFromQueue(ws) {
  const index =
    matchmakingQueue.indexOf(ws);

  if (index >= 0) {
    matchmakingQueue.splice(
      index,
      1
    );
  }
}

function getRoomClients(room) {
  return [
    room.host,
    room.guest
  ].filter(
    (ws) =>
      ws &&
      ws.readyState === 1
  );
}

function otherClient(room, ws) {
  return room.host === ws
    ? room.guest
    : room.host;
}

function createRoom(roomCode, host) {
  const room = {
    code: roomCode,
    host,
    guest: null,
    round: 0,
    finishedRounds: new Map(),
    createdAt: Date.now()
  };

  rooms.set(roomCode, room);
  host.__room = room;
  host.__role = "host";

  return room;
}

function sendPeerJoined(room) {
  for (const ws of getRoomClients(room)) {
    safeSend(ws, {
      type: "peerJoined"
    });
  }
}

function startQuickMatch(a, b) {
  const roomCode =
    `Q${crypto
      .randomBytes(5)
      .toString("hex")
      .slice(0, 8)
      .toUpperCase()}`;

  const room =
    createRoom(roomCode, a);

  room.guest = b;

  a.__room = room;
  a.__role = "host";

  b.__room = room;
  b.__role = "guest";

  safeSend(a, {
    type: "matchFound",
    role: "host"
  });

  safeSend(b, {
    type: "matchFound",
    role: "guest"
  });
}

function tryMatchmake() {
  while (
    matchmakingQueue.length >= 2
  ) {
    const a =
      matchmakingQueue.shift();

    const b =
      matchmakingQueue.shift();

    if (
      !a ||
      !b ||
      a.readyState !== 1 ||
      b.readyState !== 1
    ) {
      continue;
    }

    startQuickMatch(a, b);
  }
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function relayToPeer(ws, data) {
  const room = ws.__room;
  if (!room) return;

  safeSend(
    otherClient(room, ws),
    data
  );
}

function handleWsMessage(ws, data) {
  const type = String(
    data && data.type || ""
  );

  if (type === "matchmake") {
    removeFromQueue(ws);

    if (ws.__room) {
      safeSend(ws, {
        type: "error",
        message:
          "이미 다른 방에 연결되어 있습니다."
      });
      return;
    }

    matchmakingQueue.push(ws);
    tryMatchmake();
    return;
  }

  if (type === "create") {
    const roomCode =
      normalizeRoomCode(
        data.room
      );

    if (
      !/^[A-Z0-9]{5}$/.test(
        roomCode
      )
    ) {
      safeSend(ws, {
        type: "error",
        message:
          "방 코드는 영문/숫자 5자리여야 합니다."
      });
      return;
    }

    if (rooms.has(roomCode)) {
      safeSend(ws, {
        type: "error",
        message:
          "이미 사용 중인 방 코드입니다."
      });
      return;
    }

    removeFromQueue(ws);

    const room =
      createRoom(
        roomCode,
        ws
      );

    safeSend(ws, {
      type: "roomCreated",
      room: room.code
    });

    return;
  }

  if (type === "join") {
    const roomCode =
      normalizeRoomCode(
        data.room
      );

    const room =
      rooms.get(roomCode);

    if (!room) {
      safeSend(ws, {
        type: "error",
        message:
          "존재하지 않는 방입니다."
      });
      return;
    }

    if (
      room.guest &&
      room.guest !== ws &&
      room.guest.readyState === 1
    ) {
      safeSend(ws, {
        type: "error",
        message:
          "방이 가득 찼습니다."
      });
      return;
    }

    removeFromQueue(ws);

    room.guest = ws;
    ws.__room = room;
    ws.__role = "guest";

    safeSend(ws, {
      type: "roomJoined",
      room: room.code
    });

    sendPeerJoined(room);
    return;
  }

  const room = ws.__room;

  if (!room) {
    safeSend(ws, {
      type: "error",
      message:
        "먼저 방을 만들거나 참가해주세요."
    });
    return;
  }

  if (type === "finish") {
    const round =
      Number(data.round || 0);

    if (!round) return;

    if (
      room.finishedRounds.has(
        round
      )
    ) {
      return;
    }

    room.finishedRounds.set(
      round,
      {
        winner:
          ws.__role,
        position:
          data.position || null
      }
    );

    safeSend(
      room.host,
      {
        type: "roundWon",
        round,
        winner: ws.__role,
        nextStart:
          data.position || null
      }
    );

    safeSend(
      room.guest,
      {
        type: "roundWon",
        round,
        winner: ws.__role,
        nextStart:
          data.position || null
      }
    );

    return;
  }

  if (type === "eliminated") {
    const livesRemaining = Math.max(
      0,
      Number(data.livesRemaining) || 0
    );

    relayToPeer(ws, {
      type: "eliminated",
      round:
        Number(data.round || 0),
      livesRemaining,
      position:
        data.position || null
    });

    if (livesRemaining <= 0) {
      const winner =
        ws.__role === "host"
          ? "guest"
          : "host";

      for (const client of
        getRoomClients(room)) {
        safeSend(client, {
          type: "matchOver",
          winner
        });
      }
    }

    return;
  }

  /*
   * position / matchStart 및 향후 추가 메시지는
   * 상대에게 그대로 전달합니다.
   *
   * matchStart는 방장이 보내므로 guest가 받습니다.
   * position은 반대 플레이어가 받습니다.
   */
  relayToPeer(ws, data);
}

wss.on("connection", (ws) => {
  ws.__room = null;
  ws.__role = null;
  ws.__closedHandled = false;

  ws.on("message", (raw) => {
    try {
      const data =
        JSON.parse(
          raw.toString()
        );

      if (
        !data ||
        typeof data !== "object"
      ) {
        return;
      }

      handleWsMessage(
        ws,
        data
      );
    } catch (error) {
      safeSend(ws, {
        type: "error",
        message:
          "잘못된 서버 메시지입니다."
      });
    }
  });

  ws.on("close", () => {
    if (ws.__closedHandled) return;
    ws.__closedHandled = true;

    removeFromQueue(ws);

    const room = ws.__room;

    if (!room) return;

    const peer =
      otherClient(room, ws);

    if (
      peer &&
      peer.readyState === 1
    ) {
      safeSend(peer, {
        type: "peerLeft"
      });

      setTimeout(() => {
        if (
          !peer ||
          peer.readyState !== 1
        ) {
          return;
        }

        /*
         * 상대가 10초 안에 재접속하면
         * 같은 방의 peerJoined 처리로 계속 진행할 수 있습니다.
         * 이미 다른 방에 있지 않은 경우에만 결과를 종료합니다.
         */
        if (
          peer.__room === room
        ) {
          const winner =
            peer.__role === "host"
              ? "host"
              : "guest";

          safeSend(peer, {
            type: "playerLeftTimeout",
            winner
          });

          peer.__room = null;
          peer.__role = null;

          if (
            rooms.get(room.code) ===
            room
          ) {
            rooms.delete(
              room.code
            );
          }
        }
      }, 10000);
    }

    if (
      rooms.get(room.code) ===
      room &&
      !peer
    ) {
      rooms.delete(
        room.code
      );
    }
  });
});

/* =========================================================
   정리
========================================================= */

setInterval(() => {
  const now =
    Date.now();

  for (const [code, room] of rooms) {
    const clients =
      getRoomClients(room);

    if (
      clients.length === 0 &&
      now - room.createdAt > 60000
    ) {
      rooms.delete(code);
    }
  }

  /*
   * 오래된 매칭 대기 소켓 제거
   */
  for (
    let i =
      matchmakingQueue.length - 1;
    i >= 0;
    i--
  ) {
    const ws =
      matchmakingQueue[i];

    if (
      !ws ||
      ws.readyState !== 1
    ) {
      matchmakingQueue.splice(
        i,
        1
      );
    }
  }
}, 30000);

/* =========================================================
   정적 파일
========================================================= */

app.use(
  express.static(__dirname)
);

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );
});

/* =========================================================
   시작
========================================================= */

server.listen(PORT, () => {
  console.log(
    `Sliding Maze V29 server running on port ${PORT}`
  );

  console.log(
    "Supabase persistence: ON"
  );

  console.log(
    "Daily ranking: ON"
  );

  console.log(
    "Weekly ranking: ON"
  );

  console.log(
    "Multiplayer WebSocket: ON"
  );

  console.log(
    "Score: clears*50 + maxStreak*100 - skips*10 - lifeLosses*10"
  );
});
