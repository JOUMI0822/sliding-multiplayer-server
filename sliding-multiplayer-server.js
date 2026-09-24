const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HTML_FILE = path.join(__dirname, '슬라이딩_10초_미리보기렉최적화_v2-2-5.html');
const rooms = new Map();
const clients = new Set();

const HOST_RECONNECT_TIME = 5 * 60 * 1000;

function wsAcceptKey(key) {
    return crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
}

function encodeFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    let header;

    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    return Buffer.concat([header, payload]);
}

function send(ws, data) {
    if (!ws || ws.destroyed) return;

    try {
        ws.write(encodeFrame(JSON.stringify(data)));
    } catch {}
}

function parseFrames(buffer) {
    const messages = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const b1 = buffer[offset];
        const b2 = buffer[offset + 1];
        const opcode = b1 & 0x0f;
        const masked = (b2 & 0x80) !== 0;

        let length = b2 & 0x7f;
        let headerLength = 2;

        if (length === 126) {
            if (offset + 4 > buffer.length) break;

            length = buffer.readUInt16BE(offset + 2);
            headerLength = 4;
        } else if (length === 127) {
            if (offset + 10 > buffer.length) break;

            const bigLength = buffer.readBigUInt64BE(offset + 2);

            if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error('Frame too large');
            }

            length = Number(bigLength);
            headerLength = 10;
        }

        const maskLength = masked ? 4 : 0;
        const frameLength = headerLength + maskLength + length;

        if (offset + frameLength > buffer.length) break;

        let payloadStart = offset + headerLength;

        const mask = masked
            ? buffer.subarray(payloadStart, payloadStart + 4)
            : null;

        if (masked) payloadStart += 4;

        const payload = Buffer.from(
            buffer.subarray(payloadStart, payloadStart + length)
        );

        if (masked) {
            for (let i = 0; i < payload.length; i++) {
                payload[i] ^= mask[i % 4];
            }
        }

        messages.push({ opcode, payload });
        offset += frameLength;
    }

    return {
        messages,
        rest: buffer.subarray(offset)
    };
}

function sendError(ws, message) {
    send(ws, {
        type: 'error',
        message
    });
}

function removeClient(ws) {
    clients.delete(ws);

    const roomCode = ws.roomCode;

    if (!roomCode) return;

    const room = rooms.get(roomCode);

    if (!room) return;

    if (room.host === ws) {
        room.host = null;
        room.hostDisconnectedAt = Date.now();

        if (room.guest) {
            send(room.guest, {
                type: 'peerLeft'
            });
        }

        // 방은 즉시 삭제하지 않음
        // 5분 동안 방장이 다시 접속할 수 있음

        return;
    }

    if (room.guest === ws) {
        room.guest = null;

        if (room.host) {
            send(room.host, {
                type: 'peerLeft'
            });
        }

        // 방장이 살아 있으면 방은 계속 유지
    }
}

