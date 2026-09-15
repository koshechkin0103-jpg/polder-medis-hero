// Проверка вёрстки наложением макета в режиме difference.
// Открыть страницу на ширине окна 1440 px (или любой — макет масштабируется
// вместе с блоком), вставить этот код в консоль DevTools. Совпавшие элементы
// станут чёрными, расхождения — светлыми. Повторный запуск убирает наложение.
(() => {
  const old = document.getElementById('diff-overlay');
  if (old) { old.remove(); return; }
  const hero = document.getElementById('hero');
  const img = document.createElement('img');
  img.id = 'diff-overlay';
  img.src = 'Дизайн.png';
  Object.assign(img.style, {
    position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
    mixBlendMode: 'difference', zIndex: 99, pointerEvents: 'none'
  });
  hero.appendChild(img);
})();
