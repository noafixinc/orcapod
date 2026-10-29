import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'prompts/**', 'state/**', 'runs/**', 'logs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
