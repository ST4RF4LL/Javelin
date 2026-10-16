import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAgentSettingsForm, readAgentSettingsForm } from '../web/dynamic-validation-observatory/public/agent-settings-ui.js';

const labels = { opencode: 'OpenCode v1', 'opencode-v2': 'OpenCode v2', grow: 'Grow' };
const element = (_tag, _class, textContent) => ({ textContent, value: '' });
function fixture(settings) {
  const form = { dataset: {}, elements: { default_engine: { value: '', replaceChildren(...options) { this.options = options; } } } };
  for (const id of Object.keys(labels)) {
    form.elements[`enabled_${id}`] = { checked: true };
    form.elements[`command_${id}`] = { value: '', closest: () => null };
  }
  const render = () => syncAgentSettingsForm({ form, settings, saving: false, labels, element });
  render();
  return { form, render };
}

test('停用并清空路径可保存，默认选项联动，重新启用后恢复必填', () => {
  const { form, render } = fixture({ default_engine: 'grow', commands: { opencode: 'opencode', 'opencode-v2': 'opencode2', grow: '/custom/grow' } });
  form.dataset.dirty = 'true';
  form.elements.enabled_grow.checked = false;
  form.elements.command_grow.value = '';
  form.elements.command_opencode.value = '/edited/opencode';
  render();
  assert.equal(form.elements.command_grow.required, false);
  assert.equal(form.elements.command_grow.disabled, false, '关闭后仍可清空路径');
  assert.deepEqual(form.elements.default_engine.options.map(option => option.value), ['opencode', 'opencode-v2']);
  const input = readAgentSettingsForm(form, labels);
  assert.equal(input.enabled.grow, false); assert.equal(input.commands.grow, '');
  assert.equal(input.commands.opencode, '/edited/opencode', '重绘不能覆盖未保存的路径');
  assert.equal(input.default_engine, 'opencode');
  form.elements.enabled_grow.checked = true; render();
  assert.equal(form.elements.command_grow.required, true);
  assert.equal(form.elements.command_grow.value, '');
});

test('重新打开全部关闭的设置可继续保存，并且不伪造默认基座', () => {
  const { form } = fixture({ default_engine: null, enabled: { opencode: false, 'opencode-v2': false, grow: false }, commands: { opencode: '', 'opencode-v2': '', grow: '' } });
  assert.equal(form.elements.default_engine.required, false);
  assert.equal(form.elements.default_engine.disabled, true);
  const input = readAgentSettingsForm(form, labels);
  assert.equal(input.default_engine, null);
  assert.deepEqual(Object.values(input.enabled), [false, false, false]);
  assert.deepEqual(Object.values(input.commands), ['', '', '']);
  assert.ok(Object.keys(labels).every(id => form.elements[`command_${id}`].required === false));
});
