/**
 * Sliding Maze V28 - Account + Daily Ranking + Weekly Ranking
 *
 * V28 score:
 * clears * 50 + maxStreak * 100 - skips * 10 - lifeLosses * 10
 *
 * npm install
 * npm start
 */
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 30));
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try {
    const x = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      accounts: x.accounts && typeof x.accounts === "object" ? x.accounts : {},
      nicknames: x.nicknames && typeof x.nicknames === "object" ? x.nicknames : {},
      scores: x.scores && typeof x.scores === "object" ? x.scores : {}
    };
  } catch (_) {
    return { accounts: {}, nicknames: {}, scores: {} };
  }
}
let db = loadData();
function saveData() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function normalizeId(v) { return String(v || "").trim().toLowerCase(); }
function normalizeNickname(v) { return String(v || "").trim().toLowerCase(); }
function validId(v) { return /^[A-Za-z0-9_]{3,24}$/.test(v); }
function validNickname(v) { return v.length >= 2 && v.length <= 16 && !/[\u0000-\u001F\u007F]/.test(v); }

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}
function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.salt || !stored.hash) return false;
    const a = Buffer.from(hashPassword(password, stored.salt).hash, "hex");
    const b = Buffer.from(stored.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

const sessions = new Map();
function createSession(accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { accountId, expiresAt: Date.now() + SESSION_DAYS * 86400000 });
  return token;
}
function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i < 0) return;
    let v = p.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch (_) {}
    out[p.slice(0, i).trim()] = v;
  });
  return out;
}
function getSession(req) {
  const token = parseCookies(req.headers.cookie).sliding_session;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  return { token, ...s };
}
function setSessionCookie(res, token) {
  const p = [`sliding_session=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 86400}`, "Path=/"];
  if (COOKIE_SECURE) p.push("Secure");
  res.setHeader("Set-Cookie", p.join("; "));
}
function clearSessionCookie(res) {
  const p = ["sliding_session=", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Path=/"];
  if (COOKIE_SECURE) p.push("Secure");
  res.setHeader("Set-Cookie", p.join("; "));
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s || !db.accounts[s.accountId]) return res.status(401).json({ error: "로그인이 필요합니다." });
  req.session = s;
  req.account = db.accounts[s.accountId];
  next();
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  x.setDate(x.getDate() + diff);
  return x;
}
function weekKey(d = new Date()) { return dateKey(startOfWeek(d)); }

function calculateScore(clears, maxStreak, skips, lifeLosses) {
  const c = Math.max(0, Math.min(100000, Math.floor(Number(clears) || 0)));
  const s = Math.max(0, Math.min(c, Math.floor(Number(maxStreak) || 0)));
  const k = Math.max(0, Math.min(100000, Math.floor(Number(skips) || 0)));
  const l = Math.max(0, Math.min(100000, Math.floor(Number(lifeLosses) || 0)));
  return Math.max(0, c * 50 + s * 100 - k * 10 - l * 10);
}

app.use(express.json({ limit: "16kb" }));

app.post("/api/register", (req, res) => {
  const id = normalizeId(req.body.id);
  const nickname = String(req.body.nickname || "").trim();
  const nk = normalizeNickname(nickname);
  const password = String(req.body.password || "");
  if (!validId(id)) return res.status(400).json({ error: "아이디는 영문/숫자/_ 3~24자로 입력해주세요." });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: "비밀번호는 8~72자로 입력해주세요." });
  if (!validNickname(nickname)) return res.status(400).json({ error: "닉네임은 2~16자로 입력해주세요." });
  if (db.accounts[id]) return res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
  if (db.nicknames[nk]) return res.status(409).json({ error: "이미 사용 중인 닉네임입니다." });
  db.accounts[id] = { id, nickname, nicknameKey: nk, password: hashPassword(password), createdAt: new Date().toISOString() };
  db.nicknames[nk] = id;
  saveData();
  setSessionCookie(res, createSession(id));
  res.json({ user: { id, nickname } });
});

app.post("/api/login", (req, res) => {
  const id = normalizeId(req.body.id);
  const account = db.accounts[id];
  if (!account || !verifyPassword(String(req.body.password || ""), account.password)) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
  setSessionCookie(res, createSession(id));
  res.json({ user: { id: account.id, nickname: account.nickname } });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ id: req.account.id, nickname: req.account.nickname }));
