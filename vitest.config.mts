import { defineConfig } from 'vitest/config';
import { resolve } from "node:path";

export default defineConfig({
    test: {
        include: [ "src/**/test.ts", "src/**/*.test.ts" ],
        alias: {
            vscode: resolve(import.meta.dirname, './src/mocks/vscode.cts'),
        },
        typecheck: {
            enabled: true,
        },
    }
})
