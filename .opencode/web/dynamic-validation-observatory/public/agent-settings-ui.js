export function syncAgentSettingsForm({ form, settings, saving, labels, element }) {
  const locked = !settings || saving;
  const selected = form.dataset.dirty ? form.elements.default_engine.value : settings?.default_engine;
  const enabled = [];
  for (const id of Object.keys(labels)) {
    const toggle = form.elements[`enabled_${id}`];
    const command = form.elements[`command_${id}`];
    if (settings && !form.dataset.dirty) {
      toggle.checked = settings.enabled?.[id] !== false;
      command.value = settings.commands?.[id] ?? '';
    }
    toggle.disabled = locked;
    command.disabled = locked;
    command.required = toggle.checked;
    command.closest('.agent-command-field')?.classList.toggle('is-disabled', !toggle.checked);
    if (settings && toggle.checked) enabled.push(id);
  }
  const select = form.elements.default_engine;
  select.replaceChildren(...(enabled.length ? enabled : ['']).map(id => {
    const option = element('option', '', id ? labels[id] : settings ? '未启用任何 Agent' : '正在读取…');
    option.value = id;
    return option;
  }));
  select.value = enabled.includes(selected) ? selected : enabled[0] ?? '';
  select.disabled = locked || !enabled.length;
  select.required = enabled.length > 0;
}

export function readAgentSettingsForm(form, labels) {
  return {
    default_engine: form.elements.default_engine.value || null,
    enabled: Object.fromEntries(Object.keys(labels).map(id => [id, form.elements[`enabled_${id}`].checked])),
    commands: Object.fromEntries(Object.keys(labels).map(id => [id, form.elements[`command_${id}`].value.trim()])),
  };
}
