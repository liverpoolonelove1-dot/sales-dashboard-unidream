// Cloudflare Worker: прокладка для встраивания call-widget.html в карточку сделки Bitrix24.
//
// ПРИЧИНА: Bitrix24 всегда открывает встроенные виджеты/локальные приложения через POST-запрос
// (так передаются токены авторизации в iframe) — это часть платформы, не настройка, не обходится.
// pulsecrm.uz работает на GitHub Pages — чисто статический хостинг, который умеет отвечать
// только на GET/HEAD и возвращает 405 Not Allowed на любой POST. Отсюда и "405 Not Allowed"
// в самой карточке сделки — Bitrix24 не может загрузить страницу, а не "виджет сломан".
//
// РЕШЕНИЕ: этот воркер принимает запрос ЛЮБЫМ методом (GET и POST) и просто отдаёт содержимое
// call-widget.html как обычную HTML-страницу с кодом 200 — Cloudflare Workers прекрасно
// работают с POST, в отличие от GitHub Pages. Сам виджет внутри использует BX24.js (постоянную
// связь с родительским окном через postMessage), поэтому ему не нужно ничего вытаскивать из
// тела POST-запроса — авторизация всё равно происходит через сам Bitrix24 JS SDK после загрузки.
//
// ИСТОЧНИК КОДА: raw.githubusercontent.com, а НЕ pulsecrm.uz (6 августа 2026 обнаружено, что
// GitHub Pages deploy для этого репозитория несколько раз подряд падал по таймауту на стороне
// GitHub — "Timeout reached, aborting!", из-за чего pulsecrm.uz зависал на старой версии файлов
// на неопределённое время). raw.githubusercontent.com отдаёт файл прямо из git-репозитория,
// без отдельного шага деплоя — обновляется сразу после git push, независимо от того, работает
// сейчас Pages или нет. Раздаёт с content-type: text/plain, но это не важно — воркер ниже всё
// равно принудительно выставляет text/html в ответе.
// Если Pages-деплой на pulsecrm.uz снова станет надёжным — можно вернуть SOURCE_URL обратно на
// https://pulsecrm.uz/call-widget.html, тогда правки будут видны сразу через обычный дашборд тоже.
//
// КАК РАЗВЕРНУТЬ/ОБНОВИТЬ (Cloudflare Dashboard):
// 1. dash.cloudflare.com → Workers & Pages → воркер pulsecrm-call-widget → Edit code
// 2. Стереть всё, вставить содержимое этого файла целиком → Deploy
// 3. В Bitrix24 (там, где регистрировал виджет "Анализ звонка ИИ") URL обработчика должен
//    указывать на адрес этого воркера (не на pulsecrm.uz/call-widget.html напрямую).
//
// Если позже поменяется сам call-widget.html в репозитории — редеплоить этот воркер не нужно,
// он всегда подтягивает свежую версию из git на лету (raw.githubusercontent.com кэширует у себя
// недолго, обычно секунды).

const SOURCE_URL = 'https://raw.githubusercontent.com/liverpoolonelove1-dot/sales-dashboard-unidream/main/call-widget.html';

export default {
  async fetch(request) {
    const upstream = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'pulsecrm-call-widget-proxy' },
      cf: { cacheTtl: 60 }
    });
    const html = await upstream.text();
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }
};
