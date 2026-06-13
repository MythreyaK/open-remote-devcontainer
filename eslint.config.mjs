import tseslint from "typescript-eslint";

const isDev = process.env.NODE_ENV !== "production";

export default tseslint.config(
    {
        ignores: ["dist/", "out/", "*.mjs", "*.js", "**/*.d.ts"],
    },
    tseslint.configs.strictTypeChecked,
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
            semi: "warn",
            "no-throw-literal": "warn",
            "no-eval": "error",
            "no-caller": "error",
            "no-duplicate-imports": "warn",
            "no-new-wrappers": "warn",
        },
    },
    {
        files: [ "**/*.test.ts" ],
        rules: {
            "@typescript-eslint/no-unsafe-argument": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-call": "warn",
        }
    }
);
