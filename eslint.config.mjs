import tseslint from "typescript-eslint";

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
            "@typescript-eslint/naming-convention": ["warn", {
                selector: "import",
                format: ["camelCase", "PascalCase"],
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
);
