// Brief section 2: can a steer leak across sessions or across turns?
import { TurnSteering } from "../src/turn-steering.js";
let fails = 0;
const chk = (c, m) => { console.log((c ? "ok:   " : "FAIL: ") + m); if (!c) fails++; };

// --- Case 1: distinct sessions must never cross ---
{
  const s = new TurnSteering();
  s.beginTurn("A", { turnId: "tA" });
  s.beginTurn("B", { turnId: "tB" });
  s.steer("A", "for-A-only");
  const bResults = [{ type: "tool_result", tool_use_id: "b1", content: "B output", is_error: false }];
  const deliveredToB = s.applyToToolResults("B", bResults);
  chk(deliveredToB === false, "1: A's steer is NOT delivered into B's batch");
  chk(!String(bResults[0].content).includes("for-A-only"), "1: B's tool result is uncontaminated");
  chk(s.peek("A") === "for-A-only", "1: A's steer is still pending for A");
}

// --- Case 3: same session, two overlapping turns (beginTurn collision) ---
{
  const s = new TurnSteering();
  s.beginTurn("S", { turnId: "turn-1" });
  s.beginTurn("S", { turnId: "turn-2" });   // overwrites turn-1 in #inFlight
  chk(s.inFlight("S")?.turnId === "turn-2", "3: second beginTurn overwrote the first (Map keyed by session)");

  s.steer("S", "guidance-for-turn-2");
  // turn-1 finishes FIRST and calls endTurn -> whose steer dies?
  const stranded = s.endTurn("S");
  chk(stranded === "guidance-for-turn-2",
      "3: turn-1's endTurn consumed turn-2's steer (cross-turn interference)");
  chk(s.isTurnInFlight("S") === false,
      "3: turn-2 is now marked NOT in flight even though it is still running");
  console.log("      -> consequence: while turn-2 runs, a new user message sees no in-flight turn,");
  console.log("         so it PREEMPTS the goal instead of steering -- the exact behavior Phase 3 removes.");
}

// --- Negative control: does the guard work at all when used correctly? ---
{
  const s = new TurnSteering();
  s.beginTurn("S", { turnId: "t1" });
  s.steer("S", "deliver me");
  const r = [{ type: "tool_result", tool_use_id: "x", content: "out", is_error: false }];
  chk(s.applyToToolResults("S", r) === true, "control: correct single-turn use DOES deliver");
  chk(String(r[0].content).includes("deliver me"), "control: marker landed on the right batch");
}

console.log(fails === 0 ? "\nPROBE PASS (all assertions held)" : `\n${fails} assertion(s) FAILED`);
process.exit(0);
