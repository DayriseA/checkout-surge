-- Repository-owned policies seeded before the public custom VU and ERP TPS
-- limits were introduced omitted these four keys. Key-existence checks are
-- intentional: explicit JSON null and all operator-supplied values are
-- preserved so the full contract validation run by the migration command can
-- fail closed instead of silently treating invalid data as legacy-missing.
UPDATE "public_runtime_policies"
SET "policy" = jsonb_set(
  "policy",
  '{publicCustomLimits}',
  ("policy" -> 'publicCustomLimits')
    || CASE
      WHEN ("policy" -> 'publicCustomLimits') ? 'maxPreAllocatedVus'
        THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'maxPreAllocatedVus',
        LEAST(
          1000::numeric,
          CASE
            WHEN ("policy" #>> '{deploymentHardCaps,maxPreAllocatedVus}') ~ '^[1-9][0-9]*$'
              THEN ("policy" #>> '{deploymentHardCaps,maxPreAllocatedVus}')::numeric
            ELSE 1000::numeric
          END,
          CASE
            WHEN ("policy" #>> '{deploymentHardCaps,maxVus}') ~ '^[1-9][0-9]*$'
              THEN ("policy" #>> '{deploymentHardCaps,maxVus}')::numeric
            ELSE 1000::numeric
          END,
          CASE
            WHEN ("policy" #>> '{publicCustomLimits,maxVus}') ~ '^[1-9][0-9]*$'
              THEN ("policy" #>> '{publicCustomLimits,maxVus}')::numeric
            ELSE 1000::numeric
          END
        )
      )
    END
    || CASE
      WHEN ("policy" -> 'publicCustomLimits') ? 'maxVus'
        THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'maxVus',
        LEAST(
          CASE
            WHEN ("policy" #>> '{deploymentHardCaps,maxVus}') ~ '^[1-9][0-9]*$'
              THEN ("policy" #>> '{deploymentHardCaps,maxVus}')::numeric
            ELSE 1000::numeric
          END,
          GREATEST(
            LEAST(
              1000::numeric,
              CASE
                WHEN ("policy" #>> '{deploymentHardCaps,maxVus}') ~ '^[1-9][0-9]*$'
                  THEN ("policy" #>> '{deploymentHardCaps,maxVus}')::numeric
                ELSE 1000::numeric
              END
            ),
            CASE
              WHEN ("policy" #>> '{publicCustomLimits,maxPreAllocatedVus}') ~ '^[1-9][0-9]*$'
                THEN ("policy" #>> '{publicCustomLimits,maxPreAllocatedVus}')::numeric
              ELSE 1::numeric
            END
          )
        )
      )
    END
    || CASE
      WHEN ("policy" -> 'publicCustomLimits') ? 'minErpMaxTps'
        THEN '{}'::jsonb
      ELSE jsonb_build_object('minErpMaxTps', 1)
    END
    || CASE
      WHEN ("policy" -> 'publicCustomLimits') ? 'maxErpMaxTps'
        THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'maxErpMaxTps',
        GREATEST(
          100::numeric,
          CASE
            WHEN ("policy" #>> '{publicCustomDefaults,erpConfig,maxTps}') ~ '^[1-9][0-9]*$'
              THEN ("policy" #>> '{publicCustomDefaults,erpConfig,maxTps}')::numeric
            ELSE 100::numeric
          END,
          CASE
            WHEN ("policy" #>> '{publicCustomLimits,minErpMaxTps}') ~ '^[1-9][0-9]*$'
              THEN ("policy" #>> '{publicCustomLimits,minErpMaxTps}')::numeric
            ELSE 1::numeric
          END
        )
      )
    END,
  false
)
WHERE jsonb_typeof("policy") = 'object'
  AND jsonb_typeof("policy" -> 'publicCustomLimits') = 'object'
  AND (
    NOT (("policy" -> 'publicCustomLimits') ? 'maxPreAllocatedVus')
    OR NOT (("policy" -> 'publicCustomLimits') ? 'maxVus')
    OR NOT (("policy" -> 'publicCustomLimits') ? 'minErpMaxTps')
    OR NOT (("policy" -> 'publicCustomLimits') ? 'maxErpMaxTps')
  );
