import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";

const isDev = process.env.NODE_ENV !== "production";

export default tseslint.config(
    {
        ignores: ["dist/", "out/", "*.mjs", "*.js", "**/*.d.ts"],
    },
    tseslint.configs.strictTypeChecked,
    stylistic.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                project: ["tsconfig.json", "tsconfig.test.json"],
            },
        },
    },
    {
        rules: {
            "@typescript-eslint/no-unused-vars": isDev ? "warn" : "error",
            "@typescript-eslint/naming-convention": ["warn", {
                selector: "import",
                format: ["camelCase", "PascalCase"],
            }],
            "@typescript-eslint/restrict-template-expressions": ["error", {
                allowNumber: true,
            }],

            curly: "warn",
            eqeqeq: "warn",
            "no-throw-literal": "warn",
            "no-eval": "error",
            "no-caller": "error",
            "no-duplicate-imports": "warn",
            "no-new-wrappers": "warn",
        },
    },
    {
        files: ["**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-unsafe-argument": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-call": "warn",
        }
    },
    {
        rules: {
            "@stylistic/indent": ["warn", 4],
            "@stylistic/semi": ["warn", "always"],
            "@stylistic/quotes": ["warn", "double", { avoidEscape: true }],
            "@stylistic/member-delimiter-style": ["warn", {
                multiline: { delimiter: "comma", requireLast: true },
                singleline: { delimiter: "comma" },
            }],
        }
    }
);
