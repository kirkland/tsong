// The Parliament — client overlay for the Nomic rules game. Self-contained + lazy-loaded like the
// other sub-games, but it's a DOM panel (a rulebook, the floor, a scoreboard) rather than a canvas.
// The server (server/nomic.ts) is authoritative; this just renders the broadcast `nomState` and
// sends the player's moves (enter/leave/propose/vote/resolve). See docs/nomic.md.

import type {
  NomEffect, NomParams, NomProposalKind, NomStateMsg, NomVote,
} from '../shared/types';

export interface NomicNet {
  enter(): void;
  leave(): void;
  propose(kind: NomProposalKind, text: string, target?: number, effect?: NomEffect | null, ruleClass?: 'immutable' | 'mutable'): void;
  vote(vote: NomVote): void;
  resolve(): void;
}

let net: NomicNet | null = null;
let overlay: HTMLDivElement | null = null;
let state: NomStateMsg | null = null;

const THRESHOLD_LABEL: Record<NomParams['threshold'], string> = {
  majority: 'simple majority', twothirds: 'two-thirds', unanimous: 'unanimous',
};

// Open the Parliament: build the overlay (once), subscribe, and wait for the first nomState.
export function startNomic(host: NomicNet) {
  net = host;
  if (overlay) { overlay.style.display = 'flex'; net.enter(); return; }
  injectStyles();
  overlay = document.createElement('div');
  overlay.className = 'nom-overlay';
  overlay.innerHTML = `
    <div class="nom-panel">
      <header class="nom-head">
        <div class="nom-title">🏛️ <b>PARLIAMENT</b> <span class="nom-season"></span></div>
        <button class="nom-close" title="Leave the chamber">✕</button>
      </header>
      <div class="nom-body">
        <section class="nom-rules">
          <h3>The Rulebook</h3>
          <div class="nom-rulelist"></div>
        </section>
        <aside class="nom-side">
          <div class="nom-params"></div>
          <div class="nom-floor"></div>
          <div class="nom-scores"></div>
          <div class="nom-log"></div>
        </aside>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.nom-close')!.addEventListener('click', () => closeNomic());
  overlay.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') closeNomic(); });
  net.enter();
  render();
}

export function closeNomic() {
  net?.leave();
  if (overlay) overlay.style.display = 'none';
}

// Server pushed a fresh parliament snapshot (routed here from main.ts).
export function feedNomState(s: NomStateMsg) {
  state = s;
  render();
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function nameOf(id: string | null): string {
  if (!id || !state) return '—';
  return state.scores.find((sc) => sc.id === id)?.name ?? '—';
}

function render() {
  if (!overlay || !state) return;
  const s = state;
  (overlay.querySelector('.nom-season') as HTMLElement).textContent = `· Season ${s.season}`;

  // Winner banner (briefly shown right after a season is sealed).
  let banner = overlay.querySelector('.nom-winner') as HTMLElement | null;
  if (s.winner) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'nom-winner';
      overlay.querySelector('.nom-panel')!.prepend(banner);
    }
    banner.textContent = `🏆 ${s.winner} won the season! A fresh session convenes — the rulebook carries on, scores reset.`;
  } else if (banner) { banner.remove(); }

  renderRules(s);
  renderParams(s);
  renderFloor(s);
  renderScores(s);
  renderLog(s);
}

function renderRules(s: NomStateMsg) {
  const host = overlay!.querySelector('.nom-rulelist') as HTMLElement;
  const imm = s.rules.filter((r) => !r.mutable);
  const mut = s.rules.filter((r) => r.mutable);
  const row = (r: { num: number; text: string; effect?: NomEffect | null }) =>
    `<div class="nom-rule"><span class="nom-num">${r.num}</span><span class="nom-rtext">${esc(r.text)}${r.effect ? ` <em class="nom-knob">[${r.effect.param}]</em>` : ''}</span></div>`;
  host.innerHTML =
    `<div class="nom-class">Immutable — the Constitution <small>(transmute needs unanimity)</small></div>` +
    imm.map(row).join('') +
    `<div class="nom-class nom-class-mut">Mutable — the Body</div>` +
    (mut.length ? mut.map(row).join('') : `<div class="nom-empty">(none — the body has been repealed to nothing!)</div>`);
}

function renderParams(s: NomStateMsg) {
  const p = s.params;
  (overlay!.querySelector('.nom-params') as HTMLElement).innerHTML = `
    <h3>Rules in force</h3>
    <ul class="nom-plist">
      <li>Pass by <b>${THRESHOLD_LABEL[p.threshold]}</b></li>
      <li>Adopting scores <b>${p.pointsPerAdoption}</b> pts</li>
      <li>Win at <b>${p.winScore}</b> pts</li>
      <li>Turn order: <b>${p.turnDir === 1 ? 'forward' : 'reverse'}</b></li>
      <li>Abstaining: <b>${p.allowAbstain ? 'allowed' : 'forbidden'}</b></li>
    </ul>`;
}

function renderScores(s: NomStateMsg) {
  const host = overlay!.querySelector('.nom-scores') as HTMLElement;
  const rows = s.scores.map((sc) => {
    const seated = s.members.includes(sc.id);
    const speaker = s.turn === sc.id;
    return `<li class="${seated ? 'nom-seated' : 'nom-absent'}">
      <span class="nom-dot" style="background:${esc(sc.color)}"></span>
      <span class="nom-pname">${speaker ? '🪑 ' : ''}${esc(sc.name)}${sc.id === s.you ? ' <em>(you)</em>' : ''}</span>
      <span class="nom-pts">${sc.points}</span></li>`;
  }).join('');
  host.innerHTML = `<h3>Legislators</h3><ol class="nom-scorelist">${rows || '<li class="nom-empty">Nobody seated.</li>'}</ol>`;
}

function renderLog(s: NomStateMsg) {
  const host = overlay!.querySelector('.nom-log') as HTMLElement;
  const lines = s.log.slice(-12).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');
  host.innerHTML = `<h3>The record</h3><ul class="nom-loglist">${lines || '<li class="nom-empty">No business yet.</li>'}</ul>`;
}

// Tracks what the floor currently shows so we don't rebuild an in-progress propose form on every
// broadcast — re-running host.innerHTML would wipe whatever the Speaker is mid-typing (and drop
// focus) the instant another legislator enters, votes, or proposes.
let floorMode = '';
function renderFloor(s: NomStateMsg) {
  const host = overlay!.querySelector('.nom-floor') as HTMLElement;
  if (s.proposal) { floorMode = 'proposal'; renderProposalOnFloor(s, host); return; }
  if (s.yourTurn) {
    // Build the form once when the floor first becomes ours; leave it alone (and its typed text)
    // on subsequent broadcasts while it's still our turn with nothing on the floor.
    if (floorMode === 'propose' && host.querySelector('.nom-form')) return;
    floorMode = 'propose';
    renderProposeForm(host);
    return;
  }
  floorMode = 'wait';
  host.innerHTML = `<h3>The floor</h3><p class="nom-wait">Waiting for <b>${esc(nameOf(s.turn))}</b> to take the floor…</p>`;
}

function renderProposalOnFloor(s: NomStateMsg, host: HTMLElement) {
  const p = s.proposal!;
  const fors = p.votes.filter((v) => v.vote === 'for').length;
  const against = p.votes.filter((v) => v.vote === 'against').length;
  const abst = p.votes.filter((v) => v.vote === 'abstain').length;
  const mine = p.votes.find((v) => v.id === s.you)?.vote ?? null;
  const seated = s.you !== '';
  const kindLabel = p.kind === 'enact' ? `Enact a new ${p.ruleClass === 'immutable' ? 'immutable ' : ''}rule`
    : p.kind === 'amend' ? `Amend rule ${p.target}`
    : p.kind === 'repeal' ? `Repeal rule ${p.target}`
    : `Transmute rule ${p.target}`;
  const effLine = p.effect ? `<div class="nom-efftag">backs <b>${p.effect.param}</b> → <b>${esc(String((p.effect as { value: unknown }).value))}</b></div>` : '';
  const transmuteNote = p.kind === 'transmute' ? `<div class="nom-note">Transmutations require <b>unanimity</b>.</div>` : '';
  const voteBtns = seated ? `
    <div class="nom-votebtns">
      <button data-v="for" class="${mine === 'for' ? 'on' : ''}">👍 For</button>
      <button data-v="against" class="${mine === 'against' ? 'on' : ''}">👎 Against</button>
      ${s.params.allowAbstain ? `<button data-v="abstain" class="${mine === 'abstain' ? 'on' : ''}">🤷 Abstain</button>` : ''}
    </div>` : `<p class="nom-wait">Take a seat to vote.</p>`;
  const callBtn = (s.you === p.proposer || s.yourTurn) ? `<button class="nom-call">⚖️ Call the vote</button>` : '';
  host.innerHTML = `
    <h3>On the floor</h3>
    <div class="nom-prop">
      <div class="nom-propkind">${kindLabel} — <span class="nom-by">${esc(p.proposerName)}</span></div>
      ${p.text ? `<blockquote>${esc(p.text)}</blockquote>` : ''}
      ${effLine}${transmuteNote}
      <div class="nom-tally">👍 ${fors} · 👎 ${against} · 🤷 ${abst}</div>
      ${voteBtns}${callBtn}
    </div>`;
  host.querySelectorAll('.nom-votebtns button').forEach((b) =>
    b.addEventListener('click', () => net?.vote((b as HTMLElement).dataset.v as NomVote)));
  host.querySelector('.nom-call')?.addEventListener('click', () => net?.resolve());
}

function renderProposeForm(host: HTMLElement) {
  host.innerHTML = `
    <h3>🪑 You hold the floor</h3>
    <div class="nom-form">
      <label>Move
        <select class="nf-kind">
          <option value="enact">Enact a new rule</option>
          <option value="amend">Amend a rule</option>
          <option value="repeal">Repeal a rule</option>
          <option value="transmute">Transmute a rule</option>
        </select>
      </label>
      <label class="nf-class-wrap">Class
        <select class="nf-class">
          <option value="mutable">Mutable (the Body)</option>
          <option value="immutable">Immutable (the Constitution)</option>
        </select>
      </label>
      <label class="nf-target-wrap">Rule #
        <input class="nf-target" type="number" min="101" placeholder="e.g. 207" />
      </label>
      <label class="nf-text-wrap">Rule text
        <textarea class="nf-text" rows="3" placeholder="Write the rule in good cheer…"></textarea>
      </label>
      <label class="nf-eff-wrap">Backs a rule (optional)
        <select class="nf-param">
          <option value="">— none (flavor only) —</option>
          <option value="threshold">threshold</option>
          <option value="pointsPerAdoption">points per adoption</option>
          <option value="votesPerPlayer">votes per player</option>
          <option value="winScore">winning score</option>
          <option value="turnDir">turn direction</option>
          <option value="allowAbstain">allow abstain</option>
        </select>
        <span class="nf-val-wrap"></span>
      </label>
      <button class="nf-submit">Put it to the floor →</button>
      <div class="nf-err"></div>
    </div>`;

  const q = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T;
  const kind = q<HTMLSelectElement>('.nf-kind');
  const paramSel = q<HTMLSelectElement>('.nf-param');
  const valWrap = q<HTMLElement>('.nf-val-wrap');

  const syncFields = () => {
    const k = kind.value as NomProposalKind;
    (q('.nf-class-wrap') as HTMLElement).style.display = k === 'enact' ? '' : 'none';
    (q('.nf-target-wrap') as HTMLElement).style.display = k === 'enact' ? 'none' : '';
    (q('.nf-text-wrap') as HTMLElement).style.display = (k === 'enact' || k === 'amend') ? '' : 'none';
    (q('.nf-eff-wrap') as HTMLElement).style.display = (k === 'enact' || k === 'amend') ? '' : 'none';
  };
  const syncVal = () => {
    const p = paramSel.value;
    if (p === 'threshold') valWrap.innerHTML = `<select class="nf-val"><option value="majority">simple majority</option><option value="twothirds">two-thirds</option><option value="unanimous">unanimous</option></select>`;
    else if (p === 'turnDir') valWrap.innerHTML = `<select class="nf-val"><option value="1">forward</option><option value="-1">reverse</option></select>`;
    else if (p === 'allowAbstain') valWrap.innerHTML = `<select class="nf-val"><option value="true">allowed</option><option value="false">forbidden</option></select>`;
    else if (p) valWrap.innerHTML = `<input class="nf-val" type="number" placeholder="number" />`;
    else valWrap.innerHTML = '';
  };
  kind.addEventListener('change', syncFields);
  paramSel.addEventListener('change', syncVal);
  syncFields(); syncVal();

  q('.nf-submit').addEventListener('click', () => {
    const k = kind.value as NomProposalKind;
    const errBox = q<HTMLElement>('.nf-err');
    errBox.textContent = '';
    const text = (q<HTMLTextAreaElement>('.nf-text').value || '').trim();
    const target = k === 'enact' ? undefined : parseInt(q<HTMLInputElement>('.nf-target').value, 10);
    const ruleClass = k === 'enact' ? (q<HTMLSelectElement>('.nf-class').value as 'immutable' | 'mutable') : undefined;
    let effect: NomEffect | null = null;
    const pParam = paramSel.value;
    if ((k === 'enact' || k === 'amend') && pParam) {
      const raw = (q<HTMLInputElement | HTMLSelectElement>('.nf-val')?.value ?? '').trim();
      effect = buildEffect(pParam, raw);
      if (!effect) { errBox.textContent = 'Give the backed rule a value.'; return; }
    }
    if (k === 'enact' && !text) { errBox.textContent = 'A new rule needs a body.'; return; }
    if (k !== 'enact' && (!Number.isFinite(target))) { errBox.textContent = 'Name the rule number to change.'; return; }
    if (k === 'amend' && !text && !effect) { errBox.textContent = 'An amendment must change the text or a backed rule.'; return; }
    net?.propose(k, text, target, effect, ruleClass);
  });
}

function buildEffect(param: string, raw: string): NomEffect | null {
  switch (param) {
    case 'threshold':
      return (raw === 'majority' || raw === 'twothirds' || raw === 'unanimous') ? { param, value: raw } : null;
    case 'turnDir':
      return { param, value: raw === '-1' ? -1 : 1 };
    case 'allowAbstain':
      return { param, value: raw === 'true' };
    case 'pointsPerAdoption': case 'votesPerPlayer': case 'winScore': {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? { param, value: n } : null;
    }
    default: return null;
  }
}

function injectStyles() {
  if (document.getElementById('nom-styles')) return;
  const css = document.createElement('style');
  css.id = 'nom-styles';
  css.textContent = `
  .nom-overlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(10,8,4,.72);font-family:system-ui,sans-serif}
  .nom-panel{position:relative;width:min(1040px,96vw);height:min(760px,94vh);background:#f4ecd6;color:#2a241a;border:3px solid #6b5a36;border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden}
  .nom-head{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(#5b4a2c,#42351f);color:#f4ecd6;border-bottom:3px solid #6b5a36}
  .nom-title{font-size:20px;letter-spacing:.5px}
  .nom-season{opacity:.8;font-size:14px;font-weight:400}
  .nom-close{background:transparent;border:0;color:#f4ecd6;font-size:20px;cursor:pointer;line-height:1}
  .nom-winner{padding:8px 16px;background:#ffe9a8;color:#5a3d00;font-weight:600;text-align:center;border-bottom:2px solid #c9a93f}
  .nom-body{display:flex;flex:1;min-height:0}
  .nom-rules{flex:1.3;padding:14px 18px;overflow-y:auto;border-right:2px solid #d8caa0}
  .nom-side{flex:1;padding:14px 16px;overflow-y:auto;background:#efe6cd;display:flex;flex-direction:column;gap:14px}
  .nom-rules h3,.nom-side h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#7a6536}
  .nom-class{margin:14px 0 6px;font-weight:700;color:#6b5a36;border-bottom:1px solid #cdbb8c;padding-bottom:3px}
  .nom-class:first-child{margin-top:0}
  .nom-class small{font-weight:400;opacity:.7}
  .nom-class-mut{color:#3f6f4a;border-color:#9fc6a8}
  .nom-rule{display:flex;gap:10px;padding:5px 0;line-height:1.4;border-bottom:1px dotted #ddd0a6}
  .nom-num{font-weight:700;color:#9a7b2f;min-width:34px;font-variant-numeric:tabular-nums}
  .nom-knob{color:#3f6f4a;font-style:normal;font-size:11px;opacity:.85}
  .nom-plist{list-style:none;margin:0;padding:0;font-size:13px;line-height:1.7}
  .nom-prop{background:#fff8e6;border:1px solid #d9c486;border-radius:8px;padding:10px}
  .nom-propkind{font-weight:600;margin-bottom:4px}
  .nom-by{color:#9a7b2f}
  .nom-prop blockquote{margin:6px 0;padding:6px 10px;border-left:3px solid #c9a93f;background:#fdf4dd;font-style:italic}
  .nom-efftag,.nom-note{font-size:12px;margin:4px 0;color:#3f6f4a}
  .nom-note{color:#a23b2b}
  .nom-tally{font-weight:700;margin:8px 0;font-variant-numeric:tabular-nums}
  .nom-votebtns{display:flex;gap:6px;flex-wrap:wrap}
  .nom-votebtns button,.nom-call,.nf-submit{cursor:pointer;border:1px solid #6b5a36;background:#e8dcb6;color:#2a241a;border-radius:6px;padding:6px 10px;font-size:13px;font-weight:600}
  .nom-votebtns button.on{background:#5b4a2c;color:#f4ecd6}
  .nom-call{margin-top:8px;width:100%;background:#3f6f4a;color:#fff;border-color:#2c5236}
  .nom-scorelist{list-style:none;margin:0;padding:0}
  .nom-scorelist li{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:13px}
  .nom-absent{opacity:.45}
  .nom-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:0 0 auto}
  .nom-pname{flex:1}.nom-pname em{opacity:.7;font-style:normal;font-size:11px}
  .nom-pts{font-weight:700;font-variant-numeric:tabular-nums}
  .nom-loglist{list-style:none;margin:0;padding:0;font-size:12px;line-height:1.5;color:#4a4030}
  .nom-loglist li{padding:2px 0;border-bottom:1px dotted #ddd0a6}
  .nom-empty,.nom-wait{opacity:.6;font-size:13px;font-style:italic}
  .nom-form{display:flex;flex-direction:column;gap:8px}
  .nom-form label{display:flex;flex-direction:column;gap:3px;font-size:12px;font-weight:600;color:#6b5a36}
  .nom-form select,.nom-form input,.nom-form textarea{font:inherit;padding:5px 7px;border:1px solid #b9a673;border-radius:5px;background:#fffdf5;color:#2a241a;color-scheme:light}
  .nom-form option{background:#fffdf5;color:#2a241a}
  .nf-val-wrap{margin-top:5px}
  .nf-err{color:#a23b2b;font-size:12px;min-height:14px}
  `;
  document.head.appendChild(css);
}
