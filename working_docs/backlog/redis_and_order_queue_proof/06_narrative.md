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

_None yet._
