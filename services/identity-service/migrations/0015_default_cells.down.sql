-- Remove the default cells only where they are still unused; a cell with
-- tenants assigned must survive (tenants.cell_id references it).
DELETE FROM cells
WHERE id IN ('11111111-1111-1111-1111-111111111111',
             '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333')
  AND tenant_count = 0;
