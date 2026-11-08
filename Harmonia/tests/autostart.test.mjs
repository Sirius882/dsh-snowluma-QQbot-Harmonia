import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBotProcess, shouldAttach } from '../scripts/autostart.mjs';

test('autostart selects only the bot and refuses ambiguous processes', () => {
  const owner = { pid: 1, account: { uin: '100000001' } };
  const bot = { pid: 2, account: { uin: '100000002' } };
  assert.equal(selectBotProcess([owner, bot], '100000002'), bot);
  assert.equal(selectBotProcess([owner], '100000002'), null);
  assert.equal(selectBotProcess([bot, { ...bot, pid: 3 }], '100000002'), null);
});
test('autostart does not reload connected or connecting bots and bounds failures', () => {
  const bot = { pid: 2, connected: false, injected: false };
  assert.equal(shouldAttach(bot), true);
  assert.equal(shouldAttach({ ...bot, connected: true }), false);
  assert.equal(shouldAttach({ ...bot, injected: true, status: 'connecting' }), false);
  assert.equal(shouldAttach(bot, { pid: 2, attempts: 3 }), false);
  assert.equal(shouldAttach(bot, { pid: 1, attempts: 3 }), true);
});
