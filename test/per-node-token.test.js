const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function fixture(requiredOrigins = "") {
  const state = {mapping: {'https://node.phala.com': 'node-token'}, mode: 0o600, calls: []};
  const fakefs = {...fs, statSync: () => ({isFile: () => true, mode: state.mode}), readFileSync: () => state.invalid || JSON.stringify(state.mapping)};
  const context = vm.createContext({require: name => name === 'fs' ? fakefs : require(name), __dirname: path.join(__dirname,'..'), process: {env: {PIG_NODE_TOKENS_FILE:'/private/tokens.json', PIG_ADMIN_TOKEN:'shared-token', PIG_REQUIRED_TOKEN_ORIGINS:requiredOrigins}}, URL, Buffer, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {state.calls.push({url, options});return {ok:true,status:200, headers:new Headers(),text:async()=>url.endsWith('/pig/metrics') ? 'pig_dynamic_observed_running 1\npig_dynamic_global_limit 8\n' : '{}'};}});
  vm.runInContext(source.slice(0,source.indexOf('const server = http.createServer')),context);
  return {state,context};
}
test('exact origins select credentials, fallback is bounded, rotations reload', () => {
  const {state,context:c}=fixture();
  assert.equal(c.pigTokenForNode('https://node.phala.com/v1'),'node-token');
  for(const origin of ['https://other.phala.com','https://node.phala.com.evil.invalid','https://node.phala.com:8443']) assert.equal(c.pigTokenForNode(origin),'shared-token');
  state.mapping['https://node.phala.com']='rotated';assert.equal(c.pigTokenForNode('https://node.phala.com'),'rotated');
});
test('invalid configured file fails closed without disclosing values', () => {
  const {state,context:c}=fixture();
  for(const mapping of [[],null,{'https://node.phala.com/':'secret'},{'http://node.phala.com':'secret'},{'https://node.phala.com':''},{'https://node.phala.com':'secret\r\nheader'},{'https://node.phala.com':'secret space'}]) {
    state.mapping=mapping;assert.throws(()=>c.pigTokenForNode('https://other.phala.com'),/^Error: PIG node credential file is unavailable or invalid$/);
  }
  state.mapping={};state.mode=0o644;assert.throws(()=>c.pigTokenForNode('https://other.phala.com'));
  state.mode=0o600;state.invalid='{broken';assert.throws(()=>c.pigTokenForNode('https://other.phala.com'));
});
test('metrics and GET/PATCH policy use the same per-node token; invalid config sends nothing', async () => {
  const {state,context:c}=fixture();
  await c.fetchPigMetrics('https://node.phala.com/v1',true);
  await c.pigPolicyRequest('https://node.phala.com/v1','GET');
  await c.pigPolicyRequest('https://node.phala.com/v1','PATCH',{running_limit:8});
  assert.equal(state.calls.length,3);
  assert.ok(state.calls.every(x=>x.options.headers.Authorization==='Bearer node-token'));
  assert.ok(state.calls.every(x=>x.options.redirect==='error'));
  await c.pigPolicyRequest('https://other.phala.com/v1','GET');
  assert.equal(state.calls.at(-1).options.headers.Authorization,'Bearer shared-token');
  state.invalid='{broken';const before=state.calls.length;
  await assert.rejects(c.pigPolicyRequest('https://node.phala.com/v1','GET'));
  await c.fetchPigMetrics('https://node.phala.com/v1',true);
  assert.equal(state.calls.length,before);
});
test('existing live waiting_allowance policy remains supported',()=>{
  const {context:c}=fixture();assert.equal(c.normalizePigPolicyPatch({waiting_allowance:7}).waiting_allowance,7);
});

test('required origins never fall back when one mapping disappears, while existing origins are preserved',async()=>{
  const {state,context:c}=fixture('https://node.phala.com,https://second.phala.com');
  state.mapping['https://second.phala.com']='second-token';
  state.mapping['https://existing.phala.com']='existing-token';
  assert.equal(c.pigTokenForNode('https://existing.phala.com/v1'),'existing-token');
  assert.equal(c.pigTokenForNode('https://node.phala.com/v1'),'node-token');
  assert.equal(c.pigTokenForNode('https://second.phala.com/v1'),'second-token');
  state.mapping['https://node.phala.com']='rotated-token';
  assert.equal(c.pigTokenForNode('https://node.phala.com/v1'),'rotated-token');
  assert.equal(c.pigTokenForNode('https://second.phala.com/v1'),'second-token');
  assert.equal(c.pigTokenForNode('https://other.phala.com/v1'),'shared-token');
  assert.throws(()=>c.pigTokenForNode('https://user@node.phala.com/v1'),/Invalid PIG endpoint/);
  delete state.mapping['https://node.phala.com'];
  await assert.rejects(c.pigPolicyRequest('https://node.phala.com/v1','GET'),/credential file is unavailable or invalid/);
  await c.fetchPigMetrics('https://node.phala.com/v1',true);
  assert.equal(state.calls.length,0);
});

test('required origins reject paths and non-HTTPS configuration',()=>{
  for(const origin of ['https://node.phala.com/v1','http://node.phala.com','https://user@node.phala.com']){
    assert.throws(()=>fixture(origin));
  }
});
