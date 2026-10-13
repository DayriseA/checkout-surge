# 06 — Narrative, Site Structure and Decisions

**Design:** sections 1, 3.1, 5 · **Depends on:** 05

## Goal

A visitor understands quickly what the project is and what it shows, and a curious visitor can easily find the theory, the industry practices, what the demo shows of them at its scale, and its limits. The decisions are recorded.

## Scope

- **Site structure (owner, 2026-10-13).** The home page (Overview) is clear and pleasant: the project's nature, its concept and its key points, in plain language, with visuals where they help, and without large blocks of technical text. Detail lives on dedicated pages (or at least one) for curious visitors:
  - the theory and the industry's standard practices for this kind of situation, and why they are standard: what each one brings;
  - what the demo lets you see of them, at its scale, including both comparisons;
  - the demo's limits and known defects.
- **Discoverable links.** The home page links to these pages where relevant (for example, "the demo presents architecture choices common in the industry" links to the theory page; a mention of a limit links to the limits section). Links may recur where relevant, without overloading.
- **Diagrams and visuals** where they explain better than text.
- The existing technical content is moved and condensed, not lost. The "How it works" link must lead somewhere other than the home page.
- The preset texts, the README and the architecture docs.
- The "known limits" content: remove what the project now shows, and keep what it still cannot show.
- Present any simulated constraint as a simulation.
- State openly that PostgreSQL and Redis run on the API's Machine: in a real deployment they would sit about a millisecond away, which would add about the same to every answer in both modes without changing what the comparisons show (design section 3.1).
- State the Redis trade-off honestly: Redis keeps turned-away buyers off the database, but each winner costs more work, since two stores must be kept in step.
- Explain why the industry puts this work in Redis, without implying that it merely moves the load: PostgreSQL is the system of record, with one write primary, limited connections and the rest of the system depending on it; Redis decides the stock in memory, atomically and without row locks, scales out cheaply, and holds data that can be rebuilt. The point is to keep the database free for the orders and to isolate the surge from the rest of the shop.
- The comparisons' disclosures (the same buy processes in both runs, stores sharing the core Machine, how to read each figure) live on the detail pages, linked from the comparison view.
- Decision log entries for the modes, the fairness rules and the comparison-only conditions (including the amendment of HD-51), where they pass the inclusion test.

## Done When

- **Owner checkpoint D1:** the owner has approved the proposed page structure and content outline, before implementation.
- **Owner checkpoint D2:** the owner has reviewed the implemented pages and texts.

## Open Points

- The page structure, proposed for checkpoint D1.

## Working Notes

### Owner decisions at checkpoint D1 (2026-10-13)

The owner approved the proposal below as broadly aligned, and will review the implemented pages at checkpoint D2 rather than the written outline. Answers to its open questions:
1. Navigation: drop "Overview" (the logo is the home link); move "Admin" to the footer.
2. Home figures: static medians from the proof measurements, labelled with the method, refreshed after the production deploy (task 07).
3. Industry examples stay generic: no vendors or well-known sales.
4. No author line: visitors arrive from the owner's portfolio, not the other way round.
5. Yes to one sentence about the project on the gate's "The demo is asleep" page.
6. Titles "How it works" and "Under the hood" approved.

### Proposal for checkpoint D1 (2026-10-13)

**Decision asked.** Approve the page structure, the content outlines and the visuals below, or ask for changes, before any implementation. **Recommendation:** approve as proposed. Each open question in section 8 has a default.

#### 1. The current site

| Route (nav) | Content | Verdict |
| :-- | :-- | :-- |
| `/` (Overview) | A hero whose "How it works" button is an anchor on the same page, then 12 sections (about 1,900 words): the waiting room and journey, the Redis decision and the architecture diagram, the queue and the ERP, real vs simulated, what production adds, signals, run finish, success, admission and reset, what limits a run, known limits, a glossary. | Sound and honest, but it reads as engineering documentation. **Too technical for a home:** signals, finishing, success, admission, VU limit, uncertain results, glossary. **Redundant:** the buy path is told three times (its section, the diagram caption, the `/demo` capsule), and the two limits sections overlap. **Stale:** "later work will compare…"; "one API process answers every buyer" (the Redis comparison uses two); "does not show here" (now shown, as database load). |
| `/demo` (Demo) | The preset board, the custom builder, and a 90-word "How the surge stays safe" capsule linking to `/#waiting-room`. | The capsule repeats the home. The comparison presets do not say what they show. |
| `/watch` (Watch) | The run card ("Overview" and "Pipeline" tabs) and the comparison panel, with an intro and a takeaway. Task 05 makes the panel a third tab without prose. | The tab "Overview" clashes with the nav's. The panel's prose needs a home. |
| `/run-history`, `/admin`, Repository ↗ | Reports (with the comparison panel); the operator console; GitHub. | The reports need the same links as Watch. Admin sits in the visitors' nav. |
| Gate pages (`apps/gate`) | "The demo is asleep" and the other states. | The real first page of a cold visit, and it does not say what the demo is. |

