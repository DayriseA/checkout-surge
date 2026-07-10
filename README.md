# Checkout-Surge AI Results Branch

This branch is reserved for evaluation and notes.

Use this branch for review and comparison artifacts only, such as notes about agent runs, delivery assessments, model comparisons, and references to the things being evaluated.

## Evaluation flow

The results in this branch follow a specific order:

1. Each agent implemented Checkout-Surge phases 1-10 in its own branch.
2. Each agent self-audited its own implementation and produced the findings stored under `results/p1-10_auto_review/` and `results/data/findings/`.
3. Those self-audit findings were turned into issues on the respective implementation branches.
4. The same agents were given a chance to fix the issues they found and claimed completion.
5. Only after those claimed fixes did independent browser-use testing run against the implementations.

That ordering matters for `results/data/browser-use-test-findings/`: a post-fix browser finding is either a self-audit issue that survived the claimed fix, or a blind spot the self-audit did not identify.

## License

This repository remains licensed under the MIT License. See [LICENSE](LICENSE) for details.
