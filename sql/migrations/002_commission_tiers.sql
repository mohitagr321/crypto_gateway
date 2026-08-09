-- Migration: tiered (slab-based) commissions.
-- Adds the 'tiered' commission type and a JSONB `tiers` column holding the slabs.
-- Idempotent; safe to run on an existing database. Run in autocommit (psql -f).

ALTER TYPE commission_type ADD VALUE IF NOT EXISTS 'tiered';

ALTER TABLE commissions ADD COLUMN IF NOT EXISTS tiers JSONB;
