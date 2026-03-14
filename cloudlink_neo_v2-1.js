(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('CloudLink Neo must run unsandboxed.');
  }

  class CloudLinkNeo {
    constructor() {
      this._ws             = null;
      this._connected      = false;
      this._username       = '';
      this._role           = '';
      this._room           = '';
      this._token          = '';
      this._reconnectToken = '';
      this._vars           = {};
      this._varDirty       = {};
      this._lastVar        = { name: '', value: '', from: '' };
      this._lastDM         = { from: '', data: '' };
      this._lastPkt        = { from: '', data: '' };
      this._lastErr        = '';
      this._lastJoinedRoom = '';
      this._roomMembers    = [];
      this._roomList       = '[]';

      this._events = {
        connected:    false,
        disconnected: false,
        error:        false,
        dm:           false,
        packet:       false,
        roomJoined:   false,
        roomLeft:     false,
        userJoined:   false,
        userLeft:     false,
        registered:   false,
      };

      this._lastJoinedUser = '';
      this._lastLeftUser   = '';
    }

    getInfo() {
      return {
        id:     'cloudlinkneoext',
        name:   'CloudLink Neo',
        color1: '#0d0d1a',
        color2: '#1a1a3e',
        color3: '#3a3a8c',
        blocks: [

          // ── Auth ────────────────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Auth' },
          {
            opcode: 'openSocket', blockType: Scratch.BlockType.COMMAND,
            text: 'connect to server [URL]',
            arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'ws://localhost:3000' } }
          },
          {
            opcode: 'register', blockType: Scratch.BlockType.COMMAND,
            text: 'register as [USER] password [PASS]',
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: 'player1' },
              PASS: { type: Scratch.ArgumentType.STRING, defaultValue: 'secret' },
            }
          },
          {
            opcode: 'login', blockType: Scratch.BlockType.COMMAND,
            text: 'login as [USER] password [PASS]',
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: 'player1' },
              PASS: { type: Scratch.ArgumentType.STRING, defaultValue: 'secret' },
            }
          },
          {
            opcode: 'authToken', blockType: Scratch.BlockType.COMMAND,
            text: 'login with token [TOKEN]',
            arguments: { TOKEN: { type: Scratch.ArgumentType.STRING, defaultValue: '' } }
          },
          {
            opcode: 'reconnect', blockType: Scratch.BlockType.COMMAND,
            text: 'reconnect with saved token',
          },
          {
            opcode: 'disconnect', blockType: Scratch.BlockType.COMMAND,
            text: 'disconnect',
          },
          {
            opcode: 'isConnected', blockType: Scratch.BlockType.BOOLEAN,
            text: 'connected?',
          },
          {
            opcode: 'getUsername', blockType: Scratch.BlockType.REPORTER,
            text: 'username',
          },
          {
            opcode: 'getRole', blockType: Scratch.BlockType.REPORTER,
            text: 'role',
          },
          {
            opcode: 'getToken', blockType: Scratch.BlockType.REPORTER,
            text: 'auth token',
          },

          '---',

          // ── Auth Events ──────────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Auth Events' },
          {
            opcode: 'onConnected', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when connected',
          },
          {
            opcode: 'onRegistered', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when registered',
          },
          {
            opcode: 'onDisconnected', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when disconnected',
          },
          {
            opcode: 'onError', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when error',
          },
          {
            opcode: 'getLastError', blockType: Scratch.BlockType.REPORTER,
            text: 'last error',
          },

          '---',

          // ── Rooms ─────────────────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Rooms' },
          {
            opcode: 'createRoom', blockType: Scratch.BlockType.COMMAND,
            text: 'create room [ROOM] password [PASS] max [MAX]',
            arguments: {
              ROOM: { type: Scratch.ArgumentType.STRING,  defaultValue: 'lobby' },
              PASS: { type: Scratch.ArgumentType.STRING,  defaultValue: '' },
              MAX:  { type: Scratch.ArgumentType.NUMBER,  defaultValue: 20 },
            }
          },
          {
            opcode: 'joinRoom', blockType: Scratch.BlockType.COMMAND,
            text: 'join room [ROOM] password [PASS]',
            arguments: {
              ROOM: { type: Scratch.ArgumentType.STRING, defaultValue: 'lobby' },
              PASS: { type: Scratch.ArgumentType.STRING, defaultValue: '' },
            }
          },
          {
            opcode: 'leaveRoom', blockType: Scratch.BlockType.COMMAND,
            text: 'leave room',
          },
          {
            opcode: 'listRooms', blockType: Scratch.BlockType.COMMAND,
            text: 'fetch room list',
          },
          {
            opcode: 'getRoomList', blockType: Scratch.BlockType.REPORTER,
            text: 'room list (JSON)',
          },
          {
            opcode: 'getRoom', blockType: Scratch.BlockType.REPORTER,
            text: 'current room',
          },
          {
            opcode: 'getRoomMembers', blockType: Scratch.BlockType.REPORTER,
            text: 'room members (JSON)',
          },

          '---',

          // ── Room Events ───────────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Room Events' },
          {
            opcode: 'onRoomJoined', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when room joined',
          },
          {
            opcode: 'onRoomLeft', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when room left',
          },
          {
            opcode: 'onUserJoined', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when user joins room',
          },
          {
            opcode: 'onUserLeft', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when user leaves room',
          },
          {
            opcode: 'getLastJoinedUser', blockType: Scratch.BlockType.REPORTER,
            text: 'user who joined',
          },
          {
            opcode: 'getLastLeftUser', blockType: Scratch.BlockType.REPORTER,
            text: 'user who left',
          },

          '---',

          // ── Global Variables ──────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Global Variables' },
          {
            opcode: 'setVar', blockType: Scratch.BlockType.COMMAND,
            text: 'set global [VAR] to [VALUE]',
            arguments: {
              VAR:   { type: Scratch.ArgumentType.STRING, defaultValue: 'score' },
              VALUE: { type: Scratch.ArgumentType.STRING, defaultValue: '0' },
            }
          },
          {
            opcode: 'getVar', blockType: Scratch.BlockType.REPORTER,
            text: 'global [VAR]',
            arguments: { VAR: { type: Scratch.ArgumentType.STRING, defaultValue: 'score' } }
          },
          {
            opcode: 'onVarChanged', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false,
            text: 'when global [VAR] changes',
            arguments: { VAR: { type: Scratch.ArgumentType.STRING, defaultValue: 'score' } }
          },
          {
            opcode: 'getVarFrom', blockType: Scratch.BlockType.REPORTER,
            text: 'last global var changed by',
          },

          '---',

          // ── Direct Messaging ──────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Direct Messages' },
          {
            opcode: 'sendDM', blockType: Scratch.BlockType.COMMAND,
            text: 'send DM to [USER] data [DATA]',
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: 'player2' },
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: 'hello' },
            }
          },
          {
            opcode: 'onDM', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when DM received',
          },
          {
            opcode: 'getDMFrom', blockType: Scratch.BlockType.REPORTER, text: 'DM sender',
          },
          {
            opcode: 'getDMData', blockType: Scratch.BlockType.REPORTER, text: 'DM data',
          },

          '---',

          // ── Custom Packets ────────────────────────────────────────────
          { blockType: Scratch.BlockType.LABEL, text: 'Custom Packets' },
          {
            opcode: 'sendPacketRoom', blockType: Scratch.BlockType.COMMAND,
            text: 'broadcast packet [DATA] to room',
            arguments: { DATA: { type: Scratch.ArgumentType.STRING, defaultValue: '{}' } }
          },
          {
            opcode: 'sendPacketUser', blockType: Scratch.BlockType.COMMAND,
            text: 'send packet [DATA] to [USER]',
            arguments: {
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: '{}' },
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: 'player2' },
            }
          },
          {
            opcode: 'onPacket', blockType: Scratch.BlockType.HAT,
            isEdgeActivated: false, text: 'when packet received',
          },
          {
            opcode: 'getPacketFrom', blockType: Scratch.BlockType.REPORTER, text: 'packet sender',
          },
          {
            opcode: 'getPacketData', blockType: Scratch.BlockType.REPORTER, text: 'packet data',
          },

        ]
      };
    }

    // ─── Internal ─────────────────────────────────────────────────────────

    _send(obj) {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify(obj));
      }
    }

    _handleMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.cmd) {
        case 'auth_ok':
          this._connected      = true;
          this._token          = msg.token          || this._token;
          this._reconnectToken = msg.reconnectToken || this._reconnectToken;
          this._role           = msg.role            || 'user';
          this._events.connected = true;
          break;

        case 'register_ok':
          this._token          = msg.token || '';
          this._events.registered = true;
          break;

        case 'auth_fail':
        case 'register_fail':
          this._lastErr       = msg.reason || 'Auth failed';
          this._events.error  = true;
          break;

        case 'room_joined':
          this._room           = msg.room;
          this._roomMembers    = msg.members || [];
          if (msg.vars) Object.assign(this._vars, msg.vars);
          this._events.roomJoined = true;
          break;

        case 'room_left':
          this._room            = '';
          this._events.roomLeft = true;
          break;

        case 'room_list':
          this._roomList = JSON.stringify(msg.rooms || []);
          break;

        case 'user_joined':
          this._lastJoinedUser = msg.username;
          if (!this._roomMembers.includes(msg.username)) this._roomMembers.push(msg.username);
          this._events.userJoined = true;
          break;

        case 'user_left':
          this._lastLeftUser = msg.username;
          this._roomMembers  = this._roomMembers.filter(u => u !== msg.username);
          this._events.userLeft = true;
          break;

        case 'varset':
          this._vars[msg.name] = msg.value;
          this._lastVar = { name: msg.name, value: msg.value, from: msg.from || '' };
          this._varDirty[msg.name] = (this._varDirty[msg.name] || 0) + 1;
          break;

        case 'dm':
          this._lastDM       = { from: msg.from || '', data: msg.data || '' };
          this._events.dm    = true;
          break;

        case 'packet':
          this._lastPkt         = { from: msg.from || '', data: msg.data || '' };
          this._events.packet   = true;
          break;

        case 'kicked':
          this._lastErr = msg.reason || 'Kicked from server';
          this._events.error = true;
          break;

        case 'error':
          this._lastErr       = msg.reason || 'Unknown error';
          this._events.error  = true;
          break;
      }
    }

    _openSocket(url) {
      return new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.onopen    = () => resolve(ws);
        ws.onerror   = () => { this._lastErr = 'Connection failed'; this._events.error = true; resolve(null); };
        ws.onmessage = (e) => this._handleMessage(e.data);
        ws.onclose   = () => { this._connected = false; this._events.disconnected = true; };
      });
    }

    // ─── Blocks ───────────────────────────────────────────────────────────

    async openSocket({ URL }) {
      if (this._ws) this._ws.close();
      this._ws = await this._openSocket(URL);
    }

    async register({ USER, PASS }) {
      this._username = USER;
      this._send({ cmd: 'register', username: USER, password: PASS });
    }

    async login({ USER, PASS }) {
      this._username = USER;
      this._send({ cmd: 'login', username: USER, password: PASS });
    }

    authToken({ TOKEN }) {
      this._send({ cmd: 'auth', token: TOKEN });
    }

    reconnect() {
      if (this._reconnectToken) {
        this._send({ cmd: 'reconnect', reconnectToken: this._reconnectToken });
      }
    }

    disconnect() { if (this._ws) this._ws.close(); }

    isConnected()  { return this._connected; }
    getUsername()  { return this._username;  }
    getRole()      { return this._role;      }
    getToken()     { return this._token;     }
    getLastError() { return this._lastErr;   }

    onConnected()    { if (this._events.connected)    { this._events.connected    = false; return true; } return false; }
    onRegistered()   { if (this._events.registered)   { this._events.registered   = false; return true; } return false; }
    onDisconnected() { if (this._events.disconnected) { this._events.disconnected = false; return true; } return false; }
    onError()        { if (this._events.error)        { this._events.error        = false; return true; } return false; }

    createRoom({ ROOM, PASS, MAX }) {
      this._send({ cmd: 'create_room', room: ROOM, password: PASS || null, maxSize: MAX });
    }

    joinRoom({ ROOM, PASS }) {
      this._send({ cmd: 'join', room: ROOM, password: PASS || null });
    }

    leaveRoom()  { this._send({ cmd: 'leave' }); }
    listRooms()  { this._send({ cmd: 'list_rooms' }); }
    getRoomList() { return this._roomList; }
    getRoom()    { return this._room; }
    getRoomMembers() { return JSON.stringify(this._roomMembers); }

    onRoomJoined()  { if (this._events.roomJoined)  { this._events.roomJoined  = false; return true; } return false; }
    onRoomLeft()    { if (this._events.roomLeft)    { this._events.roomLeft    = false; return true; } return false; }
    onUserJoined()  { if (this._events.userJoined)  { this._events.userJoined  = false; return true; } return false; }
    onUserLeft()    { if (this._events.userLeft)    { this._events.userLeft    = false; return true; } return false; }
    getLastJoinedUser() { return this._lastJoinedUser; }
    getLastLeftUser()   { return this._lastLeftUser;   }

    setVar({ VAR, VALUE }) {
      this._vars[VAR] = VALUE;
      this._send({ cmd: 'setvar', name: VAR, value: VALUE });
    }

    getVar({ VAR }) { return this._vars[VAR] !== undefined ? this._vars[VAR] : ''; }

    onVarChanged({ VAR }) {
      if ((this._varDirty[VAR] || 0) > 0) { this._varDirty[VAR]--; return true; }
      return false;
    }

    getVarFrom() { return this._lastVar.from; }

    sendDM({ USER, DATA }) { this._send({ cmd: 'dm', to: USER, data: DATA }); }
    onDM()      { if (this._events.dm)     { this._events.dm     = false; return true; } return false; }
    getDMFrom() { return this._lastDM.from; }
    getDMData() { return this._lastDM.data; }

    sendPacketRoom({ DATA })        { this._send({ cmd: 'packet', data: DATA, room: true }); }
    sendPacketUser({ DATA, USER })  { this._send({ cmd: 'packet', data: DATA, to: USER }); }
    onPacket()      { if (this._events.packet)  { this._events.packet  = false; return true; } return false; }
    getPacketFrom() { return this._lastPkt.from; }
    getPacketData() { return this._lastPkt.data; }
  }

  Scratch.extensions.register(new CloudLinkNeo());

})(Scratch);
