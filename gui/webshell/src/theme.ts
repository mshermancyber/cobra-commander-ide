// ---------------------------------------------------------------------------
// Cobra Commander theme — Claude Code web UI aesthetic (warm dark, clean)
// Green accent (#00ff41) kept for brand, used sparingly
// ---------------------------------------------------------------------------

const theme = {
  // Backgrounds — warm dark charcoal, NOT cool blue
  bg: '#1c1c1e',
  bgSecondary: '#252528',
  bgTertiary: '#2d2d30',
  border: '#3a3a3d',
  // Text — warm off-white, not cool gray
  text: '#e8e5e0',
  textSecondary: '#8b8685',
  textMuted: '#555555',
  // Accents
  accent: '#00ff41',
  accentGreen: '#00ff41',
  accentRed: '#ff4d4d',
  accentYellow: '#e5c07b',
  accentOrange: '#ff8800',
  accentPurple: '#c678dd',
  // UI surfaces
  toolBg: '#1e1e20',
  cardBg: '#252528',
  inputBg: '#1e1e22',
  inputBorder: '#3a3a3d',
  inputFocusBorder: '#00ff41',
  inputAreaBg: '#252528',
  shadow: 'rgba(0,0,0,0.5)',
  glow: '0 0 20px rgba(0,255,65,0.15)',
  glowStrong: '0 0 40px rgba(0,255,65,0.35)',
  // Chat-specific
  userBubbleBg: '#252528', // unused — messages have no bubbles
  codeBlockBg: '#0d1117',
  inlineCodeBg: '#2a2a45',
  chatInputBg: '#1e1e22',
} as const;

const cssVariables = `
:root {
  --cc-bg: ${theme.bg};
  --cc-bg-secondary: ${theme.bgSecondary};
  --cc-bg-tertiary: ${theme.bgTertiary};
  --cc-border: ${theme.border};
  --cc-text: ${theme.text};
  --cc-text-secondary: ${theme.textSecondary};
  --cc-text-muted: ${theme.textMuted};
  --cc-accent: ${theme.accent};
  --cc-accent-green: ${theme.accentGreen};
  --cc-accent-red: ${theme.accentRed};
  --cc-accent-yellow: ${theme.accentYellow};
  --cc-accent-orange: ${theme.accentOrange};
  --cc-accent-purple: ${theme.accentPurple};
  --cc-tool-bg: ${theme.toolBg};
  --cc-card-bg: ${theme.cardBg};
  --cc-input-bg: ${theme.inputBg};
  --cc-input-border: ${theme.inputBorder};
  --cc-input-focus-border: ${theme.inputFocusBorder};
  --cc-input-area-bg: ${theme.inputAreaBg};
  --cc-shadow: ${theme.shadow};
  --cc-glow: ${theme.glow};
  --cc-glow-strong: ${theme.glowStrong};
  --cc-user-bubble-bg: ${theme.userBubbleBg};
  --cc-code-block-bg: ${theme.codeBlockBg};
  --cc-inline-code-bg: ${theme.inlineCodeBg};
  --cc-chat-input-bg: ${theme.chatInputBg};
}
`;

export function injectTheme(): void {
  const style = document.createElement('style');
  style.id = 'cc-theme';
  style.textContent = cssVariables;
  document.head.appendChild(style);
}

export default theme;
