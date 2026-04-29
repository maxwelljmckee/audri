-- Slice 9: cost-monitoring SQL views over usage_events.
--
-- Two views: per-user-per-day rollup (operational), and per-event-kind daily
-- (architecture-level cost shape). Materialized would be faster but at our
-- scale a regular view is fine; revisit when daily row count crosses ~100k.
--
-- Sample queries to run from psql:
--   SELECT * FROM usage_daily_per_user
--     WHERE day >= now() - interval '7 days'
--     ORDER BY total_tokens DESC LIMIT 10;
--
--   SELECT * FROM usage_daily_by_kind
--     WHERE day >= now() - interval '30 days'
--     ORDER BY day DESC, total_tokens DESC;

CREATE OR REPLACE VIEW "usage_daily_per_user" AS
SELECT
  date_trunc('day', created_at) AS day,
  user_id,
  COUNT(*) AS event_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cached_tokens) AS cached_tokens,
  SUM(input_tokens + output_tokens + cached_tokens) AS total_tokens,
  SUM(cost_cents) AS cost_cents
FROM "usage_events"
GROUP BY 1, 2;--> statement-breakpoint

CREATE OR REPLACE VIEW "usage_daily_by_kind" AS
SELECT
  date_trunc('day', created_at) AS day,
  event_kind,
  model,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_id) AS distinct_users,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cached_tokens) AS cached_tokens,
  SUM(input_tokens + output_tokens + cached_tokens) AS total_tokens,
  SUM(cost_cents) AS cost_cents
FROM "usage_events"
GROUP BY 1, 2, 3;