**Sources.** `README.md` opens with a 250-word paragraph and never mentions the comparisons. The Purpose section of `docs/architecture.md` and the single-process caveat in `scope_and_caveats.md` (HD-51) predate them. The results and disclosures exist only in tasks 03 and 04.

**Missing.** What the project is, in plain words. Why each practice is standard, and its cost. The comparisons' results. The co-located-stores disclosure. Known defects. Visuals that work on a phone. Any route to the details other than the home page.

#### 2. Proposed structure

Four content pages, three of them new. The app pages are unchanged.

| Route | Title (nav) | Audience and purpose | Size |
| :-- | :-- | :-- | :-- |
| `/` | Checkout-Surge (the logo) | Everyone, in one minute: what it is, the concept in one picture, what the comparisons show, and a way to try it. | ~350 words, 2 visuals |
| `/how-it-works` | How flash-sale checkouts are built ("How it works") | Curious visitors, with no engineering background needed. Four standard practices, each with the problem, the standard answer, what it brings and what it costs. Then what the demo shows of them at its scale, and the two comparisons with how to read them. | ~1,800 words, 5 visuals |
| `/limits` | Limits and known defects (footer, recurring links) | Anyone checking the claims: what is simulated, the scale, what the comparisons cannot show, what production adds, and the known defects. | ~900 words |
| `/under-the-hood` | Under the hood (footer) | Engineers: architecture, buy path, safety nets, run lifecycle, measurement method, hosting, glossary. Mostly moved content. | ~1,500 words, 2 visuals |

- **Nav:** Demo · Watch · Run history · How it works · Repository ↗ · Admin. "Overview" goes: the logo is the home link, and Watch's tab no longer clashes.
- **A footer on every page:** How it works · Under the hood · Limits and known defects · Glossary · Repository · Admin.
- **Limits gets its own page** because it is the most-linked target and answers one question ("what's the catch?"). As a page of its own, it reads as deliberate honesty, not as a footnote.
- **No separate comparisons page.** The comparisons are the evidence for practices 2 and 3. Ending the theory page with them keeps one reading path (practice, then evidence, then limits), and Watch deep-links straight into them.

#### 3. Content outlines

**Tone.** Short sentences. The plain term first, with the technology in parentheses: "an in-memory store (Redis)". Every simulated value is called simulated.