function handleMessage(ws, data) {
    if (data.type === 'create') {
        const roomCode = String(data.room || '').toUpperCase();

        if (!/^[A-Z0-9]{5}$/.test(roomCode)) {
            return sendError(ws, '방 코드가 올바르지 않습니다.');
        }

        if (rooms.has(roomCode)) {
            return sendError(
                ws,
                '이미 사용 중인 방 코드입니다. 새 방을 만들어 주세요.'
            );
        }

        ws.roomCode = roomCode;
        ws.role = 'host';

        rooms.set(roomCode, {
            host: ws,
            guest: null,
            winner: null,
            hostEliminated: false,
            guestEliminated: false,
            hostDisconnectedAt: null
        });

        send(ws, {
            type: 'roomCreated',
            room: roomCode
        });

        return;
    }

    if (data.type === 'join') {
        const roomCode = String(data.room || '').toUpperCase();
        const room = rooms.get(roomCode);

        if (!room) {
            return sendError(ws, '존재하지 않는 방입니다.');
        }

        // 방장이 나간 상태라면 같은 방 코드로 방장 복귀
        if (
            room.host === null &&
            room.hostDisconnectedAt &&
            Date.now() - room.hostDisconnectedAt < HOST_RECONNECT_TIME
        ) {
            ws.roomCode = roomCode;
            ws.role = 'host';

            room.host = ws;
            room.hostDisconnectedAt = null;

            send(ws, {
                type: 'roomRejoined',
                room: roomCode
            });

            if (room.guest) {
                send(room.guest, {
                    type: 'peerJoined'
                });
            }

            return;
        }

        if (room.guest) {
            return sendError(
                ws,
                '이미 두 명이 참가한 방입니다.'
            );
        }

        ws.roomCode = roomCode;
        ws.role = 'guest';

        room.guest = ws;

        send(ws, {
            type: 'roomJoined',
            room: roomCode
        });

        if (room.host) {
            send(room.host, {
                type: 'peerJoined'
            });
        }

        return;
    }

    const room = rooms.get(ws.roomCode);

    if (!room) {
        return sendError(
            ws,
            '먼저 방을 만들어 주세요.'
        );
    }

    const other =
        ws === room.host
            ? room.guest
            : room.host;

    if (!other) return;

    if (data.type === 'matchStart') {
        if (ws === room.host) {
            send(other, data);
        }

        return;
    }

    if (data.type === 'position') {
        send(other, data);
        return;
    }

    if (data.type === 'finish') {
        if (room.winner) return;

        room.winner = ws.role;

        if (room.host) {
            send(room.host, {
                type: 'matchOver',
                winner: room.winner
            });
        }

        if (room.guest) {
            send(room.guest, {
                type: 'matchOver',
                winner: room.winner
            });
        }

        return;
    }

    if (data.type === 'eliminated') {
        if (ws === room.host) {
            room.hostEliminated = true;
        }

        if (ws === room.guest) {
            room.guestEliminated = true;
        }

        if (
            room.hostEliminated &&
            room.guestEliminated
        ) {
            room.winner = 'draw';
        } else if (room.hostEliminated) {
            room.winner = 'guest';
        } else if (room.guestEliminated) {
            room.winner = 'host';
        }

        if (room.winner) {
            if (room.host) {
                send(room.host, {
                    type: 'matchOver',
                    winner: room.winner
                });
            }

            if (room.guest) {
                send(room.guest, {
                    type: 'matchOver',
                    winner: room.winner
                });
            }
        }
    }
}

const server = http.createServer((req, res) => {
    const requestPath =
        new URL(
            req.url,
            `http://${req.headers.host}`
        ).pathname;

    if (
        requestPath !== '/' &&
        requestPath !== '/index.html'
    ) {
        res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        res.end('Not found');
        return;
    }

    fs.readFile(HTML_FILE, (err, data) => {
        if (err) {
            res.writeHead(500, {
                'Content-Type': 'text/plain; charset=utf-8'
            });

            res.end(
                'HTML 파일을 찾을 수 없습니다.'
            );

            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });

        res.end(data);
    });
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];

    if (!key) {
        socket.destroy();
        return;
    }

    const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
        '\r\n'
    ];

    socket.write(headers.join('\r\n'));

    socket.roomCode = null;
    socket.role = null;
    socket.frameBuffer = Buffer.alloc(0);

    clients.add(socket);

    socket.on('data', chunk => {
        try {
            socket.frameBuffer = Buffer.concat([
                socket.frameBuffer,
                chunk
            ]);

            const parsed =
                parseFrames(socket.frameBuffer);

            socket.frameBuffer = parsed.rest;

            for (const frame of parsed.messages) {
                if (frame.opcode === 0x8) {
                    socket.end();
                    return;
                }

                if (frame.opcode === 0x9) {
                    socket.write(
                        Buffer.from([
                            0x8A,
                            frame.payload.length,
                            ...frame.payload
                        ])
                    );

                    continue;
                }

                if (frame.opcode !== 0x1) continue;

                const text =
                    frame.payload.toString('utf8');

                let data;

                try {
                    data = JSON.parse(text);
                } catch {
                    sendError(
                        socket,
                        '잘못된 통신 데이터입니다.'
                    );

                    continue;
                }

                handleMessage(socket, data);
            }
        } catch (error) {
            socket.destroy();
        }
    });

    socket.on('close', () => {
        removeClient(socket);
    });

    socket.on('error', () => {
        removeClient(socket);
    });
});

// 5분이 지난 방장 연결 대기 방 삭제
setInterval(() => {
    const now = Date.now();

    for (const [roomCode, room] of rooms) {
        if (
            room.host === null &&
            room.hostDisconnectedAt &&
            now - room.hostDisconnectedAt >= HOST_RECONNECT_TIME
        ) {
            rooms.delete(roomCode);
            console.log(
                `방 ${roomCode} 삭제: 방장 재접속 시간 만료`
            );
        }
    }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(
        `슬라이딩 2인용 Wi-Fi 서버: http://0.0.0.0:${PORT}`
    );

    console.log(
        '같은 Wi-Fi의 다른 기기에서는 서버 기기의 사설 IP:8080으로 접속하세요.'
    );
});
