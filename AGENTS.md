# Notes for coding agents

- TypeScript (NodeNext), pnpm. Run `pnpm check` before every commit.
- Tools live in `src/tools.ts`; each declares kind, permission and a strict zod input. Never add user, tenant or employee id inputs.
- Writes must go through `PreviewStore.issue/consume` and `Idempotency.run`. Commits never complete an HR action; they start one for approval.
- Never mark a domain live in `src/adapters.ts` without the contract proof in docs/ARCHITECTURE.md.
- Fixture data must stay obviously fictional and carry `example: true` on source refs.
- No em dashes in docs or user-facing text.
