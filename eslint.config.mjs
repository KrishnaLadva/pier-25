import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: [
      'dist/**/*',
      'node_modules/**/*',
      '.playwright-cli/**/*',
      'Portfolio page/**/*',
      'app.bundle.js',
    ],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
