# Agent Instructions & Workflow Guidelines

## 🚨 Mandatory Rule: Commit After Every Change
Any AI agent working in this repository **MUST** create a Git commit after every logical change, feature addition, refactoring, or bugfix.

### Required Agent Workflow:
1. **Safety & Hygiene Check**:
   - Before staging, run git status to verify modified files.
   - **NEVER** stage or commit sensitive data (.env, API tokens, private keys, passwords).
   - **NEVER** commit heavy dependencies, caches, or build artifacts (
ode_modules/, .venv/, __pycache__/, dist/, uild/).
2. **Atomic Commits**:
   - Commit frequently — do not bundle unrelated modifications into a single massive commit.
   - Each commit must represent a single coherent unit of work.
3. **Meaningful Commit Messages**:
   - Write clear, imperative commit messages (e.g. eat: add user filter component, ix: handle edge case in parser).
4. **Push to Remote**:
   - Push commits to GitHub (git push origin <current-branch>) after completing the requested task or milestone.

---

## 🇷🇺 Инструкции для ИИ-агентов (Правило обязательных коммитов)

1. **Обязательный коммит после каждого изменения**:
   - Любой ИИ-агент, вносящий изменения в проект, **обязан** зафиксировать их через git commit сразу после каждого завершённого логического шага или задачи.
2. **Проверка чистоты и безопасности**:
   - Всегда проверять git status перед добавлением файлов.
   - **Никогда** не коммитить файлы с секретами (.env, токены, ключи доступа), кэши, виртуальные окружения (.venv) и сторонние библиотеки (
ode_modules).
3. **Атомарность и описание**:
   - Один логический шаг — один коммит с чётким описанием сути изменений.
4. **Отправка в облако**:
   - По завершении работы отправить коммиты на GitHub (git push).
