/**
 * Sliding Maze V27 - account + daily ranking server
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Put the generated HTML beside this file as index.html.
 *
 * Environment:
 *   PORT=3000
 *   SESSION_DAYS=30
 *   COOKIE_SECURE=true
 */

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Math.max(
    1,
    Number(process.env.SESSION_DAYS || 30)
);
const COOKIE_SECURE =
    String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "accounts.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

/* =========================================================
   DATABASE
========================================================= */

function loadData() {
    try {
        const parsed = JSON.parse(
            fs.readFileSync(DATA_FILE, "utf8")
        );

        return {
            accounts:
                parsed.accounts &&
                typeof parsed.accounts === "object"
                    ? parsed.accounts
                    : {},

            nicknames:
                parsed.nicknames &&
                typeof parsed.nicknames === "object"
                    ? parsed.nicknames
                    : {},

            scores:
                parsed.scores &&
                typeof parsed.scores === "object"
                    ? parsed.scores
                    : {}
        };
    } catch {
        return {
            accounts: {},
            nicknames: {},
            scores: {}
        };
    }
}

let db = loadData();

function saveData() {
    const tempFile = DATA_FILE + ".tmp";

    fs.writeFileSync(
        tempFile,
        JSON.stringify(db, null, 2),
        "utf8"
    );

    fs.renameSync(tempFile, DATA_FILE);
}

/* =========================================================
   VALIDATION
========================================================= */

