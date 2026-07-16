import type { AppTemplate } from "../types";

/**
 * EXAMPLE APP — Blackjack 21 (multiplayer, realtime, HIDDEN INFORMATION).
 *
 * Multiple players sit at one table and play against a shared dealer. It uses the
 * same three realtime seams as the poker example (see src/templates/types.ts):
 *
 *   - `seats`                declares the seat pool ("P1".."P5").
 *   - `applyAction(s,a,ctx)` a PURE reducer holding ONE full authoritative state
 *                            (deck, every hand, the dealer's hole card, bets).
 *                            Math.random is allowed here to shuffle.
 *   - `view(state, ctx)`     a PURE projection: the dealer's HOLE card is hidden
 *                            from everyone until the dealer plays, so it never
 *                            leaks over the wire. Player hands are face-up (as in
 *                            a real casino), so the reveal is only the dealer's.
 *
 * Flow: waiting -> betting (each player places a bet) -> playing (turn-based
 * hit / stand / double / SPLIT) -> dealer (auto-draws to 17) -> done (payouts).
 * Blackjack pays 3:2, a win pays 1:1, a push returns the bet.
 *
 * SPLIT: when a player's first two cards are the same VALUE they may split them
 * into two independent hands (a matching bet is placed on the new hand, and one
 * fresh card is dealt to each). A player may keep splitting up to MAX_HANDS (4)
 * hands total. Split aces receive exactly one card each and then stand (the usual
 * casino rule), and a 21 made after a split counts as an ordinary 21, not a
 * natural blackjack. Each hand is then played out in turn before moving on to the
 * next seat, and each hand is settled against the dealer independently.
 *
 * Written as plain JavaScript (single-quoted strings, no backticks or ${} so it
 * embeds here without a build).
 */