**Home `/`**
1. **Hero.** Draft: "A live demo of the system behind a flash sale: 10,000 buyers rush for 500 units, nobody gets a unit that does not exist, and a slow back office is never flooded. Start a simulated sale and watch it live." Buttons: Try the demo; How it works (`/how-it-works`). The surge band stays.
2. **How it works, in one picture.** "It uses design choices that are standard in the industry for this kind of sale" (linked). Then V1, and four cards as its legend, each with one sentence, a tag, and a link to its section: ① stock decided in memory ("compared live"); ② "yes" now, confirm later ("compared live"); ③ safe retries ("shown live"); the waiting room ("not modelled"). Closing line: "The software is real; the buyers, the back office and the emails are simulated" (`/limits#real-and-simulated`).
3. **What each choice buys.** Two cards, "same workload, run twice, one choice switched", each with one measured pair (V2): "every buyer answered within" for the queue, and PostgreSQL transactions while selling for Redis. Each card has Run it (`/demo#<slug>-title`, the preset card's existing id), How to read it, and a footnote with the method.
4. **A demo, at demo scale.** Three bullets (one machine and up to 10,000 buyers in a second; no payment or bot protection; the stores share the API's machine), then a link to `/limits`.
5. **For engineers.** The stack line, and "sleeps when idle, wakes in about 15 seconds". Links to Under the hood and the repository.
6. **Closing band:** "See it under load" (kept).

**How it works `/how-it-works`** (sticky contents list, as on today's home)

**A flash sale in three numbers** (V3): 10,000 buyers in about a second, 500 units, and a back office that confirms 20 orders per second (simulated). Demand is 20 times the stock and arrives 500 times faster than the back office confirms. So the system must answer everyone fast, sell each unit once, and protect both the back office and the rest of the shop. V4 shows the five-step purchase journey and what the demo covers (moved from the home, with its note on the missing payment step).

**Four practices**, each framed *The problem · The standard answer · What it brings · What it costs*, and each closed by an "In this demo" box (preset, matching limit):
1. **Let buyers in at a pace you can absorb** (waiting room). Costs: buyers wait, and each release still lands as a burst. In this demo: not modelled. "Everyone at once" is one release; "Steady stream" is its outflow.
2. **Decide the stock in memory, in one step** (Redis), with V5.
   - *Why it is standard, without implying it merely moves load:* PostgreSQL is the system of record, with one write primary, limited connections, and the rest of the shop depending on it. Redis decides in memory, atomically and without row locks, scales out cheaply, and holds data that can be rebuilt. The point is to keep the database free for the orders and to isolate the surge from the rest of the shop.
   - *Costs:* Redis keeps turned-away buyers off the database, but each winner costs more work, since two stores must be kept in step (with recovery when the second write fails). Redis has its own ceiling, and winners are not faster.
   - In this demo: every run, and the Redis comparison.
3. **Say "yes" now, confirm later** (order queue, paced worker), with V6. Brings: answers in seconds whatever the back office does, a back office never flooded, work that survives crashes. Costs: "secured" comes before "confirmed", failures after a "yes" need handling, more moving parts; and the back office is not faster. The note on declared-limit pacing versus an adaptive limiter moves here. In this demo: every backlog chart, Slow ERP, Laggy ERP, and the queue comparison.
4. **Make every step safe to repeat** (idempotency). A double click, timeout or retry never buys twice, and an uncertain result is checked before any replay. Costs: keys to store, and a downstream that supports them. In this demo: the Duplicate-click storm preset and the ERP's ledger.

**What the demo shows, at its scale.** A table of practice × "every run" × "compared live" × preset. Real sales can be far larger: the patterns carry over, the numbers do not (`/limits#scale`).

**The queue comparison** (`#queue-comparison`)
- *What it runs:* Surge 5k, twice. In run 2, each winner's request waits for the same worker's confirmation. After 45 s it is told "still being confirmed" and the order completes later, so nothing is lost by design.
- *V7:* winners' wait, every buyer answered, orders confirmed, the ERP's pace.
- *Reading:* "The queue moves the wait from the buyer to the back office; it does not make the back office faster."
- *How to read each figure:* one line per Watch row (cohorts, 95th percentile, pace window).
- *Fair test:* same buyers, stock, ERP limit, worker and protections; fixed order, with the queue first.

**The Redis comparison** (`#redis-comparison`)
- *What it runs:* Surge 10k, twice. Run 2 moves both of Redis's jobs (the stock decision and the order queue) into PostgreSQL, with the same protections. Redis still carries the live counters and notifications, and the same two buy-only processes serve both runs.
- *V7:* transactions, time in queries, CPU, both waits.
- *Reading:* the headline is the database's load. Turned-away buyers are answered a little sooner; winners about equal. The speed gap stays small because the database is not the bottleneck at this scale. It would be with several API instances sharing it, with a remote database behind a bounded pool, or with a database busy with the rest of the shop.
- *How to read each figure:* the selling window, a transaction, and "time in queries" (stock-row waits included).
- *Fair test:* a standard PostgreSQL design (one stock row, conditional decrement, read-only pre-check, no write for a sold-out answer); the same pools; a conservative window; and, in these words: "PostgreSQL and Redis run on the API's machine. In a real deployment they would sit about a millisecond away, which would add about the same to every answer in both runs without changing what the comparison shows."

The two comparison sections take over the panel's intro and takeaway. Each ends with links to `/limits#comparison-limits` and `/under-the-hood#measurement`.

**Limits and known defects `/limits`**
1. **Real and simulated** (`#real-and-simulated`). Moved, plus two points: there is no payment step, and the PostgreSQL and no-queue modes exist only in the comparison presets.
2. **Scale** (`#scale`).
   - One core machine runs everything except the load generator.
   - One API process serves ordinary runs; two buy-only processes serve the Redis comparison (the HD-51 amendment).
   - The measured ceilings, moved.
   - Runs too heavy for the demo are refused.
   - Connections can take seconds to open in a 10,000-buyer spike.
   - These are observations, not a benchmark.
3. **What limits a run** (`#run-limits`). Moved and condensed.
4. **What the comparisons do not show** (`#comparison-limits`).
   - The stores are co-located with the API.
   - Winners are not faster with Redis.
   - A speed gap needs a database bottleneck the demo lacks.
   - Redis's single-thread ceiling is not measured.
   - The run order is fixed.
   - The first comparison after a wake is slower, in both runs.
   - The 45 s answer never occurs on the preset.
5. **What production would add** (`#production`). Moved, plus Redis–database reconciliation, back-office protection coordinated across workers, and monitoring.
6. **Known defects** (`#known-defects`). One line each, with its effect and a repository link, compiled at implementation time. Candidates:
   - the PostgreSQL queue drains about 12 % slower, outside the measured window;
   - an idle stop can race a run start (HD-21);
   - the countdown can be briefly stale (HD-23);
   - history is lost on a reinstall (HD-05);
   - form messages follow the browser's language;
   - whatever task 05 leaves open.
7. **Further reading:** scope and caveats, and the decision logs.

"Later work will compare…" is removed.

**Under the hood `/under-the-hood`**
- **Architecture** (`#architecture`): today's diagram and the stack table.
- **The buy path** (`#buy-path`): the home's technical detail, covering the transaction and publish, the scanners, pending-persistence recovery, reservation vs response timing, the declared capacity, and uncertain results.
- **Safety nets** (`#safety-nets`): one line per failure mode.
- **How a run works** (`#runs`): admission, finishing, success, grace and reset, the shared slot, chaining.
- **Live signals** (`#signals`).
- **How the comparisons are measured** (`#measurement`): modes, fairness rules, the selling window and its sources, pairs and warm-up, median and range, cold and warm tables, the buy-only pool.
- **Hosting** (`#hosting`): V8, idle stop and wake, sizes, prewarm, disposable data.
- **Glossary** (`#glossary`): its anchors are kept.

**Other surfaces.**
- `/demo`: the capsule shrinks to two sentences linking to `/how-it-works`, and each comparison card gets a "What this shows" link.
- README: a short opening that mirrors the home, and the buy-only pool in the single-process sentence.
- `docs/architecture.md` (its Purpose section) and `scope_and_caveats.md` are aligned.

**Wireframe: home** (desktop; on a phone, V1 becomes one column and the cards stack)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▮ Checkout-Surge         Demo  Watch  Run history  How it works  Repo ↗  Admin │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▁▂▃▅▆▇█▆█▇███▐ · · · · · · · ·                          (surge band, kept)    │
│ CHECKOUT-SURGE                                                               │
│ A live demo of the system behind a flash sale: 10,000 buyers rush for 500    │
│ units, nobody gets a unit that does not exist, and a slow back office is     │
│ never flooded.  Start a simulated sale and watch it live.                    │
│ [ Try the demo ]  [ How it works ]                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ HOW IT WORKS, IN ONE PICTURE — standard design choices for this kind of sale →│
│ ┆waiting room┆──▶[ API ③ ]──▶[① stock decision]──▶ "Sold out"   (milliseconds)│
│ ┆not modelled┆                      │ unit left                               │
│                                     ▼                                        │
│                              [order saved]──▶ "You got it"   (seconds)        │
│                                     ▼                                        │
│                 [② queue]──▶[worker]──▶[back office]──▶ "Confirmed"           │
│                                         at its own pace                      │
│ ┌① Stock in memory─┐┌② Yes now,─────────┐┌③ Safe retries──┐┌ Waiting room ──┐ │
│ │never oversells,  ││  confirm later    ││a double click  ││buyers let in at│ │
│ │spares the DB     ││back office paced  ││buys once       ││a safe pace     │ │
│ │COMPARED LIVE   → ││COMPARED LIVE    → ││SHOWN LIVE    → ││NOT MODELLED  → │ │
│ └──────────────────┘└───────────────────┘└────────────────┘└────────────────┘ │
│ The software is real; buyers, back office and emails are simulated. →        │
├──────────────────────────────────────────────────────────────────────────────┤
│ WHAT EACH CHOICE BUYS — same workload, run twice, one choice switched        │
│ ┌ Queue comparison ─────────────────┐ ┌ Redis comparison ────────────────────┐│
│ │ Every buyer answered within       │ │ Database transactions while selling  ││
│ │ with     ██ 5 s                   │ │ with     ████ ~4,500                 ││
│ │ without  ████████████████ 27 s    │ │ without  ████████████ ~12,000        ││
│ │ Same 500 orders, same ERP pace    │ │ Same 500 units sold, same answers    ││
│ │ [ Run it ]   How to read it →     │ │ [ Run it ]   How to read it →        ││
│ └───────────────────────────────────┘ └──────────────────────────────────────┘│
│ Medians of measured pairs; your run will differ a little.                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ A DEMO, AT DEMO SCALE  · one machine, up to 10,000 buyers in a second        │
│ · no payment, no bot protection · the stores share the API's machine         │
│ Limits and known defects →                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ FOR ENGINEERS  Node.js · Fastify · Redis · PostgreSQL · BullMQ · k6 · Next.js │
│ · Fly.io — sleeps when idle, wakes in ~15 s.   Under the hood →   Repo ↗      │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓▓ See it under load                                        [ Try the demo ] │
├──────────────────────────────────────────────────────────────────────────────┤
│ How it works · Under the hood · Limits and known defects · Glossary · Repo ↗ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Wireframe: How it works** (practices 1 and 4 use the same frame as 2 and 3, without a visual)

```text
HOW FLASH-SALE CHECKOUTS ARE BUILT
What shops do when demand far exceeds stock, why it is standard, and what this demo shows of it.
┌ On this page ─┐ ┌──────────────────────────────────────────────────────────────┐
│ Three numbers │ │ A FLASH SALE IN THREE NUMBERS                                  │
│ 1 Waiting room│ │  10,000 buyers  ████████████████████ in about a second         │
│ 2 Stock       │ │     500 units   █                                              │
│ 3 Yes now     │ │   20 per second ▏ confirmed by the back office (simulated)     │
│ 4 Safe retries│ │  [waiting room]→[stock]→[hold+payment]→[order]→[fulfil+notify] │
│ At its scale  │ │   not modelled   shown   simplified     shown   simulated      │
│ Queue compar. │ ├──────────────────────────────────────────────────────────────┤
│ Redis compar. │ │ 2. DECIDE THE STOCK IN MEMORY, IN ONE STEP                     │
│ Limits →      │ │  with Redis     ●●●●●●●●●●… 95 stop at Redis: "sold out"       │
│ (sticky)      │ │                 ●●●●● 5 reach PostgreSQL                       │
│               │ │  without Redis  ●●●●●●●●●●… all 100 reach PostgreSQL           │
│               │ │  The problem …  The standard answer …  Why it is standard …    │
│               │ │  What it brings …  What it costs …                             │
│               │ │  ┌ In this demo: every run · compared live → Redis comparison ┐│
│               │ │  └ Limit: winners are not faster →                             ┘│
│               │ ├──────────────────────────────────────────────────────────────┤
│               │ │ 3. SAY "YES" NOW, CONFIRM LATER                                │
│               │ │  with queue    buyer ▌~3 s   back office ▬▬▬▬▬▬▬▬▬▬▬▬▬ ~27 s   │
│               │ │  without       buyer ▬▬▬▬▬▬▬▬▬▬▬▬▬ up to ~27 s (same lane)     │
│               │ │  … same frame, "In this demo" box …                           │
│               │ ├──────────────────────────────────────────────────────────────┤
│               │ │ WHAT THE DEMO SHOWS, AT ITS SCALE  table · scale note →        │
│               │ ├──────────────────────────────────────────────────────────────┤
│               │ │ THE QUEUE COMPARISON                              [ Run it ]   │
│               │ │  What it runs · measured pairs (V7) · the reading              │
│               │ │  How to read each figure · Fair test · Limits →                │
│               │ │ THE REDIS COMPARISON — same frame + the co-located disclosure  │
│               │ │ NEXT: Limits and known defects →    Under the hood →           │
└───────────────┘ └──────────────────────────────────────────────────────────────┘
```

#### 4. Visuals

| ID | Where | What it shows |
| :-- | :-- | :-- |
| V1 | Home | One purchase, two answers: "sold out" in milliseconds, or "you got it" within seconds once the order is saved. Then the queue, the worker, and the back office at its own pace. The waiting room is dashed ("not modelled"). |
| V2 | Home | One measured pair per comparison: two bars, with the values printed. |
| V3 | How it works | Three figures with proportional strips: 10,000, 500, and 20 per second. |
| V4 | How it works | The five-step journey, each step tagged shown, simplified, simulated or not modelled. |
| V5 | How it works | 100 dots, one per 100 buyers. With Redis, 95 stop at Redis and 5 reach PostgreSQL; without it, all 100 do. |
| V6 | How it works | Who waits: two timelines. The buyer's answer moves (about 3 s against up to about 27 s); the back office's lane is identical. |
| V7 | How it works | Each comparison's measured pairs: median bars, with the range in text. |
| V8 | Under the hood | The hosting topology (gate, core, runner, guard). Plus today's architecture diagram, moved. |

**How to build them.**
- Server components in `components/diagrams/`, sharing one primitives file grown from today's `DiagramNode`.
- Colors come only from the `globals.css` tokens, as today: signal for the fast path, signal-soft for the slow one, accent-soft for durable stores, and a dashed outline for anything simulated or not modelled.
- V1 to V7 are HTML/Tailwind grids that turn into a column below 900 px, with SVG only for arrows and dots. The dense diagrams keep today's sideways scroll.
- Each visual has an accessible name and a text description.
- Every quoted figure comes from one data module, as `hostedMeasurements` does today.
- No chart library and no animation.

#### 5. The comparisons across the site

- **Home:** two teaser cards.
- **How it works:** one section per comparison, holding everything Watch no longer says.
- **Demo:** each comparison card says what it switches, and links to its section. The wording is settled with task 05.
- **Watch tab and run reports** (task 05): no prose, only one line of two links:
  - "How to read these figures" goes to `/how-it-works#queue-comparison` or `#redis-comparison`;
  - "What this comparison does not show" goes to `/limits#comparison-limits`.
- **Limits:** `#comparison-limits`. **Under the hood:** `#measurement`, with the full tables.

#### 6. Cross-links

Every link sits on the sentence that raises its topic:
- On the home, the "standard design choices" sentence and each card lead to How it works; "simulated" leads to `#real-and-simulated`; the scale band leads to Limits; the comparison cards lead to their sections and presets; the engineers' band leads to Under the hood.
- On How it works, each practice ends in one "In this demo" box (its preset, a limit link), and each comparison links to `#comparison-limits` and `#measurement`.
- Limits links back to what it qualifies, and to the repository's caveats and decision logs.
- Wherever a limit is named (Watch's run caveats, the Demo capsule), the phrase links to its `/limits` anchor.

Rules:
- At most one limits link per section or card, never on "see here".
- Every route and anchor comes from one `site-links.ts`, and one test checks that each anchor exists on its page.

#### 7. Effort and order

| Part | Rough lines |
| :-- | :-- |
| Shared: `site-links.ts`, footer, nav, content-page layout with its contents list, practice frame, measured pair, figures data | ~350 |
| Visuals V1–V8 and their primitives (the moved architecture diagram not counted) | ~550 |
| Pages: home (703 → ~220), How it works ~550, Limits ~230, Under the hood ~380 (about 60 % moved text) | ~1,380 |
| Demo, Watch and report links; comparison preset texts | ~40 |
| Tests: `public-mental-model.test.tsx` rewritten (pages render, the link check, the home's calls to action) | ~100 |
| Docs: README opening, architecture Purpose, scope and caveats, decision entries | ~180 |

About 2,300 production lines, of which about 900 are moved text.

**Order.**
1. The shared parts.
2. Under the hood and Limits, moving today's content first, so nothing is lost.
3. How it works and its visuals, with anchors aligned with task 05.
4. The home.
5. The Demo, Watch and report links.
6. The README, the docs and the decision entries: the modes and fairness rules, the comparison-only conditions, and the HD-51 amendment. Then checkpoint D2.

#### 8. Open questions for the owner

1. **Nav:** drop "Overview" and move Admin to the footer? *Default:* drop Overview, keep Admin in the nav.
2. **Quoted figures:** use static medians from the proof measurements, refreshed after the production deploy (task 07), or ratios only? *Default:* static figures, labelled with the method.
3. **Industry examples:** name vendors and well-known sales, or stay generic? *Default:* generic, so that every claim is one the project can stand behind.
4. **Author:** name you and link a profile? *Default:* one footer line, if you provide the link.
5. **Gate page:** add one sentence on what Checkout-Surge is to "The demo is asleep", which cold visitors see first? This is a small change in `apps/gate`. *Default:* yes.
6. **Titles:** "How it works" in the nav for a page titled "How flash-sale checkouts are built", and "Under the hood"? *Default:* as proposed.
