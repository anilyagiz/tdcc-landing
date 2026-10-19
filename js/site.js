// Shared page behaviour for every page that links styles/site.css: the mobile
// menu, the nav background once the page scrolls, .reveal entrances, and the
// active entry in a .toc table of contents.
(() => {
  const nav = document.querySelector('.nav');
  const btn = document.getElementById('menu-btn');
  const links = document.getElementById('nav-links');

  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  if (btn && links && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    const set = (open) => {
      links.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    btn.addEventListener('click', () => set(!links.classList.contains('open')));
    links.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && links.classList.contains('open')) { set(false); btn.focus(); } });
  }

  const reveals = document.querySelectorAll('.reveal');
  if (reveals.length) {
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      reveals.forEach((el) => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver((entries) => entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      }), { rootMargin: '0px 0px -8% 0px' });
      reveals.forEach((el) => io.observe(el));
    }
  }

  const toc = document.querySelector('.toc');
  if (toc && 'IntersectionObserver' in window) {
    const map = new Map();
    toc.querySelectorAll('a[href^="#"]').forEach((a) => {
      const el = document.getElementById(decodeURIComponent(a.hash.slice(1)));
      if (el) map.set(el, a);
    });
    const seen = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => (en.isIntersecting ? seen.add(en.target) : seen.delete(en.target)));
      const first = [...map.keys()].find((el) => seen.has(el));
      if (!first) return;
      map.forEach((a, el) => a.classList.toggle('on', el === first));
    }, { rootMargin: '-80px 0px -60% 0px' });
    map.forEach((_, el) => io.observe(el));
  }
})();