function normalizeId(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function normalizeNickname(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function validId(id) {
    return /^[A-Za-z0-9_]{3,24}$/.test(id);
}

function validNickname(nickname) {
    if (!nickname) return false;

    if (nickname.length < 2) return false;
    if (nickname.length > 16) return false;

    if (/[\u0000-\u001F\u007F]/.test(nickname)) {
        return false;
    }

    return true;
}

/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(
    password,
    salt = crypto.randomBytes(16).toString("hex")
) {
    const hash = crypto
        .scryptSync(String(password), salt, 64)
        .toString("hex");

    return {
        salt,
        hash
    };
}

function verifyPassword(password, stored) {
    try {
        const result = hashPassword(
            password,
            stored.salt
        );

        return crypto.timingSafeEqual(
            Buffer.from(result.hash, "hex"),
            Buffer.from(stored.hash, "hex")
        );
    } catch {
        return false;
    }
}

/* =========================================================
   SESSION
========================================================= */

function randomToken() {
    return crypto.randomBytes(32).toString("base64url");
}

const sessions = new Map();

function createSession(accountId) {
    const token = randomToken();

    sessions.set(token, {
        accountId,
        expiresAt:
            Date.now() +
            SESSION_DAYS * 24 * 60 * 60 * 1000
    });

    return token;
}

function parseCookies(header) {
    const result = {};

    String(header || "")
        .split(";")
        .forEach(part => {
            const index = part.indexOf("=");

            if (index < 0) return;

            const key = part
                .slice(0, index)
                .trim();

            const value = decodeURIComponent(
                part
                    .slice(index + 1)
                    .trim()
            );

            result[key] = value;
        });

    return result;
}

function getSession(req) {
    const cookies = parseCookies(
        req.headers.cookie
    );

    const token = cookies.sliding_session;

    if (!token) {
        return null;
    }

    const session = sessions.get(token);

    if (!session) {
        return null;
    }

    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }

    return {
        token,
        ...session
    };
}

function setSessionCookie(res, token) {
    const parts = [
        `sliding_session=${encodeURIComponent(token)}`,
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${SESSION_DAYS * 86400}`,
        "Path=/"
    ];

    if (COOKIE_SECURE) {
        parts.push("Secure");
    }

    res.setHeader(
        "Set-Cookie",
        parts.join("; ")
    );
}

function clearSessionCookie(res) {
    const parts = [
        "sliding_session=",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
        "Path=/"
    ];

    if (COOKIE_SECURE) {
        parts.push("Secure");
    }

    res.setHeader(
        "Set-Cookie",
        parts.join("; ")
    );
}

function requireAuth(req, res, next) {
    const session = getSession(req);

    if (!session) {
        return res.status(401).json({
            error: "로그인이 필요합니다."
        });
    }

    const account =
        db.accounts[session.accountId];

    if (!account) {
        return res.status(401).json({
            error: "계정을 찾을 수 없습니다."
        });
    }

    req.account = account;
    req.session = session;

    next();
}

/* =========================================================
   DATE
========================================================= */

function todayKey() {
    const d = new Date();

    const year = d.getFullYear();

    const month = String(
        d.getMonth() + 1
    ).padStart(2, "0");

    const day = String(
        d.getDate()
    ).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(
    express.json({
        limit: "16kb"
    })
);

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", (req, res) => {
    const id = normalizeId(req.body.id);

    const nickname = String(
        req.body.nickname || ""
    ).trim();

    const nicknameKey =
        normalizeNickname(nickname);

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

    if (db.accounts[id]) {
        return res.status(409).json({
            error:
                "이미 사용 중인 아이디입니다."
        });
    }

    if (db.nicknames[nicknameKey]) {
        return res.status(409).json({
            error:
                "이미 사용 중인 닉네임입니다."
        });
    }

    const passwordData =
        hashPassword(password);

    const account = {
        id,
        nickname,
        nicknameKey,
        password: passwordData,
        createdAt:
            new Date().toISOString()
    };

    db.accounts[id] = account;

    db.nicknames[nicknameKey] = id;

    saveData();

    const token =
        createSession(id);

    setSessionCookie(
        res,
        token
    );

    res.json({
        user: {
            id: account.id,
            nickname: account.nickname
        }
    });
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", (req, res) => {
    const id = normalizeId(
        req.body.id
    );

    const password = String(
        req.body.password || ""
    );

    const account =
        db.accounts[id];

    if (
        !account ||
        !verifyPassword(
            password,
            account.password
        )
    ) {
        return res.status(401).json({
            error:
                "아이디 또는 비밀번호가 올바르지 않습니다."
        });
    }

    const token =
        createSession(id);

    setSessionCookie(
        res,
        token
    );

    res.json({
        user: {
            id: account.id,
            nickname: account.nickname
        }
    });
});

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
    "/api/me",
    requireAuth,
    (req, res) => {
        res.json({
            id: req.account.id,
            nickname:
                req.account.nickname
        });
    }
);

/* =========================================================
   LOGOUT
========================================================= */

app.post(
    "/api/logout",
    (req, res) => {
        const session =
            getSession(req);

        if (session) {
            sessions.delete(
                session.token
            );
        }

        clearSessionCookie(res);

        res.json({
            ok: true
        });
    }
);

/* =========================================================
   DAILY RANKING
========================================================= */

app.get(
    "/api/ranking/today",
    requireAuth,
    (req, res) => {
        const date = todayKey();

        const rows =
            Object.values(db.scores)
                .filter(
                    row =>
                        row.date === date
                )
                .sort(
                    (a, b) =>
                        b.score - a.score ||
                        b.maxStreak -
                            a.maxStreak ||
                        a.nickname.localeCompare(
                            b.nickname
                        )
                );

        const ranking =
            rows
                .slice(0, 100)
                .map(
                    (row, index) => ({
                        rank: index + 1,
                        nickname:
                            row.nickname,
                        score:
                            row.score,
                        clears:
                            row.clears,
                        maxStreak:
                            row.maxStreak,
                        me:
                            row.accountId ===
                            req.account.id
                    })
                );

        const mineIndex =
            rows.findIndex(
                row =>
                    row.accountId ===
                    req.account.id
            );

        const mine =
            mineIndex >= 0
                ? {
                      rank:
                          mineIndex + 1,
                      score:
                          rows[mineIndex]
                              .score,
                      clears:
                          rows[mineIndex]
                              .clears,
                      maxStreak:
                          rows[mineIndex]
                              .maxStreak
                  }
                : null;

        res.json({
            date,
            ranking,
            mine
        });
    }
);

/* =========================================================
   SAVE DAILY SCORE
========================================================= */

app.post(
    "/api/ranking/score",
    requireAuth,
    (req, res) => {
        const score =
            Number(req.body.score);

        const clears =
            Number(req.body.clears);

        const maxStreak =
            Number(
                req.body.maxStreak
            );

        if (
            !Number.isFinite(score) ||
            !Number.isFinite(clears) ||
            !Number.isFinite(maxStreak)
        ) {
            return res.status(400).json({
                error:
                    "잘못된 점수 데이터입니다."
            });
        }

        const safeClears =
            Math.max(
                0,
                Math.min(
                    100000,
                    Math.floor(clears)
                )
            );

        const safeStreak =
            Math.max(
                0,
                Math.min(
                    safeClears,
                    Math.floor(
                        maxStreak
                    )
                )
            );

        const safeScore =
            Math.max(
                0,
                Math.min(
                    15000000,
                    Math.floor(score)
                )
            );

        const expectedUpperBound =
            safeClears * 100 +
            safeStreak * 50;

        if (
            safeScore >
            expectedUpperBound
        ) {
            return res.status(400).json({
                error:
                    "점수 값이 게임 기록과 맞지 않습니다."
            });
        }

        const date =
            todayKey();

        const key =
            `${date}:${req.account.id}`;

        const old =
            db.scores[key];

        const candidate = {
            date,
            accountId:
                req.account.id,
            nickname:
                req.account.nickname,
            score:
                safeScore,
            clears:
                safeClears,
            maxStreak:
                safeStreak,
            updatedAt:
                new Date().toISOString()
        };

        /*
         * 오늘의 최고 기록만 저장합니다.
         */

        if (
            !old ||
            candidate.score >
                old.score ||
            (
                candidate.score ===
                    old.score &&
                candidate.maxStreak >
                    old.maxStreak
            )
        ) {
            db.scores[key] =
                candidate;

            saveData();

            return res.json({
                saved: true,
                score:
                    candidate.score
            });
        }

        res.json({
            saved: false,
            score: old.score
        });
    }
);

/* =========================================================
   OLD RANKING CLEANUP
========================================================= */

setInterval(
    () => {
        const cutoff =
            new Date();

        cutoff.setDate(
            cutoff.getDate() -
                35
        );

        const cutoffKey =
            `${cutoff.getFullYear()}-${String(
                cutoff.getMonth() + 1
            ).padStart(2, "0")}-${String(
                cutoff.getDate()
            ).padStart(2, "0")}`;

        let changed = false;

        for (
            const [key, row]
            of Object.entries(
                db.scores
            )
        ) {
            if (
                row.date <
                cutoffKey
            ) {
                delete db.scores[key];
                changed = true;
            }
        }

        if (changed) {
            saveData();
        }
    },
    6 * 60 * 60 * 1000
);

/* =========================================================
   STATIC GAME FILES
========================================================= */

app.use(
    express.static(__dirname)
);

/* =========================================================
   FALLBACK
========================================================= */

app.get(
    "*",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "index.html"
            )
        );
    }
);

/* =========================================================
   START
========================================================= */

app.listen(
    PORT,
    () => {
        console.log(
            `Sliding Maze account/ranking server running on port ${PORT}`
        );
    }
);
