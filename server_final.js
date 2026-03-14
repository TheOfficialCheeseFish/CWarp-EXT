require('dotenv').config();

/**
 * CloudLink Neo — Advanced Server
 *
 * Install:  npm install
 * Run:      npm start
 *
 * Copy .env.example to .env and set your JWT_SECRET before running.
 *
 * Protocol — all messages are JSON strings.
 *
 * Client → Server (pre-auth):
 *   { cmd: "register",   username, password }
 *   { cmd: "login",      username, password }
 *   { cmd: "auth",       token }              ← resume with JWT
 *   { cmd: "reconnect",  reconnectToken }     ← silent re-auth
 *
 * Client → Server (authenticated):
 *   { cmd: "create_room", room, password?, maxSize? }
 *   { cmd: "join",        room, password? }
 *   { cmd: "leave" }
 *   { cmd: "list_rooms" }
 *   { cmd: "setvar",      name, value }
 *   { cmd: "dm",          to, data }
 *   { cmd: "packet",      data, room?: true, to?: username }
 *   { cmd: "kick",        target, reason? }   ← admin only
 *   { cmd: "ban",         target }            ← admin only
 *   { cmd: "ping" }
 *
 * Server → Client:
 *   { cmd: "auth_ok",      token, reconnectToken, role }
 *   { cmd: "auth_fail",    reason }
 *   { cmd: "register_ok",  token }
 *   { cmd: "register_fail",reason }
 *   { cmd: "room_created", room }
 *   { cmd: "room_joined",  room, owner, members, vars }
 *   { cmd: "room_left",    room }
 *   { cmd: "room_list",    rooms: [{ name, owner, size, maxSize, hasPassword }] }
 *   { cmd: "user_joined",  username }
 *   { cmd: "user_left",    username }
 *   { cmd: "varset",       name, value, from }
 *   { cmd: "dm",           from, data }
 *   { cmd: "packet",       from, data }
 *   { cmd: "kicked",       reason }
 *   { cmd: "admin_ok",     action, target }
 *   { cmd: "pong" }
 *   { cmd: "error",        reason }
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT          = Number(process.env.PORT)          || 3000;
const JWT_SECRET    = process.env.JWT_SECRET            || 'change-me-in-production';
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 50;
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS) || 50;
const BCRYPT_ROUNDS = 10;
const TOKEN_TTL     = '2h';

if (JWT_SECRET === 'change-me-in-production') {
  console.warn('\n⚠️  WARNING: JWT_SECRET is not set. Set it in your .env file before deploying.\n');
}

// ─── In-Memory Stores ─────────────────────────────────────────────────────────
// Swap these Maps for real DB calls (Supabase, SQLite, Postgres, etc.)

/** @type {Map<string, { passwordHash: string, role: 'user'|'admin' }>} */
const userDB = new Map();

/**
 * @type {Map<string, {
 *   ws: WebSocket,
 *   username: string,
 *   room: string|null,
 *   role: 'user'|'admin',
 *   reconnectToken: string|null
 * }>}
 */
const sessions = new Map();

/**
 * @type {Map<string, {
 *   owner:    string,
 *   password: string|null,
 *   maxSize:  number,
 *   vars:     Map<string, any>,
 *   created:  number
 * }>}
 */
const rooms = new Map();

/** @type {Set<string>} */
const bannedUsers = new Set();

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

const lastMessageTime = new Map();

