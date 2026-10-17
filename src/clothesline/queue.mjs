export function createQueue(container, onTake, onChange) {
  const size = 20;
  let page = 0, items = [], busy = false, signature = '';
  function paint() {
    page = Math.min(page, Math.max(0, Math.ceil(items.length / size) - 1));
    const rows = items.slice(page * size, (page + 1) * size);
    const next = JSON.stringify([page, items.length, busy, rows.map(p => [p.id, p.name])]);
    if (signature === next) return;
    signature = next;
    container.replaceChildren();
    if (!items.length) { onChange(); return; }
    const controls = document.createElement('div'); controls.className = 'queuePages';
    const status = document.createElement('span'); status.textContent = `排队 ${items.length} 张 · ${page + 1}/${Math.ceil(items.length / size)} 页`;
    controls.append(status);
    for (const [label, delta] of [['上一页', -1], ['下一页', 1]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.disabled = (delta < 0 ? page === 0 : (page + 1) * size >= items.length);
      button.onclick = () => { page += delta; paint(); };
      controls.append(button);
    }
    container.append(controls);
    for (const item of rows) {
      const button = document.createElement('button');
      button.textContent = '排队 · ' + item.name + ' → 转贴图'; button.disabled = busy;
      button.onclick = () => onTake(item.id);
      container.append(button);
    }
    onChange();
  }
  return { render(next, disabled) { items = next; busy = disabled; paint(); } };
}
