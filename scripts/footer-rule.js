import assert from 'node:assert/strict';

// The link rule for footers (dialog footers, Map sheets, card footers): one filled button at most, and every other
// action is a quiet text link, never an outlined or boxed button. A footer with a single button is left alone.
export async function assertQuietFooters(scope, label) {
  const footers = await scope.evaluate(root => [...root.querySelectorAll('.modal-foot,.map-dialog-foot,.map-panel-foot,.card-footer')].map(foot => {
    const buttons = [...foot.querySelectorAll('button,a.button')].filter(b => b.getClientRects().length && !b.classList.contains('icon') && !b.classList.contains('icon-button'));
    const stat = b => { const c = getComputedStyle(b); return { text: b.textContent.trim(), bw: parseFloat(c.borderTopWidth) + parseFloat(c.borderLeftWidth), bg: c.backgroundColor, filled: /\b(primary|danger|destructive)\b/.test(b.className), link: b.classList.contains('link-action'), role: b.getAttribute('role') }; };
    return buttons.map(stat);
  }));
  for (const buttons of footers) {
    if (buttons.length < 2) continue;
    const names = buttons.map(b => b.text).join(' / ');
    assert.ok(buttons.filter(b => b.filled).length <= 1, `${label}: at most one filled button in the footer (${names})`);
    for (const b of buttons.filter(b => !b.filled)) {
      assert.ok(b.link && b.bw === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(b.bg), `${label}: "${b.text}" is a text link, not an outlined button (${names})`);
    }
  }
  return footers.length;
}
