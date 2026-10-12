# Правила для агентов и людей

- Модули в `src/` общаются **только через `src/contracts`**. `git`, `analysis`, `layout` и `server` не импортируют друг друга. Соединяет их только `src/pipeline.ts` (и `src/cli.ts` как точка входа). Исключение — `src/diff`: чистые функции без ввода-вывода, их могут использовать `git` и `analysis`.
- Сервер не знает про git: действия приходят интерфейсом `ServerActions`. Изменяющие запросы требуют токен из `/api/graph` (`x-vc-token`) и локальный `Origin`.
- Меняешь форму данных между этапами — сначала меняй схему в `src/contracts`, потом производителя и потребителя.
- `web/` импортирует только `@core/contracts` и `@core/layout` (ELK-независимая часть — `@core/layout/sizes`).
- Вывод каждого этапа детерминирован: одинаковый вход даёт одинаковый результат (сортировка без `localeCompare`, без случайностей). `meta.generatedAt` — единственное исключение.
- Новый язык добавляется через `LanguageAdapter` (`src/analysis/adapters/types.ts`), без правок графа.
- Каждый модуль покрыт тестами в изоляции (`*.test.ts` рядом с кодом). Для git-тестов есть `test/fixtures/repo.ts`, для diff'ов — `test/fixtures/change.ts`.
- Перед коммитом: `npm run typecheck && npm test && npm run build`.
