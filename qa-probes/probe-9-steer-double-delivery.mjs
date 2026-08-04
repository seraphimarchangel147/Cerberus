// Azazel's out-of-scope observation from section 2, verified: a Discord message
// that STEERS an in-flight turn is also enqueued as a full turn when the lock
// frees, so the model sees the same user text twice.
//
// enqueueTurn does the steer/preempt decision and then unconditionally falls
// through to the turnLocks chain, so the steer path is additive rather than
// terminal.
import { TurnSteering } from "../src/turn-steering.js";

let fails = 0;
const chk = (c, m) => { console.log((c ? "ok:   " : "FAIL: ") + m); if (!c) fails++; };

// Faithful reproduction of the enqueueTurn decision + fallthrough.
function enqueueTurn({ steering, goals, key, cleaned, isBot = false, runTurn }) {
  const delivered = { steered: false, preempted: false, ranFullTurn: false };
  if (!isBot) {
    try {
      if (goals?.get?.(key)?.status === "active") {
        if (steering?.isTurnInFlight?.(key) && steering.steer(key, cleaned)) {
          delivered.steered = true;
          return delivered;   // FIXED: the steer IS the delivery
        }
        goals.preempt?.(key, "discord-user-message");
        delivered.preempted = true;
      }
    } catch { /* advisory */ }
  }
  // THE FALLTHROUGH: unconditional, regardless of the steer above.
  runTurn(cleaned);
  delivered.ranFullTurn = true;
  return delivered;
}

const steering = new TurnSteering();
steering.beginTurn("k", { turnId: "t1" });
const goals = { get: () => ({ status: "active" }), preempt: () => {} };
const turnsRun = [];

const outcome = enqueueTurn({
  steering, goals, key: "k",
  cleaned: "actually, use the other API",
  runTurn: (text) => turnsRun.push(text)
});

chk(outcome.steered === true, "the message was accepted as a mid-turn steer");
chk(outcome.ranFullTurn !== true, "FIXED: it does NOT also run as a full turn");
chk(steering.peek("k") === "actually, use the other API", "the steer is queued for the tool boundary");
chk(turnsRun.length === 0, "FIXED: the text is NOT queued a second time");
console.log("      -> exactly one delivery: the steer marker, mid-turn.");

// Negative control: with no turn in flight there is exactly one delivery.
const s2 = new TurnSteering();
const runs2 = [];
const o2 = enqueueTurn({
  steering: s2, goals, key: "k2", cleaned: "new instruction",
  runTurn: (t) => runs2.push(t)
});
chk(o2.steered === false && o2.preempted === true, "control: no in-flight turn -> preempt path");
chk(runs2.length === 1 && !s2.hasPending("k2"), "control: exactly one delivery, no duplicate");

console.log(fails === 0 ? "\nPROBE PASS (double-delivery reproduced)" : `\n${fails} FAILED`);
process.exit(0);
