export const FONTS = [
  { id: 'system', label: '系統預設', css: '"Segoe UI", "Microsoft JhengHei", sans-serif' },
  { id: 'jhenghei', label: '微軟正黑體', css: '"Microsoft JhengHei", "Segoe UI", sans-serif' },
  { id: 'noto', label: 'Noto Sans TC', css: '"Noto Sans TC", "Microsoft JhengHei", sans-serif' },
  { id: 'arial', label: 'Arial', css: 'Arial, "Microsoft JhengHei", sans-serif' },
  { id: 'ming', label: '新細明體', css: '"PMingLiU", "Noto Serif TC", serif' },
  { id: 'kai', label: '標楷體', css: '"DFKai-SB", "BiauKai", serif' },
];
// color is the light-theme override and darkColor the dark-theme one; '' follows the theme default.
// lineHeight is shared by source and translation text (multiple of the font size).
// lineHeightCustom marks a value the person chose with the slider; without it the current default
// applies, so a later change of default reaches everyone who never adjusted it.
export const LINE_HEIGHT = { min: 1, max: 2.2, step: 0.05, default: 1.2 };
export const defaultAppearance = () => ({ source: { font: 'system', size: 18, color: '', darkColor: '' }, translation: { font: 'system', size: 18, color: '', darkColor: '' }, lineHeight: LINE_HEIGHT.default, lineHeightCustom: false });
export function normalizeAppearance(value) {
  const result = defaultAppearance();
  for (const kind of ['source', 'translation']) {
    const item = value?.[kind];
    if (!item) continue;
    if (FONTS.some(font => font.id === item.font)) result[kind].font = item.font;
    if (Number.isInteger(item.size) && item.size >= 12 && item.size <= 40) result[kind].size = item.size;
    for (const field of ['color', 'darkColor']) if (/^#[0-9a-f]{6}$/i.test(item[field])) result[kind][field] = item[field];
  }
  const lineHeight = Number(value?.lineHeight);
  if (value?.lineHeightCustom === true && Number.isFinite(lineHeight) && lineHeight >= LINE_HEIGHT.min && lineHeight <= LINE_HEIGHT.max) {
    result.lineHeight = Number((Math.round(lineHeight / LINE_HEIGHT.step) * LINE_HEIGHT.step).toFixed(2));
    result.lineHeightCustom = true;
  }
  return result;
}
