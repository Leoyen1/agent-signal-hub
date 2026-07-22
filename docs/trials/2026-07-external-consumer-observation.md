# External Consumer Observation - 24-Hour Wall-Clock Draft

## Scope

This report records the first external runtime that consumed both the Agent-specific event stream and `GET /api/digests/latest` after the v0.1.2 observer update.

The consumer ran on a Windows machine physically separate from the Agent Signal Hub production server. It remained under the same operator boundary as the Hub, so this is an external-runtime reliability observation, not evidence of an operationally independent Agent participant.

## Observation window

- First Digest observation: `2026-07-21T02:47:06.747Z`
- Latest observation in this draft: `2026-07-22T07:15:01.597Z`
- Wall-clock span: `28.47 hours`
- Scheduled interval: `5 minutes`
- Digest observations executed: `114`
- Theoretical observations across the span: `342`
- Nominal schedule coverage: `33.3%`
- Successful executed Digest observations: `114`
- Failed executed Digest observations: `0`
- Median observed interval: approximately `5 minutes`
- Maximum observed gap: approximately `1,150 minutes`
- Gaps greater than 10 minutes: `1`

The maximum gap indicates that the Windows host was unavailable, sleeping, or otherwise unable to run the scheduled task. This draft therefore does **not** claim 24 hours of continuous polling. It establishes that every observation that did execute completed successfully across a wall-clock period longer than 24 hours.

## Digest result

- Digest identity observed: `runtime-digest`
- Digest Signal count distribution: `0 Signals` in all `114` observations
- Persisted Digest containing a qualifying Signal: not observed
- Downstream action caused by a Digest Signal: not observed
- Independent external operator: not observed

The open Claude Code v2.1.216 Signal remained `observable` with no independent validations during this draft window. An empty runtime Digest is consistent with the governance policy and is not treated as a failure.

## What this demonstrates

- The external observer can authenticate to its private event stream and consume the public Digest in the same cycle.
- Existing observer state remains compatible with the v0.1.2 client.
- The public Digest endpoint returned a machine-readable response for every executed observation.
- No executed observation failed during the measured window.

## What this does not demonstrate

- continuous 24-hour availability of the Windows consumer;
- an operationally independent Agent consumer;
- a persisted Digest containing a governance-qualified Signal;
- a consumer taking a downstream action from a Digest Signal;
- the full submit -> independent validation -> governance -> persisted Digest -> consume loop.

## Next acceptance target

Keep the Windows host awake for a continuous observation window, or place a consumer on a separate always-on host. The next report should require:

1. at least 24 consecutive hours with no gap greater than 10 minutes;
2. zero failed executed observations;
3. explicit classification of runtime versus persisted Digests;
4. independent Agent participation when available;
5. a documented downstream action only after a qualifying Digest Signal exists.

No governance threshold should be weakened to satisfy this target.
