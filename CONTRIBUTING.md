# Contributing

Thanks for looking. Small, focused pull requests are the easiest to review.

## Run the tests

```bash
npm ci
npm run typecheck
npm test
npm run build
```

No API key is needed. All four commands must pass before a pull request is merged.

## Ground rules

- One change per pull request. Say what it does and how you checked it.
- Add or update a test for any behaviour change. Tests sit next to the code as `*.test.ts`.
- Never commit a secret, a real transcript, a real person's name or a real email address. Use `example.com` and invented names in tests and fixtures.
- Real personas are private. Only `soul/example.md` and `soul/README.md` are tracked.
- Privacy rules are enforced on the server in `src/agent/work-scope.ts`. A change there needs tests for both the allow case and the deny case.

## Where to start

The roadmap in the README lists good first issues. Open an issue before a large change so we can agree on the approach.