app.post("/api/logout", (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

function rankingRows(scope) {
  const today = dateKey();
  const week = weekKey();
  const rows = Object.values(db.scores).filter(r => scope === "daily" ? r.date === today : r.week === week);
  rows.sort((a,b) => b.score-a.score || b.maxStreak-a.maxStreak || b.clears-a.clears || a.lifeLosses-b.lifeLosses || a.skips-b.skips || String(a.nickname).localeCompare(String(b.nickname)));
  return rows;
}
function formatRanking(rows, accountId) {
  return rows.slice(0,100).map((r,i) => ({ rank:i+1, nickname:r.nickname, score:r.score, clears:r.clears, maxStreak:r.maxStreak, skips:r.skips, lifeLosses:r.lifeLosses, me:r.accountId===accountId }));
}

app.get("/api/ranking/today", requireAuth, (req,res) => {
  const rows = rankingRows("daily");
  const idx = rows.findIndex(r => r.accountId === req.account.id);
  res.json({ date: dateKey(), ranking: formatRanking(rows, req.account.id), mine: idx >= 0 ? { rank:idx+1, ...rows[idx] } : null });
});

app.get("/api/ranking/weekly", requireAuth, (req,res) => {
  const rows = rankingRows("weekly");
  const idx = rows.findIndex(r => r.accountId === req.account.id);
  res.json({ week: weekKey(), weekEnds: dateKey(new Date(startOfWeek().getTime()+6*86400000)), ranking: formatRanking(rows, req.account.id), mine: idx >= 0 ? { rank:idx+1, ...rows[idx] } : null });
});

app.post("/api/ranking/score", requireAuth, (req,res) => {
  const clears = Number(req.body.clears);
  const maxStreak = Number(req.body.maxStreak);
  const skips = Number(req.body.skips);
  const lifeLosses = Number(req.body.lifeLosses);
  if (![clears,maxStreak,skips,lifeLosses].every(Number.isFinite)) return res.status(400).json({ error:"잘못된 게임 기록입니다." });
  const c = Math.max(0, Math.min(100000, Math.floor(clears)));
  const s = Math.max(0, Math.min(c, Math.floor(maxStreak)));
  const k = Math.max(0, Math.min(100000, Math.floor(skips)));
  const l = Math.max(0, Math.min(100000, Math.floor(lifeLosses)));
  const score = calculateScore(c,s,k,l);
  const date = dateKey();
  const week = weekKey();
  const key = `${date}:${req.account.id}`;
  const old = db.scores[key];
  const candidate = { date, week, accountId:req.account.id, nickname:req.account.nickname, score, clears:c, maxStreak:s, skips:k, lifeLosses:l, updatedAt:new Date().toISOString() };
  const better = !old || score > old.score || (score === old.score && s > old.maxStreak) || (score === old.score && s === old.maxStreak && c > old.clears) || (score === old.score && s === old.maxStreak && c === old.clears && l < old.lifeLosses) || (score === old.score && s === old.maxStreak && c === old.clears && l === old.lifeLosses && k < old.skips);
  if (better) { db.scores[key] = candidate; saveData(); }
  res.json({ saved:better, score:better ? score : old.score, record:better ? candidate : old });
});

app.get("/api/ranking/me", requireAuth, (req,res) => {
  const rows = rankingRows("daily");
  const idx = rows.findIndex(r => r.accountId === req.account.id);
  const key = `${dateKey()}:${req.account.id}`;
  res.json({ record:db.scores[key] || null, rank:idx >= 0 ? idx+1 : null });
});

app.get("/api/ranking/weekly/me", requireAuth, (req,res) => {
  const rows = rankingRows("weekly");
  const idx = rows.findIndex(r => r.accountId === req.account.id);
  const records = Object.values(db.scores).filter(r => r.week === weekKey() && r.accountId === req.account.id);
  records.sort((a,b)=>b.score-a.score);
  res.json({ record:records[0] || null, rank:idx >= 0 ? idx+1 : null });
});

app.get("/api/health", (req,res) => res.json({ ok:true, version:"V28", dailyRanking:true, weeklyRanking:true, scoreFormula:"clears * 50 + maxStreak * 100 - skips * 10 - lifeLosses * 10" }));

setInterval(() => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate()-35);
  const key = dateKey(cutoff);
  let changed=false;
  for (const [k,r] of Object.entries(db.scores)) {
    if (!r || !r.date || r.date < key) { delete db.scores[k]; changed=true; }
  }
  if (changed) saveData();
}, 6*60*60*1000);

setInterval(() => {
  const now=Date.now();
  for (const [token,s] of sessions) if (!s || s.expiresAt<=now) sessions.delete(token);
}, 60*60*1000);

app.use(express.static(__dirname));
app.get("*", (req,res) => res.sendFile(path.join(__dirname,"index.html")));

app.listen(PORT, () => {
  console.log(`Sliding Maze V28 server running on port ${PORT}`);
  console.log("Daily ranking: ON");
  console.log("Weekly ranking: ON (Monday-Sunday)");
  console.log("Score: clears*50 + maxStreak*100 - skips*10 - lifeLosses*10");
});
