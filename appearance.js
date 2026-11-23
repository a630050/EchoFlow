export const FONTS = [
  { id: 'system', label: '系統預設', css: '"Segoe UI", "Microsoft JhengHei", sans-serif' },
  { id: 'jhenghei', label: '微軟正黑體', css: '"Microsoft JhengHei", "Segoe UI", sans-serif' },
  { id: 'noto', label: 'Noto Sans TC', css: '"Noto Sans TC", "Microsoft JhengHei", sans-serif' },
  { id: 'arial', label: 'Arial', css: 'Arial, "Microsoft JhengHei", sans-serif' },
  { id: 'ming', label: '新細明體', css: '"PMingLiU", "Noto Serif TC", serif' },
  { id: 'kai', label: '標楷體', css: '"DFKai-SB", "BiauKai", serif' },
];
// color is the light-theme override and darkColor the dark-theme one; '' follows the theme default.
export const defaultAppearance = () => ({ source: { font: 'system', size: 18, color: '', darkColor: '' }, translation: { font: 'system', size: 18, color: '', darkColor: '' } });
export function normalizeAppearance(value) {
  const result = defaultAppearance();
  for (const kind of ['source', 'translation']) {
    const item = value?.[kind];
    if (!item) continue;
    if (FONTS.some(font => font.id === item.font)) result[kind].font = item.font;
    if (Number.isInteger(item.size) && item.size >= 12 && item.size <= 40) result[kind].size = item.size;
    for (const field of ['color', 'darkColor']) if (/^#[0-9a-f]{6}$/i.test(item[field])) result[kind][field] = item[field];
  }
  return result;
}
