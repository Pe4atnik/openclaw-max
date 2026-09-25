import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The reconnect suite uses node:test and is run separately by
    // `npm run test:reconnect`; Vitest must not treat it as an empty suite.
    exclude: ["test/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Типы без исполняемого кода.
        "src/types.ts",
        // Список сертификатов Минцифры — данные, не логика.
        "src/max-ca.ts",
        // Скомпилированная копия из dist с `@ts-nocheck`, пришедшая от апстрима.
        // Покрывать её осмысленно только после переписывания на TypeScript —
        // отдельная задача, см. план в основном репозитории.
        "src/webhook-handler.ts",
      ],
      reporter: ["text", "text-summary"],
      // Планка по достигнутому: операторы и строки покрыты целиком, и ронять
      // это нельзя — правка без теста сразу красит проверку. Ветки ниже ста
      // осознанно: часть из них — защитные `?.` на путях, которые ядро не
      // проходит, и выдумывать под них сценарии значит писать тесты ради цифры.
      thresholds: {
        // Current OpenClaw mediaUrl compatibility adds guarded fallback
        // branches that are covered by focused tests but not every defensive
        // error path. Keep the gate above the measured baseline.
        statements: 97,
        lines: 97,
        functions: 95,
        branches: 85,
      },
    },
  },
});
