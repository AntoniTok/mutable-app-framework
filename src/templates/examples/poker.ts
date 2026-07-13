import type { AppTemplate } from "../types";

/**
 * EXAMPLE APP — Texas Hold'em (multiplayer, realtime, HIDDEN INFORMATION).
 *
 * This is the reference example for ASYMMETRIC VIEWS: unlike tic-tac-toe (where
 * everyone sees the same board), each player must see their OWN hole cards but
 * NOT anyone else's. It uses three generic seams from the realtime contract
 * (see src/templates/types.ts) — none of which are poker-specific:
 *
 *   - `seats`                declares the seat pool ("P1".."P6"); the core owns
 *                            no seat names of its own.
 *   - `applyAction(s,a,ctx)` a PURE reducer holding ONE full authoritative state
 *                            (deck, everyone's hole cards, pot, bets). Math.random
 *                            is allowed here to shuffle.
 *   - `view(state, ctx)`     a PURE projection: given the full truth + who's
 *                            asking, return only what that seat may see. The
 *                            framework calls it per connection and sends each
 *                            client its own frame — so hole cards never leak.
 *
 * The reducer never holds a socket and does no I/O; the trusted coordinator owns
 * the WebSockets, seats, persistence and per-player broadcast.
 *
 * Scope: simplified full-hand Hold'em — blinds, preflop/flop/turn/river betting
 * (fold/check/call/raise), a single main pot (NO side pots / no short all-in
 * side-pot math), and a 5-of-7 showdown evaluator. Written as plain JavaScript
 * (single-quoted strings, no backticks or ${} — so it embeds here and needs no
 * build step).
 */
