(() => {
  try {
    const MAX = __MAX_ELEMENTS__;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const SEL = [
      'a[href]','button','input:not([type=hidden])','select','textarea',
      '[role=button]','[role=link]','[role=checkbox]','[role=radio]',
      '[role=tab]','[role=menuitem]','[role=menuitemcheckbox]','[role=switch]',
      '[role=combobox]','[role=textbox]','[role=option]','[role=searchbox]',
      '[role=slider]','[role=spinbutton]',
      '[contenteditable=""]','[contenteditable=true]',
      'summary','[tabindex]:not([tabindex="-1"])'
    ].join(',');

    document.querySelectorAll('[data-bb]').forEach(function (e) { e.removeAttribute('data-bb'); });

    const norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };

    const isVisible = function (el, r) {
      if (!r || r.width <= 1 || r.height <= 1) return false;
      const st = window.getComputedStyle(el);
      if (!st) return false;
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      if (Number(st.opacity) === 0) return false;
      return true;
    };

    const inView = function (r) {
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    };

    const roleOf = function (el) {
      const ex = el.getAttribute('role');
      if (ex) return ex;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return tag;
    };

    const nameOf = function (el) {
      const al = norm(el.getAttribute('aria-label'));
      if (al) return al.slice(0, 100);
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = norm(lb.split(/\s+/).map(function (id) {
          const n = document.getElementById(id);
          return n ? n.innerText : '';
        }).join(' '));
        if (t) return t.slice(0, 100);
      }
      let txt = norm(el.innerText || el.textContent || '');
      if (!txt && el.id) {
        try {
          const sel = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id;
          const lab = document.querySelector('label[for="' + sel + '"]');
          if (lab) txt = norm(lab.innerText);
        } catch (_) {}
      }
      if (!txt) txt = norm(el.getAttribute('placeholder'));
      if (!txt) txt = norm(el.getAttribute('title'));
      if (!txt) txt = norm(el.getAttribute('alt'));
      if (!txt && typeof el.value === 'string') txt = norm(el.value);
      return txt.slice(0, 100);
    };

    const enabledOf = function (el) {
      if (el.disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      return true;
    };

    const all = Array.from(document.querySelectorAll(SEL));
    const active = document.activeElement;
    const out = [];
    let count = 0;
    let stamp = 0;
    let focused = null;

    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r) || !inView(r)) continue;
      count++;
      if (out.length >= MAX) continue;

      const idx = stamp++;
      try { el.setAttribute('data-bb', String(idx)); } catch (_) {}
      const role = roleOf(el);
      const tag = el.tagName.toLowerCase();
      const item = {
        id: 'e' + idx,
        role: role,
        name: nameOf(el),
        bbox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        enabled: enabledOf(el),
        ref: '[data-bb="' + idx + '"]'
      };
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        item.checked = !!el.checked || el.getAttribute('aria-checked') === 'true';
      }
      if ((tag === 'input' || tag === 'textarea') && typeof el.value === 'string' && el.value) {
        item.value = norm(el.value).slice(0, 60);
      }
      if (el === active) focused = item.id;
      out.push(item);
    }

    const dialog = !!document.querySelector('[role=dialog],[role=alertdialog],dialog[open]');
    const scrollMaxY = Math.max(
      0,
      (document.documentElement ? document.documentElement.scrollHeight : 0) - vh
    );

    return {
      url: location.href,
      title: document.title || '',
      scrollY: Math.round(window.scrollY || 0),
      scrollMaxY: Math.round(scrollMaxY),
      viewport: [vw, vh],
      dialog: dialog,
      focused: focused,
      elements: out,
      truncated: count > out.length
    };
  } catch (e) {
    return { error: String(e) };
  }
})()
