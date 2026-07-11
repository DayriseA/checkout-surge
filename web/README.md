# Results bench

Local browser for the Checkout-Surge agent-comparison experiment: the three self-audit reports, cross-model finding clusters, supplementary post-fix browser-use results, implementation comparisons, the fixed-reviewer independent reviews of each post-fix branch, and the resulting base-branch decision synthesis.

Not meant to be hosted — run it locally on this branch.

```sh
cd web
npm install
npm run dev        # http://localhost:5173
```

Other commands:

```sh
npm run check-data # validate results/data/*.json against the schemas (Node ≥ 23.6)
npm run build      # type-check + production build (sanity check; nothing deploys)
npm run preview    # serve the production build locally
```

Optional render smoke (needs a one-time `npx playwright install chromium --only-shell`, plus `sudo npx playwright install-deps chromium` on bare containers): start `npm run preview`, then `node scripts/smoke.ts` — renders every page headlessly and fails on console errors or missing content.

## Where the content lives

The app has no content of its own — everything is read from `../results` at build/dev time:

- `results/**/*.md` — the full reports (self-audits and independent reviews), rendered on each agent's page.
- `results/data/**` — the structured layer (findings index, clusters, independent-review findings and clusters, post-fix browser-use findings, comparisons). Schemas are documented in `results/data/README.md` and enforced by `src/lib/schema.ts`; the app refuses to start on invalid data, and `npm run check-data` gives the same verdict from the CLI (plus checks that every finding's section can be located in its report).

The base-selection narrative lives at `results/base_selection/base_branch_recommendation.md`. Its intentionally small metadata record, `results/data/base-selection.json`, drives the `/base-selection` summary and links back to existing evidence IDs without duplicating the full reasoning.

Edit the JSON, save, and Vite hot-reloads the views. To add a future report: drop the markdown under an appropriate `results/` subfolder, the findings JSON in `results/data/findings/`, and register the model in `results/data/models.json`.

Browser-use findings are supplementary post-remediation results: each implementation had already gone through self-audit, issue filing, attempted fixes, and claimed completion before independent browser testing ran.

## Stack

Vite · React 19 · TypeScript · Tailwind CSS v4 · Radix primitives (shadcn-style components in `src/components/ui/`) · react-markdown · Zod.
