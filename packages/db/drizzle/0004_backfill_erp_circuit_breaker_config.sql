-- Existing installations can run migrations independently from the environment-aware
-- demo seed. Supply stable compatibility defaults so legacy accepted configuration is
-- readable immediately after a migrate-only upgrade. A later seed only fills fields
-- still missing and therefore preserves these values and all operator configuration.
UPDATE "demo_presets"
SET "backpressure_config" = coalesce("backpressure_config", '{}'::jsonb)
  || CASE
    WHEN coalesce("backpressure_config", '{}'::jsonb) ? 'circuitBreakerFailureThreshold'
      THEN '{}'::jsonb
    ELSE jsonb_build_object('circuitBreakerFailureThreshold', 5)
  END
  || CASE
    WHEN coalesce("backpressure_config", '{}'::jsonb) ? 'circuitBreakerResetTimeoutMs'
      THEN '{}'::jsonb
    ELSE jsonb_build_object('circuitBreakerResetTimeoutMs', 10000)
  END
WHERE NOT (coalesce("backpressure_config", '{}'::jsonb) ? 'circuitBreakerFailureThreshold')
  OR NOT (coalesce("backpressure_config", '{}'::jsonb) ? 'circuitBreakerResetTimeoutMs');

UPDATE "public_runtime_policies"
SET "policy" = jsonb_set(
  "policy",
  '{publicCustomDefaults}',
  coalesce("policy" -> 'publicCustomDefaults', '{}'::jsonb)
    || jsonb_build_object(
      'backpressureConfig',
      coalesce("policy" #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb)
        || CASE
          WHEN coalesce("policy" #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb)
            ? 'circuitBreakerFailureThreshold'
            THEN '{}'::jsonb
          ELSE jsonb_build_object('circuitBreakerFailureThreshold', 5)
        END
        || CASE
          WHEN coalesce("policy" #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb)
            ? 'circuitBreakerResetTimeoutMs'
            THEN '{}'::jsonb
          ELSE jsonb_build_object('circuitBreakerResetTimeoutMs', 10000)
        END
    ),
  true
)
WHERE NOT (coalesce("policy" #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb)
    ? 'circuitBreakerFailureThreshold')
  OR NOT (coalesce("policy" #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb)
    ? 'circuitBreakerResetTimeoutMs');
