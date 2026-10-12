import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "执行经验按工作区和会话折叠展示，详情保留真实来源，迟到操作不能恢复旧候选",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ExecutionLearningPanel } from './apps/desktop/src/renderer/ExecutionLearningPanel.tsx';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const check = (value, message) => { if (!value) throw new Error(message); };
const source = {sessionId:'session-a',runId:'run-a',turnId:'turn-real',eventId:'event-real-failure'};
const candidate = (id, state = 'waiting', extra = {}) => ({
  candidateId:id,revision:1,workspaceKey:'/project',sessionId:'session-a',runId:'run-a',
  state,predicateId:'test-target-pass.v1',targetId:'target-'+id,targetLabel:'目标 '+id,
  updatedAt:1,sources:[source],...extra,
});
const claim = (id, revision = 1) => ({
  candidateId:id,revision,failureKey:'failure-'+id,predicateId:'test-target-pass.v1',
  admission:{admissionId:'admission',workspaceKey:'/project',sessionId:'session-a',runId:'run-a',workDir:'/project',settingsVersion:1,deletionRevision:0,managementRevision:0,inputEpoch:1,createdAt:1},
  target:{targetId:'target-'+id,label:'目标 '+id,kind:'node-test',command:'node --test test/main.test.js',argv:['--test','test/main.test.js'],cwd:'/project',scopeHash:'scope',entryFiles:[],testFiles:['test/main.test.js']},
  claimHash:'claim',conditions:[{kind:'cwd',path:'/project'},{kind:'json',path:'/project/config.json',field:['mode'],value:'test'}],
  recipe:[],failedTestIds:['test/main.test.js > restores data'],failure:source,createdAt:1,
});
const inspectCalls = [], discardCalls = [];
let inspectionPending, discardPending;
const onInspect = async id => {
  inspectCalls.push(id);
  if (inspectionPending) return inspectionPending.promise;
  return {claim:claim(id),hypothesis:'可能与配置有关 <img src=x>，尚未验证',sources:[source]};
};
const onDiscard = async (id, revision) => {
  discardCalls.push([id,revision]);
  if (discardPending) await discardPending.promise;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {resolve=ok;reject=fail;});
  return {promise,resolve,reject};
};
const root = createRoot(document.getElementById('app'));
const render = (statuses, mode = 'memory', workspaceKey = '/project', sessionId = 'session-a') =>
  root.render(<PicoTheme><ExecutionLearningPanel statuses={statuses} workspaceKey={workspaceKey}
    sessionId={sessionId} mode={mode} onInspect={onInspect} onDiscard={onDiscard}/></PicoTheme>);