const INDEX_JS = `
// ── Texas Hold'em (simplified). Pure realtime app: seats + applyAction + view.
var SEATS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
var START = 1000;   // starting stack
var SB = 5;         // small blind
var BB = 10;        // big blind

// Seats the framework should hand out (declared by the app, not the core).
export var seats = SEATS;

// ── helpers: cards are ints 0..51. rank = c%13 (0='2' .. 12='A'), suit = c/13.
function shuffledDeck() {
  var d = [];
  for (var i = 0; i < 52; i++) d.push(i);
  for (var i = 51; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

function seatedOrder(state) {
  var out = [];
  for (var i = 0; i < SEATS.length; i++) if (state.players[SEATS[i]]) out.push(SEATS[i]);
  return out;
}

function canActNow(state, s) {
  var p = state.players[s];
  if (!p) return false;
  if (state.hand.indexOf(s) < 0) return false;
  return !p.folded && !p.allIn && p.chips > 0;
}

function needsToAct(state, s) {
  if (!canActNow(state, s)) return false;
  var p = state.players[s];
  return !p.acted || p.bet < state.currentBet;
}

function nextActor(state, fromSeat) {
  var h = state.hand, n = h.length;
  var i = h.indexOf(fromSeat);
  for (var k = 1; k <= n; k++) {
    var s = h[(i + k) % n];
    if (needsToAct(state, s)) return s;
  }
  return null;
}

function firstActor(state, startSeat) {
  if (needsToAct(state, startSeat)) return startSeat;
  return nextActor(state, startSeat);
}

function seatAfter(state, seat) {
  var h = state.hand, n = h.length;
  var i = h.indexOf(seat);
  return h[(i + 1) % n];
}

function inHandSeats(state) {
  return state.hand.filter(function (s) { return !state.players[s].folded; });
}

function resetRound(state) {
  for (var i = 0; i < state.hand.length; i++) {
    var p = state.players[state.hand[i]];
    p.bet = 0; p.acted = false;
  }
  state.currentBet = 0;
  state.minRaise = BB;
}

// ── hand evaluation (5-of-7). Returns a comparable score array. ──
function score5(cs) {
  var ranks = [], suits = [], cnt = {};
  for (var k = 0; k < 5; k++) {
    var r = cs[k] % 13, s = Math.floor(cs[k] / 13);
    ranks.push(r); suits.push(s); cnt[r] = (cnt[r] || 0) + 1;
  }
  var flush = suits[0] === suits[1] && suits[1] === suits[2] && suits[2] === suits[3] && suits[3] === suits[4];
  var desc = ranks.slice().sort(function (a, b) { return b - a; });
  // group ordering: primarily by count desc, then rank desc.
  var byGroup = ranks.slice().sort(function (a, b) { return (cnt[b] - cnt[a]) || (b - a); });
  // straight (with wheel A-2-3-4-5).
  var uniq = [];
  for (var i = 0; i < desc.length; i++) if (uniq.indexOf(desc[i]) < 0) uniq.push(desc[i]);
  var straightHigh = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[2] === 2 && uniq[3] === 1 && uniq[4] === 0) straightHigh = 3;
  }
  var counts = byGroup.map(function (r) { return cnt[r]; });
  if (flush && straightHigh >= 0) return [8, straightHigh];
  if (counts[0] === 4) return [7].concat(byGroup);
  if (counts[0] === 3 && counts[3] === 2) return [6].concat(byGroup);
  if (flush) return [5].concat(desc);
  if (straightHigh >= 0) return [4, straightHigh];
  if (counts[0] === 3) return [3].concat(byGroup);
  if (counts[0] === 2 && counts[2] === 2) return [2].concat(byGroup);
  if (counts[0] === 2) return [1].concat(byGroup);
  return [0].concat(desc);
}

function cmp(a, b) {
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    var x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function score7(seven) {
  var best = null;
  for (var a = 0; a < 7; a++) {
    for (var b = a + 1; b < 7; b++) {
      var five = [];
      for (var i = 0; i < 7; i++) if (i !== a && i !== b) five.push(seven[i]);
      var sc = score5(five);
      if (best === null || cmp(sc, best) > 0) best = sc;
    }
  }
  return best;
}

var HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// ── end-of-hand resolution ──
function awardFold(state, winner) {
  state.players[winner].chips += state.pot;
  state.results = { winners: [winner], amount: state.pot, byFold: true, hands: {} };
  state.message = winner + ' wins ' + state.pot + ' (everyone folded)';
  state.pot = 0;
  state.phase = 'showdown';
  state.showdownReveal = false;
  state.toAct = null;
}

function doShowdown(state) {
  var live = inHandSeats(state);
  var best = null, winners = [], hands = {};
  for (var i = 0; i < live.length; i++) {
    var s = live[i];
    var sc = score7(state.players[s].hole.concat(state.community));
    hands[s] = HAND_NAMES[sc[0]];
    if (best === null || cmp(sc, best) > 0) { best = sc; winners = [s]; }
    else if (cmp(sc, best) === 0) winners.push(s);
  }
  var share = Math.floor(state.pot / winners.length);
  var remainder = state.pot - share * winners.length;
  for (var w = 0; w < winners.length; w++) {
    state.players[winners[w]].chips += share + (w === 0 ? remainder : 0);
  }
  state.results = { winners: winners, amount: share, byFold: false, hands: hands };
  state.message = winners.join(', ') + ' win ' + share + ' each with ' + HAND_NAMES[best[0]];
  state.pot = 0;
  state.phase = 'showdown';
  state.showdownReveal = true;
  state.toAct = null;
}

// Called after a betting action resolves. Move to next actor, next street, or end.
function afterAction(state) {
  var live = inHandSeats(state);
  if (live.length === 1) { awardFold(state, live[0]); return; }
  var na = nextActor(state, state.toAct);
  if (na) { state.toAct = na; return; }
  progress(state);
}

// Betting round complete → deal the next street(s) and set up the next round,
// or run the board out to showdown when nobody can bet any more.
function progress(state) {
  while (true) {
    if (state.phase === 'river') { doShowdown(state); return; }
    if (state.phase === 'preflop') { state.community.push(state.deck.pop(), state.deck.pop(), state.deck.pop()); state.phase = 'flop'; }
    else if (state.phase === 'flop') { state.community.push(state.deck.pop()); state.phase = 'turn'; }
    else if (state.phase === 'turn') { state.community.push(state.deck.pop()); state.phase = 'river'; }
    resetRound(state);
    var canAct = state.hand.filter(function (s) { return canActNow(state, s); });
    if (canAct.length >= 2) {
      state.toAct = firstActor(state, seatAfter(state, state.button));
      return;
    }
    // else: 0 or 1 players can act (rest all-in) → keep dealing to showdown.
  }
}

// ── start a fresh hand ──
function startHand(state) {
  var participants = seatedOrder(state).filter(function (s) { return state.players[s].chips > 0; });
  if (participants.length < 2) { state.message = 'Need at least 2 players with chips.'; return state; }

  // rotate the dealer button to the next participant.
  var bi = participants.indexOf(state.button);
  state.button = participants[(bi + 1) % participants.length];

  state.deck = shuffledDeck();
  state.community = [];
  state.pot = 0;
  state.results = null;
  state.showdownReveal = false;
  state.hand = participants.slice();

  for (var i = 0; i < participants.length; i++) {
    var p = state.players[participants[i]];
    p.folded = false; p.allIn = false; p.bet = 0; p.acted = false;
    p.hole = [state.deck.pop(), state.deck.pop()];
  }

  var n = participants.length;
  var b = participants.indexOf(state.button);
  var sbSeat, bbSeat, first;
  if (n === 2) { sbSeat = participants[b]; bbSeat = participants[(b + 1) % n]; first = participants[b]; }
  else { sbSeat = participants[(b + 1) % n]; bbSeat = participants[(b + 2) % n]; first = participants[(b + 3) % n]; }

  postBlind(state, sbSeat, SB);
  postBlind(state, bbSeat, BB);
  state.currentBet = BB;
  state.minRaise = BB;
  state.phase = 'preflop';
  state.toAct = firstActor(state, first);
  state.message = 'New hand dealt. Blinds ' + SB + '/' + BB + '.';
  return state;
}

function postBlind(state, seat, amount) {
  var p = state.players[seat];
  var amt = Math.min(amount, p.chips);
  p.chips -= amt; p.bet = amt; state.pot += amt;
  if (p.chips === 0) p.allIn = true;
}

// ── REALTIME EXPORTS ──

export function initialState() {
  return {
    phase: 'waiting',            // waiting | preflop | flop | turn | river | showdown
    players: {},                 // seat -> { chips, hole, bet, folded, allIn, acted }
    hand: [],                    // seats dealt into the current hand (in order)
    community: [],
    deck: [],
    pot: 0,
    currentBet: 0,
    minRaise: BB,
    toAct: null,
    button: null,
    showdownReveal: false,
    results: null,
    message: 'Waiting for players. Take a seat and start a hand.'
  };
}

export function applyAction(state, action, ctx) {
  var s = state;
  if (!action || !action.type) return s;
  var seat = ctx ? ctx.seat : null;

  // Anyone (even a spectator promoted to a seat) can sit down for chips.
  if (action.type === 'sit') {
    if (!seat) return s;
    if (!s.players[seat]) s.players[seat] = { chips: START, hole: [], bet: 0, folded: false, allIn: false, acted: false };
    return s;
  }

  if (action.type === 'start') {
    if (s.phase !== 'waiting' && s.phase !== 'showdown') return s;
    return startHand(s);
  }

  // Betting actions: only the seat whose turn it is, during a betting street.
  var betting = s.phase === 'preflop' || s.phase === 'flop' || s.phase === 'turn' || s.phase === 'river';
  if (!betting) return s;
  if (!seat || seat !== s.toAct) return s;
  var p = s.players[seat];
  if (!p || p.folded || p.allIn) return s;

  if (action.type === 'fold') {
    p.folded = true; p.acted = true;
    afterAction(s);
    return s;
  }

  if (action.type === 'check') {
    if (p.bet !== s.currentBet) return s;   // can't check facing a bet
    p.acted = true;
    afterAction(s);
    return s;
  }

  if (action.type === 'call') {
    var need = s.currentBet - p.bet;
    if (need <= 0) return s;
    var amt = Math.min(need, p.chips);
    p.chips -= amt; p.bet += amt; s.pot += amt;
    if (p.chips === 0) p.allIn = true;
    p.acted = true;
    afterAction(s);
    return s;
  }

  if (action.type === 'raise') {
    var target = action.amount;
    if (typeof target !== 'number' || !isFinite(target)) return s;
    target = Math.floor(target);
    var contribution = target - p.bet;
    if (contribution <= 0) return s;
    var allIn = false;
    if (contribution >= p.chips) { contribution = p.chips; target = p.bet + contribution; allIn = true; }
    else if (target < s.currentBet + s.minRaise) return s;  // below min raise (and not all-in)
    p.chips -= contribution; p.bet = target; s.pot += contribution;
    if (allIn) p.allIn = true;
    if (target > s.currentBet) {
      s.minRaise = target - s.currentBet;
      s.currentBet = target;
      for (var i = 0; i < s.hand.length; i++) {
        var os = s.hand[i];
        if (os !== seat && canActNow(s, os)) s.players[os].acted = false;
      }
    }
    p.acted = true;
    afterAction(s);
    return s;
  }

  return s;
}

// The KEY function: project the full truth to what one viewer may see. Own hole
// cards are visible; others are hidden (shown as face-down placeholders) until a
// real showdown. The deck is NEVER included.
export function view(state, ctx) {
  var me = ctx ? ctx.seat : null;
  var reveal = state.phase === 'showdown' && state.showdownReveal;
  var players = {};
  var order = seatedOrder(state);
  for (var i = 0; i < order.length; i++) {
    var seat = order[i];
    var p = state.players[seat];
    var mine = seat === me;
    var show = mine || (reveal && !p.folded && state.hand.indexOf(seat) >= 0);
    var hole;
    if (show) hole = (p.hole || []).slice();
    else hole = (p.hole || []).map(function () { return null; });   // face-down count only
    players[seat] = {
      chips: p.chips,
      bet: p.bet || 0,
      folded: !!p.folded,
      allIn: !!p.allIn,
      inHand: state.hand.indexOf(seat) >= 0,
      isButton: state.button === seat,
      hole: hole
    };
  }
  return {
    phase: state.phase,
    community: state.community.slice(),
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    toAct: state.toAct,
    youSeat: me || null,
    message: state.message || '',
    results: state.results || null,
    seats: SEATS.slice(),
    players: players
  };
}

// ── PAGE (served by fetch; talks to the coordinator over a WebSocket) ──
var PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<style>',
  'body{margin:0;min-height:100vh;font-family:system-ui,sans-serif;background:#0b3d2e;color:#e6edf3;display:flex;flex-direction:column;align-items:center}',
  '.wrap{width:100%;max-width:760px;padding:16px;box-sizing:border-box}',
  '.seat{font-size:13px;color:#a7c4b5;letter-spacing:.05em;text-transform:uppercase;margin:0 0 4px}',
  '.msg{min-height:20px;font-size:14px;color:#ffd479;margin:0 0 12px}',
  '.board{display:flex;align-items:center;gap:14px;justify-content:center;background:rgba(0,0,0,.18);border-radius:16px;padding:18px;margin-bottom:14px}',
  '.pot{font-size:15px;color:#a7c4b5}',
  '.cards{display:flex;gap:6px}',
  '.card{width:46px;height:64px;border-radius:8px;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.4)}',
  '.card.red{color:#c0392b}.card.back{background:#243b6b;color:#243b6b}.card.empty{background:transparent;box-shadow:none;border:1px dashed #3c6b57}',
  '.players{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:14px}',
  '.p{border:1px solid #2f5f4c;border-radius:10px;padding:8px 10px;background:rgba(0,0,0,.15);font-size:13px}',
  '.p.turn{border-color:#ffd479;box-shadow:0 0 0 1px #ffd479}',
  '.p.me{background:rgba(47,129,247,.14)}',
  '.p.folded{opacity:.45}',
  '.p .name{font-weight:600;display:flex;justify-content:space-between}',
  '.p .sub{color:#a7c4b5;font-size:12px;margin-top:2px}',
  '.mine{display:flex;gap:8px;align-items:center;justify-content:center;margin:8px 0 16px}',
  '.mine .card{width:60px;height:84px;font-size:30px}',
  '.controls{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}',
  'button{font-size:15px;padding:9px 14px;border:0;border-radius:10px;background:#2f81f7;color:#fff;cursor:pointer}',
  'button.alt{background:#3fb950}button.warn{background:#d9534f}button.ghost{background:transparent;border:1px solid #3c6b57;color:#e6edf3}',
  'button:disabled{opacity:.4;cursor:not-allowed}',
  'input{width:90px;font-size:15px;padding:8px;border-radius:8px;border:1px solid #3c6b57;background:#0b3d2e;color:#e6edf3}',
  '.badge{font-size:10px;background:#ffd479;color:#111;border-radius:4px;padding:0 4px;margin-left:4px}',
  '</style></head><body><div class="wrap">',
  '<p class="seat" id="seat">connecting…</p>',
  '<p class="msg" id="msg"></p>',
  '<div class="board"><div class="pot" id="pot">Pot: 0</div><div class="cards" id="community"></div></div>',
  '<div class="players" id="players"></div>',
  '<div class="mine" id="mine"></div>',
  '<div class="controls" id="controls"></div>',
  '</div>',
  '<script>',
  'var RANKS="23456789TJQKA";var SUITS=["\\u2663","\\u2666","\\u2665","\\u2660"];',
  'var seatEl=document.getElementById("seat");var msgEl=document.getElementById("msg");',
  'var potEl=document.getElementById("pot");var commEl=document.getElementById("community");',
  'var playersEl=document.getElementById("players");var mineEl=document.getElementById("mine");',
  'var controlsEl=document.getElementById("controls");',
  'var token=sessionStorage.getItem("poker-token");',
  'if(!token){token=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem("poker-token",token);}',
  'var mySeat=null,ws=null,cur=null;',
  'function roomId(){var r=new URLSearchParams(location.search).get("room");return r||"main";}',
  'function agentUrl(){var proto=location.protocol==="https:"?"wss":"ws";return proto+"://"+location.host+"/agents/app-host/"+encodeURIComponent(roomId())+"?token="+encodeURIComponent(token);}',
  'function connect(){ws=new WebSocket(agentUrl());ws.onmessage=onMsg;ws.onclose=function(){seatEl.textContent="reconnecting…";setTimeout(connect,1000);};}',
  'function onMsg(e){var m;try{m=JSON.parse(e.data);}catch(err){return;}',
  '  if(m.type==="welcome"){mySeat=m.seat;if(mySeat)send({type:"sit"});}',
  '  else if(m.type==="state"){cur=m.state;render(m.state,m.players);}}',
  'function send(action){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:"action",action:action}));}',
  'function cardEl(c){var d=document.createElement("div");',
  '  if(c===null){d.className="card back";d.textContent="\\u2605";return d;}',
  '  var suit=Math.floor(c/13);d.className="card"+(suit===1||suit===2?" red":"");',
  '  d.textContent=RANKS.charAt(c%13)+SUITS[suit];return d;}',
  'function emptyCard(){var d=document.createElement("div");d.className="card empty";return d;}',
  'function render(s,presence){',
  '  seatEl.textContent=(mySeat?("You are "+mySeat):"Spectator")+"  ·  "+(s.phase||"");',
  '  msgEl.textContent=s.message||"";',
  '  potEl.textContent="Pot: "+s.pot;',
  '  commEl.innerHTML="";var comm=s.community||[];',
  '  for(var i=0;i<5;i++){commEl.appendChild(i<comm.length?cardEl(comm[i]):emptyCard());}',
  '  playersEl.innerHTML="";var order=s.seats||[];',
  '  for(var j=0;j<order.length;j++){(function(seat){var p=s.players[seat];if(!p)return;',
  '    var div=document.createElement("div");div.className="p"+(seat===s.toAct?" turn":"")+(seat===mySeat?" me":"")+(p.folded?" folded":"");',
  '    var online=presence&&presence[seat];',
  // Build the card via DOM nodes (no innerHTML with quoted attributes) so the
  // app source needs no fragile quote-escaping.
  '    var nameRow=document.createElement("div");nameRow.className="name";',
  '    var nm=document.createElement("span");nm.textContent=seat+(p.isButton?" (D)":"")+(seat===mySeat?" (you)":"");',
  '    var ch=document.createElement("span");ch.textContent=p.chips;',
  '    nameRow.appendChild(nm);nameRow.appendChild(ch);',
  '    var status=p.folded?"folded":(p.allIn?"all in":(p.bet>0?("bet "+p.bet):(online?"online":"away")));',
  '    var sub=document.createElement("div");sub.className="sub";sub.textContent=status;',
  '    div.appendChild(nameRow);div.appendChild(sub);',
  '    playersEl.appendChild(div);})(order[j]);}',
  '  mineEl.innerHTML="";var me=mySeat&&s.players[mySeat];',
  '  if(me&&me.hole&&me.hole.length){for(var k=0;k<me.hole.length;k++)mineEl.appendChild(cardEl(me.hole[k]));}',
  '  renderControls(s,me);',
  '}',
  'function mkBtn(label,cls,fn,disabled){var b=document.createElement("button");b.textContent=label;if(cls)b.className=cls;b.disabled=!!disabled;b.onclick=fn;return b;}',
  'function renderControls(s,me){',
  '  controlsEl.innerHTML="";',
  '  var seated=!!me;',
  '  if(!mySeat){controlsEl.appendChild(mkBtn("Table full — spectating","ghost",function(){},true));return;}',
  '  if(!seated){controlsEl.appendChild(mkBtn("Sit down","alt",function(){send({type:"sit"});}));return;}',
  '  var canStart=(s.phase==="waiting"||s.phase==="showdown");',
  '  if(canStart){controlsEl.appendChild(mkBtn("Deal / Next hand","alt",function(){send({type:"start"});}));return;}',
  '  var myTurn=(s.toAct===mySeat);var toCall=s.currentBet-(me.bet||0);',
  '  controlsEl.appendChild(mkBtn("Fold","warn",function(){send({type:"fold"});},!myTurn));',
  '  if(toCall<=0)controlsEl.appendChild(mkBtn("Check",null,function(){send({type:"check"});},!myTurn));',
  '  else controlsEl.appendChild(mkBtn("Call "+Math.min(toCall,me.chips),null,function(){send({type:"call"});},!myTurn));',
  '  var minTo=s.currentBet+s.minRaise;var inp=document.createElement("input");inp.type="number";inp.value=Math.min(minTo,me.chips+(me.bet||0));inp.min=minTo;',
  '  controlsEl.appendChild(inp);',
  '  controlsEl.appendChild(mkBtn("Raise to","alt",function(){send({type:"raise",amount:Number(inp.value)});},!myTurn||me.chips<=0));',
  '}',
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

export const pokerTemplate: AppTemplate = {
  id: "poker",
  label: "Texas Hold'em (multiplayer, hidden hands)",
  declares: ["room"],
  entrypoint: "src/index.js",
  files: [{ path: "src/index.js", content: INDEX_JS }]
};
