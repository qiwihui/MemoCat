(() => {
  'use strict';
  const THEME_KEY = 'memocat-site-theme';
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function readTheme() {
    try {
      const val = localStorage.getItem(THEME_KEY);
      return ['system', 'light', 'dark'].includes(val) ? val : 'system';
    } catch {
      return 'system';
    }
  }

  function applyTheme(pref) {
    const valid = ['system', 'light', 'dark'].includes(pref) ? pref : 'system';
    const effective = valid === 'system' ? (darkMedia.matches ? 'dark' : 'light') : valid;
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
    const toggle = document.getElementById('site-theme-toggle');
    if (toggle) {
      const isEn = document.documentElement.lang.startsWith('en');
      const labels = isEn
        ? { system: 'System', light: 'Light', dark: 'Dark' }
        : { system: '系统', light: '浅色', dark: '深色' };
      const labelEl = toggle.querySelector('.theme-label');
      if (labelEl) labelEl.textContent = labels[valid];
    }
  }

  applyTheme(readTheme());
  darkMedia.addEventListener('change', () => {
    if (readTheme() === 'system') applyTheme('system');
  });

  const themeToggle = document.getElementById('site-theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const order = ['system', 'light', 'dark'];
      const next = order[(order.indexOf(readTheme()) + 1) % order.length];
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {}
      applyTheme(next);
    });
  }

  // Interactive Workbench Screenshot Switcher
  const tabs = [...document.querySelectorAll('.showcase-tab')];
  const img = document.getElementById('showcase-img');
  const titleEl = document.getElementById('showcase-title');
  const descEl = document.getElementById('showcase-desc');

  if (tabs.length && img) {
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        if (tab.dataset.src) img.src = tab.dataset.src;
        if (tab.dataset.alt) img.alt = tab.dataset.alt;
        if (titleEl && tab.dataset.title) titleEl.textContent = tab.dataset.title;
        if (descEl && tab.dataset.desc) descEl.textContent = tab.dataset.desc;
      });
    });
  }

  // Interactive MCP Config Tabs & Copy Button
  const codeTabs = [...document.querySelectorAll('.code-tab')];
  const codeBlock = document.getElementById('mcp-code-content');
  const codeMeta = document.getElementById('mcp-code-meta');
  const copyBtn = document.getElementById('mcp-copy-btn');

  if (codeTabs.length && codeBlock) {
    codeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        codeTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (tab.dataset.code) codeBlock.textContent = tab.dataset.code;
        if (codeMeta && tab.dataset.meta) codeMeta.textContent = tab.dataset.meta;
      });
    });
  }

  if (copyBtn && codeBlock) {
    const defaultLabel = copyBtn.textContent;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeBlock.textContent || '');
        copyBtn.textContent = copyBtn.dataset.copied || '已复制';
        setTimeout(() => {
          copyBtn.textContent = defaultLabel;
        }, 1600);
      } catch {}
    });
  }
})();
