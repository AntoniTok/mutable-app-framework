import type { AppTemplate } from "../types";

/**
 * EXAMPLE APP — tic-tac-toe, base 3x3 (multiplayer, realtime).
 *
 * The classic 3x3 board for two players. This is the BASE example; larger
 * boards / other games can be added as separate templates alongside it.
 *
 * Demonstrates the REALTIME CONTRACT (see src/templates/types.ts). The app is
 * still just a sandboxed worker with no sockets and no network. Multiplayer
 * comes from two extra PURE exports the framework's realtime coordinator drives:
 *
 *   - `initialState`         the starting shared state for a fresh game.
 *   - `applyAction(s,a,ctx)` a pure reducer: (state, action, ctx) -> nextState.
 *
 * The trusted core (src/realtime/coordinator.ts) owns the WebSockets, assigns
 * each player a seat from this app's `seats` export ("X"/"O", or null =
 * spectator) and passes it as `ctx.seat`, then persists + broadcasts whatever
 * the reducer returns. Return the state unchanged to reject an illegal move.
 * (This app has no `view` export, so every client sees the same state — the
 * coordinator broadcasts it in full.)
 *
 * The page served by `fetch` opens a WebSocket to `/agents/app-host/<room>`,
 * where <room> is read from its own `location` (`?room=`, default "main") so the
 * same page works in any room. It sends `{type:"action", action}` frames, and
 * renders each `{type:"state"}`
 * broadcast. Written as plain JavaScript (single-quoted strings, no backticks
 * or template literals) so it needs no build step.
 */
const INDEX_JS = `
// Tic-tac-toe — base 3x3 example (multiplayer). Classic 3x3 board, 2 players.
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function fresh() {
  return { board: [null, null, null, null, null, null, null, null, null], turn: 'X', winner: null };
}

function evaluate(board) {
  for (let i = 0; i < LINES.length; i++) {
    const a = LINES[i][0], b = LINES[i][1], c = LINES[i][2];
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(function (cell) { return cell !== null; }) ? 'draw' : null;
}

// ── REALTIME EXPORTS (pure; driven by the framework coordinator) ──

// Seat names this app hands out (the framework core declares none of its own).
export const seats = ['X', 'O'];

export const initialState = fresh();

export function applyAction(state, action, ctx) {
  const s = state || fresh();
  if (!action) return s;

  if (action.type === 'rematch') return fresh();

  if (action.type === 'move') {
    if (s.winner) return s;                       // game already over
    if (!ctx || ctx.seat !== s.turn) return s;    // not your seat / not your turn
    const cell = action.cell;
    if (typeof cell !== 'number' || cell < 0 || cell > 8) return s;
    if (s.board[cell] !== null) return s;         // occupied
    const board = s.board.slice();
    board[cell] = s.turn;
    return { board: board, turn: s.turn === 'X' ? 'O' : 'X', winner: evaluate(board) };
  }

  return s;
}

// ── PAGE (served by fetch; talks to the coordinator over a WebSocket) ──

const PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3}',
  '.wrap{text-align:center}',
  '.seat{font-size:13px;color:#8b949e;margin:0 0 6px;letter-spacing:.05em;text-transform:uppercase}',
  '.status{font-size:22px;font-weight:600;margin:0 0 18px;min-height:28px}',
  '.grid{display:grid;grid-template-columns:repeat(3,96px);grid-template-rows:repeat(3,96px);gap:8px}',
  '.cell{font-size:52px;font-weight:700;border:1px solid #30363d;border-radius:12px;background:#161b22;color:#e6edf3;cursor:pointer;display:flex;align-items:center;justify-content:center}',
  '.cell:hover{border-color:#2f81f7}',
  '.cell.x{color:#2f81f7}.cell.o{color:#f0883e}',
  'button{margin-top:20px;font-size:16px;padding:9px 16px;border:0;border-radius:10px;background:#2f81f7;color:#fff;cursor:pointer}',
  '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#30363d;margin:0 3px}',
  '.dot.on{background:#3fb950}',
  '</style></head><body>',
  '<div class="wrap">',
  '<p class="seat" id="seat">connecting…</p>',
  '<p class="status" id="status">…</p>',
  '<div class="grid" id="grid"></div>',
  '<button onclick="rematch()">Rematch</button>',
  '</div>',
  '<script>',
  'var grid=document.getElementById("grid");',
  'var statusEl=document.getElementById("status");',
  'var seatEl=document.getElementById("seat");',
  'var cells=[];',
  'for(var i=0;i<9;i++){(function(i){var d=document.createElement("div");d.className="cell";d.onclick=function(){move(i);};grid.appendChild(d);cells.push(d);})(i);}',
  // Stable identity: ?player=<id> (explicit, multi-tab friendly) beats the
  // per-browser id in localStorage (survives tab close/restart => resume seat).
  'var _pl=new URLSearchParams(location.search).get("player");',
  'var token=_pl||localStorage.getItem("ttt-token");',
  'if(!token){token=Math.random().toString(36).slice(2)+Date.now().toString(36);}',
  'if(!_pl){localStorage.setItem("ttt-token",token);}',
  'var mySeat=null,ws=null,last=null;',
  // Self-locate the room from our own URL (?room=abc), so one page serves any
  // room. Missing/blank => "main" (matches the host default).
  'function roomId(){var r=new URLSearchParams(location.search).get("room");return r||"main";}',
  'function agentUrl(){var proto=location.protocol==="https:"?"wss":"ws";return proto+"://"+location.host+"/agents/app-host/"+encodeURIComponent(roomId())+"?token="+encodeURIComponent(token);}',
  'function connect(){ws=new WebSocket(agentUrl());ws.onmessage=onMsg;ws.onclose=function(){seatEl.textContent="reconnecting…";setTimeout(connect,1000);};}',
  'function onMsg(e){var m;try{m=JSON.parse(e.data);}catch(err){return;}if(m.type==="welcome"){mySeat=m.seat;}else if(m.type==="state"){last=m;render(m.state,m.players);}else if(m.type==="reload"){location.reload();}}',
  'function dot(on){return on?"\u25CF":"\u25CB";}',
  'function seatLabel(players){var who=mySeat?("You are "+mySeat):"Spectator";return who+"   X "+dot(players&&players.X)+"  O "+dot(players&&players.O);}',
  'function render(s,players){',
  '  for(var i=0;i<9;i++){var v=s.board[i];cells[i].textContent=v||"";cells[i].className="cell"+(v==="X"?" x":v==="O"?" o":"");}',
  '  seatEl.textContent=seatLabel(players);',
  '  var msg;',
  '  if(s.winner==="draw")msg="Draw";',
  '  else if(s.winner)msg=s.winner+" wins!";',
  '  else if(!mySeat)msg="Spectating — "+s.turn+" to move";',
  '  else if(players&&!(players.X&&players.O))msg="Waiting for opponent…";',
  '  else msg=(s.turn===mySeat?"Your turn":"Opponent to move")+" ("+s.turn+")";',
  '  statusEl.textContent=msg;',
  '}',
  'function send(action){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:"action",action:action}));}',
  'function move(i){send({type:"move",cell:i});}',
  'function rematch(){send({type:"rematch"});}',
  'window.rematch=rematch;',
  'connect();',
  '</' + 'script>',
  '</body></html>'
].join('');

export default {
  async fetch(request, env) {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
};
`;

export const tictactoeTemplate: AppTemplate = {
  id: "tictactoe",
  label: "Tic-tac-toe — base 3x3 (multiplayer)",
  declares: ["store", "room"],
  entrypoint: "src/index.js",
  files: [{ path: "src/index.js", content: INDEX_JS }]
};