function isRateLimited(ws) {
  const now  = Date.now();
  const last = lastMessageTime.get(ws) || 0;
  if (now - last < RATE_LIMIT_MS) return true;
  lastMessageTime.set(ws, now);
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendTo(username, obj) {
  const s = sessions.get(username);
  if (s) send(s.ws, obj);
}

function broadcastRoom(roomName, obj, excludeUsername = null) {
  for (const [uname, s] of sessions) {
    if (s.room === roomName && uname !== excludeUsername) {
      send(s.ws, obj);
    }
  }
}

function roomMembers(roomName) {
  const out = [];
  for (const [uname, s] of sessions) {
    if (s.room === roomName) out.push(uname);
  }
  return out;
}

function signJWT(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function makeReconnectToken(username) {
  return jwt.sign({ username, type: 'reconnect' }, JWT_SECRET, { expiresIn: '10m' });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function handleRegister(ws, msg) {
  const { username, password } = msg;
  if (!username || !password)
    return send(ws, { cmd: 'register_fail', reason: 'Missing username or password' });
  if (!/^[a-zA-Z0-9_]{2,24}$/.test(username))
    return send(ws, { cmd: 'register_fail', reason: 'Username must be 2–24 alphanumeric characters' });
  if (userDB.has(username))
    return send(ws, { cmd: 'register_fail', reason: 'Username taken' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  userDB.set(username, { passwordHash, role: 'user' });

  const token = signJWT({ username, role: 'user' });
  send(ws, { cmd: 'register_ok', token });
  console.log(`[register] ${username}`);
}

async function handleLogin(ws, msg) {
  const { username, password } = msg;
  const user = userDB.get(username);
  if (!user)                       return send(ws, { cmd: 'auth_fail', reason: 'User not found' });
  if (bannedUsers.has(username))   return send(ws, { cmd: 'auth_fail', reason: 'Banned' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return send(ws, { cmd: 'auth_fail', reason: 'Wrong password' });

  const token          = signJWT({ username, role: user.role });
  const reconnectToken = makeReconnectToken(username);
  openSession(ws, username, user.role, reconnectToken);
  send(ws, { cmd: 'auth_ok', token, reconnectToken, role: user.role });
}

function handleTokenAuth(ws, msg) {
  const payload = verifyJWT(msg.token);
  if (!payload)                          return send(ws, { cmd: 'auth_fail', reason: 'Invalid or expired token' });
  if (bannedUsers.has(payload.username)) return send(ws, { cmd: 'auth_fail', reason: 'Banned' });

  const reconnectToken = makeReconnectToken(payload.username);
  openSession(ws, payload.username, payload.role || 'user', reconnectToken);
  send(ws, { cmd: 'auth_ok', reconnectToken, role: payload.role || 'user' });
}

function handleReconnect(ws, msg) {
  const payload = verifyJWT(msg.reconnectToken);
  if (!payload || payload.type !== 'reconnect')
    return send(ws, { cmd: 'auth_fail', reason: 'Invalid reconnect token' });
  if (bannedUsers.has(payload.username))
    return send(ws, { cmd: 'auth_fail', reason: 'Banned' });

  const user           = userDB.get(payload.username);
  const role           = user ? user.role : 'user';
  const reconnectToken = makeReconnectToken(payload.username);
  openSession(ws, payload.username, role, reconnectToken);
  send(ws, { cmd: 'auth_ok', reconnectToken, role });
}

function openSession(ws, username, role, reconnectToken) {
  // Close any existing session for this username
  if (sessions.has(username)) {
    const old = sessions.get(username);
    send(old.ws, { cmd: 'error', reason: 'Logged in elsewhere' });
    old.ws.close();
  }
  sessions.set(username, { ws, username, room: null, role, reconnectToken });
  console.log(`[auth] ${username} (${role})`);
}

// ─── Room Commands ────────────────────────────────────────────────────────────

function handleCreateRoom(ws, s, msg) {
  const { room, password, maxSize } = msg;
  if (!room)          return send(ws, { cmd: 'error', reason: 'Room name required' });
  if (rooms.has(room)) return send(ws, { cmd: 'error', reason: 'Room already exists' });

  rooms.set(room, {
    owner:    s.username,
    password: password || null,
    maxSize:  Math.min(maxSize || MAX_ROOM_SIZE, MAX_ROOM_SIZE),
    vars:     new Map(),
    created:  Date.now(),
  });

  send(ws, { cmd: 'room_created', room });
  console.log(`[room] "${room}" created by ${s.username}`);
}

function handleJoinRoom(ws, s, msg) {
  const r = rooms.get(msg.room);
  if (!r) return send(ws, { cmd: 'error', reason: `Room "${msg.room}" does not exist` });
  if (r.password && r.password !== msg.password)
    return send(ws, { cmd: 'error', reason: 'Wrong room password' });
  if (roomMembers(msg.room).length >= r.maxSize)
    return send(ws, { cmd: 'error', reason: 'Room is full' });

  if (s.room) {
    broadcastRoom(s.room, { cmd: 'user_left', username: s.username }, s.username);
  }

  s.room = msg.room;
  broadcastRoom(msg.room, { cmd: 'user_joined', username: s.username }, s.username);

  const varSnapshot = {};
  for (const [k, v] of r.vars) varSnapshot[k] = v;

  send(ws, {
    cmd:     'room_joined',
    room:    msg.room,
    owner:   r.owner,
    members: roomMembers(msg.room),
    vars:    varSnapshot,
  });

  console.log(`[room] ${s.username} joined "${msg.room}"`);
}

function handleLeaveRoom(ws, s) {
  if (!s.room) return;
  const oldRoom = s.room;
  s.room = null;
  broadcastRoom(oldRoom, { cmd: 'user_left', username: s.username });
  send(ws, { cmd: 'room_left', room: oldRoom });

  const r = rooms.get(oldRoom);
  if (r && r.owner === s.username && roomMembers(oldRoom).length === 0) {
    rooms.delete(oldRoom);
    console.log(`[room] "${oldRoom}" disbanded`);
  }
}

function handleListRooms(ws) {
  const list = [];
  for (const [name, r] of rooms) {
    list.push({
      name,
      owner:       r.owner,
      size:        roomMembers(name).length,
      maxSize:     r.maxSize,
      hasPassword: !!r.password,
    });
  }
  send(ws, { cmd: 'room_list', rooms: list });
}

// ─── Variable Commands ────────────────────────────────────────────────────────

function handleSetVar(ws, s, msg) {
  if (!s.room) return send(ws, { cmd: 'error', reason: 'Join a room first' });
  if (!msg.name) return;

  const r = rooms.get(s.room);
  if (r) r.vars.set(msg.name, msg.value);

  broadcastRoom(s.room, {
    cmd:   'varset',
    name:  msg.name,
    value: msg.value,
    from:  s.username,
  }, s.username);
}

// ─── Admin Commands ───────────────────────────────────────────────────────────

function handleKick(ws, s, msg) {
  if (s.role !== 'admin') return send(ws, { cmd: 'error', reason: 'Forbidden' });
  const target = sessions.get(msg.target);
  if (!target) return send(ws, { cmd: 'error', reason: 'User not found' });
  send(target.ws, { cmd: 'kicked', reason: msg.reason || 'Kicked by admin' });
  target.ws.close();
  send(ws, { cmd: 'admin_ok', action: 'kick', target: msg.target });
  console.log(`[admin] ${s.username} kicked ${msg.target}`);
}

function handleBan(ws, s, msg) {
  if (s.role !== 'admin') return send(ws, { cmd: 'error', reason: 'Forbidden' });
  bannedUsers.add(msg.target);
  const target = sessions.get(msg.target);
  if (target) {
    send(target.ws, { cmd: 'kicked', reason: 'Banned' });
    target.ws.close();
  }
  send(ws, { cmd: 'admin_ok', action: 'ban', target: msg.target });
  console.log(`[admin] ${s.username} banned ${msg.target}`);
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    if (isRateLimited(ws)) return;

    let msg;
    try { msg = JSON.parse(raw); }
    catch { return send(ws, { cmd: 'error', reason: 'Invalid JSON' }); }

    // Pre-auth commands
    if (msg.cmd === 'register')  return await handleRegister(ws, msg);
    if (msg.cmd === 'login')     return await handleLogin(ws, msg);
    if (msg.cmd === 'auth')      return handleTokenAuth(ws, msg);
    if (msg.cmd === 'reconnect') return handleReconnect(ws, msg);

    // Resolve session from ws reference
    let authedUsername = null;
    for (const [uname, s] of sessions) {
      if (s.ws === ws) { authedUsername = uname; break; }
    }
    if (!authedUsername) return send(ws, { cmd: 'error', reason: 'Not authenticated' });

    const s = sessions.get(authedUsername);

    switch (msg.cmd) {
      case 'create_room': handleCreateRoom(ws, s, msg); break;
      case 'join':        handleJoinRoom(ws, s, msg);   break;
      case 'leave':       handleLeaveRoom(ws, s);       break;
      case 'list_rooms':  handleListRooms(ws);          break;
      case 'setvar':      handleSetVar(ws, s, msg);     break;

      case 'dm': {
        const t = sessions.get(msg.to);
        if (!t) { send(ws, { cmd: 'error', reason: `User "${msg.to}" not found` }); break; }
        send(t.ws, { cmd: 'dm', from: s.username, data: msg.data });
        break;
      }

      case 'packet':
        if (msg.room) {
          if (!s.room) { send(ws, { cmd: 'error', reason: 'Join a room first' }); break; }
          broadcastRoom(s.room, { cmd: 'packet', from: s.username, data: msg.data }, s.username);
        } else if (msg.to) {
          const t = sessions.get(msg.to);
          if (!t) { send(ws, { cmd: 'error', reason: `User "${msg.to}" not found` }); break; }
          send(t.ws, { cmd: 'packet', from: s.username, data: msg.data });
        }
        break;

      case 'kick':  handleKick(ws, s, msg); break;
      case 'ban':   handleBan(ws, s, msg);  break;
      case 'ping':  send(ws, { cmd: 'pong' }); break;

      default:
        send(ws, { cmd: 'error', reason: `Unknown command: ${msg.cmd}` });
    }
  });

  ws.on('close', () => {
    lastMessageTime.delete(ws);
    for (const [uname, s] of sessions) {
      if (s.ws === ws) {
        if (s.room) broadcastRoom(s.room, { cmd: 'user_left', username: uname });
        sessions.delete(uname);
        console.log(`[-] ${uname} disconnected`);
        break;
      }
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

console.log(`CloudLink Neo server running on ws://localhost:${PORT}`);
