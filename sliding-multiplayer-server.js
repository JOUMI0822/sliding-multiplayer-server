/* =========================================================
   V29 Multiplayer WebSocket relay (수정본)
========================================================= */

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const quickQueue = [];
const rooms = new Map();
const socketState = new Map();
let nextWsDebugId = 1;

function quickDebug(ws, event, extra = {}) {
  const state = socketState.get(ws) || { room: null, role: null };
  const room = state.room ? rooms.get(state.room) : null;
  console.log("[QUICK DEBUG]", JSON.stringify({
    time: new Date().toISOString(),
    event,
    ws: ws?._quickDebugId || null,
    room: state.room || null,
    role: state.role || null,
    queueLength: quickQueue.length,
    roomType: room?.type || null,
    started: room?.started ?? null,
    over: room?.over ?? null,
    ...extra
  }));
}

function wsSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch (_) {}
}

function removeFromQueue(ws) {
  for (let i = quickQueue.length - 1; i >= 0; i--) {
    if (quickQueue[i] === ws) quickQueue.splice(i, 1);
  }
}

function makeRoomState(room, host, guest, type) {
  return {
    room,
    host,
    guest,
    type,
    round: 0,
    started: false,       // 첫 matchStart가 전달된 뒤 true
    over: false,          // matchOver / 기권 처리 뒤 true (이후 알림 전송 금지)
    roundResolved: null,
    finishes: new Map(),
    eliminated: new Map(),
    finishResolveTimer: null,
    finishResolveRound: null,
    lastStart: null,
    quickGuestReady: false,
    quickHostReady: false,
    quickStartRequested: false,
    quickReadyTimer: null
  };
}

function peerOf(room, ws) {
  if (!room) return null;
  return room.host === ws ? room.guest : room.host;
}

function roomFor(ws) {
  const state = socketState.get(ws);
  return state?.room ? rooms.get(state.room) : null;
}

function attachRoom(ws, room, role) {
  socketState.set(ws, { room: room.room, role });
  if (role === "host") room.host = ws;
  else room.guest = ws;
}

function finishRoom(room) {
  if (!room) return;
  if (room.finishResolveTimer) clearTimeout(room.finishResolveTimer);
  if (room.quickReadyTimer) clearTimeout(room.quickReadyTimer);
  room.finishResolveTimer = null;
  room.quickReadyTimer = null;
  rooms.delete(room.room);
  if (room.host) socketState.delete(room.host);
  if (room.guest) socketState.delete(room.guest);
}

