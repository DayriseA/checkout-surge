UPDATE "demo_presets"
SET "backpressure_config" = coalesce("backpressure_config", '{}'::jsonb)
  || jsonb_build_object(
    'retryPolicy',
    coalesce("backpressure_config" -> 'retryPolicy', jsonb_build_object('maxAttempts', 4, 'initialBackoffMs', 500))
  )
WHERE NOT (coalesce("backpressure_config", '{}'::jsonb) ? 'retryPolicy');

UPDATE "public_runtime_policies"
SET "policy" = jsonb_set(
  "policy",
  '{publicCustomDefaults,backpressureConfig,retryPolicy}',
  jsonb_build_object('maxAttempts', 4, 'initialBackoffMs', 500),
  true
)
WHERE NOT (coalesce("policy" #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb) ? 'retryPolicy');

UPDATE "demo_runs"
SET "config_snapshot" = jsonb_set(
  "config_snapshot",
  '{backpressureConfig,retryPolicy}',
  jsonb_build_object('maxAttempts', 4, 'initialBackoffMs', 500),
  true
)
WHERE NOT (coalesce("config_snapshot" #> '{backpressureConfig}', '{}'::jsonb) ? 'retryPolicy');
