// Focused regression checks for stage effects, stage-select flow, and results bookkeeping.
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('No game script found');
function makeCtx() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 50 });
      if (String(prop).startsWith('create')) return () => makeCtx();
      return () => makeCtx();
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}
const ctx = makeCtx();
const canvas = { width: 960, height: 600, getContext: () => ctx };
const sandbox = {
  console, Math, Date,
  performance: { now: () => 0 },
  requestAnimationFrame: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    getElementById: id => id === 'game' ? canvas : { style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} }, addEventListener() {} },
    addEventListener() {},
  },
  window: { addEventListener() {} },
};
sandbox.global = sandbox;
let script = match[1].replace(/^const /gm, 'var ').replace(/^let /gm, 'var ');
vm.runInNewContext(script, sandbox, { filename: 'index.html' });
let passed = 0;
function check(value, label) {
  if (!value) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✅ ${label}`);
}
check(Object.keys(sandbox.STAGES).length === 6, 'six stages remain defined');
check(sandbox.STAGES.battlefield.platM, 'Battlefield middle platform is defined');
check(sandbox.STAGES.yoshisStory.hasRandall, "Yoshi's Story enables Randall");
check(sandbox.getStagePlatforms(sandbox.STAGES.yoshisStory, 0).length === 4, 'Randall joins the collision platform list');
const f0 = sandbox.getStagePlatforms(sandbox.STAGES.fountainOfDreams, 0);
const f300 = sandbox.getStagePlatforms(sandbox.STAGES.fountainOfDreams, 300);
check(f0[1].y !== f300[1].y || f0[2].y !== f300[2].y, 'Fountain side platforms wave over time');
const ps0 = sandbox.getStadiumLayout(0).name;
const ps1800 = sandbox.getStadiumLayout(1800).name;
check(ps0 !== ps1800, 'Pokemon Stadium transforms cycle');
check(sandbox.getStageSelectInput(1).confirm === false, 'stage-select input adapter exists');
const p = sandbox.createPlayer('fox', 0, true);
check(p.stats && p.stats.kos === 0 && p.stats.falls === 0 && p.stats.selfDestructs === 0, 'players initialize result stats');
check(typeof sandbox.drawResults === 'function', 'results renderer exists');
check(typeof sandbox.beginSceneTransition === 'function', 'scene transition helper exists');
console.log(`\nRESULTS: ${passed}/${passed} passed`);
