export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** 主题存 localStorage 而不是 IndexedDB：首屏要在 React 挂载前同步读到，否则会闪一下 */
export const THEME_KEY = 'nexus-theme';

export function loadThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  localStorage.setItem(THEME_KEY, mode);
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** 只在 mode === 'system' 时需要监听，其余情况调用方直接忽略返回的清理函数即可 */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export const MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
};

export const MODE_ICON: Record<ThemeMode, string> = {
  system: '◑',
  light: '☀',
  dark: '☾',
};
