# Results bench

Local browser for the Checkout-Surge agent-comparison experiment: the three self-audit reports, cross-model finding clusters, and (as the experiment progresses) agentic exploratory testing results and implementation comparisons.

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

- `results/*.md` — the full self-audit reports, rendered on each agent's page.
- `results/data/**` — the structured layer (findings index, clusters, agentic test findings, comparisons). Schemas are documented in `results/data/README.md` and enforced by `src/lib/schema.ts`; the app refuses to start on invalid data, and `npm run check-data` gives the same verdict from the CLI (plus checks that every finding's section can be located in its report).

Edit the JSON, save, and Vite hot-reloads the views. To add a future report: drop the markdown in `results/`, the findings JSON in `results/data/findings/`, and register the model in `results/data/models.json`.

## Stack

Vite · React 19 · TypeScript · Tailwind CSS v4 · Radix primitives (shadcn-style components in `src/components/ui/`) · react-markdown · Zod.