const card = id => document.querySelector('[data-candidate-id="'+id+'"]');
const button = (id, label) => [...card(id).querySelectorAll('button')].find(node => node.getAttribute('aria-label')?.startsWith(label));
const outer = () => [...document.querySelectorAll('.execution-learning')];
const text = () => document.body.textContent;
(async () => {
  const states = ['waiting','ready','working','saved','insufficient','invalidated','discarded','expired'];
  const statuses = states.map((state,index) => candidate('candidate-'+index,state,index===3?{itemId:'memory-real'}:{}));
  statuses.push(candidate('environment','waiting',{predicateId:'command-conditions.v1'}));
  statuses.push(candidate('other-workspace','waiting',{workspaceKey:'/elsewhere',targetLabel:'隐藏工作区目标'}));
  statuses.push(candidate('other-session','waiting',{sessionId:'session-b',targetLabel:'隐藏会话目标'}));
  await act(async () => render(statuses));
  check(outer().length===1 && !outer()[0].open,'memory candidates start collapsed');
  check(document.querySelectorAll('[data-candidate-id]').length===9,'workspace and session isolate candidates');
  check(!text().includes('隐藏工作区目标')&&!text().includes('隐藏会话目标'),'foreign scopes are absent');
  for (const label of ['待自然验收','待整理','整理中','已保存经验','证据不足','待复核','已丢弃','过期'])
    check(text().includes(label),'persistent state label '+label);
  check(text().includes('测试验收')&&text().includes('环境条件验收'),'fixed acceptance predicate labels');
  check(!document.querySelector('[role=progressbar]')&&!/0\\/3|根因已验证|accepted|自动重跑/.test(text()),'waiting has no fabricated progress or causal assurance');
  check(inspectCalls.length===0,'collapsed list does not request candidate details');
  await act(async () => outer()[0].querySelector('summary').click());
  const provenance = card('candidate-3').querySelector('.memory-source');
  await act(async () => provenance.querySelector('summary').click());
  check(provenance.open&&provenance.textContent.includes('event-real-failure')&&provenance.textContent.includes('turn-real')&&provenance.textContent.includes('memory-real'),'saved experience exposes real source identifiers');
  await act(async () => button('candidate-0','查看候选详情').click());
  check(inspectCalls.join()==='candidate-0','inspect callback targets selected candidate');
  check(button('candidate-0','查看候选详情').getAttribute('aria-expanded')==='true','detail control exposes expansion');
  check(card('candidate-0').textContent.includes('假设（未验证）')&&card('candidate-0').textContent.includes('配置：/project/config.json'),'details retain hypothesis boundary and exact conditions');
  check(card('candidate-0').textContent.includes('<img src=x>')&&!card('candidate-0').querySelector('img'),'hypothesis is inert text');
  check(card('candidate-0').querySelectorAll('.memory-source dl').length===1,'same true source is deduplicated');
  check(!button('candidate-6','丢弃候选')&&!button('candidate-7','丢弃候选'),'terminal candidates cannot be discarded twice');
  await act(async () => render([...statuses,candidate('next-run','ready',{runId:'run-next'})],'conversation'));
  check(outer().length===2&&outer().every(node=>!node.open),'conversation has one collapsed card per run');
  check(outer().filter(node=>node.dataset.runId==='run-a').length===1,'multiple candidates share one run card');
  check(outer()[0].querySelector('summary').textContent.includes('已保存经验'),'saved state is visible in the run summary');

  // A discard acknowledgement can arrive after a newer readonly projection or a route change.
  const racing = candidate('race');
  await act(async () => render([racing]));
  await act(async () => outer()[0].querySelector('summary').click());
  discardPending=deferred();
  await act(async () => button('race','丢弃候选').click());
  check(JSON.stringify(discardCalls)===JSON.stringify([['race',1]]),'discard submits the displayed revision');
  check(button('race','丢弃候选').disabled,'pending discard cannot repeat');
  await act(async () => render([{...racing,revision:2,updatedAt:2,state:'discarded'}]));
  await act(async () => {discardPending.reject(new Error('stale revision'));await Promise.resolve();});
  discardPending=undefined;
  check(card('race').dataset.state==='discarded'&&!document.querySelector('[role=alert]'),'late discard failure cannot replace newer state or error');
  check(!button('race','丢弃候选'),'late discard cannot resurrect a management action');

  inspectionPending=deferred();
  await act(async () => render([candidate('inspect-race')]));
  await act(async () => outer()[0].querySelector('summary').click());
  await act(async () => button('inspect-race','查看候选详情').click());
  check(card('inspect-race').querySelector('[aria-busy=true]'),'detail loading is local');
  await act(async () => render([{...candidate('inspect-race'),revision:2,updatedAt:2,state:'saved',itemId:'new-memory'}]));
  await act(async () => {inspectionPending.resolve({claim:claim('inspect-race'),hypothesis:'STALE_HYPOTHESIS'});await Promise.resolve();});
  inspectionPending=undefined;
  check(!text().includes('STALE_HYPOTHESIS')&&card('inspect-race').dataset.state==='saved','late inspection cannot leak an old hypothesis');

  await act(async () => render([candidate('route-race')]));
  await act(async () => outer()[0].querySelector('summary').click());
  discardPending=deferred();
  await act(async () => button('route-race','丢弃候选').click());
  await act(async () => render([candidate('route-race')],'memory','/elsewhere'));
  await act(async () => {discardPending.resolve();await Promise.resolve();});
  check(!document.querySelector('[data-candidate-id]')&&!text().includes('丢弃请求已完成'),'route switch cannot revive a pending candidate');
  await act(async () => root.unmount());
  await fetch('/result',{method:'POST',body:'PASS: execution learning presentation'});
})().catch(async error => {await fetch('/result',{method:'POST',body:'FAIL: '+error.stack});});
`);
    assert.equal(result, "PASS: execution learning presentation", result);
  },
);
