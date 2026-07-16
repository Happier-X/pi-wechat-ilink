# Contributing

## Local development

```bash
npm install
pi install .
```

Edit `src/index.ts`, then reload Pi:

```text
/reload
```

## Checks

```bash
npm run typecheck
```

## Release checklist

1. Bump version in `package.json` and `src/index.ts` (`PACKAGE_VERSION`)
2. Update `CHANGELOG.md`
3. Commit and tag
4. `npm publish --access public`
5. Push tag to GitHub
