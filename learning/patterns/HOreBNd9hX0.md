# The Magic of Self-Healing Infrastructure: Real World Implications of Execution Cloud

URL: https://youtube.com/watch?v=HOreBNd9hX0
Тема: self healing infrastructure AI
Дата: 2026-03-14

## CORE PROBLEM
Автоматизированные тесты постоянно ломаются не из-за реальных багов в приложении, а из-за изменений в DOM-локаторах (ID, классы, XPath), которые девелоперы меняют независимо от пользовательского опыта. 90% времени на поддержку тестов уходит именно на фикс локаторов, а не на реальную логику — это узкое место между Dev и QA командами. Традиционные тестовые фреймворки (Selenium, WebDriver) видят приложение как набор кода, а не как то, что видит пользователь.

## KEY INSIGHT
Нужно **разделить test interaction и test assertion**: взаимодействие с UI должно быть устойчивым к изменениям DOM (self-healing), а валидация — явной и намеренной. Локатор — это детерминированная хрупкость; визуальный AI — это семантическая устойчивость.

## SOLUTION APPROACH
Applitools Execution Cloud решает проблему через визуальный AI, который видит приложение так же, как пользователь — по presentation layer, а не по DOM-структуре. При каждом взаимодействии с элементом система захватывает сотни data points: локаторные стратегии, контекстное окружение, позицию, размер, текст — всё сохраняется в БД. Когда элемент не найден при следующем запуске, алгоритм извлекает сохранённый контекст и ищет элемент в bounds box на основе совокупности факторов. Успешное нахождение → обновление БД новой информацией, то есть система постоянно обучается на реальных тест-ранах. Это первая self-healing инфраструктура для open-source фреймворков (Selenium, WebDriver) — раньше такое было только в проприетарных codeless-инструментах.

## ACTIONABLE STEPS
1. **Разделить interaction и assertion** — пройтись по всем существующим тестам и вынести каждую проверку в явный checkpoint/assertion, убрав скрытые валидации из interaction-шагов (кликнул → проверил отдельно)
2. **Аудит локаторов** — найти все хрупкие локаторы (XPath с индексами, динамические CSS-классы из Astro/Next/Gatsby), заменить на data-testid атрибуты или семантические роли
3. **Внедрить visual baseline** — для каждого критичного UI-состояния сделать скриншот-baseline, чтобы AI мог сравнивать presentation layer, а не DOM
4. **Контекстная база элементов** — хранить не только локатор элемента, но и его контекстное окружение (соседние элементы, позиция на странице, текст) — при изменении DOM контекст остаётся стабильным
5. **Pipeline resilience** — настроить тест-ран так, чтобы при failed locator система пыталась self-heal перед тем, как фейлить весь pipeline

## CODE PATTERN

```python
# Self-healing element resolver pattern
# (Framework-agnostic, applicable to any UI testing)

from dataclasses import dataclass, field
from typing import Optional
import json

@dataclass
class ElementFingerprint:
    """Multi-strategy element identity — не один локатор, а контекст"""
    primary_locator: str          # id, data-testid (стабильный)
    fallback_locators: list[str]  # class, name, aria-label
    visual_context: dict          # соседние элементы, позиция
    text_content: Optional[str]   # текст кнопки (для информации, не для поиска)
    bounds: dict                  # {x, y, width, height}
    confidence: float = 1.0       # снижается при каждом heal

class SelfHealingLocator:
    def __init__(self, driver, fingerprint_db):
        self.driver = driver
        self.db = fingerprint_db   # Qdrant / SQLite / JSON

    def find_element(self, element_id: str):
        fp = self.db.get(element_id)

        # Stage 1: Try primary locator (fast path)
        element = self._try_locator(fp.primary_locator)
        if element:
            return element

        # Stage 2: Try fallbacks in order
        for locator in fp.fallback_locators:
            element = self._try_locator(locator)
            if element:
                self._heal_and_update(element_id, locator, fp)
                return element

        # Stage 3: Context-based search (AI-powered)
        element = self._context_search(fp.visual_context, fp.bounds)
        if element:
            self._heal_and_update(element_id, None, fp, healed_by="context")
            return element

        # Stage 4: Escalate — cannot heal
        raise ElementNotFoundError(
            f"Cannot find '{element_id}' — manual intervention required"
        )

    def _context_search(self, context: dict, bounds: dict):
        """Find element by surrounding elements and approximate position"""
        neighbors = context.get("neighbors", [])
        for neighbor_locator in neighbors:
            anchor = self._try_locator(neighbor_locator)
            if anchor:
                # Search in spatial proximity to anchor
                return self._find_near(anchor, bounds["relative_position"])
        return None

    def _heal_and_update(self, element_id, new_locator, fp, healed_by="locator"):
        """Update DB with healed locator — system learns"""
        fp.confidence *= 0.9  # Decay confidence on each heal
        if new_locator and new_locator not in fp.fallback_locators:
            fp.fallback_locators.insert(0, new_locator)  # Promote to top

        self.db.update(element_id, fp)
        print(f"[HEALED] {element_id} via {healed_by}, confidence={fp.confidence:.2f}")

# Usage in test:
# locator = SelfHealingLocator(driver, db)
# submit_btn = locator.find_element("signin_submit_button")
# submit_btn.click()
# — THEN separately assert the outcome:
# assert driver.current_url == "/dashboard"  # Explicit assertion, NOT implicit
```

## METRICS & RESULTS
| Метрика | Результат |
|---------|-----------|
| **Test flakiness** | Drastically reduced — большинство локаторных изменений больше не ломают pipeline |
| **Maintenance effort** | -90% времени на поддержку тестов (90% effort уходило на локаторы → теперь self-heal) |
| **Test speed** | Execution Cloud быстрее или наравне с конкурентами при параллельном запуске |
| **Coverage** | Увеличивается за счёт параллельного запуска по браузерам и сценариям |
| **Dev-QA friction** | Снижается — девелоперы могут менять DOM без страха сломать тесты |

*Конкретных числовых KPI (%, $) в видео не приводится — фокус на качественных улучшениях.*

## APPLY TO ASYSTEM
ASYSTEM Panel активно развивается (Sprint 20+), и фронтенд React-компоненты регулярно меняются — это идеальный кандидат для self-healing тестов. Для Voltera-mobile (Vite + Capacitor) и AURWA (v3.0) стоит внедрить паттерн **fingerprint-based locators**: хранить не только CSS-селекторы, но и контекст элементов в Qdrant (уже есть), чтобы при рефакторинге компонентов тесты не падали. Ключевое правило из видео применить немедленно: в тестах для `/api/dispatch`, Panel UI и агентских воркфлоу разделить interaction (кликнуть, заполнить) и assertion (проверить URL, статус, ответ) — это снизит false-positive failures при обновлениях панели.

## TAGS
`self-healing-tests`, `test-automation`, `DOM-locators`, `visual-AI`, `flaky-tests`, `selenium`, `UI-testing`, `test-maintenance`