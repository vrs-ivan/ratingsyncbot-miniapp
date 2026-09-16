# ratingsyncbot Mini App

Статичний фронтенд Telegram Mini App для керування розсилкою `uk-offers-table-sync` (Старт / Перегляд / Стоп / Відкат).

Хоститься на GitHub Pages. За замовчуванням `index.html` має `data-demo="true"` — працює локальна симуляція без бекенду.

Для підключення до реального API: у `index.html` виставити `data-demo="false"` та `data-api-base="https://<домен n8n>/webhook"`.

Немає токенів чи інших секретів у цьому репозиторії — Mini App лише викликає захищений бекенд, авторизацію передає через `Telegram.WebApp.initData` та одноразовий `thread_context` токен (див. `access-config.example.json`).
