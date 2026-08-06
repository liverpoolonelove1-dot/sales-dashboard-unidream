// Cloudflare Worker: прокладка для встраивания call-widget.html в карточку сделки Bitrix24.
//
// ПРИЧИНА: Bitrix24 всегда открывает встроенные виджеты/локальные приложения через POST-запрос
// (так передаются токены авторизации в iframe) — это часть платформы, не настройка, не обходится.
// pulsecrm.uz работает на GitHub Pages — чисто статический хостинг, который умеет отвечать
// только на GET/HEAD и возвращает 405 Not Allowed на любой POST. Отсюда и "405 Not Allowed"
// в самой карточке сделки — Bitrix24 не может загрузить страницу, а не "виджет сломан".
//
// РЕШЕНИЕ: этот воркер принимает запрос ЛЮБЫМ методом (GET и POST) и просто отдаёт содержимое
// call-widget.html с pulsecrm.uz как обычную HTML-страницу с кодом 200 — Cloudflare Workers
// прекрасно работают с POST, в отличие от GitHub Pages. Сам виджет внутри использует BX24.js
// (постоянную связь с родительским окном через postMessage), поэтому ему не нужно ничего
// вытаскивать из тела POST-запроса — авторизация всё равно происходит через сам Bitrix24 JS SDK
// после загрузки страницы.
//
// КАК РАЗВЕРНУТЬ (Cloudflare Dashboard, 2 минуты):
// 1. dash.cloudflare.com → Workers & Pages → Create → Create Worker
// 2. Дать имя, например "pulsecrm-call-widget" → Deploy (создастся болванка)
// 3. Edit code → стереть всё, вставить содержимое этого файла → Deploy
// 4. Скопировать итоговый адрес воркера, например:
//      https://pulsecrm-call-widget.<твой-поддомен>.workers.dev
// 5. В Bitrix24 (там, где регистрировал виджет "Анализ звонка ИИ" — Разработчикам/Local
//    application или Приложение с плейсментом CRM_DEAL_DETAIL_TAB) заменить URL обработчика
//    со старого https://pulsecrm.uz/call-widget.html на новый адрес воркера из шага 4.
// 6. Обновить страницу карточки сделки в Bitrix24 — вкладка "Анализ звонка ИИ" должна открыться.
//
// Если позже поменяется сам call-widget.html — редеплоить этот воркер не нужно, он всегда
// подтягивает свежую версию с pulsecrm.uz на лету.

const SOURCE_URL = 'https://pulsecrm.uz/call-widget.html';

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