function pairQuickMatch(a, b) {
  const roomCode = `Q${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  const room = makeRoomState(roomCode, a, b, "quick");
  rooms.set(roomCode, room);
  attachRoom(a, room, "host");
  attachRoom(b, room, "guest");
  quickDebug(a, "pairQuickMatch", { hostWs: a?._quickDebugId, guestWs: b?._quickDebugId });
  wsSend(a, { type: "matchFound", role: "host" });
  wsSend(b, { type: "matchFound", role: "guest" });

  room.quickReadyTimer = setTimeout(() => {
    if (room.quickGuestReady && room.quickHostReady) return;
    console.warn(`[QUICK MATCH TIMEOUT] room=${roomCode} hostReady=${room.quickHostReady} guestReady=${room.quickGuestReady}`);
    const timeoutMessage = {
      type: "quickMatchTimeout",
      message: "상대 연결 준비가 시간 초과되었습니다. 빠른 대전을 다시 시도해 주세요."
    };
    wsSend(room.host, timeoutMessage);
    wsSend(room.guest, timeoutMessage);
    finishRoom(room);
  }, 25000);
}

/* ---------- Heartbeat: Render 프록시의 유휴 연결 종료 방지 ---------- */
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch (_) {}
  }
}, 25000);
wss.on("close", () => clearInterval(heartbeatTimer));

wss.on("connection", ws => {
  ws._quickDebugId = nextWsDebugId++;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  socketState.set(ws, { room: null, role: null });
  quickDebug(ws, "wsConnected");
  ws.on("error", error => {
    quickDebug(ws, "wsError", { message: String(error?.message || error) });
  });

  ws.on("message", raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (_) {
      wsSend(ws, { type: "error", message: "잘못된 WebSocket 메시지입니다." });
      return;
    }

    const state = socketState.get(ws) || { room: null, role: null };
    if (["matchmake", "matchReady", "matchStart", "create", "join"].includes(data.type)) {
      quickDebug(ws, "received:" + data.type, data.type === "matchStart" ? { round: data.round } : {});
    }

    /* ---------- 빠른 대전 ---------- */
    if (data.type === "matchmake") {
      removeFromQueue(ws);
      const other = quickQueue.shift();
      if (other && other.readyState === 1 && other !== ws) {
        pairQuickMatch(other, ws);
      } else {
        quickQueue.push(ws);
        socketState.set(ws, { room: null, role: null, queued: true });
        wsSend(ws, { type: "queued" });
      }
      return;
    }

    /* ---------- 친구 방 ---------- */
    if (data.type === "create") {
      const roomCode = String(data.room || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(roomCode)) {
        wsSend(ws, { type: "error", message: "방 코드가 올바르지 않습니다." });
        return;
      }
      if (rooms.has(roomCode)) {
        wsSend(ws, { type: "error", message: "이미 사용 중인 방 코드입니다." });
        return;
      }
      const room = makeRoomState(roomCode, ws, null, "friend");
      rooms.set(roomCode, room);
      attachRoom(ws, room, "host");
      wsSend(ws, { type: "roomCreated", room: roomCode });
      return;
    }

    if (data.type === "join") {
      const roomCode = String(data.room || "").trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room || !room.host || room.over) {
        wsSend(ws, { type: "error", message: "존재하지 않는 방입니다." });
        return;
      }
      if (room.started) {
        wsSend(ws, { type: "error", message: "이미 경기가 시작된 방입니다." });
        return;
      }
      if (room.guest && room.guest !== ws) {
        wsSend(ws, { type: "error", message: "방이 이미 가득 찼습니다." });
        return;
      }
      attachRoom(ws, room, "guest");
      wsSend(ws, { type: "roomJoined", room: roomCode });
      wsSend(room.host, { type: "peerJoined" });
      return;
    }

    const room = roomFor(ws);
    if (!room) {
      wsSend(ws, { type: "error", message: "먼저 빠른 대전이나 방에 참가해주세요." });
      return;
    }

    /* ---------- 빠른 대전 준비 완료 ---------- */
    if (data.type === "matchReady") {
      if (room.type !== "quick") return;

      if (state.role === "guest") room.quickGuestReady = true;
      if (state.role === "host") room.quickHostReady = true;

      if (room.quickGuestReady && room.quickHostReady) {
        if (room.quickReadyTimer) clearTimeout(room.quickReadyTimer);
        room.quickReadyTimer = null;

        if (room.quickStartRequested && room.lastStart) {
          room.started = true;
          room.round = Number(room.lastStart.round) || 1;
          room.roundResolved = null;
          wsSend(room.guest, room.lastStart);
          room.quickStartRequested = false;
        } else {
          wsSend(room.host, { type: "quickMatchReady" });
        }
      }
      return;
    }

    /* ---------- 위치 중계 ---------- */
    if (data.type === "position") {
      if (room.over) return;
      if (room.eliminated.has(state.role)) return;

      const now = Date.now();
      const socketInfo = socketState.get(ws) || {};
      if (socketInfo.lastPositionRelayAt && now - socketInfo.lastPositionRelayAt < 50) {
        socketInfo.pendingPosition = data;
        socketState.set(ws, socketInfo);
        if (!socketInfo.positionRelayTimer) {
          socketInfo.positionRelayTimer = setTimeout(() => {
            const latestState = socketState.get(ws);
            if (!latestState) return;
            latestState.positionRelayTimer = null;
            const latest = latestState.pendingPosition;
            latestState.pendingPosition = null;
            if (latest && ws.readyState === 1 && !room.over) {
              latestState.lastPositionRelayAt = Date.now();
              wsSend(peerOf(room, ws), latest);
            }
          }, Math.max(1, 50 - (now - socketInfo.lastPositionRelayAt)));
        }
        return;
      }
      socketInfo.lastPositionRelayAt = now;
      socketState.set(ws, socketInfo);
      wsSend(peerOf(room, ws), data);
      return;
    }

    /* ---------- 라운드 시작 (방장 전용) ---------- */
    if (data.type === "matchStart") {
      if (state.role !== "host") return;
      if (room.over || !room.guest) return;

      if (room.type === "quick" && !(room.quickGuestReady && room.quickHostReady)) {
        room.quickStartRequested = true;
        room.lastStart = data;
        return;
      }
      if (room.finishResolveTimer) clearTimeout(room.finishResolveTimer);
      room.finishResolveTimer = null;
      room.finishResolveRound = null;
      room.started = true;
      room.round = Number(data.round) || room.round + 1;
      room.roundResolved = null;
      room.finishes.clear();
      room.eliminated.clear();
      room.lastStart = data;
      wsSend(room.guest, data);
      return;
    }

    /* ---------- 골인 ---------- */
    if (data.type === "finish") {
      if (room.over) return;
      const round = Number(data.round) || room.round;
      if (round !== room.round) return;           // 지난 라운드의 늦은 메시지 무시
      if (room.roundResolved === round) return;
      room.finishes.set(state.role, data);

      if (room.finishResolveTimer && room.finishResolveRound === round) return;
      room.finishResolveRound = round;
      room.finishResolveTimer = setTimeout(() => {
        room.finishResolveTimer = null;
        room.finishResolveRound = null;
        if (room.over || room.roundResolved === round) return;

        const finisherRole = room.finishes.keys().next().value;
        if (!finisherRole) return;
        room.roundResolved = round;
        const finishData = room.finishes.get(finisherRole);
        const payload = {
          type: "roundWon",
          round,
          winner: finisherRole,
          nextStart: finishData?.position || { c: 1, r: 1 }
        };
        wsSend(room.host, payload);
        wsSend(room.guest, payload);
        room.finishes.clear();
        room.eliminated.clear();
      }, 250);
      return;
    }

    /* ---------- 탈락(목숨 감소) ---------- */
    if (data.type === "eliminated") {
      if (room.over) return;
      const round = Number(data.round) || room.round;
      const otherRole = state.role === "host" ? "guest" : "host";

      // 목숨 0은 라운드 종료 여부/라운드 번호와 상관없이 항상 경기 종료
      if (Number(data.livesRemaining) <= 0) {
        if (room.finishResolveTimer) clearTimeout(room.finishResolveTimer);
        room.finishResolveTimer = null;
        room.finishResolveRound = null;
        room.roundResolved = round;
        room.over = true;
        const payload = { type: "matchOver", winner: otherRole, loser: state.role };
        wsSend(room.host, payload);
        wsSend(room.guest, payload);
        room.finishes.clear();
        room.eliminated.clear();
        return;
      }

      if (round !== room.round) return;
      if (room.roundResolved === round) return;

      room.eliminated.set(state.role, data);
      wsSend(peerOf(room, ws), { type: "opponentEliminated", round });

      if (room.eliminated.has(otherRole)) {
        if (room.finishResolveTimer) clearTimeout(room.finishResolveTimer);
        room.finishResolveTimer = null;
        room.finishResolveRound = null;
        room.roundResolved = round;
        const payload = { type: "roundWon", round, winner: "draw", nextStart: data.position || { c: 1, r: 1 } };
        wsSend(room.host, payload);
        wsSend(room.guest, payload);
        room.finishes.clear();
        room.eliminated.clear();
      }
      return;
    }
  });

  ws.on("close", (code, reason) => {
    quickDebug(ws, "wsClosed", { closeCode: code, closeReason: String(reason || "") });
    const closingState = socketState.get(ws);
    if (closingState?.positionRelayTimer) clearTimeout(closingState.positionRelayTimer);
    removeFromQueue(ws);

    const room = roomFor(ws);
    if (room) {
      const leavingRole = closingState?.role;          // finishRoom 전에 미리 저장
      const peer = peerOf(room, ws);

      if (room.over) {
        // 이미 끝난 경기: 상대에게 아무 알림도 보내지 않고 정리만 함
        finishRoom(room);
      } else if (room.started) {
        // 경기 중 이탈: 남은 사람이 즉시 승리
        room.over = true;
        wsSend(peer, {
          type: "playerLeftTimeout",
          winner: leavingRole === "host" ? "guest" : "host"
        });
        finishRoom(room);
      } else if (room.type === "friend" && leavingRole === "guest") {
        // 로비에서 참가자만 나감: 방은 유지하고 방장에게만 알림
        room.guest = null;
        wsSend(room.host, { type: "peerLeft" });
      } else if (room.type === "quick") {
        wsSend(peer, {
          type: "quickMatchTimeout",
          message: "상대가 연결을 종료했습니다. 빠른 대전을 다시 시도해 주세요."
        });
        finishRoom(room);
      } else {
        // 친구 방의 방장이 나감: 방 폐쇄
        wsSend(peer, { type: "peerLeft", roomClosed: true });
        finishRoom(room);
      }
    }
    socketState.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Sliding Maze V29 backend running on port ${PORT}`);
  console.log("[ENV CHECK] SUPABASE_URL: FOUND");
  console.log("[ENV CHECK] SUPABASE_SERVICE_ROLE_KEY: FOUND");
  console.log(`[ENV CHECK] ALLOWED_ORIGIN: ${ALLOWED_ORIGIN}`);
  console.log("WebSocket multiplayer: ON");
});
