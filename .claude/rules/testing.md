---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

# Test File Rules

## Never test TypeScript types

Do not write tests that only verify type-level behavior (e.g., `expectTypeOf`, `type-fest` helpers, assignability checks). Types are validated by `tsc` — testing them adds no value.

## Use `test`, never `describe`/`it`

```ts
// Correct
import { test, expect } from 'vitest';

test('parses valid input', () => { ... });
test('throws on empty string', () => { ... });

// Wrong — do not use describe or it
describe('parser', () => {
  it('parses valid input', () => { ... });
});
```

## No `beforeEach`/`beforeAll` — use a `setupTest()` helper

```ts
// Correct
function setupTest() {
  const store = createStore();
  const handler = buildHandler(store);
  return { store, handler };
}

test('handler updates store', () => {
  const { store, handler } = setupTest();
  handler.process(event);
  expect(store.getState().count).toBe(1);
});

// Wrong — do not use beforeEach or beforeAll
let store: Store;
beforeEach(() => {
  store = createStore();
});
```