const INDEX_JS = `
// ── Blackjack 21 (multiplayer vs. a shared dealer). Pure realtime app.
var SEATS = ['P1', 'P2', 'P3', 'P4', 'P5'];
var START = 1000;   // starting stack
var MIN_BET = 10;
var DEALER_STANDS_ON = 17;   // dealer draws until >= 17 (stands on all 17)
var MAX_HANDS = 4;           // a player may split until they hold up to 4 hands

// Seats the framework should hand out (declared by the app, not the core).
export var seats = SEATS;

// ── cards are ints 0..51. rank = c%13 (0='2' .. 8='T',9='J',10='Q',11='K',12='A').
function shuffledDeck() {
  var d = [];
  // two decks so a full table rarely runs dry.
  for (var n = 0; n < 2; n++) for (var i = 0; i < 52; i++) d.push(i);
  for (var i = d.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

function cardValue(rank) {
  if (rank === 12) return 11;   // ace (soft) — adjusted in handValue
  if (rank >= 8) return 10;     // T, J, Q, K
  return rank + 2;              // 2..9
}

// Best total <= 21 when possible (aces count 11 then drop to 1).
function handValue(cards) {
  var sum = 0, aces = 0;
  for (var i = 0; i < cards.length; i++) {
    var r = cards[i] % 13;
    sum += cardValue(r);
    if (r === 12) aces++;
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return sum;
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

function seatedOrder(state) {
  var out = [];
  for (var i = 0; i < SEATS.length; i++) if (state.players[SEATS[i]]) out.push(SEATS[i]);
  return out;
}

// A single playable hand. A player holds one of these normally, or several after
// splitting. 'fromSplit' hands can never score as a natural blackjack.
function makeHand(cards, bet, fromSplit) {
  return { cards: cards, bet: bet, busted: false, done: false, doubled: false, fromSplit: !!fromSplit, outcome: null, net: 0 };
}

// A seat is finished when every one of its hands has been played out.
function seatDone(p) {
  if (!p.hands || p.hands.length === 0) return true;
  for (var i = 0; i < p.hands.length; i++) if (!p.hands[i].done) return false;
  return true;
}

// Index of this seat's first hand that still needs to act (-1 if none).
function firstLiveHand(p) {
  var hands = p.hands || [];
  for (var i = 0; i < hands.length; i++) if (!hands[i].done) return i;
  return -1;
}

// Point the seat at its first hand still in play.
function focusSeat(state, seat) {
  var p = seat && state.players[seat];
  if (p) { var i = firstLiveHand(p); if (i >= 0) p.active = i; }
}

// Next seat in the current hand that still has a hand to play.
function nextActor(state, fromSeat) {
  var h = state.hand, n = h.length;
  var start = fromSeat === null ? -1 : h.indexOf(fromSeat);
  for (var k = 1; k <= n; k++) {
    var s = h[(start + k) % n];
    var p = state.players[s];
    if (p && !seatDone(p)) return s;
  }
  return null;
}

// ── dealer + resolution ──
function playDealerAndResolve(state) {
  state.phase = 'dealer';
  state.dealerReveal = true;

  // Only draw if at least one hand is still standing (not all busted).
  var anyLive = false;
  for (var i = 0; i < state.hand.length; i++) {
    var pp = state.players[state.hand[i]];
    if (!pp) continue;
    for (var q = 0; q < pp.hands.length; q++) if (!pp.hands[q].busted) { anyLive = true; break; }
    if (anyLive) break;
  }
  if (anyLive) {
    while (handValue(state.dealer.hand) < DEALER_STANDS_ON) {
      state.dealer.hand.push(state.deck.pop());
    }
  }

  var dTotal = handValue(state.dealer.hand);
  var dBust = dTotal > 21;
  var dBJ = isBlackjack(state.dealer.hand);
  var summary = [];

  for (var j = 0; j < state.hand.length; j++) {
    var seat = state.hand[j];
    var p = state.players[seat];
    if (!p) continue;
    var seatNet = 0;
    for (var hi = 0; hi < p.hands.length; hi++) {
      var hd = p.hands[hi];
      var pTotal = handValue(hd.cards);
      var pBJ = isBlackjack(hd.cards) && !hd.fromSplit;
      var outcome, payout;
      if (hd.busted) { outcome = 'bust'; payout = 0; }
      else if (pBJ && !dBJ) { outcome = 'blackjack'; payout = Math.floor(hd.bet * 2.5); }
      else if (dBJ && !pBJ) { outcome = 'lose'; payout = 0; }
      else if (dBust) { outcome = 'win'; payout = hd.bet * 2; }
      else if (pTotal > dTotal) { outcome = 'win'; payout = hd.bet * 2; }
      else if (pTotal === dTotal) { outcome = 'push'; payout = hd.bet; }
      else { outcome = 'lose'; payout = 0; }
      p.chips += payout;
      hd.outcome = outcome;
      hd.net = payout - hd.bet;
      seatNet += hd.net;
    }
    summary.push(seat + ' ' + (seatNet > 0 ? ('+' + seatNet) : (seatNet < 0 ? ('' + seatNet) : 'even')));
  }

  state.phase = 'done';
  state.toAct = null;
  state.results = { dealerTotal: dTotal, dealerBust: dBust, dealerBlackjack: dBJ };
  state.message = 'Dealer ' + (dBust ? 'busts with ' + dTotal : 'has ' + dTotal) + '.  ' + summary.join('   ');
}

// Advance within the current seat's hands, then to the next seat, then dealer.
function afterAction(state) {
  var p = state.players[state.toAct];
  if (p) {
    var i = firstLiveHand(p);
    if (i >= 0) { p.active = i; return; }   // same seat still has a hand to play
  }
  var na = nextActor(state, state.toAct);
  if (na) { state.toAct = na; focusSeat(state, na); return; }
  playDealerAndResolve(state);
}

// ── deal a fresh round to everyone who placed a bet ──
function deal(state) {
  var betters = seatedOrder(state).filter(function (s) { return state.players[s].bet > 0; });
  if (betters.length === 0) { state.message = 'Place a bet before dealing.'; return state; }

  state.deck = shuffledDeck();
  state.hand = betters.slice();
  state.dealer = { hand: [state.deck.pop(), state.deck.pop()] };
  state.dealerReveal = false;
  state.results = null;

  for (var i = 0; i < betters.length; i++) {
    var p = state.players[betters[i]];
    var cards = [state.deck.pop(), state.deck.pop()];
    p.hands = [makeHand(cards, p.bet, false)];
    p.active = 0;
    if (isBlackjack(cards)) p.hands[0].done = true;   // naturals stand automatically
  }

  state.phase = 'playing';
  state.toAct = nextActor(state, null);
  focusSeat(state, state.toAct);
  state.message = 'Cards dealt. ' + (state.toAct ? state.toAct + ' to act.' : 'Dealer plays.');
  if (!state.toAct) playDealerAndResolve(state);   // e.g. everyone dealt blackjack
  return state;
}

// Reset to a fresh betting round (keep chips + seats).
function newRound(state) {
  var order = seatedOrder(state);
  for (var i = 0; i < order.length; i++) {
    var p = state.players[order[i]];
    p.bet = 0; p.hands = []; p.active = 0;
  }
  state.dealer = { hand: [] };
  state.dealerReveal = false;
  state.hand = [];
  state.results = null;
  state.phase = 'betting';
  state.toAct = null;
  state.message = 'Place your bets (min ' + MIN_BET + ').';
  return state;
}

// ── REALTIME EXPORTS ──

export function initialState() {
  return {
    phase: 'waiting',          // waiting | betting | playing | dealer | done
    players: {},               // seat -> { chips, bet, hands:[hand], active }
    dealer: { hand: [] },
    dealerReveal: false,
    hand: [],                  // seats dealt into the current round (in order)
    deck: [],
    toAct: null,
    results: null,
    message: 'Waiting for players. Take a seat to begin.'
  };
}

export function applyAction(state, action, ctx) {
  var s = state;
  if (!action || !action.type) return s;
  var seat = ctx ? ctx.seat : null;

  if (action.type === 'sit') {
    if (!seat) return s;
    if (!s.players[seat]) {
      s.players[seat] = { chips: START, bet: 0, hands: [], active: 0 };
      if (s.phase === 'waiting') { s.phase = 'betting'; s.message = 'Place your bets (min ' + MIN_BET + ').'; }
    }
    return s;
  }

  // Move from a finished/blank table into a fresh betting round.
  if (action.type === 'newRound') {
    if (s.phase !== 'done' && s.phase !== 'waiting') return s;
    if (seatedOrder(s).length === 0) return s;
    return newRound(s);
  }

  if (action.type === 'bet') {
    if (s.phase !== 'betting') return s;
    if (!seat || !s.players[seat]) return s;
    var p = s.players[seat];
    if (p.bet > 0) return s;   // already bet this round
    var amt = action.amount;
    if (typeof amt !== 'number' || !isFinite(amt)) return s;
    amt = Math.floor(amt);
    if (amt < MIN_BET || amt > p.chips) return s;
    p.chips -= amt; p.bet = amt;
    s.message = seat + ' bet ' + amt + '.';
    return s;
  }

  if (action.type === 'deal') {
    if (s.phase !== 'betting') return s;
    return deal(s);
  }

  // Player turn actions — all operate on the seat's currently active hand.
  if (s.phase !== 'playing') return s;
  if (!seat || seat !== s.toAct) return s;
  var pl = s.players[seat];
  if (!pl) return s;
  var hd = pl.hands[pl.active];
  if (!hd || hd.done) return s;

  if (action.type === 'hit') {
    hd.cards.push(s.deck.pop());
    var v = handValue(hd.cards);
    if (v > 21) { hd.busted = true; hd.done = true; }
    else if (v === 21) { hd.done = true; }
    afterAction(s);
    return s;
  }

  if (action.type === 'stand') {
    hd.done = true;
    afterAction(s);
    return s;
  }

  if (action.type === 'double') {
    // Double the bet, take exactly one card, then stand. Only on first two cards.
    if (hd.cards.length !== 2 || pl.chips < hd.bet) return s;
    pl.chips -= hd.bet; hd.bet *= 2; hd.doubled = true;
    hd.cards.push(s.deck.pop());
    if (handValue(hd.cards) > 21) hd.busted = true;
    hd.done = true;
    afterAction(s);
    return s;
  }

  if (action.type === 'split') {
    // Split two same-value cards into two hands, matching the bet on the new one.
    if (hd.cards.length !== 2) return s;
    if (pl.hands.length >= MAX_HANDS) return s;
    var ra = hd.cards[0] % 13, rb = hd.cards[1] % 13;
    if (cardValue(ra) !== cardValue(rb)) return s;
    if (pl.chips < hd.bet) return s;

    pl.chips -= hd.bet;                     // matching bet for the new hand
    var moved = hd.cards.pop();             // second card starts the new hand
    hd.fromSplit = true;
    var nh = makeHand([moved], hd.bet, true);
    hd.cards.push(s.deck.pop());            // one fresh card to each hand
    nh.cards.push(s.deck.pop());
    pl.hands.splice(pl.active + 1, 0, nh);  // play the new hand right after this one

    if (cardValue(ra) === 11) {
      // Split aces: exactly one card each, then both stand (standard rule).
      hd.done = true; nh.done = true;
    } else {
      if (handValue(hd.cards) === 21) hd.done = true;
      if (handValue(nh.cards) === 21) nh.done = true;
    }
    afterAction(s);
    return s;
  }

  return s;
}

// Project the truth to what one viewer may see. Player hands are face-up (all
// visible), as in a casino; the dealer's SECOND (hole) card stays hidden until
// the dealer plays. The deck is NEVER included.
export function view(state, ctx) {
  var me = ctx ? ctx.seat : null;
  var players = {};
  var order = seatedOrder(state);
  for (var i = 0; i < order.length; i++) {
    var seat = order[i];
    var p = state.players[seat];
    var hands = (p.hands || []).map(function (h) {
      return {
        cards: h.cards.slice(),
        total: handValue(h.cards),
        bet: h.bet,
        busted: !!h.busted,
        done: !!h.done,
        doubled: !!h.doubled,
        blackjack: isBlackjack(h.cards) && !h.fromSplit,
        outcome: h.outcome || null,
        net: h.net || 0
      };
    });
    players[seat] = {
      chips: p.chips,
      bet: p.bet || 0,
      active: p.active || 0,
      inHand: state.hand.indexOf(seat) >= 0,
      hands: hands
    };
  }

  var dealerHand, dealerTotal = null;
  var dh = (state.dealer && state.dealer.hand) || [];
  if (state.dealerReveal) {
    dealerHand = dh.slice();
    dealerTotal = handValue(dh);
  } else {
    // Show only the up-card; the hole card is face-down.
    dealerHand = dh.map(function (c, idx) { return idx === 0 ? c : null; });
  }

  return {
    phase: state.phase,
    dealer: { hand: dealerHand, total: dealerTotal, reveal: !!state.dealerReveal },
    toAct: state.toAct,
    youSeat: me || null,
    message: state.message || '',
    results: state.results || null,
    minBet: MIN_BET,
    maxHands: MAX_HANDS,
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
  '.wrap{width:100%;max-width:820px;padding:16px;box-sizing:border-box}',
  '.seat{font-size:13px;color:#a7c4b5;letter-spacing:.05em;text-transform:uppercase;margin:0 0 4px}',
  '.msg{min-height:20px;font-size:14px;color:#ffd479;margin:0 0 12px}',
  '.dealer{background:rgba(0,0,0,.18);border-radius:16px;padding:16px;margin-bottom:14px;text-align:center}',
  '.dealer h2{margin:0 0 8px;font-size:15px;color:#a7c4b5;letter-spacing:.05em;text-transform:uppercase}',
  '.cards{display:flex;gap:6px;justify-content:center}',
  '.card{width:46px;height:64px;border-radius:8px;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.4)}',
  '.card.red{color:#c0392b}.card.back{background:#243b6b;color:#7f9bd6}.card.empty{background:transparent;box-shadow:none;border:1px dashed #3c6b57}',
  '.total{font-size:13px;color:#a7c4b5;margin-top:6px}',
  '.players{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:14px}',
  '.p{border:1px solid #2f5f4c;border-radius:10px;padding:8px 10px;background:rgba(0,0,0,.15);font-size:13px}',
  '.p.turn{border-color:#ffd479;box-shadow:0 0 0 1px #ffd479}',
  '.p.me{background:rgba(47,129,247,.14)}',
  '.p .name{font-weight:600;display:flex;justify-content:space-between}',
  '.p .sub{color:#a7c4b5;font-size:12px;margin:4px 0}',
  '.p .cards{justify-content:flex-start;flex-wrap:wrap}',
  '.p .card{width:32px;height:46px;font-size:16px}',
  '.p .hands{display:flex;flex-direction:column;gap:6px;margin-top:4px}',
  '.hand{border-radius:8px;padding:4px 6px}',
  '.hand.active{background:rgba(255,212,121,.12);outline:1px solid #ffd479}',
  '.hand.busted{opacity:.5}',
  '.hand .meta{color:#a7c4b5;font-size:12px;margin-bottom:3px}',
  '.win{color:#3fb950}.lose{color:#d9534f}.push{color:#ffd479}',
  '.controls{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center}',
  'button{font-size:15px;padding:9px 14px;border:0;border-radius:10px;background:#2f81f7;color:#fff;cursor:pointer}',
  'button.alt{background:#3fb950}button.warn{background:#d9534f}button.ghost{background:transparent;border:1px solid #3c6b57;color:#e6edf3}',
  'button:disabled{opacity:.4;cursor:not-allowed}',
  'input{width:90px;font-size:15px;padding:8px;border-radius:8px;border:1px solid #3c6b57;background:#0b3d2e;color:#e6edf3}',
  '.chips{margin-left:6px;color:#3fb950}',
  '</style></head><body><div class="wrap">',
  '<p class="seat" id="seat">connecting…</p>',
  '<p class="msg" id="msg"></p>',
  '<div class="dealer"><h2>Dealer</h2><div class="cards" id="dealerCards"></div><div class="total" id="dealerTotal"></div></div>',
  '<div class="players" id="players"></div>',
  '<div class="controls" id="controls"></div>',
  '</div>',
  '<script>',
  'var RANKS="23456789TJQKA";var SUITS=["\\u2663","\\u2666","\\u2665","\\u2660"];',
  'var seatEl=document.getElementById("seat");var msgEl=document.getElementById("msg");',
  'var dealerCardsEl=document.getElementById("dealerCards");var dealerTotalEl=document.getElementById("dealerTotal");',
  'var playersEl=document.getElementById("players");var controlsEl=document.getElementById("controls");',
  // Stable per-tab / per-browser identity so reload resumes the same seat.
  'var _pl=new URLSearchParams(location.search).get("player");',
  'var token=_pl||localStorage.getItem("blackjack-token");',
  'if(!token){token=Math.random().toString(36).slice(2)+Date.now().toString(36);}',
  'if(!_pl){localStorage.setItem("blackjack-token",token);}',
  'var mySeat=null,ws=null,cur=null;',
  'function roomId(){var r=new URLSearchParams(location.search).get("room");return r||"main";}',
  'function agentUrl(){var proto=location.protocol==="https:"?"wss":"ws";return proto+"://"+location.host+"/agents/app-host/"+encodeURIComponent(roomId())+"?token="+encodeURIComponent(token);}',
  'function connect(){ws=new WebSocket(agentUrl());ws.onmessage=onMsg;ws.onclose=function(){seatEl.textContent="reconnecting…";setTimeout(connect,1000);};}',
  'function onMsg(e){var m;try{m=JSON.parse(e.data);}catch(err){return;}',
  '  if(m.type==="welcome"){mySeat=m.seat;if(mySeat)send({type:"sit"});}',
  '  else if(m.type==="state"){cur=m.state;render(m.state,m.players);}',
  '  else if(m.type==="reload"){location.reload();}}',
  'function send(action){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:"action",action:action}));}',
  'function cardVal(c){var r=c%13;return r===12?11:(r>=8?10:r+2);}',
  'function cardEl(c){var d=document.createElement("div");',
  '  if(c===null){d.className="card back";d.textContent="\\u2605";return d;}',
  '  var suit=Math.floor(c/13);d.className="card"+(suit===1||suit===2?" red":"");',
  '  d.textContent=RANKS.charAt(c%13)+SUITS[suit];return d;}',
  'function emptyCard(){var d=document.createElement("div");d.className="card empty";return d;}',
  'function render(s,presence){',
  '  seatEl.textContent=(mySeat?("You are "+mySeat):"Spectator")+"  ·  "+(s.phase||"");',
  '  msgEl.textContent=s.message||"";',
  '  dealerCardsEl.innerHTML="";var dh=(s.dealer&&s.dealer.hand)||[];',
  '  if(!dh.length){dealerCardsEl.appendChild(emptyCard());dealerCardsEl.appendChild(emptyCard());}',
  '  else for(var i=0;i<dh.length;i++)dealerCardsEl.appendChild(cardEl(dh[i]));',
  '  dealerTotalEl.textContent=(s.dealer&&s.dealer.total!=null)?("Total: "+s.dealer.total):"";',
  '  playersEl.innerHTML="";var order=s.seats||[];',
  '  for(var j=0;j<order.length;j++){(function(seat){var p=s.players[seat];if(!p)return;',
  '    var div=document.createElement("div");div.className="p"+(seat===s.toAct?" turn":"")+(seat===mySeat?" me":"");',
  '    var online=presence&&presence[seat];',
  '    var nameRow=document.createElement("div");nameRow.className="name";',
  '    var nm=document.createElement("span");nm.textContent=seat+(seat===mySeat?" (you)":"");',
  '    var ch=document.createElement("span");ch.className="chips";ch.textContent=p.chips;',
  '    nameRow.appendChild(nm);nameRow.appendChild(ch);div.appendChild(nameRow);',
  '    var hands=p.hands||[];',
  '    if(!hands.length){',
  '      var sub=document.createElement("div");sub.className="sub";var b=[];',
  '      if(p.bet>0)b.push("bet "+p.bet);',
  '      else if(s.phase==="betting")b.push("no bet");',
  '      else if(!online)b.push("away");',
  '      sub.textContent=b.join("  ·  ");div.appendChild(sub);',
  '    }else{',
  '      var wrap=document.createElement("div");wrap.className="hands";',
  '      for(var k=0;k<hands.length;k++){(function(h,hi){',
  '        var hd=document.createElement("div");hd.className="hand"+((seat===s.toAct&&hi===p.active)?" active":"")+(h.busted?" busted":"");',
  '        var meta=document.createElement("div");meta.className="meta";var tags=["total "+h.total];',
  '        if(h.bet)tags.push("bet "+h.bet);',
  '        if(h.blackjack)tags.push("BLACKJACK");else if(h.busted)tags.push("BUST");',
  '        if(h.doubled)tags.push("DOUBLED");',
  '        meta.textContent=tags.join("  ·  ");hd.appendChild(meta);',
  '        var cardsRow=document.createElement("div");cardsRow.className="cards";',
  '        var cs=h.cards||[];for(var m=0;m<cs.length;m++)cardsRow.appendChild(cardEl(cs[m]));hd.appendChild(cardsRow);',
  '        if(h.outcome){var res=document.createElement("div");res.className="sub "+(h.outcome==="win"||h.outcome==="blackjack"?"win":(h.outcome==="push"?"push":"lose"));',
  '          res.textContent=h.outcome.toUpperCase()+(h.net>0?(" +"+h.net):(h.net<0?(" "+h.net):""));hd.appendChild(res);}',
  '        wrap.appendChild(hd);})(hands[k],k);}',
  '      div.appendChild(wrap);',
  '    }',
  '    playersEl.appendChild(div);})(order[j]);}',
  '  renderControls(s);',
  '}',
  'function mkBtn(label,cls,fn,disabled){var b=document.createElement("button");b.textContent=label;if(cls)b.className=cls;b.disabled=!!disabled;b.onclick=fn;return b;}',
  'function renderControls(s){',
  '  controlsEl.innerHTML="";',
  '  var me=mySeat&&s.players[mySeat];',
  '  if(!mySeat){controlsEl.appendChild(mkBtn("Table full — spectating","ghost",function(){},true));return;}',
  '  if(!me){controlsEl.appendChild(mkBtn("Sit down","alt",function(){send({type:"sit"});}));return;}',
  '  if(s.phase==="betting"){',
  '    if(me.bet>0){controlsEl.appendChild(mkBtn("Bet placed: "+me.bet,"ghost",function(){},true));',
  '      controlsEl.appendChild(mkBtn("Deal","alt",function(){send({type:"deal"});}));return;}',
  '    var inp=document.createElement("input");inp.type="number";inp.value=Math.min(s.minBet,me.chips);inp.min=s.minBet;inp.max=me.chips;',
  '    controlsEl.appendChild(inp);',
  '    controlsEl.appendChild(mkBtn("Place bet","alt",function(){send({type:"bet",amount:Number(inp.value)});},me.chips<s.minBet));',
  '    return;}',
  '  if(s.phase==="playing"){',
  '    var myTurn=(s.toAct===mySeat);',
  '    var hand=me.hands&&me.hands[me.active];',
  '    var two=hand&&hand.cards&&hand.cards.length===2;',
  '    controlsEl.appendChild(mkBtn("Hit",null,function(){send({type:"hit"});},!myTurn||!hand));',
  '    controlsEl.appendChild(mkBtn("Stand","warn",function(){send({type:"stand"});},!myTurn||!hand));',
  '    var canDouble=myTurn&&two&&me.chips>=hand.bet;',
  '    controlsEl.appendChild(mkBtn("Double","alt",function(){send({type:"double"});},!canDouble));',
  '    var canSplit=myTurn&&two&&cardVal(hand.cards[0])===cardVal(hand.cards[1])&&me.chips>=hand.bet&&me.hands.length<s.maxHands;',
  '    controlsEl.appendChild(mkBtn("Split",null,function(){send({type:"split"});},!canSplit));',
  '    return;}',
  '  if(s.phase==="done"){controlsEl.appendChild(mkBtn("Next round","alt",function(){send({type:"newRound"});}));return;}',
  '  controlsEl.appendChild(mkBtn("Waiting…","ghost",function(){},true));',
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

export const blackjackTemplate: AppTemplate = {
  id: "blackjack",
  label: "Blackjack 21 (multiplayer vs. dealer)",
  declares: ["room"],
  entrypoint: "src/index.js",
  files: [{ path: "src/index.js", content: INDEX_JS }]
};
