import tsParser from "@typescript-eslint/parser";

export default [
    {
        ignores: [
            "node_modules/**",
            "tests/fixtures/**",
        ],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: "module",
            },
        },
        rules: {
            "curly": "error",
            "brace-style": ["error", "1tbs"],
            "indent": ["error", 4, { SwitchCase: 1 }],
            "eqeqeq": ["error", "always"],
            "no-var": "error",
            "prefer-const": "error",
        },
    },
];
