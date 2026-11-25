// Inline SVG icons (the Mac app uses SF Symbols, which do not exist on Windows). 24 x 24 grid, drawn to match.

const stroke = (body, size = 18, width = 1.7) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** A filled circle with a glyph cut out of it (the "circle.fill" family). */
const badge = (glyph, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/>` +
  `<g fill="none" stroke="var(--glyph, #101014)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`;

export const icons = {
  home: stroke('<path d="M4 11.2 12 4.5l8 6.7"/><path d="M6 10v9.2c0 .4.3.8.8.8h10.4c.5 0 .8-.4.8-.8V10"/><path d="M10 20v-5.2h4V20"/>'),
  switcher: stroke('<rect x="8.5" y="8.5" width="11" height="11" rx="2.6"/><path d="M15.5 8.5V7a2.6 2.6 0 0 0-2.6-2.6H7A2.6 2.6 0 0 0 4.4 7v5.9A2.6 2.6 0 0 0 7 15.5h1.5"/>'),
  bell: stroke('<path d="M6.2 16.5V11a5.8 5.8 0 1 1 11.6 0v5.5l1.4 1.9H4.8z"/><path d="M10 20.8a2.2 2.2 0 0 0 4 0"/>'),
  more: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>',
  minimize: stroke('<path d="M6.5 12h11"/>', 16),
  fit: stroke('<rect x="6" y="6" width="12" height="12" rx="2.2"/>', 16),
  close: stroke('<path d="M7 7l10 10M17 7 7 17"/>', 16),
  chevronRight: stroke('<path d="M9.5 6l6 6-6 6"/>', 12, 2.4),
  chevronLeft: stroke('<path d="M14.5 6l-6 6 6 6"/>', 12, 2.4),
  check: stroke('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14, 2.4),
  clear: badge('<path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"/>', 15),
  okCircle: badge('<path d="M7.6 12.4l3.2 3.2 5.8-6.4"/>'),
  errorCircle: badge('<path d="M12 6.8v6.2"/><path d="M12 16.6v.1"/>'),
  infoCircle: badge('<path d="M12 11v6"/><path d="M12 7.4v.1"/>'),
  phoneBadge: stroke('<rect x="7.5" y="3" width="9" height="18" rx="2.3"/><path d="M10.8 18.2h2.4"/>', 18, 1.8),
  plug: stroke('<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-5.5 5.5 5.5 5.5 0 0 1-5.5-5.5z"/><path d="M12 17v4"/>', 20, 1.6),
  dropDoc: stroke('<path d="M14 3.5v4.2h4.2"/><path d="M6.5 3.5h7.6l4.4 4.4v12.6h-12z"/><path d="M12.5 10.8v6.2M9.8 14.3l2.7 2.8 2.7-2.8"/>', 34, 1.4),
  hero:
    '<svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><rect x="20" y="9" width="24" height="46" rx="5.8"/><path d="M28 15.5h8"/>' +
    '<path d="M29 49h6"/><g class="wave w1"><path d="M10.5 25c-2.6 4.8-2.6 9.2 0 14"/><path d="M53.5 25c2.6 4.8 2.6 9.2 0 14"/></g>' +
    '<g class="wave w2"><path d="M5.5 20.5c-4.4 7.4-4.4 15.6 0 23"/><path d="M58.5 20.5c4.4 7.4 4.4 15.6 0 23"/></g></svg>',
};

/** Fills every element that has data-icon="name". */
export function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon] ?? '';
}
