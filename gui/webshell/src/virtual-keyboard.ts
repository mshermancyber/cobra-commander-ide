// ---------------------------------------------------------------------------
// Virtual keyboard toolbar — floating bar above iOS soft keyboard
// ---------------------------------------------------------------------------
// Buttons: Ctrl, Alt, Esc, Tab, Up, Down, | (pipe), ~ (tilde)
// 44x44px minimum touch targets
// Shown only when soft keyboard is visible (via visualViewport resize)
// ---------------------------------------------------------------------------

import theme from './theme.js';

export interface KeyboardToolbarCallbacks {
  onKey: (key: string) => void;
}

export class KeyboardToolbar {
  private toolbar: HTMLElement;
  private callbacks: KeyboardToolbarCallbacks;
  private visible = false;
  private resizeHandler: (() => void) | null = null;

  constructor(callbacks: KeyboardToolbarCallbacks) {
    this.callbacks = callbacks;
    this.toolbar = this.buildToolbar();
    this.mount();
  }

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cc-kb-toolbar';
    bar.style.cssText = `
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      display: none;
      flex-wrap: wrap;
      justify-content: center;
      gap: 4px;
      padding: 6px 8px;
      background: ${theme.bgSecondary};
      border-top: 1px solid ${theme.border};
      padding-bottom: max(6px, env(safe-area-inset-bottom, 0px));
      z-index: 100;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    `;

    const keys = [
      { label: 'Ctrl', key: 'Control' },
      { label: 'Alt', key: 'Alt' },
      { label: 'Esc', key: 'Escape' },
      { label: 'Tab', key: 'Tab' },
      { label: '\u25B2', key: 'ArrowUp' },   // ▲
      { label: '\u25BC', key: 'ArrowDown' },  // ▼
      { label: '|', key: '|' },
      { label: '~', key: '~' },
    ];

    for (const k of keys) {
      const btn = document.createElement('button');
      btn.textContent = k.label;
      btn.setAttribute('tabindex', '-1');
      btn.setAttribute('aria-label', k.key);
      btn.style.cssText = `
        min-width: 44px;
        min-height: 44px;
        padding: 8px 6px;
        background: ${theme.bgTertiary};
        color: ${theme.text};
        border: 1px solid ${theme.border};
        border-radius: 6px;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        -webkit-appearance: none;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      `;

      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.style.background = theme.accent;
        btn.style.color = '#fff';
      });

      btn.addEventListener('pointerup', (e) => {
        e.preventDefault();
        btn.style.background = theme.bgTertiary;
        btn.style.color = theme.text;
        this.callbacks.onKey(k.key);
      });

      btn.addEventListener('pointerleave', () => {
        btn.style.background = theme.bgTertiary;
        btn.style.color = theme.text;
      });

      bar.appendChild(btn);
    }

    return bar;
  }

  private mount(): void {
    document.body.appendChild(this.toolbar);

    // Detect soft keyboard visibility via visualViewport
    if (window.visualViewport) {
      this.resizeHandler = () => {
        const viewport = window.visualViewport!;
        const keyboardHeight = window.innerHeight - viewport.height;

        if (keyboardHeight > 100 && !this.visible) {
          this.visible = true;
          this.toolbar.style.display = 'flex';
          // Adjust toolbar position to sit above keyboard
          this.toolbar.style.bottom = `${keyboardHeight}px`;
        } else if (keyboardHeight <= 100 && this.visible) {
          this.visible = false;
          this.toolbar.style.display = 'none';
          this.toolbar.style.bottom = '0px';
        } else if (this.visible) {
          // Update position as keyboard resizes
          this.toolbar.style.bottom = `${keyboardHeight}px`;
        }
      };

      window.visualViewport.addEventListener('resize', this.resizeHandler);
      window.visualViewport.addEventListener('scroll', this.resizeHandler);
    }

    // Fallback: also listen for focusin on inputs/textareas to detect keyboard
    document.addEventListener('focusin', (e) => {
      const el = e.target as HTMLElement;
      if (
        !window.visualViewport &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        this.visible = true;
        this.toolbar.style.display = 'flex';
      }
    });

    document.addEventListener('focusout', () => {
      if (!window.visualViewport && this.visible) {
        // Small delay to allow focus to move to toolbar buttons
        setTimeout(() => {
          if (document.activeElement?.closest?.('.cc-kb-toolbar')) return;
          this.visible = false;
          this.toolbar.style.display = 'none';
        }, 100);
      }
    });
  }

  destroy(): void {
    if (this.resizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.resizeHandler);
      window.visualViewport.removeEventListener('scroll', this.resizeHandler);
    }
    this.toolbar.remove();
  }
}
