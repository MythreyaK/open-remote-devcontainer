import { defineConfig } from 'vitest/config';
import { resolve } from "node:path";

export default defineConfig({
    test: {
        alias: {
            vscode: resolve(__dirname, './src/mocks/vscode.cts'),
        }
    }
})
